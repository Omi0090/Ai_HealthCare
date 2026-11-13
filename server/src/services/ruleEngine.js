/**
 * ruleEngine.js
 * -------------
 * The deterministic half of the platform.
 *
 * Machine-learning models are probabilistic and can be wrong in opaque ways;
 * payers therefore run an explicit red-flag rule set alongside the model. Every
 * rule here is inspectable, has a weight, and cites the scheme it targets - the
 * same pattern used by commercial SIU platforms (and by CMS/NABH audit
 * guidance). The rules power:
 *   - the human-readable "why was this flagged?" panel
 *   - a second, independent risk signal that is fused with the model score
 *   - the rule-performance dashboard (lift, capture, precision per rule)
 *
 * The rule set and weights are seeded into the `alertrules` collection so an
 * investigator can tune them at runtime from the Admin screen.
 */

const DEFAULT_RULES = [
  {
    code: 'R01_AMOUNT_PEER',
    name: 'Billed far above provider peer average',
    category: 'Billing anomaly',
    weight: 14,
    target: 'upcoding, phantom_billing',
    test: (c) => c.amountBilled > 2.0 * (c.providerAvgBilled || 30000),
    detail: (c) => `Billed ₹${fmt(c.amountBilled)} vs peer average ₹${fmt(c.providerAvgBilled)} ` +
      `(${(c.amountBilled / Math.max(c.providerAvgBilled, 1)).toFixed(1)}x)`,
  },
  {
    code: 'R02_AMOUNT_BENCHMARK',
    name: 'Billed above specialty benchmark',
    category: 'Billing anomaly',
    weight: 12,
    target: 'upcoding',
    test: (c) => c.amountBilled > 3.0 * (c.specialtyAmountMean || 30000),
    detail: (c) => `Billed ₹${fmt(c.amountBilled)} vs specialty mean ` +
      `₹${fmt(c.specialtyAmountMean)} (${(c.amountBilled / Math.max(c.specialtyAmountMean, 1)).toFixed(1)}x)`,
  },
  {
    code: 'R03_UNITS',
    name: 'Excessive units claimed',
    category: 'Utilisation',
    weight: 12,
    target: 'phantom_billing, unbundling',
    test: (c) => (c.unitsClaimed || 0) > 15,
    detail: (c) => `${c.unitsClaimed} units claimed for a single encounter (threshold 15)`,
  },
  {
    code: 'R04_LOS',
    name: 'Length of stay inconsistent with diagnosis',
    category: 'Utilisation',
    weight: 11,
    target: 'los_inflation',
    test: (c) => (c.serviceDays || 0) > 12 || ((c.serviceDays || 0) > 6 && (c.diagnosisSeverity || 0) < 0.3),
    detail: (c) => `${c.serviceDays} service days with diagnosis severity ${(c.diagnosisSeverity || 0).toFixed(2)}`,
  },
  {
    code: 'R05_DUPLICATE',
    name: 'Near-duplicate of an existing claim',
    category: 'Duplication',
    weight: 18,
    target: 'duplicate_billing',
    test: (c) => (c.duplicateSimilarity || 0) > 0.85,
    detail: (c) => `${((c.duplicateSimilarity || 0) * 100).toFixed(0)}% field similarity to a prior claim`,
  },
  {
    code: 'R06_DIAG_PROC',
    name: 'Diagnosis-procedure mismatch',
    category: 'Clinical consistency',
    weight: 12,
    target: 'upcoding, unbundling',
    test: (c) => (c.diagProcMatch ?? 1) < 0.55,
    detail: (c) => `Procedure "${c.procedureCode}" poorly supported by diagnosis "${c.diagnosisCode}" ` +
      `(match ${((c.diagProcMatch || 0) * 100).toFixed(0)}%)`,
  },
  {
    code: 'R07_PROVIDER_HISTORY',
    name: 'Provider has prior fraud history',
    category: 'Provider risk',
    weight: 9,
    target: 'collusion_ring, phantom_billing',
    test: (c) => (c.providerFraudHistory || 0) > 0,
    detail: (c) => `Provider ${c.providerId} has ${c.providerFraudHistory} previous adverse finding(s)`,
  },
  {
    code: 'R08_OUT_NETWORK',
    name: 'Out-of-network provider',
    category: 'Provider risk',
    weight: 7,
    target: 'collusion_ring',
    test: (c) => Number(c.providerInNetwork) === 0,
    detail: () => 'Provider is outside the payer network - manual verification required',
  },
  {
    code: 'R09_SAME_DAY',
    name: 'Multiple claims same day, same member',
    category: 'Utilisation',
    weight: 10,
    target: 'collusion_ring, duplicate_billing',
    test: (c) => (c.sameDayClaims || 0) > 3,
    detail: (c) => `${c.sameDayClaims} claims submitted for this member on the service date`,
  },
  {
    code: 'R10_LATE_SUBMIT',
    name: 'Late submission beyond policy window',
    category: 'Process',
    weight: 6,
    target: 'phantom_billing',
    test: (c) => (c.submissionLagDays || 0) > 30,
    detail: (c) => `Submitted ${c.submissionLagDays} days after service (window: 30)`,
  },
  {
    code: 'R11_FREQUENCY',
    name: 'Abnormal member claim frequency',
    category: 'Utilisation',
    weight: 9,
    target: 'collusion_ring',
    test: (c) => (c.priorClaims30d || 0) > 3 || (c.memberClaims12m || 0) > 12,
    detail: (c) => `${c.priorClaims30d} claims in 30 days, ${c.memberClaims12m} in 12 months`,
  },
  {
    code: 'R12_NEW_POLICY',
    name: 'Claim on a very new policy (waiting period)',
    category: 'Policy',
    weight: 8,
    target: 'identity_misuse',
    test: (c) => (c.policyAgeMonths ?? 24) < 6,
    detail: (c) => `Policy is only ${c.policyAgeMonths} month(s) old`,
  },
  {
    code: 'R13_HIGH_APPROVAL',
    name: 'Approved ratio atypically high',
    category: 'Billing anomaly',
    weight: 8,
    target: 'upcoding, phantom_billing',
    test: (c) => (c.amountBilled || 0) > 0 && (c.amountApproved || 0) / c.amountBilled > 0.95 && c.amountBilled > 50000,
    detail: (c) => `${(((c.amountApproved || 0) / Math.max(c.amountBilled, 1)) * 100).toFixed(0)}% of a large claim approved automatically`,
  },
  {
    code: 'R14_DISTANCE',
    name: 'Member treated far from home',
    category: 'Provider risk',
    weight: 7,
    target: 'collusion_ring',
    test: (c) => (c.distanceKm || 0) > 200,
    detail: (c) => `${Math.round(c.distanceKm)} km between member residence and provider`,
  },
  {
    code: 'R15_AGE_SERVICE',
    name: 'Age-service mismatch',
    category: 'Clinical consistency',
    weight: 15,
    target: 'identity_misuse',
    test: (c) => Number(c.ageServiceMismatch) === 1,
    detail: (c) => `Procedure "${c.procedureCode}" is implausible for a ${c.memberAge}-year-old member`,
  },
  {
    code: 'R16_WEEKEND',
    name: 'Weekend / holiday submission',
    category: 'Process',
    weight: 3,
    target: 'phantom_billing',
    test: (c) => Number(c.isWeekendSubmission) === 1,
    detail: () => 'Submitted on a weekend when the provider’s billing office is closed',
  },
  {
    code: 'R17_PROCEDURE_COUNT',
    name: 'Unbundled procedure explosion',
    category: 'Clinical consistency',
    weight: 11,
    target: 'unbundling',
    test: (c) => (c.numProcedures || 1) > 8,
    detail: (c) => `${c.numProcedures} line-item procedures on one claim (threshold 8)`,
  },
];

const fmt = (v) => Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

/**
 * Runs all rules against a claim.
 * @returns {{score:number, triggered:Array, maxScore:number, level:string}}
 */
function evaluateRules(claim, rules = DEFAULT_RULES) {
  const triggered = [];
  let score = 0;
  let maxScore = 0;
  for (const rule of rules) {
    maxScore += rule.weight;
    let fired = false;
    try {
      fired = Boolean(rule.test(claim));
    } catch {
      fired = false;
    }
    if (fired) {
      score += rule.weight;
      triggered.push({
        code: rule.code,
        name: rule.name,
        category: rule.category,
        weight: rule.weight,
        targets: rule.target,
        detail: typeof rule.detail === 'function' ? rule.detail(claim) : rule.detail,
      });
    }
  }
  // Normalise: 3+ strong rules should reach ~1.0
  const normalised = Math.min(1, score / 46);
  return {
    score: Number(normalised.toFixed(4)),
    rawScore: score,
    maxScore,
    triggered,
    level: triggered.length === 0 ? 'none' : triggered.length >= 5 ? 'critical'
      : triggered.length >= 3 ? 'high' : triggered.length >= 2 ? 'medium' : 'low',
  };
}

function ruleCatalogue() {
  return DEFAULT_RULES.map((r) => ({
    code: r.code, name: r.name, category: r.category,
    weight: r.weight, targets: r.target, description: `${r.name} (weight ${r.weight})`,
  }));
}

module.exports = { DEFAULT_RULES, evaluateRules, ruleCatalogue };
