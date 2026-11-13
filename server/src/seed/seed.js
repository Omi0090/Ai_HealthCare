/**
 * seed.js
 * -------
 * Loads the synthetic payer ledger into the database, scores every claim with
 * the ML ensemble, runs the rule engine, opens investigation cases for the
 * highest-risk claims and creates demo user accounts.
 *
 *   node src/seed/seed.js            # seed (idempotent: clears prior demo data)
 *   node src/seed/seed.js --limit 600   # smaller portfolio for a quick demo
 *
 * Requires ml-service/data/claims.csv (see ml-service/data/generate_dataset.py)
 * and ml-service/models/ (see train_models.py). If the ML service is offline the
 * seeder still works - mlService falls back to the exported linear model.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const { initStore, getStore, closeStore } = require('../db/store');
const ml = require('../services/mlService');
const { evaluateRules } = require('../services/ruleEngine');
const { fuseRisk, decideStatus, DECISIVE_RULES } = require('../services/riskService');
const { riskLevel: riskLevelOf } = require('../services/featureService');

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : 0;
})();

/* ------------------------------------------------------------ CSV parser */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') {
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((c) => c !== '')) rows.push(row); }
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (v, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

/* ------------------------------------------------ dataset -> documents */
function buildProviderDocs(rows) {
  const map = new Map();
  for (const r of rows) {
    if (map.has(r.provider_id)) continue;
    map.set(r.provider_id, {
      providerId: r.provider_id,
      name: r.provider_name,
      specialty: r.specialty,
      city: r.city,
      state: r.state,
      licenseNumber: `LIC-${r.provider_id.slice(-5)}`,
      licenseAgeYears: num(r.provider_license_age_years),
      inNetwork: num(r.provider_in_network) === 1,
      fraudHistory: num(r.provider_fraud_history),
      peerAvgBilled: num(r.provider_avg_billed),
      benchmarkCost: num(r.specialty_amount_mean),
      ringMember: false,
      onWatchlist: num(r.provider_fraud_history) > 0,
      riskScore: 0,
      claimsCount: 0,
      flaggedCount: 0,
      billedTotal: 0,
      approvedTotal: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return [...map.values()];
}

function buildMemberDocs(rows) {
  const map = new Map();
  for (const r of rows) {
    if (map.has(r.member_id)) continue;
    map.set(r.member_id, {
      memberId: r.member_id,
      name: `${r.member_name}`,
      age: num(r.member_age),
      gender: num(r.member_age) % 2 ? 'Female' : 'Male',
      city: r.city,
      state: r.state,
      planType: r.plan_type,
      policyAgeMonths: num(r.policy_age_months),
      chronicConditions: num(r.chronic_conditions),
      annualPremium: num(r.annual_premium),
      ringMember: false,
      riskScore: 0,
      claimsCount: 0,
      flaggedCount: 0,
      createdAt: new Date().toISOString(),
    });
  }
  return [...map.values()];
}

function buildClaimDoc(r) {
  const serviceDate = new Date(r.service_date);
  const submissionDate = new Date(r.submission_date);
  return {
    claimId: r.claim_id,
    providerId: r.provider_id,
    providerName: r.provider_name,
    memberId: r.member_id,
    memberName: r.member_name,
    claimType: r.claim_type,
    specialty: r.specialty,
    procedureCode: r.procedure_code,
    diagnosisCode: r.diagnosis_code,
    planType: r.plan_type,
    state: r.state,
    serviceDate: serviceDate.toISOString(),
    submissionDate: submissionDate.toISOString(),
    amountBilled: num(r.amount_billed),
    amountApproved: num(r.amount_approved),
    unitsClaimed: num(r.units_claimed, 1),
    serviceDays: num(r.service_days, 1),
    nightsInHospital: num(r.nights_in_hospital, 0),
    numProcedures: num(r.num_procedures, 1),
    priorClaims30d: num(r.prior_claims_30d),
    memberClaims12m: num(r.member_claims_12m),
    providerClaims30d: num(r.provider_claims_30d),
    sameDayClaims: num(r.same_day_claims),
    duplicateSimilarity: num(r.duplicate_similarity),
    diagProcMatch: num(r.diag_proc_match, 1),
    ageServiceMismatch: num(r.age_service_mismatch),
    diagnosisSeverity: num(r.diagnosis_severity, 0.45),
    submissionLagDays: num(r.submission_lag_days),
    isWeekendSubmission: num(r.is_weekend_submission),
    providerLicenseAgeYears: num(r.provider_license_age_years),
    providerFraudHistory: num(r.provider_fraud_history),
    providerInNetwork: num(r.provider_in_network, 1),
    providerAvgBilled: num(r.provider_avg_billed),
    distanceKm: num(r.distance_km),
    memberAge: num(r.member_age),
    chronicConditions: num(r.chronic_conditions),
    policyAgeMonths: num(r.policy_age_months),
    annualPremium: num(r.annual_premium),
    isEmergency: num(r.is_emergency),
    pharmacyQty: num(r.pharmacy_qty, 1),
    pharmacyRefillDays: num(r.pharmacy_refill_days, 30),
    specialtyAmountMean: num(r.specialty_amount_mean),
    specialtyAmountStd: num(r.specialty_amount_std),
    status: 'pending',
    notes: [],
    groundTruth: {
      isFraud: num(r.is_fraud) === 1,
      archetype: r.archetype,
      severity: num(r.fraud_severity),
    },
    createdAt: new Date().toISOString(),
  };
}

/* ---------------------------------------------------------------- main */
async function main() {
  const csvPath = process.env.CLAIMS_CSV
    || path.join(__dirname, '..', '..', '..', 'ml-service', 'data', 'claims.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`[seed] dataset not found at ${csvPath}`);
    console.error('[seed] run:  cd ml-service && python data/generate_dataset.py');
    process.exit(1);
  }

  console.log('[seed] initialising database...');
  await initStore();
  const store = getStore();
  const health = await ml.checkHealth();
  console.log(`[seed] ML service: ${health.reachable ? 'online' : 'offline -> using exported linear model'}`);

  let rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  // Deterministic shuffle then truncate so demos are reproducible
  if (LIMIT) {
    let seed = 12345;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    rows = rows.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).slice(0, LIMIT).map((x) => x.r);
  }
  console.log(`[seed] loaded ${rows.length} claims from dataset`);

  // ---- wipe previous demo data -------------------------------------------
  for (const c of ['claims', 'providers', 'members', 'cases', 'auditlogs', 'alertrules']) {
    await store.deleteMany(c, {});
  }
  const keepUsers = args.includes('--keep-users');
  if (!keepUsers) await store.deleteMany('users', {});

  // ---- reference data -----------------------------------------------------
  const providers = buildProviderDocs(rows);
  const members = buildMemberDocs(rows);
  await store.insert('providers', providers);
  await store.insert('members', members);
  console.log(`[seed] inserted ${providers.length} providers, ${members.length} members`);

  // ---- users --------------------------------------------------------------
  if (!keepUsers) {
    const passwordHash = await bcrypt.hash('MedGuard@2024', 12);
    const users = [
      { name: 'Dr. Ananya Deshpande', email: 'admin@medguard.ai', passwordHash, role: 'admin', department: 'Fraud Analytics', active: true },
      { name: 'Rohit Kulkarni', email: 'investigator@medguard.ai', passwordHash, role: 'investigator', department: 'Special Investigation Unit', active: true },
      { name: 'Priya Nair', email: 'analyst@medguard.ai', passwordHash, role: 'analyst', department: 'Claims Analytics', active: true },
      { name: 'Vikram Rao', email: 'viewer@medguard.ai', passwordHash, role: 'viewer', department: 'Audit & Compliance', active: true },
    ];
    await store.insert('users', users);
    console.log('[seed] created 4 demo users (password: MedGuard@2024)');
  }

  // ---- score every claim --------------------------------------------------
  const docs = rows.map(buildClaimDoc);
  console.log(`[seed] scoring ${docs.length} claims with the ensemble...`);
  const t0 = Date.now();
  const scored = await ml.scoreClaims(docs);
  console.log(`[seed] scored in ${((Date.now() - t0) / 1000).toFixed(1)}s via ${scored[0]?.source}`);

  const flaggedIdx = [];
  const finalClaims = docs.map((doc, i) => {
    const s = scored[i] || { fraudProbability: 0, riskScore: 0, riskLevel: 'minimal', anomalyScore: 0, source: 'unknown' };
    const rules = evaluateRules(doc);
    // Same fusion formula as services/riskService.js - keep them in sync.
    let fused = 0.6 * (s.fraudProbability || 0) + 0.3 * rules.score + 0.1 * (s.anomalyScore || 0);
    const modelVals = Object.values(s.probaByModel || {}).map(Number).filter(Number.isFinite);
    if (modelVals.length >= 2 && modelVals.every((v) => v >= 0.7)) fused = Math.min(1, fused + 0.04);
    const decisive = rules.triggered.filter((t) => DECISIVE_RULES.has(t.code));
    let risk = fused;
    if (decisive.length >= 2) risk = Math.max(risk, 0.82);
    else if (decisive.length === 1 && rules.triggered.length >= 2) risk = Math.max(risk, 0.66);
    risk = Math.max(0, Math.min(1, risk));

    const claim = {
      ...doc,
      fraudProbability: Number((s.fraudProbability || 0).toFixed(4)),
      anomalyScore: Number((s.anomalyScore || 0).toFixed(4)),
      ruleScore: rules.score,
      riskScore: Math.round(risk * 100),
      riskLevel: riskLevelOf(risk),
      isFlagged: risk >= Number(process.env.FLAG_THRESHOLD || 0.55),
      triggeredRules: rules.triggered,
      modelScores: s.probaByModel,
      explanation: s.explanation || null,
      scoringSource: s.source,
      modelVersion: 'v1.0.0',
      scoredAt: new Date().toISOString(),
      status: 'pending',
    };
    claim.status = decideStatus(claim);
    if (claim.isFlagged) flaggedIdx.push(i);
    return claim;
  });

  // insert in chunks to keep memory sane
  for (let i = 0; i < finalClaims.length; i += 400) {
    await store.insert('claims', finalClaims.slice(i, i + 400));
    process.stdout.write(`\r[seed] inserted ${Math.min(i + 400, finalClaims.length)}/${finalClaims.length} claims`);
  }
  process.stdout.write('\n');

  // ---- aggregate provider / member stats ---------------------------------
  const byProvider = new Map();
  const byMember = new Map();
  for (const c of finalClaims) {
    const p = byProvider.get(c.providerId) || { claims: 0, flagged: 0, billed: 0, approved: 0, risk: 0 };
    p.claims += 1; p.flagged += c.isFlagged ? 1 : 0;
    p.billed += c.amountBilled; p.approved += c.amountApproved; p.risk += c.riskScore;
    byProvider.set(c.providerId, p);

    const m = byMember.get(c.memberId) || { claims: 0, flagged: 0, billed: 0, risk: 0 };
    m.claims += 1; m.flagged += c.isFlagged ? 1 : 0; m.billed += c.amountBilled; m.risk += c.riskScore;
    byMember.set(c.memberId, m);
  }
  for (const [providerId, s] of byProvider) {
    await store.updateOne('providers', { providerId }, {
      claimsCount: s.claims, flaggedCount: s.flagged, billedTotal: s.billed,
      approvedTotal: s.approved, riskScore: Math.round(s.risk / Math.max(s.claims, 1)),
    });
  }
  for (const [memberId, s] of byMember) {
    await store.updateOne('members', { memberId }, {
      claimsCount: s.claims, flaggedCount: s.flagged, riskScore: Math.round(s.risk / Math.max(s.claims, 1)),
    });
  }

  // Case numbers use the ledger's own year so the demo reads consistently
  // (the dataset covers 2024-2025; take the year of the newest claim).
  const ledgerYear = finalClaims.reduce((y, c) => {
    const t = new Date(c.serviceDate);
    return Number.isNaN(+t) ? y : Math.max(y, t.getUTCFullYear());
  }, 0) || new Date().getUTCFullYear();

  // ---- open cases for the worst offenders ---------------------------------
  const worst = finalClaims.filter((c) => c.isFlagged)
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 45);
  const investigators = ['Rohit Kulkarni', 'Dr. Ananya Deshpande', 'Priya Nair'];
  const caseDocs = worst.map((c, i) => ({
    caseNumber: `CASE-${ledgerYear}-${String(i + 1).padStart(4, '0')}`,
    claimId: c.claimId,
    providerId: c.providerId,
    memberId: c.memberId,
    amountBilled: c.amountBilled,
    riskScore: c.riskScore,
    priority: c.riskLevel === 'critical' ? 'critical' : c.riskLevel === 'high' ? 'high' : 'medium',
    status: i < 12 ? 'investigating' : 'open',
    assignedTo: investigators[i % investigators.length],
    decision: 'pending',
    recoverableAmount: 0,
    findings: '',
    timeline: [{ at: new Date().toISOString(), actor: 'system', event: `Auto-opened from ${c.claimId} at risk score ${c.riskScore}` }],
    openedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }));
  await store.insert('cases', caseDocs);
  console.log(`[seed] opened ${caseDocs.length} investigation cases`);

  // ---- summary ------------------------------------------------------------
  const flagged = finalClaims.filter((c) => c.isFlagged).length;
  const truePos = finalClaims.filter((c) => c.isFlagged && c.groundTruth.isFraud).length;
  const actualFraud = finalClaims.filter((c) => c.groundTruth.isFraud).length;
  console.log('\n================ SEED COMPLETE ================');
  console.log(`  claims            : ${finalClaims.length}`);
  console.log(`  actually fraudulent: ${actualFraud} (${((actualFraud / finalClaims.length) * 100).toFixed(1)}%)`);
  console.log(`  flagged by system : ${flagged} (${((flagged / finalClaims.length) * 100).toFixed(1)}%)`);
  console.log(`  true positives    : ${truePos}`);
  console.log(`  precision         : ${((truePos / Math.max(flagged, 1)) * 100).toFixed(1)}%`);
  console.log(`  recall            : ${((truePos / Math.max(actualFraud, 1)) * 100).toFixed(1)}%`);
  console.log('  login: admin@medguard.ai / MedGuard@2024');
  console.log('===============================================\n');

  await closeStore();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[seed] failed:', err);
  await closeStore();
  process.exit(1);
});
