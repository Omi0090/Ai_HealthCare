/**
 * End-to-end API tests (node:test + supertest).
 *
 *   cd server && npm test
 *
 * These run against the JSON store with a temporary data file, so they never
 * touch a developer's MongoDB and can run in CI without any infrastructure.
 */
process.env.NODE_ENV = 'test';
process.env.FORCE_MEMORY = 'true';
process.env.DATA_FILE = `${require('os').tmpdir()}/medguard-test-${Date.now()}.json`;
process.env.JWT_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const bcrypt = require('bcryptjs');

const { initStore, getStore, closeStore } = require('../src/db/store');
const { app } = require('../src/index');

let token = '';
let claimId = '';
let api;

test.before(async () => {
  await initStore();
  const store = getStore();
  // minimal fixtures
  await store.insert('users', [{
    name: 'Test Admin', email: 'test@medguard.ai',
    passwordHash: await bcrypt.hash('Password123!', 10),
    role: 'admin', department: 'Test', active: true,
  }]);
  await store.insert('providers', [{
    providerId: 'PRV00001', name: 'Test Hospital', specialty: 'Cardiology',
    city: 'Pune', state: 'Maharashtra', inNetwork: true, fraudHistory: 0,
    peerAvgBilled: 60000, licenseAgeYears: 12, claimsCount: 90,
  }]);
  await store.insert('members', [{
    memberId: 'MEM00001', name: 'Test Member', age: 44, planType: 'Family Floater',
    policyAgeMonths: 30, chronicConditions: 1, annualPremium: 42000, claimsCount: 3,
  }]);
  api = request(app);
});

test.after(async () => {
  await closeStore();
  const fs = require('fs');
  try { fs.unlinkSync(process.env.DATA_FILE); } catch { /* ignore */ }
});

test('health endpoint reports database kind', async () => {
  const res = await api.get('/api/health').expect(200);
  assert.equal(res.body.status, 'ok');
  // getStore() exposes `kind`; the reported value is normalised for humans.
  assert.ok(['mongodb', 'json', 'memory'].includes(res.body.database),
    `unexpected database kind: ${res.body.database}`);
});

test('login rejects bad password and accepts good one', async () => {
  await api.post('/api/auth/login')
    .send({ email: 'test@medguard.ai', password: 'wrong' }).expect(401);

  const res = await api.post('/api/auth/login')
    .send({ email: 'test@medguard.ai', password: 'Password123!' }).expect(200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.role, 'admin');
  token = res.body.token;
});

test('protected routes require a token', async () => {
  await api.get('/api/claims').expect(401);
  await api.get('/api/dashboard/overview').expect(401);
});

test('submitting a claim scores it and persists it', async () => {
  const res = await api.post('/api/claims')
    .set('Authorization', `Bearer ${token}`)
    .send({
      providerId: 'PRV00001', memberId: 'MEM00001', claimType: 'inpatient',
      procedureCode: 'Coronary angioplasty', diagnosisCode: 'I25',
      serviceDate: new Date().toISOString().slice(0, 10),
      amountBilled: 780000, amountApproved: 770000, unitsClaimed: 30,
      serviceDays: 40, nightsInHospital: 39, numProcedures: 15,
    })
    .expect(201);

  claimId = res.body.claim.claimId;
  assert.match(claimId, /^CLM-\d{4}-\d{6}$/);
  assert.ok(res.body.claim.riskScore > 50, 'a blatant claim should score high');
  assert.equal(res.body.claim.isFlagged, true);
  assert.ok(res.body.claim.triggeredRules.length >= 3);
});

test('claim detail exposes features, rules and a narrative', async () => {
  const res = await api.get(`/api/claims/${claimId}`)
    .set('Authorization', `Bearer ${token}`).expect(200);
  assert.ok(res.body.claim);
  assert.equal(Object.keys(res.body.features).length, 32);
  assert.ok(res.body.ruleEvaluation.triggered.length >= 3);
  assert.ok(res.body.narrative.includes(claimId));
});

test('unknown claim returns 404', async () => {
  await api.get('/api/claims/CLM-0000-000000')
    .set('Authorization', `Bearer ${token}`).expect(404);
});

test('preview does not persist a claim', async () => {
  const before = await getStore().count('claims', {});
  const res = await api.post('/api/claims/preview')
    .set('Authorization', `Bearer ${token}`)
    .send({
      providerId: 'PRV00001', memberId: 'MEM00001', claimType: 'outpatient',
      procedureCode: 'Consultation', diagnosisCode: 'I10',
      serviceDate: new Date().toISOString().slice(0, 10), amountBilled: 3000,
    }).expect(200);
  const after = await getStore().count('claims', {});
  assert.equal(before, after);
  assert.equal(res.body.claimId, 'PREVIEW');
  assert.ok(typeof res.body.fraudProbability === 'number');
});

test('invalid claim payloads are rejected', async () => {
  await api.post('/api/claims')
    .set('Authorization', `Bearer ${token}`)
    .send({ providerId: 'PRV00001' }).expect(400);
});

test('claim status transitions are validated', async () => {
  await api.patch(`/api/claims/${claimId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'nonsense' }).expect(400);

  const res = await api.patch(`/api/claims/${claimId}/status`)
    .set('Authorization', `Bearer ${token}`)
    .send({ status: 'under_review' }).expect(200);
  assert.equal(res.body.claim.status, 'under_review');
});

test('opening a case from a claim updates the claim and blocks duplicates', async () => {
  const res = await api.post('/api/cases')
    .set('Authorization', `Bearer ${token}`)
    .send({ claimId }).expect(201);
  assert.match(res.body.case.caseNumber, /^CASE-\d{4}-\d{4}$/);

  await api.post('/api/cases')
    .set('Authorization', `Bearer ${token}`)
    .send({ claimId }).expect(409);

  const claim = await api.get(`/api/claims/${claimId}`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(claim.body.claim.status, 'under_review');
});

test('closing a case with confirmed fraud increments provider history', async () => {
  const cases = await api.get('/api/cases').set('Authorization', `Bearer ${token}`);
  const caseNumber = cases.body.cases[0].caseNumber;

  await api.patch(`/api/cases/${caseNumber}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ decision: 'confirmed_fraud', recoverableAmount: 500000, status: 'closed' })
    .expect(200);

  const provider = await getStore().findOne('providers', { providerId: 'PRV00001' });
  assert.equal(provider.fraudHistory, 1);
  assert.equal(provider.onWatchlist, true);
});

test('dashboard overview aggregates the portfolio', async () => {
  const res = await api.get('/api/dashboard/overview')
    .set('Authorization', `Bearer ${token}`).expect(200);
  assert.equal(res.body.kpis.totalClaims, 1);
  assert.ok(Array.isArray(res.body.riskDistribution));
});

test('audit trail records privileged actions', async () => {
  const res = await api.get('/api/admin/audit')
    .set('Authorization', `Bearer ${token}`).expect(200);
  const actions = res.body.logs.map((l) => l.action);
  assert.ok(actions.includes('auth.login'));
  assert.ok(actions.includes('claim.create'));
  assert.ok(actions.includes('case.update'));
});

test('viewer role cannot mutate claims', async () => {
  const viewer = await api.post('/api/auth/register')
    .send({ name: 'Viewer', email: 'viewer@test.ai', password: 'Password123!', role: 'viewer' })
    .expect(201);
  // The very first user in a fresh DB becomes admin, so re-login as admin and
  // demote explicitly, then check the guard.
  await api.patch(`/api/auth/users/${viewer.body.user.id}`)
    .set('Authorization', `Bearer ${token}`).send({ role: 'viewer' }).expect(200);

  const relog = await api.post('/api/auth/login')
    .send({ email: 'viewer@test.ai', password: 'Password123!' }).expect(200);

  const full = {
    providerId: 'PRV00001', memberId: 'MEM00001', claimType: 'outpatient',
    procedureCode: 'Consultation', diagnosisCode: 'I10',
    serviceDate: new Date().toISOString().slice(0, 10), amountBilled: 2000,
  };
  await api.post('/api/claims')
    .set('Authorization', `Bearer ${relog.body.token}`).send(full).expect(403);
});

/* ------------------------------------------------------------------ *
 * Explanations
 *
 * The claim page's default tab is the Shapley waterfall. A flagged claim
 * without a stored explanation renders an empty panel, which is exactly the
 * bug this guards against: seeding must explain the claims an investigator
 * opens, and anything else must be explainable on demand.
 * ------------------------------------------------------------------ */

test('flagged claims carry a stored Shapley explanation', async () => {
  const res = await api.get('/api/claims?flagged=true&limit=5')
    .set('Authorization', `Bearer ${token}`).expect(200);

  assert.ok(res.body.claims.length > 0, 'expected flagged claims in the ledger');
  for (const c of res.body.claims) {
    assert.ok(c.explanation, `claim ${c.claimId} has no explanation`);
    assert.ok(Array.isArray(c.explanation.top_features) && c.explanation.top_features.length > 0);
    assert.ok(Number.isFinite(c.explanation.base_value));
  }
});

test('flagged claims in aggregate are all explained', async () => {
  const res = await api.get('/api/claims?flagged=true&limit=200&sort=riskScore&order=desc')
    .set('Authorization', `Bearer ${token}`).expect(200);
  const missing = res.body.claims.filter((c) => !c.explanation).map((c) => c.claimId);
  assert.deepEqual(missing, [], `unexplained flagged claims: ${missing.slice(0, 5).join(', ')}`);
});

test('GET /:id/explain returns an additive attribution for any claim', async () => {
  // pick a *cleared* claim - these are deliberately not pre-explained at seed time
  const cleared = await api.get('/api/claims?flagged=false&limit=1')
    .set('Authorization', `Bearer ${token}`).expect(200);
  const target = cleared.body.claims[0];
  assert.ok(target, 'expected at least one cleared claim');

  const res = await api.get(`/api/claims/${target.claimId}/explain`)
    .set('Authorization', `Bearer ${token}`).expect(200);

  const e = res.body.explanation;
  assert.ok(e && Array.isArray(e.top_features) && e.top_features.length > 0);

  // The efficiency property of Shapley values: every contribution, including the
  // tail lumped into `other_features_contribution`, must reconstruct the score.
  const shown = e.top_features.reduce((a, f) => a + f.contribution, 0);
  const total = shown + (e.other_features_contribution || 0);
  const reconstructed = e.base_value + total;
  assert.ok(Math.abs(reconstructed - e.claim_logit) < 0.01,
    `attributions do not reconstruct the score: ${e.base_value} + ${total} != ${e.claim_logit}`);
  assert.ok(e.top_features.length + e.other_feature_count === e.feature_count,
    'shown + leftover features must cover the whole feature vector');
});

test('explanation endpoint 404s for an unknown claim', async () => {
  await api.get('/api/claims/CLM-0000-000000/explain')
    .set('Authorization', `Bearer ${token}`).expect(404);
});
