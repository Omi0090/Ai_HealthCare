/**
 * mlService.js
 * ------------
 * Client for the Python inference service, plus a mathematically faithful
 * offline fallback.
 *
 * Primary path  : POST http://ML_SERVICE_URL/predict  (gradient boosting + RF +
 *                 logistic regression + isolation forest, Shapley explanations)
 * Fallback path : the trained logistic-regression weights are exported to
 *                 ml-service/models/linear_model_export.json and replayed here
 *                 (standardise -> dot product -> sigmoid). If the Python service
 *                 is down, the API keeps scoring claims with the *same* trained
 *                 coefficients instead of returning zeros.
 *
 * This two-tier design is deliberate: a demo must never show "AI unavailable".
 */
const fs = require('fs');
const path = require('path');
const axioslike = null; // no external dep: we use global fetch (Node 18+)

const { FEATURES, FEATURE_LABELS, buildFeatures, toMlPayload, riskLevel } = require('./featureService');

const ML_URL = (process.env.ML_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.ML_TIMEOUT_MS || 20000);

let linearModel = null;
let mlStatus = { reachable: false, lastCheck: null, models: [], error: null, champion: null };

/* --------------------------------------------------------------- helpers */
function loadLinearModel() {
  if (linearModel) return linearModel;
  const candidates = [
    process.env.LINEAR_MODEL_PATH,
    path.join(__dirname, '..', '..', '..', 'ml-service', 'models', 'linear_model_export.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        linearModel = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`[ml] loaded offline linear model (${linearModel.features.length} features) from ${p}`);
        return linearModel;
      }
    } catch (err) {
      console.warn('[ml] could not parse linear model export:', err.message);
    }
  }
  return null;
}

async function withTimeout(promise, ms, label = 'request') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function callMl(endpoint, body, method = 'POST') {
  const res = await withTimeout(
    fetch(`${ML_URL}${endpoint}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    }),
    TIMEOUT_MS,
    `ML ${endpoint}`
  );
  if (!res.ok) throw new Error(`ML ${endpoint} responded ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------- offline scorer */
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Replays the exported scikit-learn LogisticRegression pipeline:
 *   z = ((x - mean) / scale) · coef + intercept ;  p = sigmoid(z)
 */
function scoreLocally(claim) {
  const model = loadLinearModel();
  const feats = buildFeatures(claim);
  if (!model) {
    // Last resort: rule-free heuristic so nothing ever returns 0 for a blatant claim.
    const heuristic = Math.min(1, Math.max(0,
      (feats.billed_vs_peer_ratio > 2 ? 0.3 : 0) +
      (feats.units_claimed > 15 ? 0.25 : 0) +
      (feats.duplicate_similarity > 0.85 ? 0.25 : 0) +
      (feats.diag_proc_match < 0.55 ? 0.2 : 0)));
    return {
      fraudProbability: Number(heuristic.toFixed(4)),
      riskScore: Math.round(heuristic * 100),
      riskLevel: riskLevel(heuristic),
      probaByModel: { heuristic },
      anomalyScore: 0,
      source: 'heuristic',
      features: feats,
    };
  }
  let z = model.intercept;
  const contributions = [];
  model.features.forEach((name, i) => {
    const x = Number(feats[name] ?? 0);
    const std = (x - model.mean[i]) / (model.scale[i] || 1);
    const term = std * model.coef[i];
    z += term;
    contributions.push({ feature: name, label: FEATURE_LABELS[name] || name, value: x, contribution: term });
  });
  const p = sigmoid(z);
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return {
    fraudProbability: Number(p.toFixed(4)),
    riskScore: Math.round(p * 100),
    riskLevel: riskLevel(p),
    probaByModel: { logistic_regression: Number(p.toFixed(4)) },
    anomalyScore: 0,
    source: 'fallback-linear',
    features: feats,
    explanation: {
      method: 'linear_shapley',
      space: 'log_odds',
      base_value: Number(model.intercept.toFixed(4)),
      expected_logit: Number(model.intercept.toFixed(4)),
      claim_logit: Number(z.toFixed(4)),
      stability: 1,
      top_features: contributions.slice(0, 12).map((c) => ({
        ...c,
        contribution: Number(c.contribution.toFixed(5)),
        contribution_std: 0,
        weight_pct: Number((100 * Math.abs(c.contribution) / (contributions.reduce((s, x) => s + Math.abs(x.contribution), 0) || 1)).toFixed(1)),
        direction: c.contribution > 0 ? 'increases_risk' : 'decreases_risk',
      })),
    },
  };
}

/* ----------------------------------------------------------- public API */
async function checkHealth() {
  try {
    const h = await callMl('/health', null, 'GET');
    mlStatus = {
      reachable: h.status === 'ok',
      lastCheck: new Date().toISOString(),
      models: h.models || [],
      champion: h.champion,
      trainedAt: h.trained_at,
      features: h.features,
      error: h.status === 'ok' ? null : 'models not trained',
    };
  } catch (err) {
    mlStatus = {
      reachable: false,
      lastCheck: new Date().toISOString(),
      models: [],
      champion: null,
      error: err.message,
    };
  }
  return mlStatus;
}

function getStatus() {
  return { ...mlStatus, url: ML_URL, fallbackAvailable: Boolean(loadLinearModel()) };
}

/**
 * Scores one claim. Never throws: on ML failure it degrades to the exported
 * linear model and tags `source` so the UI can be transparent about it.
 */
async function scoreClaim(claim, { explain = true } = {}) {
  const payload = { ...toMlPayload(claim), explain };
  try {
    const res = await callMl('/predict', payload);
    mlStatus.reachable = true;
    mlStatus.error = null;
    return {
      fraudProbability: res.fraudProbability,
      riskScore: res.riskScore,
      riskLevel: res.riskLevel,
      isFlagged: res.isFlagged,
      threshold: res.threshold,
      probaByModel: res.modelScores,
      anomalyScore: res.anomalyScore,
      explanation: res.explanation,
      features: res.features,
      source: 'ml-service',
    };
  } catch (err) {
    mlStatus.reachable = false;
    mlStatus.error = err.message;
    const local = scoreLocally(claim);
    return { ...local, isFlagged: local.fraudProbability >= 0.5, threshold: 0.5, mlError: err.message };
  }
}

/** Batch scoring: one HTTP round trip for up to 2000 claims. */
async function scoreClaims(claims, { explain = false } = {}) {
  if (!claims.length) return [];
  const chunks = [];
  for (let i = 0; i < claims.length; i += 500) chunks.push(claims.slice(i, i + 500));
  const out = [];
  for (const chunk of chunks) {
    try {
      const res = await callMl('/predict-batch', {
        claims: chunk.map((c) => ({ ...toMlPayload(c), explain: false })),
        explain,
      });
      mlStatus.reachable = true;
      mlStatus.error = null;
      res.results.forEach((r) => out.push({
        fraudProbability: r.fraudProbability,
        riskScore: r.riskScore,
        riskLevel: r.riskLevel,
        isFlagged: r.isFlagged,
        threshold: r.threshold,
        probaByModel: r.modelScores,
        anomalyScore: r.anomalyScore,
        explanation: r.explanation,
        source: 'ml-service',
      }));
    } catch (err) {
      mlStatus.reachable = false;
      mlStatus.error = err.message;
      console.warn(`[ml] batch scoring failed (${err.message}) - using offline linear model`);
      chunk.forEach((c) => {
        const local = scoreLocally(c);
        out.push({ ...local, isFlagged: local.fraudProbability >= 0.5, threshold: 0.5 });
      });
    }
  }
  return out;
}

async function explainClaim(claim) {
  try {
    return await callMl('/explain', { ...toMlPayload(claim), explain: true });
  } catch {
    const local = scoreLocally(claim);
    return local.explanation;
  }
}

async function getModelInfo() {
  try {
    return await callMl('/model-info', null, 'GET');
  } catch (err) {
    const metricsPath = path.join(__dirname, '..', '..', '..', 'ml-service', 'models', 'metrics.json');
    if (fs.existsSync(metricsPath)) {
      const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
      return { ...m, offline: true, error: err.message };
    }
    return { error: err.message, offline: true };
  }
}

async function getRules() {
  try {
    return await callMl('/rules', null, 'GET');
  } catch {
    return { rules: [], offline: true };
  }
}

module.exports = {
  checkHealth, getStatus, scoreClaim, scoreClaims, explainClaim,
  getModelInfo, getRules, scoreLocally, FEATURES,
};
