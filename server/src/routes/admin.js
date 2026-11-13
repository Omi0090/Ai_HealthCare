const express = require('express');
const { getStore } = require('../db/store');
const { asyncHandler, authenticate, authorize, audit } = require('../middleware/auth');
const { ruleCatalogue } = require('../services/ruleEngine');
const ml = require('../services/mlService');

const router = express.Router();

/** GET /api/admin/system - runtime health & configuration */
router.get('/system', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const status = await ml.checkHealth();
  const counts = {};
  for (const c of ['users', 'claims', 'providers', 'members', 'cases', 'auditlogs']) {
    counts[c] = await store.count(c, {});
  }
  // Full model report so the AI Model screen renders without a second call
  const modelReport = await ml.getModelInfo();
  res.json({
    database: { kind: store.kind, counts },
    ml: { ...status, url: ml.getStatus().url, fallbackAvailable: ml.getStatus().fallbackAvailable },
    models: modelReport.models || null,
    modelMetrics: {
      champion: modelReport.champion,
      fusion_weights: modelReport.fusion_weights,
      cv_pr_auc: modelReport.cv_pr_auc,
      curves: modelReport.curves,
      dataset: modelReport.dataset,
      generated_at: modelReport.generated_at,
      offline: Boolean(modelReport.offline),
    },
    featureImportance: modelReport.feature_importance || modelReport.featureImportance || null,
    operatingPoints: modelReport.operating_points || null,
    perArchetype: modelReport.per_archetype_detection || null,
    fusionWeights: { model: 0.6, rules: 0.3, anomaly: 0.1 },
    flagThreshold: Number(process.env.FLAG_THRESHOLD || 0.55),
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  });
}));

/** GET /api/admin/rules - rule catalogue + observed performance */
router.get('/rules', authenticate, asyncHandler(async (req, res) => {
  const observed = await ml.getRules();
  res.json({
    catalogue: ruleCatalogue(),
    observed: observed.rules || [],
  });
}));

/** POST /api/admin/rescore-all - re-run the ensemble across the whole portfolio */
router.post('/rescore-all', authenticate, authorize('admin', 'investigator', 'analyst'), asyncHandler(async (req, res) => {
  const store = getStore();
  const limit = Math.min(Number(req.body.limit) || 500, 2000);
  const claims = await store.find('claims', {}, { limit, sort: { createdAt: -1 } });
  const results = await ml.scoreClaims(claims);
  const { evaluateRules } = require('../services/ruleEngine');
  let updated = 0;
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    const scored = results[i];
    const rules = evaluateRules(claim);
    const fused = 0.6 * scored.fraudProbability + 0.3 * rules.score + 0.1 * (scored.anomalyScore || 0);
    await store.updateOne('claims', { claimId: claim.claimId }, {
      fraudProbability: scored.fraudProbability,
      anomalyScore: scored.anomalyScore || 0,
      ruleScore: rules.score,
      riskScore: Math.round(fused * 100),
      riskLevel: scored.riskLevel,
      isFlagged: fused >= Number(process.env.FLAG_THRESHOLD || 0.55),
      triggeredRules: rules.triggered,
      scoringSource: scored.source,
      scoredAt: new Date().toISOString(),
    });
    updated += 1;
  }
  await audit(req, 'admin.rescore_all', 'claims', 'bulk', { updated });
  res.json({ updated, source: results[0]?.source || 'unknown' });
}));

/** GET /api/admin/audit */
router.get('/audit', authenticate, authorize('admin', 'investigator'), asyncHandler(async (req, res) => {
  const store = getStore();
  const logs = await store.find('auditlogs', {}, { limit: Number(req.query.limit) || 200, sort: { createdAt: -1 } });
  res.json({ logs });
}));

module.exports = router;
