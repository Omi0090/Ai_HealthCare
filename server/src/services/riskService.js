/**
 * riskService.js
 * --------------
 * Risk fusion: combines the three independent signals into the single number
 * the investigation queue is sorted by.
 *
 *   1. ML ensemble probability   (learned patterns, 32 engineered features)
 *   2. Rule engine score         (explicit, auditable red flags)
 *   3. Anomaly score             (unsupervised - catches novel schemes)
 *
 * The fusion is a weighted sum with a deliberate floor from the rule engine:
 * a claim that trips a *severe* explicit rule (duplicate billing, provider with
 * fraud history) can never be scored "minimal" just because the model is
 * unsure. Investigators must be able to trust that hard rules always surface.
 */
const { evaluateRules } = require('./ruleEngine');
const { riskLevel } = require('./featureService');

const WEIGHTS = {
  model: Number(process.env.W_MODEL || 0.60),
  rules: Number(process.env.W_RULES || 0.30),
  anomaly: Number(process.env.W_ANOMALY || 0.10),
};

/**
 * Rules that are individually decisive. Only these can force a risk floor -
 * `provider history` deliberately is NOT here even though it is informative,
 * because roughly a fifth of providers carry one historic finding and flooring
 * on it would flood the review queue with false positives.
 */
const DECISIVE_RULES = new Set(['R05_DUPLICATE', 'R15_AGE_SERVICE', 'R03_UNITS']);

function normalise(weights) {
  const total = weights.model + weights.rules + weights.anomaly;
  return {
    model: weights.model / total,
    rules: weights.rules / total,
    anomaly: weights.anomaly / total,
  };
}

/**
 * @param {object} claim stored claim document
 * @param {{explain?: boolean}} opts
 * @returns {Promise<object>} fields to merge onto the claim document
 */
async function fuseRisk(claim, { explain = true } = {}) {
  // lazy require avoids a circular dependency between claims route and service
  const ml = require('./mlService');
  const scored = await ml.scoreClaim(claim, { explain });
  const rules = evaluateRules(claim);

  const w = normalise(WEIGHTS);
  const mlScore = Number(scored.fraudProbability) || 0;
  const ruleScore = rules.score;
  const anomaly = Number(scored.anomalyScore) || 0;

  let fused = w.model * mlScore + w.rules * ruleScore + w.anomaly * anomaly;

  // Model consensus bonus: when every supervised model agrees the claim is
  // fraudulent, that agreement is itself evidence.
  const modelScores = Object.values(scored.probaByModel || {}).filter((v) => Number.isFinite(Number(v)));
  const allHigh = modelScores.length >= 2 && modelScores.every((s) => Number(s) >= 0.7);
  if (allHigh) fused = Math.min(1, fused + 0.04);

  // Hard-rule floor: decisive, low-prevalence evidence cannot be diluted away
  // by an unsure model. A near-duplicate billing line, an impossible age-service
  // combination or 15+ billed units is actionable on its own.
  const decisive = rules.triggered.filter((t) => DECISIVE_RULES.has(t.code));
  if (decisive.length >= 2) fused = Math.max(fused, 0.82);
  else if (decisive.length === 1 && rules.triggered.length >= 2) fused = Math.max(fused, 0.66);

  fused = Math.max(0, Math.min(1, fused));

  return {
    fraudProbability: Number(mlScore.toFixed(4)),
    ruleScore: Number(ruleScore.toFixed(4)),
    anomalyScore: Number(anomaly.toFixed(4)),
    riskScore: Math.round(fused * 100),
    riskLevel: riskLevel(fused),
    isFlagged: fused >= Number(process.env.FLAG_THRESHOLD || 0.55),
    triggeredRules: rules.triggered,
    explanation: scored.explanation || null,
    modelScores: scored.probaByModel,
    scoringSource: scored.source,
    modelVersion: 'v1.0.0',
    scoredAt: new Date().toISOString(),
    fusion: {
      weights: w,
      components: {
        model: Number(mlScore.toFixed(4)),
        rules: Number(ruleScore.toFixed(4)),
        anomaly: Number(anomaly.toFixed(4)),
      },
      consensusBonus: allHigh,
      decisiveRuleFloor: decisive.length >= 2 ? 0.82 : decisive.length === 1 ? 0.66 : null,
    },
  };
}

function decideStatus(claim) {
  if (claim.isFlagged) return 'flagged';
  return 'pending';
}

/** One-paragraph investigator briefing generated from the evidence. */
function narrative(claim, rules) {
  const triggered = rules?.triggered || [];
  const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  if (!triggered.length) {
    return `Claim ${claim.claimId} for ${claim.providerName} was assessed at a fraud probability of ` +
      `${((claim.fraudProbability || 0) * 100).toFixed(1)}%. No red-flag rules fired, and the detected ` +
      `pattern is consistent with the provider's historical billing profile. Recommend straight-through processing.`;
  }
  const top = triggered.slice(0, 3).map((t) => t.name.toLowerCase()).join('; ');
  return `Claim ${claim.claimId} (${money(claim.amountBilled)}) submitted by ${claim.providerName} triggered ` +
    `${triggered.length} red flag${triggered.length > 1 ? 's' : ''}, most notably ${top}. ` +
    `The ensemble scored it ${((claim.fraudProbability || 0) * 100).toFixed(1)}% fraudulent and the rule engine ` +
    `returned ${((claim.ruleScore || 0) * 100).toFixed(0)}/100, giving a composite risk of ${claim.riskScore}/100 ` +
    `(${claim.riskLevel}). ${claim.riskLevel === 'critical' || claim.riskLevel === 'high'
      ? 'Recommend immediate assignment to an investigator and a hold on reimbursement pending review.'
      : 'Flag for periodic batch review.'}`;
}

module.exports = { fuseRisk, decideStatus, narrative, WEIGHTS, DECISIVE_RULES };
