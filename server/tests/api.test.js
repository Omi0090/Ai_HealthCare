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
