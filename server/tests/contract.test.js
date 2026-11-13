/**
 * Data-contract tests.
 *
 * The ML service (Python) and the API (JavaScript) both implement the same
 * 32-feature specification. If they ever drift apart, every score silently
 * becomes wrong — the most dangerous possible bug in this system. These tests
 * pin the contract, and additionally assert that the seed dataset carries every
 * column the API reads.
 *
 *   cd server && npm test
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  FEATURES, FEATURE_LABELS, buildFeatures, toMlPayload, riskLevel,
} = require('../src/services/featureService');

const ML_DIR = path.join(__dirname, '..', '..', 'ml-service');

test('feature list matches the Python contract exactly, in order', () => {
  const py = fs.readFileSync(path.join(ML_DIR, 'features.py'), 'utf8');
  const start = py.indexOf('FEATURES: List[str] = [');
  // stop at the next top-level declaration, not at the first ']' (which sits
  // inside the List[str] annotation itself)
  const end = py.indexOf('CATEGORICAL_FEATURES', start);
  const block = py.slice(start, end);
  const pythonFeatures = [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(FEATURES, pythonFeatures,
    'featureService.js and features.py have diverged — models will mise-score');
});

test('buildFeatures returns every feature as a finite number', () => {
  const claim = {
    claimType: 'inpatient', specialty: 'Cardiology', amountBilled: 250000,
    amountApproved: 200000, unitsClaimed: 3, serviceDays: 5, nightsInHospital: 4,
    numProcedures: 2, providerAvgBilled: 95000, specialtyAmountMean: 95000,
  };
  const f = buildFeatures(claim);
  assert.deepEqual(Object.keys(f), FEATURES);
  for (const [k, v] of Object.entries(f)) {
    assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
  }
});

test('buildFeatures tolerates an empty / partial claim', () => {
  const f = buildFeatures({});
  assert.deepEqual(Object.keys(f), FEATURES);
  assert.ok(Object.values(f).every(Number.isFinite));
});

test('division by zero never leaks NaN or Infinity', () => {
  const f = buildFeatures({
    amountBilled: 0, amountApproved: 0, providerAvgBilled: 0,
    annualPremium: 0, pharmacyRefillDays: 0, specialtyAmountStd: 0,
  });
  assert.ok(Object.values(f).every(Number.isFinite), JSON.stringify(f));
});

test('every feature has a human-readable label', () => {
  for (const f of FEATURES) assert.ok(FEATURE_LABELS[f], `missing label for ${f}`);
});

test('toMlPayload emits the snake_case schema the FastAPI service validates', () => {
  const payload = toMlPayload({
    claimType: 'pharmacy', amountBilled: 1000, amountApproved: 800,
    unitsClaimed: 2, serviceDays: 1, nightsInHospital: 0, numProcedures: 1,
  });
  const required = [
    'claim_type', 'specialty', 'procedure_code', 'diagnosis_code', 'state', 'plan_type',
    'amount_billed', 'amount_approved', 'units_claimed', 'service_days', 'nights_in_hospital',
    'num_procedures', 'prior_claims_30d', 'member_claims_12m', 'provider_claims_30d',
    'same_day_claims', 'duplicate_similarity', 'diag_proc_match', 'age_service_mismatch',
    'diagnosis_severity', 'submission_lag_days', 'is_weekend_submission',
    'provider_license_age_years', 'provider_fraud_history', 'provider_in_network',
    'provider_avg_billed', 'distance_km', 'member_age', 'chronic_conditions',
    'policy_age_months', 'annual_premium', 'is_emergency', 'pharmacy_qty',
    'pharmacy_refill_days', 'specialty_amount_mean', 'specialty_amount_std', 'explain',
  ];
  for (const key of required) assert.ok(key in payload, `missing payload key ${key}`);
  // FastAPI's ClaimIn rejects unknown-free but requires these types
  assert.equal(typeof payload.amount_billed, 'number');
  assert.equal(payload.claim_type, 'pharmacy');
});

test('riskLevel bands are monotonic', () => {
  const levels = [0.01, 0.2, 0.4, 0.7, 0.9].map(riskLevel);
  assert.deepEqual(levels, ['minimal', 'low', 'medium', 'high', 'critical']);
});

test('seed dataset contains every column the seeder reads', { skip: !fs.existsSync(path.join(ML_DIR, 'data', 'claims.csv')) }, () => {
  const header = fs.readFileSync(path.join(ML_DIR, 'data', 'claims.csv'), 'utf8').split('\n')[0].split(',');
  const required = [
    'claim_id', 'service_date', 'submission_date', 'provider_id', 'provider_name',
    'specialty', 'state', 'city', 'provider_license_age_years', 'provider_fraud_history',
    'provider_in_network', 'provider_avg_billed', 'member_id', 'member_name', 'member_age',
    'plan_type', 'policy_age_months', 'chronic_conditions', 'annual_premium', 'claim_type',
    'procedure_code', 'diagnosis_code', 'diagnosis_severity', 'is_emergency', 'amount_billed',
    'amount_approved', 'units_claimed', 'service_days', 'nights_in_hospital', 'num_procedures',
    'prior_claims_30d', 'member_claims_12m', 'provider_claims_30d', 'same_day_claims',
    'duplicate_similarity', 'diag_proc_match', 'age_service_mismatch', 'submission_lag_days',
    'is_weekend_submission', 'distance_km', 'pharmacy_qty', 'pharmacy_refill_days',
    'specialty_amount_mean', 'specialty_amount_std', 'archetype', 'is_fraud', 'fraud_severity',
  ];
  for (const col of required) assert.ok(header.includes(col), `dataset missing column ${col}`);
});

test('exported linear model covers exactly the same features', { skip: !fs.existsSync(path.join(ML_DIR, 'models', 'linear_model_export.json')) }, () => {
  const exportData = JSON.parse(fs.readFileSync(path.join(ML_DIR, 'models', 'linear_model_export.json'), 'utf8'));
  assert.deepEqual(exportData.features, FEATURES,
    'linear_model_export.json features differ from featureService.js — offline fallback will be wrong');
  assert.equal(exportData.coef.length, FEATURES.length);
  assert.equal(exportData.mean.length, FEATURES.length);
  assert.equal(exportData.scale.length, FEATURES.length);
});

test('rule catalogue codes are unique and every rule has a weight', () => {
  const { ruleCatalogue } = require('../src/services/ruleEngine');
  const rules = ruleCatalogue();
  assert.ok(rules.length >= 15, `expected 15+ rules, got ${rules.length}`);
  const codes = rules.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate rule codes');
  for (const r of rules) assert.ok(r.weight > 0 && r.weight <= 20, `bad weight on ${r.code}`);
});

test('fusion weights sum to 1', () => {
  const { WEIGHTS } = require('../src/services/riskService');
  const total = WEIGHTS.model + WEIGHTS.rules + WEIGHTS.anomaly;
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});
