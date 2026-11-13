/**
 * featureService.js
 * -----------------
 * Server-side feature engineering. This is the JavaScript twin of
 * ml-service/features.py - identical formulas, identical ordering, so a claim
 * scored by the Python service and a claim scored by the offline fallback agree.
 *
 * Keeping it here also lets the API show "what the model sees" for any claim,
 * which is essential for investigator trust and for the project report.
 */

const FEATURES = [
  'amount_billed', 'approved_ratio', 'billed_vs_peer_ratio', 'amount_zscore_specialty',
  'procedure_avg_cost_ratio', 'units_claimed', 'service_days', 'nights_in_hospital',
  'los_expected_ratio', 'num_procedures', 'prior_claims_30d_member',
  'member_claim_frequency_12m', 'provider_claims_30d', 'same_day_multiple_claims',
  'duplicate_similarity', 'diag_proc_match', 'age_service_mismatch',
  'diagnosis_severity_score', 'submission_lag_days', 'is_weekend_submission',
  'provider_specialty_risk', 'provider_license_age_years', 'provider_fraud_history',
  'provider_network_status', 'distance_member_provider_km', 'member_age',
  'member_chronic_conditions', 'policy_age_months', 'premium_to_billed_ratio',
  'claim_type_risk', 'is_emergency', 'pharmacy_qty_ratio',
];

const CLAIM_TYPE_RISK = {
  inpatient: 0.55, outpatient: 0.32, pharmacy: 0.61,
  laboratory: 0.47, dental: 0.25, vision: 0.15,
};

const SPECIALTY_RISK = {
  Cardiology: 0.55, Orthopedics: 0.62, Oncology: 0.58, Dermatology: 0.22,
  'General Medicine': 0.35, Radiology: 0.48, Pathology: 0.44, Pharmacy: 0.66,
  Dentistry: 0.28, Ophthalmology: 0.20, Neurology: 0.45, Gastroenterology: 0.40,
};

const EXPECTED_LOS = {
  inpatient: 4, outpatient: 1, pharmacy: 1, laboratory: 1, dental: 1, vision: 1,
};

const PROCEDURE_BENCHMARK = {
  Cardiology: 95000, Orthopedics: 120000, Oncology: 150000, Dermatology: 8000,
  'General Medicine': 15000, Radiology: 12000, Pathology: 4000, Pharmacy: 6000,
  Dentistry: 9000, Ophthalmology: 25000, Neurology: 60000, Gastroenterology: 45000,
};

const n = (v, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const div = (a, b, d = 0) => (Math.abs(n(b)) < 1e-9 ? d : clamp(n(a) / n(b), -1e6, 1e6));

/**
 * @param {object} claim raw claim document (camelCase as stored by Mongoose)
 * @returns {Record<string, number>} ordered feature vector
 */
function buildFeatures(claim) {
  const amount = n(claim.amountBilled);
  const specialty = claim.specialty || 'General Medicine';
  const claimType = claim.claimType || 'outpatient';
  const expectedLos = EXPECTED_LOS[claimType] ?? 1;
  const benchmark = PROCEDURE_BENCHMARK[specialty] ?? 30000;
  const std = n(claim.specialtyAmountStd, 25000) || 25000;

  return {
    amount_billed: Math.log1p(Math.max(amount, 0)),
    approved_ratio: div(claim.amountApproved, amount, 0.75),
    billed_vs_peer_ratio: div(amount, n(claim.providerAvgBilled, 20000), 1),
    amount_zscore_specialty: clamp((amount - n(claim.specialtyAmountMean, 30000)) / std, -10, 10),
    procedure_avg_cost_ratio: clamp(amount / benchmark, 0, 40),
    units_claimed: clamp(n(claim.unitsClaimed, 1), 0, 400),
    service_days: clamp(n(claim.serviceDays, 1), 0, 400),
    nights_in_hospital: clamp(n(claim.nightsInHospital, 0), 0, 400),
    los_expected_ratio: clamp((n(claim.serviceDays, 1) + 0.5) / (expectedLos + 0.5), 0, 60),
    num_procedures: clamp(n(claim.numProcedures, 1), 0, 60),
    prior_claims_30d_member: clamp(n(claim.priorClaims30d, 0), 0, 80),
    member_claim_frequency_12m: clamp(n(claim.memberClaims12m, 0), 0, 200),
    provider_claims_30d: clamp(n(claim.providerClaims30d, 0), 0, 3000),
    same_day_multiple_claims: clamp(n(claim.sameDayClaims, 0), 0, 20),
    duplicate_similarity: clamp(n(claim.duplicateSimilarity, 0), 0, 1),
    diag_proc_match: clamp(n(claim.diagProcMatch, 1), 0, 1),
    age_service_mismatch: clamp(n(claim.ageServiceMismatch, 0), 0, 1),
    diagnosis_severity_score: clamp(n(claim.diagnosisSeverity, 0.5), 0, 1),
    submission_lag_days: clamp(n(claim.submissionLagDays, 3), 0, 400),
    is_weekend_submission: clamp(n(claim.isWeekendSubmission, 0), 0, 1),
    provider_specialty_risk: SPECIALTY_RISK[specialty] ?? 0.4,
    provider_license_age_years: clamp(n(claim.providerLicenseAgeYears, 8), 0, 60),
    provider_fraud_history: clamp(n(claim.providerFraudHistory, 0), 0, 25),
    provider_network_status: clamp(n(claim.providerInNetwork, 1), 0, 1),
    distance_member_provider_km: clamp(n(claim.distanceKm, 12), 0, 3000),
    member_age: clamp(n(claim.memberAge, 40), 0, 110),
    member_chronic_conditions: clamp(n(claim.chronicConditions, 0), 0, 15),
    policy_age_months: clamp(n(claim.policyAgeMonths, 24), 0, 400),
    premium_to_billed_ratio: clamp(amount / Math.max(n(claim.annualPremium, 30000), 1), 0, 60),
    claim_type_risk: CLAIM_TYPE_RISK[claimType] ?? 0.4,
    is_emergency: clamp(n(claim.isEmergency, 0), 0, 1),
    pharmacy_qty_ratio: clamp((n(claim.pharmacyQty, 1) + 1) / (n(claim.pharmacyRefillDays, 30) + 1), 0, 30),
  };
}

/** Converts a stored claim back into the Python service's snake_case payload. */
function toMlPayload(claim) {
  return {
    claim_type: claim.claimType,
    specialty: claim.specialty,
    procedure_code: claim.procedureCode,
    diagnosis_code: claim.diagnosisCode,
    state: claim.state,
    plan_type: claim.planType,
    amount_billed: n(claim.amountBilled),
    amount_approved: n(claim.amountApproved),
    units_claimed: n(claim.unitsClaimed, 1),
    service_days: n(claim.serviceDays, 1),
    nights_in_hospital: n(claim.nightsInHospital, 0),
    num_procedures: n(claim.numProcedures, 1),
    prior_claims_30d: n(claim.priorClaims30d, 0),
    member_claims_12m: n(claim.memberClaims12m, 0),
    provider_claims_30d: n(claim.providerClaims30d, 0),
    same_day_claims: n(claim.sameDayClaims, 0),
    duplicate_similarity: n(claim.duplicateSimilarity, 0),
    diag_proc_match: n(claim.diagProcMatch, 1),
    age_service_mismatch: n(claim.ageServiceMismatch, 0),
    diagnosis_severity: n(claim.diagnosisSeverity, 0.45),
    submission_lag_days: n(claim.submissionLagDays, 3),
    is_weekend_submission: n(claim.isWeekendSubmission, 0),
    provider_license_age_years: n(claim.providerLicenseAgeYears, 10),
    provider_fraud_history: n(claim.providerFraudHistory, 0),
    provider_in_network: n(claim.providerInNetwork, 1),
    provider_avg_billed: n(claim.providerAvgBilled, 30000),
    distance_km: n(claim.distanceKm, 12),
    member_age: n(claim.memberAge, 40),
    chronic_conditions: n(claim.chronicConditions, 0),
    policy_age_months: n(claim.policyAgeMonths, 24),
    annual_premium: n(claim.annualPremium, 30000),
    is_emergency: n(claim.isEmergency, 0),
    pharmacy_qty: n(claim.pharmacyQty, 1),
    pharmacy_refill_days: n(claim.pharmacyRefillDays, 30),
    specialty_amount_mean: n(claim.specialtyAmountMean, 30000),
    specialty_amount_std: n(claim.specialtyAmountStd, 25000),
    explain: false,
  };
}

const FEATURE_LABELS = {
  amount_billed: 'Billed amount (log)', approved_ratio: 'Approved / billed ratio',
  billed_vs_peer_ratio: 'Billed vs provider peer average',
  amount_zscore_specialty: 'Amount vs specialty benchmark',
  procedure_avg_cost_ratio: 'Procedure cost vs benchmark', units_claimed: 'Units claimed',
  service_days: 'Service days', nights_in_hospital: 'Nights in hospital',
  los_expected_ratio: 'Length of stay vs expected', num_procedures: 'Number of procedures',
  prior_claims_30d_member: 'Member claims in last 30 days',
  member_claim_frequency_12m: 'Member claim frequency (12m)',
  provider_claims_30d: 'Provider claim volume (30d)',
  same_day_multiple_claims: 'Same-day multiple claims',
  duplicate_similarity: 'Duplicate claim similarity', diag_proc_match: 'Diagnosis-procedure consistency',
  age_service_mismatch: 'Age-service mismatch', diagnosis_severity_score: 'Diagnosis severity',
  submission_lag_days: 'Submission lag (days)', is_weekend_submission: 'Weekend submission',
  provider_specialty_risk: 'Provider specialty risk prior',
  provider_license_age_years: 'Provider licence age', provider_fraud_history: 'Provider fraud history',
  provider_network_status: 'In-network provider', distance_member_provider_km: 'Member-provider distance',
  member_age: 'Member age', member_chronic_conditions: 'Chronic conditions',
  policy_age_months: 'Policy age (months)', premium_to_billed_ratio: 'Billed vs annual premium',
  claim_type_risk: 'Claim type risk prior', is_emergency: 'Emergency admission',
  pharmacy_qty_ratio: 'Pharmacy quantity / refill ratio',
};

function riskLevel(p) {
  if (p >= 0.8) return 'critical';
  if (p >= 0.6) return 'high';
  if (p >= 0.35) return 'medium';
  if (p >= 0.15) return 'low';
  return 'minimal';
}

module.exports = {
  FEATURES, FEATURE_LABELS, CLAIM_TYPE_RISK, SPECIALTY_RISK, EXPECTED_LOS,
  PROCEDURE_BENCHMARK, buildFeatures, toMlPayload, riskLevel,
};
