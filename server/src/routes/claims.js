const express = require('express');
const { z } = require('zod');
const { getStore } = require('../db/store');
const { ApiError, asyncHandler, authenticate, authorize, audit } = require('../middleware/auth');
const { evaluateRules } = require('../services/ruleEngine');
const { buildFeatures, riskLevel } = require('../services/featureService');
const ml = require('../services/mlService');
const { fuseRisk, decideStatus, narrative } = require('../services/riskService');

const router = express.Router();

/** Turn a Zod failure into a clean 400 instead of an opaque 500. */
const parseBody = (schema, body) => {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const details = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
  throw new ApiError(400, `Invalid claim payload — ${details[0]}`, details);
};


/**
 * Derive the behavioural features the model expects from the *ledger* rather
 * than from lifetime totals. A claim's `priorClaims30d` must mean "claims this
 * member filed in the 30 days before this service date" - using a member's
 * lifetime claim count instead would make every long-standing member look like
 * a fraud ring.
 */
async function deriveBehaviouralContext(store, { memberId, providerId, serviceDate }) {
  const day = 86400000;
  const from = new Date(+serviceDate - 30 * day);
  const to = new Date(+serviceDate + day);
  const [member30d, member12m, provider30d, sameDay] = await Promise.all([
    store.count('claims', { memberId, serviceDate: { $gte: from, $lte: to } }),
    store.count('claims', { memberId, serviceDate: { $gte: new Date(+serviceDate - 365 * day), $lte: to } }),
    store.count('claims', { providerId, serviceDate: { $gte: from, $lte: to } }),
    store.count('claims', {
      memberId,
      serviceDate: { $gte: new Date(+serviceDate - day), $lte: new Date(+serviceDate + day) },
    }),
  ]);
  return { priorClaims30d: member30d, memberClaims12m: member12m, providerClaims30d: provider30d, sameDayClaims: sameDay };
}

const claimInput = z.object({
  providerId: z.string(),
  memberId: z.string(),
  claimType: z.enum(['inpatient', 'outpatient', 'pharmacy', 'laboratory', 'dental', 'vision']),
  procedureCode: z.string(),
  diagnosisCode: z.string(),
  serviceDate: z.string(),
  submissionDate: z.string().optional(),
  amountBilled: z.number().positive(),
  amountApproved: z.number().nonnegative().optional(),
  unitsClaimed: z.number().int().positive().optional(),
  serviceDays: z.number().int().nonnegative().optional(),
  nightsInHospital: z.number().int().nonnegative().optional(),
  numProcedures: z.number().int().positive().optional(),
  isEmergency: z.number().int().min(0).max(1).optional(),
  pharmacyQty: z.number().int().positive().optional(),
  pharmacyRefillDays: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

/**
 * POST /api/claims/preview - score a hypothetical claim WITHOUT persisting it.
 * Powers the interactive adjudication simulator.
 */
router.post('/preview', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const body = parseBody(claimInput, req.body);
  const provider = await store.findOne('providers', { providerId: body.providerId });
  const member = await store.findOne('members', { memberId: body.memberId });
  if (!provider) throw new ApiError(400, `Unknown provider ${body.providerId}`);
  if (!member) throw new ApiError(400, `Unknown member ${body.memberId}`);

  const serviceDate = new Date(body.serviceDate);
  const submissionDate = body.submissionDate ? new Date(body.submissionDate) : new Date();
  const lagDays = Math.max(0, Math.round((submissionDate - serviceDate) / 86400000));
  const context = await deriveBehaviouralContext(store, {
    memberId: member.memberId, providerId: provider.providerId, serviceDate,
  });

  const claim = {
    claimId: 'PREVIEW',
    providerId: provider.providerId,
    providerName: provider.name,
    memberId: member.memberId,
    memberName: member.name,
    claimType: body.claimType,
    specialty: provider.specialty,
    procedureCode: body.procedureCode,
    diagnosisCode: body.diagnosisCode,
    planType: member.planType,
    state: provider.state,
    serviceDate: serviceDate.toISOString(),
    submissionDate: submissionDate.toISOString(),
    amountBilled: body.amountBilled,
    amountApproved: body.amountApproved ?? 0,
    unitsClaimed: body.unitsClaimed ?? 1,
    serviceDays: body.serviceDays ?? 1,
    nightsInHospital: body.nightsInHospital ?? 0,
    numProcedures: body.numProcedures ?? 1,
    priorClaims30d: context.priorClaims30d,
    memberClaims12m: context.memberClaims12m,
    providerClaims30d: Math.max(context.providerClaims30d, 1),
    sameDayClaims: context.sameDayClaims,
    duplicateSimilarity: 0.03,
    diagProcMatch: estimateDiagProcMatch(body, provider),
    ageServiceMismatch: 0,
    diagnosisSeverity: 0.45,
    submissionLagDays: lagDays,
    isWeekendSubmission: [0, 6].includes(submissionDate.getDay()) ? 1 : 0,
    providerLicenseAgeYears: provider.licenseAgeYears,
    providerFraudHistory: provider.fraudHistory,
    providerInNetwork: provider.inNetwork ? 1 : 0,
    providerAvgBilled: provider.peerAvgBilled,
    distanceKm: 18,
    memberAge: member.age,
    chronicConditions: member.chronicConditions,
    policyAgeMonths: member.policyAgeMonths,
    annualPremium: member.annualPremium,
    isEmergency: body.isEmergency ?? 0,
    pharmacyQty: body.pharmacyQty ?? 1,
    pharmacyRefillDays: body.pharmacyRefillDays ?? 30,
    specialtyAmountMean: provider.peerAvgBilled,
    specialtyAmountStd: Math.max(5000, provider.peerAvgBilled * 0.45),
  };

  const fused = await fuseRisk(claim);
  res.json({
    ...fused,
    claimId: 'PREVIEW',
    providerName: provider.name,
    specialist: provider.specialty,
    features: buildFeatures({ ...claim, ...fused }),
    narrative: narrative({ ...claim, ...fused }, { triggered: fused.triggeredRules }),
    scoringSource: fused.scoringSource,
    persisted: false,
  });
}));

/** GET /api/claims - filtered, paginated claim list */
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 20);
  const filter = {};

  if (req.query.status) filter.status = req.query.status;
  if (req.query.riskLevel) filter.riskLevel = req.query.riskLevel;
  if (req.query.specialty) filter.specialty = req.query.specialty;
  if (req.query.providerId) filter.providerId = req.query.providerId;
  if (req.query.memberId) filter.memberId = req.query.memberId;
  if (req.query.claimType) filter.claimType = req.query.claimType;
  if (req.query.state) filter.state = req.query.state;
  if (req.query.flagged === 'true') filter.isFlagged = true;
  if (req.query.minRisk) filter.riskScore = { $gte: Number(req.query.minRisk) };
  if (req.query.maxRisk) filter.riskScore = { ...(filter.riskScore || {}), $lte: Number(req.query.maxRisk) };
  if (req.query.from || req.query.to) {
    filter.serviceDate = {};
    if (req.query.from) filter.serviceDate.$gte = new Date(req.query.from);
    if (req.query.to) filter.serviceDate.$lte = new Date(req.query.to);
  }
  if (req.query.search) {
    const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ claimId: rx }, { providerName: rx }, { memberName: rx },
      { providerId: rx }, { memberId: rx }, { diagnosisName: rx }];
  }

  const sort = {};
  const sortField = req.query.sort || 'riskScore';
  sort[sortField] = req.query.order === 'asc' ? 1 : -1;

  const [claims, total] = await Promise.all([
    store.find('claims', filter, { skip: (page - 1) * limit, limit, sort }),
    store.count('claims', filter),
  ]);
  res.json({ claims, total, page, pages: Math.ceil(total / limit) || 1, limit });
}));

/** GET /api/claims/:id - full detail incl. explanation + rules + provider/member context */
router.get('/:id', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const claim = await store.findOne('claims', { claimId: req.params.id });
  if (!claim) throw new ApiError(404, 'Claim not found');
  const [provider, member, rules, siblings, caseDoc] = await Promise.all([
    store.findOne('providers', { providerId: claim.providerId }),
    store.findOne('members', { memberId: claim.memberId }),
    Promise.resolve(evaluateRules(claim)),
    store.find('claims', { memberId: claim.memberId }, { limit: 8, sort: { serviceDate: -1 } }),
    store.findOne('cases', { claimId: claim.claimId }),
  ]);
  res.json({
    claim,
    features: buildFeatures(claim),
    provider,
    member,
    ruleEvaluation: rules,
    relatedClaims: siblings.filter((c) => c.claimId !== claim.claimId),
    case: caseDoc,
    narrative: narrative(claim, rules),
  });
}));

/** GET /api/claims/:id/explain - (re)compute the Shapley explanation live */
router.get('/:id/explain', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const claim = await store.findOne('claims', { claimId: req.params.id });
  if (!claim) throw new ApiError(404, 'Claim not found');
  const explanation = await ml.explainClaim(claim);
  res.json({ claimId: claim.claimId, explanation, features: buildFeatures(claim) });
}));

/**
 * POST /api/claims - submit a new claim (the live scoring demo).
 * Runs: feature build -> ML score -> rule engine -> risk fusion -> persist.
 */
router.post('/', authenticate, authorize('admin', 'investigator', 'analyst'), asyncHandler(async (req, res) => {
  const store = getStore();
  const body = parseBody(claimInput, req.body);

  const provider = await store.findOne('providers', { providerId: body.providerId });
  const member = await store.findOne('members', { memberId: body.memberId });
  if (!provider) throw new ApiError(400, `Unknown provider ${body.providerId}`);
  if (!member) throw new ApiError(400, `Unknown member ${body.memberId}`);

  const serviceDate = new Date(body.serviceDate);
  const submissionDate = body.submissionDate ? new Date(body.submissionDate) : new Date();
  const lagDays = Math.max(0, Math.round((submissionDate - serviceDate) / 86400000));

  const context = await deriveBehaviouralContext(store, {
    memberId: member.memberId, providerId: provider.providerId, serviceDate,
  });
  const duplicateSimilarity = await findDuplicateSimilarity(store, {
    memberId: member.memberId, providerId: provider.providerId,
    amountBilled: body.amountBilled, procedureCode: body.procedureCode,
    serviceDate,
  });

  // Collision-safe sequential id in the ledger's own namespace: take the
  // highest existing sequence number (not the row count, which drifts after
  // any deletion) and increment it.
  const latest = await store.find('claims', {}, { limit: 1, sort: { claimId: -1 } });
  const lastSeq = latest.length ? Number(String(latest[0].claimId).slice(-6)) || 0 : 0;
  const seq = Math.max(lastSeq, await store.count('claims', {})) + 1;
  const claimId = `CLM-${new Date().getFullYear()}-${String(seq).padStart(6, '0')}`;

  const claim = {
    claimId,
    providerId: provider.providerId,
    providerName: provider.name,
    memberId: member.memberId,
    memberName: member.name,
    claimType: body.claimType,
    specialty: provider.specialty,
    procedureCode: body.procedureCode,
    diagnosisCode: body.diagnosisCode,
    planType: member.planType,
    state: provider.state,
    serviceDate: serviceDate.toISOString(),
    submissionDate: submissionDate.toISOString(),
    amountBilled: body.amountBilled,
    amountApproved: body.amountApproved ?? 0,
    unitsClaimed: body.unitsClaimed ?? 1,
    serviceDays: body.serviceDays ?? 1,
    nightsInHospital: body.nightsInHospital ?? 0,
    numProcedures: body.numProcedures ?? 1,
    priorClaims30d: context.priorClaims30d,
    memberClaims12m: context.memberClaims12m,
    providerClaims30d: Math.max(context.providerClaims30d, 1),
    sameDayClaims: context.sameDayClaims,
    duplicateSimilarity,
    diagProcMatch: estimateDiagProcMatch(body, provider),
    ageServiceMismatch: 0,
    diagnosisSeverity: 0.45,
    submissionLagDays: lagDays,
    isWeekendSubmission: [0, 6].includes(submissionDate.getDay()) ? 1 : 0,
    providerLicenseAgeYears: provider.licenseAgeYears,
    providerFraudHistory: provider.fraudHistory,
    providerInNetwork: provider.inNetwork ? 1 : 0,
    providerAvgBilled: provider.peerAvgBilled,
    distanceKm: 18,
    memberAge: member.age,
    chronicConditions: member.chronicConditions,
    policyAgeMonths: member.policyAgeMonths,
    annualPremium: member.annualPremium,
    isEmergency: body.isEmergency ?? 0,
    pharmacyQty: body.pharmacyQty ?? 1,
    pharmacyRefillDays: body.pharmacyRefillDays ?? 30,
    specialtyAmountMean: provider.peerAvgBilled,
    specialtyAmountStd: Math.max(5000, provider.peerAvgBilled * 0.45),
    notes: body.notes ? [{ author: req.user.name, text: body.notes, at: new Date().toISOString() }] : [],
    createdAt: new Date().toISOString(),
  };

  const fused = await fuseRisk(claim);
  Object.assign(claim, fused);
  claim.status = decideStatus(claim);

  await store.insert('claims', claim);
  await audit(req, 'claim.create', 'claim', claim.claimId, { riskScore: claim.riskScore });

  res.status(201).json({ claim, narrative: narrative(claim, { triggered: claim.triggeredRules }) });
}));

/** POST /api/claims/:id/rescore - re-run models on a stored claim */
router.post('/:id/rescore', authenticate, authorize('admin', 'investigator', 'analyst'), asyncHandler(async (req, res) => {
  const store = getStore();
  const claim = await store.findOne('claims', { claimId: req.params.id });
  if (!claim) throw new ApiError(404, 'Claim not found');
  const fused = await fuseRisk(claim, { explain: true });
  const updated = await store.updateOne('claims', { claimId: claim.claimId }, fused);
  await audit(req, 'claim.rescore', 'claim', claim.claimId, { riskScore: fused.riskScore });
  res.json({ claim: updated });
}));

/** PATCH /api/claims/:id/status - investigator workflow */
router.patch('/:id/status', authenticate, authorize('admin', 'investigator'), asyncHandler(async (req, res) => {
  const { status, assignedTo } = req.body;
  const allowed = ['pending', 'flagged', 'under_review', 'approved', 'rejected', 'paid'];
  if (status && !allowed.includes(status)) throw new ApiError(400, `status must be one of ${allowed.join(', ')}`);
  const store = getStore();
  const patch = {};
  if (status) patch.status = status;
  if (assignedTo !== undefined) patch.assignedTo = assignedTo;
  const updated = await store.updateOne('claims', { claimId: req.params.id }, patch);
  if (!updated) throw new ApiError(404, 'Claim not found');
  await audit(req, 'claim.status', 'claim', req.params.id, patch);
  res.json({ claim: updated });
}));

/** POST /api/claims/:id/notes */
router.post('/:id/notes', authenticate, asyncHandler(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (text.length < 3) throw new ApiError(400, 'Note text is required');
  const store = getStore();
  const updated = await store.pushToArray('claims', { claimId: req.params.id }, 'notes', {
    author: req.user.name, role: req.user.role, text, at: new Date().toISOString(),
  });
  if (!updated) throw new ApiError(404, 'Claim not found');
  res.json({ claim: updated });
}));

/**
 * Duplicate detection: compare the incoming claim with the same member's recent
 * claims at the same provider and score field-level similarity. This is what the
 * `R05_DUPLICATE` rule and the `duplicate_similarity` feature consume.
 */
async function findDuplicateSimilarity(store, { memberId, providerId, amountBilled, procedureCode, serviceDate }) {
  const recent = await store.find('claims', {
    memberId, providerId, serviceDate: { $gte: new Date(+serviceDate - 90 * 86400000) },
  }, { limit: 25, sort: { serviceDate: -1 } });
  if (!recent.length) return 0.02;

  let best = 0;
  for (const prior of recent) {
    let score = 0;
    const amtA = Number(amountBilled) || 0;
    const amtB = Number(prior.amountBilled) || 0;
    const amtSim = amtB > 0 ? 1 - Math.min(1, Math.abs(amtA - amtB) / Math.max(amtA, amtB)) : 0;
    if (amtSim > 0.92) score += 0.4;
    else if (amtSim > 0.75) score += 0.2;
    if (prior.procedureCode === procedureCode) score += 0.35;
    if (prior.claimType && procedureCode) score += 0.05;
    const dayGap = Math.abs((new Date(prior.serviceDate) - new Date(serviceDate)) / 86400000);
    if (dayGap <= 3) score += 0.2;
    else if (dayGap <= 14) score += 0.1;
    best = Math.max(best, score);
  }
  return Number(Math.min(0.99, Math.max(0.02, best)).toFixed(3));
}

function estimateDiagProcMatch(body, provider) {
  // Lightweight stand-in for the clinical coding engine: high-cost procedures
  // on a low-severity diagnosis code are flagged as weakly supported.
  const highCostTypes = ['inpatient', 'pharmacy'];
  if (body.amountBilled > 2.5 * (provider.peerAvgBilled || 1) && highCostTypes.includes(body.claimType)) return 0.55;
  return 0.94;
}

module.exports = router;
