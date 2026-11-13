"""
app.py
------
FastAPI inference service for the Healthcare Insurance Fraud Detection system.

Endpoints
  GET  /health                 service + model status
  GET  /model-info             metrics, thresholds, feature importance
  GET  /feature-importance     global importances (permutation)
  POST /predict                score ONE claim with the full hybrid ensemble
  POST /predict-batch          score MANY claims (used to seed the demo ledger)
  POST /explain                Monte-Carlo Shapley attribution for one claim
  POST /score-provider         aggregate provider risk (SIU provider review)
  GET  /rules                  red-flag rule catalogue with observed lift

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from features import FEATURES, build_feature_frame, humanize_feature

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE, "models")

app = FastAPI(
    title="Healthcare Insurance Fraud Detection - ML Service",
    version="1.0.0",
    description="Hybrid supervised + unsupervised claim scoring with Shapley explanations.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# model loading
# --------------------------------------------------------------------------- #
class Bundle:
    def __init__(self) -> None:
        self.meta: Dict[str, Any] = {}
        self.metrics: Dict[str, Any] = {}
        self.models: Dict[str, Any] = {}
        self.background: Optional[np.ndarray] = None
        self.loaded = False

    def load(self) -> None:
        metrics_path = os.path.join(MODEL_DIR, "metrics.json")
        if not os.path.exists(metrics_path):
            self.loaded = False
            return
        with open(metrics_path) as fh:
            self.metrics = json.load(fh)
        meta_path = os.path.join(MODEL_DIR, "model_meta.json")
        if os.path.exists(meta_path):
            with open(meta_path) as fh:
                self.meta = json.load(fh)
        for name in ("logistic_regression", "random_forest",
                     "gradient_boosting", "isolation_forest"):
            p = os.path.join(MODEL_DIR, f"{name}.joblib")
            if os.path.exists(p):
                self.models[name] = joblib.load(p)

        data_path = os.path.join(BASE, "data", "claims.csv")
        if os.path.exists(data_path):
            ref = build_feature_frame(pd.read_csv(data_path, nrows=4000))
            rng = np.random.default_rng(0)
            self.background = ref.to_numpy()[rng.choice(len(ref), size=200, replace=False)]
        self.loaded = bool(self.models)


BUNDLE = Bundle()


@lru_cache(maxsize=1)
def bundle() -> Bundle:
    if not BUNDLE.loaded:
        BUNDLE.load()
    return BUNDLE


# --------------------------------------------------------------------------- #
# scoring
# --------------------------------------------------------------------------- #
def anomaly_score(raw: np.ndarray) -> np.ndarray:
    """
    IsolationForest -> 0..1 where 1 is most anomalous.

    Calibration bounds are the 1st/99th percentiles of the *training* scores,
    exported by train_models.py. Normalising against the current batch would
    break single-claim inference (batch of one => zero variance => score 0).
    """
    b = bundle()
    iso = b.models.get("isolation_forest")
    if iso is None:
        return np.zeros(len(raw))
    s = -iso.score_samples(raw)
    cal = b.metrics.get("anomaly_calibration") or {}
    lo, hi = cal.get("low"), cal.get("high")
    if lo is None or hi is None or hi <= lo:
        lo, hi = float(np.min(s)), float(np.max(s)) or float(np.min(s)) + 1.0
    return np.clip((s - lo) / max(hi - lo, 1e-9), 0, 1)


def score_frame(df: pd.DataFrame, explain: bool = False) -> List[Dict[str, Any]]:
    b = bundle()
    if not b.loaded:
        raise HTTPException(503, "Models not trained. Run `python train_models.py` in ml-service/.")

    X = build_feature_frame(df)
    Xa = X.to_numpy()
    out: List[Dict[str, Any]] = []

    per_model = {}
    for name in ("logistic_regression", "random_forest", "gradient_boosting"):
        m = b.models.get(name)
        if m is not None:
            per_model[name] = m.predict_proba(Xa)[:, 1]
    anom = anomaly_score(Xa)

    w = b.metrics.get("fusion_weights", {})
    champ_name = w.get("champion_name", "gradient_boosting")
    sec_name = w.get("secondary_name", "logistic_regression")
    champ = per_model.get(champ_name, np.zeros(len(Xa)))
    sec = per_model.get(sec_name, np.zeros(len(Xa)))
    fused = (
        w.get("champion", 0.65) * champ
        + w.get("secondary", 0.25) * sec
        + w.get("anomaly", 0.10) * anom
    )
    thr = b.metrics.get("thresholds", {}).get("hybrid_ensemble", 0.5)

    for i in range(len(X)):
        score = float(fused[i])
        row = {
            "fraudProbability": round(score, 4),
            "riskScore": int(round(score * 100)),
            "riskLevel": risk_level(score),
            "isFlagged": bool(score >= thr),
            "threshold": round(float(thr), 4),
            "modelScores": {k: round(float(v[i]), 4) for k, v in per_model.items()},
            "anomalyScore": round(float(anom[i]), 4),
            "ensembleWeights": {
                "champion": w.get("champion"),
                "secondary": w.get("secondary"),
                "anomaly": w.get("anomaly"),
                "championName": champ_name,
                "secondaryName": sec_name,
            },
        }
        if explain:
            row["explanation"] = shap_for_row(Xa[i])
        out.append(row)
    return out


def risk_level(p: float) -> str:
    if p >= 0.80:
        return "critical"
    if p >= 0.60:
        return "high"
    if p >= 0.35:
        return "medium"
    if p >= 0.15:
        return "low"
    return "minimal"


def shap_for_row(x_row: np.ndarray) -> Dict[str, Any]:
    b = bundle()
    from train_models import shap_local_attribution  # local import keeps app start fast

    fn = b.models[b.metrics["fusion_weights"]["champion_name"]].predict_proba
    bg = b.background if b.background is not None else np.zeros((1, len(FEATURES)))
    return shap_local_attribution(fn, x_row, bg, FEATURES, n_permutations=300)


# --------------------------------------------------------------------------- #
# schemas
# --------------------------------------------------------------------------- #
class ClaimIn(BaseModel):
    claim_type: str = "inpatient"
    specialty: str = "General Medicine"
    procedure_code: str = "Consultation"
    diagnosis_code: str = "E11"
    state: str = "Maharashtra"
    plan_type: str = "Individual"
    amount_billed: float = 25_000
    amount_approved: float = 18_000
    units_claimed: int = 1
    service_days: int = 1
    nights_in_hospital: int = 0
    num_procedures: int = 1
    prior_claims_30d: int = 0
    member_claims_12m: int = 1
    provider_claims_30d: int = 40
    same_day_claims: int = 0
    duplicate_similarity: float = 0.05
    diag_proc_match: float = 0.95
    age_service_mismatch: float = 0.0
    diagnosis_severity: float = 0.45
    submission_lag_days: int = 4
    is_weekend_submission: int = 0
    provider_license_age_years: float = 10
    provider_fraud_history: int = 0
    provider_in_network: int = 1
    provider_avg_billed: float = 30_000
    distance_km: float = 15
    member_age: int = 40
    chronic_conditions: int = 1
    policy_age_months: int = 24
    annual_premium: float = 30_000
    is_emergency: int = 0
    pharmacy_qty: int = 1
    pharmacy_refill_days: int = 30
    specialty_amount_mean: float = 30_000
    specialty_amount_std: float = 25_000
    explain: bool = True


class BatchIn(BaseModel):
    claims: List[ClaimIn] = Field(..., max_length=2000)
    explain: bool = False


class BatchOut(BaseModel):
    results: List[Dict[str, Any]]
    count: int


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
def health() -> Dict[str, Any]:
    b = bundle()
    return {
        "status": "ok" if b.loaded else "models_missing",
        "models": list(b.models.keys()),
        "champion": b.metrics.get("fusion_weights", {}).get("champion_name"),
        "features": len(FEATURES),
        "trained_at": b.metrics.get("generated_at"),
        "background_rows": 0 if b.background is None else int(len(b.background)),
    }


@app.get("/model-info")
def model_info() -> Dict[str, Any]:
    b = bundle()
    if not b.loaded:
        raise HTTPException(503, "models not trained")
    return {
        "dataset": b.metrics.get("dataset"),
        "models": b.metrics.get("models"),
        "champion": b.metrics.get("champion"),
        "fusion_weights": b.metrics.get("fusion_weights"),
        "thresholds": b.metrics.get("thresholds"),
        "cv_pr_auc": b.metrics.get("cv_pr_auc"),
        "operating_points": b.metrics.get("operating_points"),
        "per_archetype_detection": b.metrics.get("per_archetype_detection"),
        "curves": b.metrics.get("curves"),
        "generated_at": b.metrics.get("generated_at"),
    }


@app.get("/feature-importance")
def feature_importance() -> Dict[str, Any]:
    b = bundle()
    return {
        "importance": b.metrics.get("feature_importance", []),
        "features": FEATURES,
    }


@app.get("/rules")
def rules() -> Dict[str, Any]:
    return {"rules": bundle().metrics.get("rule_lift", [])}


@app.post("/predict")
def predict(claim: ClaimIn) -> Dict[str, Any]:
    df = pd.DataFrame([claim.model_dump()])
    res = score_frame(df, explain=claim.explain)[0]
    res["features"] = {k: round(float(v), 4) for k, v in
                       build_feature_frame(df).iloc[0].items()}
    res["feature_labels"] = {k: humanize_feature(k) for k in FEATURES}
    return res


@app.post("/predict-batch")
def predict_batch(payload: BatchIn) -> BatchOut:
    df = pd.DataFrame([c.model_dump() for c in payload.claims])
    return BatchOut(results=score_frame(df, explain=False), count=len(df))


@app.post("/explain")
def explain(claim: ClaimIn) -> Dict[str, Any]:
    df = pd.DataFrame([claim.model_dump()])
    X = build_feature_frame(df).to_numpy()
    res = shap_for_row(X[0])
    scored = score_frame(df)[0]
    res["fraudProbability"] = scored["fraudProbability"]
    res["riskLevel"] = scored["riskLevel"]
    return res


@app.post("/score-provider")
def score_provider(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Provider-level risk: combines the mean claim risk, the *upper tail* risk
    (fraudsters often have a few blatant claims among many normal ones) and the
    provider's own behaviours. Used for SIU provider audits.
    """
    claims = payload.get("claims") or []
    if not claims:
        raise HTTPException(400, "provide at least one claim")
    df = pd.DataFrame(claims)
    scored = score_frame(df)
    probs = np.array([s["fraudProbability"] for s in scored])
    mean_risk = float(probs.mean())
    tail_risk = float(np.percentile(probs, 90))
    flagged = int((probs >= bundle().metrics["thresholds"]["hybrid_ensemble"]).sum())
    composite = 0.45 * mean_risk + 0.40 * tail_risk + 0.15 * min(1.0, flagged / 5)
    return {
        "providerRisk": round(float(composite), 4),
        "riskScore": int(round(composite * 100)),
        "riskLevel": risk_level(composite),
        "claimsScored": len(probs),
        "claimsFlagged": flagged,
        "meanClaimRisk": round(mean_risk, 4),
        "p90ClaimRisk": round(tail_risk, 4),
        "flaggedShare": round(flagged / len(probs), 4),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
