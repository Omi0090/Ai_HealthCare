const express = require('express');
const { getStore } = require('../db/store');
const { ApiError, asyncHandler, authenticate, authorize, audit } = require('../middleware/auth');

const router = express.Router();

/** GET /api/cases */
router.get('/', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;
  if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
  const cases = await store.find('cases', filter, { limit: 300, sort: { createdAt: -1 } });
  res.json({ cases, total: cases.length });
}));

/** POST /api/cases - open an investigation from a flagged claim */
router.post('/', authenticate, authorize('admin', 'investigator'), asyncHandler(async (req, res) => {
  const store = getStore();
  const claimId = req.body.claimId;
  if (!claimId) throw new ApiError(400, 'claimId is required');
  const claim = await store.findOne('claims', { claimId });
  if (!claim) throw new ApiError(404, 'Claim not found');

  const existing = await store.findOne('cases', { claimId, status: { $in: ['open', 'investigating', 'escalated'] } });
  if (existing) throw new ApiError(409, `An open case already exists (${existing.caseNumber})`);

  const count = await store.count('cases', {});
  const caseNumber = `CASE-${new Date().getFullYear()}-${String(count + 1).padStart(4, '0')}`;
  const priority = claim.riskLevel === 'critical' ? 'critical' : claim.riskLevel === 'high' ? 'high'
    : claim.riskLevel === 'medium' ? 'medium' : 'low';

  const doc = {
    caseNumber,
    claimId,
    providerId: claim.providerId,
    memberId: claim.memberId,
    amountBilled: claim.amountBilled,
    riskScore: claim.riskScore,
    priority,
    status: 'open',
    assignedTo: req.body.assignedTo || req.user.name,
    decision: 'pending',
    recoverableAmount: 0,
    findings: req.body.findings || '',
    timeline: [{ at: new Date().toISOString(), actor: req.user.name, event: 'Case opened from claim ' + claimId }],
    openedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  await store.insert('cases', doc);
  await store.updateOne('claims', { claimId }, { status: 'under_review', assignedTo: doc.assignedTo });
  await audit(req, 'case.create', 'case', caseNumber, { claimId, priority });

  res.status(201).json({ case: doc });
}));

/** PATCH /api/cases/:caseNumber - update status, decision, findings */
router.patch('/:caseNumber', authenticate, authorize('admin', 'investigator'), asyncHandler(async (req, res) => {
  const store = getStore();
  const existing = await store.findOne('cases', { caseNumber: req.params.caseNumber });
  if (!existing) throw new ApiError(404, 'Case not found');

  const patch = {};
  for (const key of ['status', 'decision', 'findings', 'assignedTo', 'priority', 'recoverableAmount']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  }
  if (patch.status === 'closed') patch.closedAt = new Date().toISOString();

  const event = {
    at: new Date().toISOString(),
    actor: req.user.name,
    event: `Updated ${Object.keys(patch).filter((k) => k !== 'closedAt').join(', ')}`,
    changes: patch,
  };
  const updated = await store.updateOne('cases', { caseNumber: req.params.caseNumber }, {
    ...patch,
    timeline: [...(existing.timeline || []), event],
  });

  // Reflect the decision back onto the claim and the provider's fraud history
  if (patch.decision && patch.decision !== 'pending') {
    const claimStatus = patch.decision === 'confirmed_fraud' ? 'rejected'
      : patch.decision === 'false_positive' ? 'approved' : 'under_review';
    await store.updateOne('claims', { claimId: existing.claimId }, { status: claimStatus });
    if (patch.decision === 'confirmed_fraud' && existing.providerId) {
      const provider = await store.findOne('providers', { providerId: existing.providerId });
      if (provider) {
        await store.updateOne('providers', { providerId: existing.providerId }, {
          fraudHistory: (provider.fraudHistory || 0) + 1,
          onWatchlist: true,
        });
      }
    }
  }
  await audit(req, 'case.update', 'case', req.params.caseNumber, patch);
  res.json({ case: updated });
}));

/** GET /api/cases/:caseNumber */
router.get('/:caseNumber', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const doc = await store.findOne('cases', { caseNumber: req.params.caseNumber });
  if (!doc) throw new ApiError(404, 'Case not found');
  const claim = await store.findOne('claims', { claimId: doc.claimId });
  const provider = doc.providerId ? await store.findOne('providers', { providerId: doc.providerId }) : null;
  const member = doc.memberId ? await store.findOne('members', { memberId: doc.memberId }) : null;
  res.json({ case: doc, claim, provider, member });
}));

module.exports = router;
