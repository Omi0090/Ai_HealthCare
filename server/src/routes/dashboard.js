const express = require('express');
const { getStore } = require('../db/store');
const { asyncHandler, authenticate } = require('../middleware/auth');
const ml = require('../services/mlService');

const router = express.Router();

const sum = (arr, fn) => arr.reduce((s, x) => s + (Number(fn(x)) || 0), 0);
const groupBy = (arr, keyFn) => {
  const m = new Map();
  for (const item of arr) {
    const k = keyFn(item) || 'Unknown';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
};

/**
 * GET /api/dashboard/overview
 * Executive KPIs for the landing dashboard.
 */
router.get('/overview', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const claims = await store.find('claims', {}, { limit: 100000, sort: { serviceDate: -1 } });
  const cases = await store.find('cases', {}, { limit: 5000 });

  const total = claims.length || 1;
  const flagged = claims.filter((c) => c.isFlagged);
  const actualFraud = claims.filter((c) => c.groundTruth?.isFraud);
  const billed = sum(claims, (c) => c.amountBilled);
  const approved = sum(claims, (c) => c.amountApproved);
  const exposure = sum(flagged, (c) => c.amountBilled);
  const recovered = sum(cases.filter((c) => c.decision === 'confirmed_fraud'), (c) => c.recoverableAmount);

  const tp = flagged.filter((c) => c.groundTruth?.isFraud).length;
  const fp = flagged.length - tp;
  const fn = actualFraud.length - tp;

  const levels = { critical: 0, high: 0, medium: 0, low: 0, minimal: 0 };
  claims.forEach((c) => { levels[c.riskLevel] = (levels[c.riskLevel] || 0) + 1; });

  const statusCounts = {};
  claims.forEach((c) => { statusCounts[c.status] = (statusCounts[c.status] || 0) + 1; });

  // Daily trend of claims vs flagged over the last 120 days *of the ledger*
  // (the synthetic portfolio is historical, so we anchor to the newest claim
  // rather than to the wall clock).
  const byDay = new Map();
  const newestClaim = claims.reduce((max, c) => {
    const t = new Date(c.serviceDate || c.createdAt).getTime();
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, 0);
  const cutoff = (newestClaim || Date.now()) - 120 * 86400000;
  claims.forEach((c) => {
    const d = new Date(c.serviceDate || c.createdAt);
    if (Number.isNaN(+d) || +d < cutoff) return;
    const key = d.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { date: key, claims: 0, flagged: 0, billed: 0, exposure: 0 });
    const row = byDay.get(key);
    row.claims += 1;
    row.billed += Number(c.amountBilled) || 0;
    if (c.isFlagged) { row.flagged += 1; row.exposure += Number(c.amountBilled) || 0; }
  });
  const trend = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));

  res.json({
    dataAsOf: newestClaim ? new Date(newestClaim).toISOString() : null,
    kpis: {
      totalClaims: claims.length,
      totalBilled: billed,
      totalApproved: approved,
      flaggedClaims: flagged.length,
      flagRate: Number(((flagged.length / total) * 100).toFixed(2)),
      exposureAtRisk: exposure,
      recoveredAmount: recovered,
      preventedLossEstimate: Math.round(sum(flagged, (c) => c.amountBilled) * 0.82),
      avgRiskScore: Number((sum(claims, (c) => c.riskScore) / total).toFixed(1)),
      openCases: cases.filter((c) => ['open', 'investigating', 'escalated'].includes(c.status)).length,
      modelPrecision: tp + fp ? Number(((tp / (tp + fp)) * 100).toFixed(1)) : null,
      modelRecall: tp + fn ? Number(((tp / (tp + fn)) * 100).toFixed(1)) : null,
      // Savings model: investigator hours avoided by auto-clearing low-risk claims
      autoCleared: claims.filter((c) => !c.isFlagged && (c.riskScore || 0) < 15).length,
      hoursSaved: Math.round(claims.filter((c) => !c.isFlagged && (c.riskScore || 0) < 15).length * 0.12 * 10) / 10,
    },
    riskDistribution: Object.entries(levels).map(([name, value]) => ({ name, value })),
    statusDistribution: Object.entries(statusCounts).map(([name, value]) => ({ name, value })),
    trend,
    mlStatus: ml.getStatus(),
  });
}));

/**
 * GET /api/dashboard/analytics - the deep-dive analytics screen
 */
router.get('/analytics', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const claims = await store.find('claims', {}, { limit: 100000 });
  const total = claims.length || 1;

  // Specialty performance
  const bySpecialty = [...groupBy(claims, (c) => c.specialty)].map(([specialty, rows]) => ({
    specialty,
    claims: rows.length,
    flagged: rows.filter((c) => c.isFlagged).length,
    billed: sum(rows, (c) => c.amountBilled),
    avgRisk: Number((sum(rows, (c) => c.riskScore) / rows.length).toFixed(1)),
    fraudRate: Number(((rows.filter((c) => c.groundTruth?.isFraud).length / rows.length) * 100).toFixed(2)),
  })).sort((a, b) => b.flagged - a.flagged);

  // Claim type
  const byClaimType = [...groupBy(claims, (c) => c.claimType)].map(([claimType, rows]) => ({
    claimType,
    claims: rows.length,
    flagged: rows.filter((c) => c.isFlagged).length,
    avgRisk: Number((sum(rows, (c) => c.riskScore) / rows.length).toFixed(1)),
  }));

  // State heat data
  const byState = [...groupBy(claims, (c) => c.state)].map(([state, rows]) => ({
    state,
    claims: rows.length,
    flagged: rows.filter((c) => c.isFlagged).length,
    exposure: sum(rows.filter((c) => c.isFlagged), (c) => c.amountBilled),
    avgRisk: Number((sum(rows, (c) => c.riskScore) / rows.length).toFixed(1)),
  })).sort((a, b) => b.exposure - a.exposure);

  // Risk-score histogram (10 buckets)
  const histogram = Array.from({ length: 10 }, (_, i) => ({
    bucket: `${i * 10}-${i * 10 + 9}`,
    claims: claims.filter((c) => (c.riskScore || 0) >= i * 10 && (c.riskScore || 0) < i * 10 + 10).length,
    fraud: claims.filter((c) => (c.riskScore || 0) >= i * 10 && (c.riskScore || 0) < i * 10 + 10
      && c.groundTruth?.isFraud).length,
  }));

  // Fraud scheme mix (ground truth archetypes)
  const archetypes = [...groupBy(claims.filter((c) => c.groundTruth?.archetype), (c) => c.groundTruth.archetype)]
    .map(([archetype, rows]) => ({
      archetype,
      claims: rows.length,
      detected: rows.filter((c) => c.isFlagged).length,
      exposure: sum(rows, (c) => c.amountBilled),
      detectionRate: Number(((rows.filter((c) => c.isFlagged).length / rows.length) * 100).toFixed(1)),
    })).sort((a, b) => b.claims - a.claims);

  // Top risky providers / members
  const byProvider = [...groupBy(claims, (c) => c.providerId)].map(([providerId, rows]) => ({
    providerId,
    providerName: rows[0].providerName,
    specialty: rows[0].specialty,
    claims: rows.length,
    flagged: rows.filter((c) => c.isFlagged).length,
    billed: sum(rows, (c) => c.amountBilled),
    avgRisk: Number((sum(rows, (c) => c.riskScore) / rows.length).toFixed(1)),
    flagRate: Number(((rows.filter((c) => c.isFlagged).length / rows.length) * 100).toFixed(1)),
  })).sort((a, b) => b.avgRisk * b.claims - a.avgRisk * a.claims).slice(0, 12);

  const byMember = [...groupBy(claims, (c) => c.memberId)].map(([memberId, rows]) => ({
    memberId,
    memberName: rows[0].memberName,
    claims: rows.length,
    flagged: rows.filter((c) => c.isFlagged).length,
    billed: sum(rows, (c) => c.amountBilled),
    avgRisk: Number((sum(rows, (c) => c.riskScore) / rows.length).toFixed(1)),
  })).sort((a, b) => b.flagged - a.flagged).slice(0, 10);

  // Model performance from ML metrics file (offline-safe)
  const modelInfo = await ml.getModelInfo();
  const rulePerformance = await ml.getRules();

  res.json({
    total,
    bySpecialty,
    byClaimType,
    byState,
    histogram,
    archetypes,
    topProviders: byProvider,
    topMembers: byMember,
    modelPerformance: {
      models: modelInfo.models || null,
      champion: modelInfo.champion,
      fusionWeights: modelInfo.fusion_weights,
      cvPrAuc: modelInfo.cv_pr_auc,
      operatingPoints: modelInfo.operating_points,
      perArchetype: modelInfo.per_archetype_detection,
      curves: modelInfo.curves,
      featureImportance: modelInfo.feature_importance || null,
      generatedAt: modelInfo.generated_at,
      offline: Boolean(modelInfo.offline),
    },
    rulePerformance: rulePerformance.rules || [],
  });
}));

/** GET /api/dashboard/providers - provider league table with provider-level risk */
router.get('/providers', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const providers = await store.find('providers', {}, { limit: 1000, sort: { riskScore: -1 } });
  const claims = await store.find('claims', {}, { limit: 100000 });

  const byProvider = groupBy(claims, (c) => c.providerId);
  const rows = providers.map((p) => {
    const rowsForProvider = byProvider.get(p.providerId) || [];
    const flagged = rowsForProvider.filter((c) => c.isFlagged);
    const risks = rowsForProvider.map((c) => c.fraudProbability || 0).sort((a, b) => a - b);
    const p90 = risks.length ? risks[Math.floor(risks.length * 0.9)] : 0;
    const mean = risks.length ? sum(risks, (x) => x) / risks.length : 0;
    const composite = 0.45 * mean + 0.4 * p90 + 0.15 * Math.min(1, flagged.length / 5);
    return {
      ...p,
      claimsCount: rowsForProvider.length,
      flaggedCount: flagged.length,
      billedTotal: sum(rowsForProvider, (c) => c.amountBilled),
      approvedTotal: sum(rowsForProvider, (c) => c.amountApproved),
      flaggedAmount: sum(flagged, (c) => c.amountBilled),
      meanClaimRisk: Number(mean.toFixed(4)),
      p90ClaimRisk: Number(p90.toFixed(4)),
      providerRiskScore: Math.round(composite * 100),
      providerRiskLevel: composite >= 0.75 ? 'critical' : composite >= 0.55 ? 'high'
        : composite >= 0.35 ? 'medium' : composite >= 0.15 ? 'low' : 'minimal',
    };
  }).sort((a, b) => b.providerRiskScore - a.providerRiskScore);

  res.json({ providers: rows });
}));

/** GET /api/dashboard/providers/:id - provider 360 view */
router.get('/providers/:id', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const provider = await store.findOne('providers', { providerId: req.params.id });
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  const claims = await store.find('claims', { providerId: provider.providerId }, { limit: 500, sort: { serviceDate: -1 } });
  const monthly = [...groupBy(claims, (c) => (c.serviceDate || '').slice(0, 7))].map(([month, rows]) => ({
    month,
    claims: rows.length,
    flagged: rows.filter((c) => c.isFlagged).length,
    billed: sum(rows, (c) => c.amountBilled),
  })).sort((a, b) => a.month.localeCompare(b.month));
  res.json({ provider, claims, monthly, summary: {
    claims: claims.length,
    flagged: claims.filter((c) => c.isFlagged).length,
    billed: sum(claims, (c) => c.amountBilled),
    approved: sum(claims, (c) => c.amountApproved),
    avgRisk: claims.length ? Number((sum(claims, (c) => c.riskScore) / claims.length).toFixed(1)) : 0,
  } });
}));

/** GET /api/dashboard/members/:id - member 360 view */
router.get('/members/:id', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const member = await store.findOne('members', { memberId: req.params.id });
  if (!member) return res.status(404).json({ error: 'Member not found' });
  const claims = await store.find('claims', { memberId: member.memberId }, { limit: 300, sort: { serviceDate: -1 } });
  res.json({ member, claims, summary: {
    claims: claims.length,
    flagged: claims.filter((c) => c.isFlagged).length,
    billed: sum(claims, (c) => c.amountBilled),
    avgRisk: claims.length ? Number((sum(claims, (c) => c.riskScore) / claims.length).toFixed(1)) : 0,
  } });
}));

/** GET /api/dashboard/network - collusion network graph (provider <-> member) */
router.get('/network', authenticate, asyncHandler(async (req, res) => {
  const store = getStore();
  const claims = await store.find('claims', { isFlagged: true }, { limit: 4000 });
  const providerAgg = new Map();
  const memberAgg = new Map();
  const edges = new Map();

  for (const c of claims) {
    const p = providerAgg.get(c.providerId) || { id: c.providerId, label: c.providerName, type: 'provider', claims: 0, risk: 0 };
    p.claims += 1; p.risk += c.riskScore || 0;
    providerAgg.set(c.providerId, p);

    const m = memberAgg.get(c.memberId) || { id: c.memberId, label: c.memberName, type: 'member', claims: 0, risk: 0 };
    m.claims += 1; m.risk += c.riskScore || 0;
    memberAgg.set(c.memberId, m);

    const key = `${c.providerId}->${c.memberId}`;
    const e = edges.get(key) || { source: c.providerId, target: c.memberId, weight: 0, amount: 0 };
    e.weight += 1; e.amount += Number(c.amountBilled) || 0;
    edges.set(key, e);
  }

  const nodes = [...providerAgg.values(), ...memberAgg.values()].map((n) => ({
    ...n, risk: Math.round(n.risk / Math.max(n.claims, 1)),
  }));
  // Only keep edges that appear more than once (rings), plus top single links
  const edgeList = [...edges.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 250);
  res.json({ nodes, edges: edgeList });
}));

module.exports = router;
