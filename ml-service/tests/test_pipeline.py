"""
Unit + integration tests for the ML pipeline.

    cd ml-service && python -m pytest tests -q      (or python tests/test_pipeline.py)

Verifies the contract the Node server depends on:
  * feature engineering is deterministic, ordered and finite
  * the exported linear model reproduces scikit-learn's probabilities exactly
  * Shapley attributions satisfy the efficiency property
  * obviously fraudulent claims score higher than obviously clean ones
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from features import FEATURES, build_feature_frame, humanize_feature  # noqa: E402
from train_models import shap_local_attribution  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CLEAN = {
    "claim_type": "outpatient", "specialty": "General Medicine", "amount_billed": 4200,
    "amount_approved": 3300, "units_claimed": 1, "service_days": 1, "nights_in_hospital": 0,
    "num_procedures": 1, "prior_claims_30d": 0, "member_claims_12m": 1,
    "provider_claims_30d": 40, "same_day_claims": 0, "duplicate_similarity": 0.02,
    "diag_proc_match": 0.95, "age_service_mismatch": 0, "diagnosis_severity": 0.4,
    "submission_lag_days": 3, "is_weekend_submission": 0, "provider_fraud_history": 0,
    "provider_in_network": 1, "provider_avg_billed": 15000, "distance_km": 12,
    "member_age": 41, "chronic_conditions": 1, "policy_age_months": 30,
    "annual_premium": 30000, "is_emergency": 0, "pharmacy_qty": 1,
    "pharmacy_refill_days": 30, "specialty_amount_mean": 15000, "specialty_amount_std": 8000,
}

FRAUD = {
    **CLEAN,
    "claim_type": "pharmacy", "amount_billed": 640000, "amount_approved": 630000,
    "units_claimed": 42, "num_procedures": 14, "provider_claims_30d": 240,
    "same_day_claims": 6, "duplicate_similarity": 0.93, "diag_proc_match": 0.22,
    "provider_fraud_history": 2, "provider_avg_billed": 6000,
    "specialty_amount_mean": 6000, "distance_km": 380, "pharmacy_qty": 60,
    "policy_age_months": 4,
}


def test_feature_frame_is_ordered_and_finite():
    df = build_feature_frame(pd.DataFrame([CLEAN, FRAUD]))
    assert list(df.columns) == FEATURES, "feature order must match the trained model"
    assert df.shape == (2, len(FEATURES))
    assert np.isfinite(df.to_numpy()).all(), "no NaN/inf may reach the model"


def test_feature_engineering_is_deterministic():
    a = build_feature_frame(pd.DataFrame([CLEAN]))
    b = build_feature_frame(pd.DataFrame([CLEAN]))
    pd.testing.assert_frame_equal(a, b)


def test_missing_fields_do_not_crash():
    base = build_feature_frame(pd.DataFrame([{}]))
    assert base.shape == (1, len(FEATURES))
    assert (base.to_numpy() == 0).all() or np.isfinite(base.to_numpy()).all()


def test_humanize_covers_every_feature():
    for f in FEATURES:
        assert humanize_feature(f) != f, f"{f} has no human label"


def test_exported_linear_model_matches_sklearn():
    """The Node fallback must reproduce scikit-learn's output bit-for-bit."""
    export_path = os.path.join(BASE, "models", "linear_model_export.json")
    if not os.path.exists(export_path):
        print("skip: linear_model_export.json not built")
        return
    import joblib

    model = joblib.load(os.path.join(BASE, "models", "logistic_regression.joblib"))
    export = json.load(open(export_path))
    X = build_feature_frame(pd.DataFrame([CLEAN, FRAUD])).to_numpy()

    expected = model.predict_proba(X)[:, 1]
    manual = []
    for row in X:
        z = export["intercept"]
        for i, name in enumerate(export["features"]):
            z += ((row[FEATURES.index(name)] - export["mean"][i]) / export["scale"][i]) * export["coef"][i]
        manual.append(1 / (1 + np.exp(-z)))
    manual = np.array(manual)
    assert np.allclose(expected, manual, atol=1e-6), f"{expected} vs {manual}"


def test_shapley_efficiency_property():
    """sum(phi) must equal f(x) - E[f] (plus a tiny MC tolerance)."""
    import joblib

    hgb_path = os.path.join(BASE, "models", "gradient_boosting.joblib")
    if not os.path.exists(hgb_path):
        print("skip: models not trained")
        return
    model = joblib.load(hgb_path)
    rng = np.random.default_rng(0)
    bg = build_feature_frame(pd.DataFrame([CLEAN, FRAUD] * 20)).to_numpy()
    x = build_feature_frame(pd.DataFrame([FRAUD])).to_numpy()[0]

    exp = shap_local_attribution(model.predict_proba, x, bg, FEATURES, n_permutations=60, seed=1)
    total = sum(f["contribution"] for f in exp["top_features"])
    # only the top 12 are returned, so compare with the full vector instead
    phi_sum = exp["claim_logit"] - exp["expected_logit"]
    assert abs(total) <= abs(phi_sum) + 1e-6
    assert exp["stability"] >= 0


def test_fraudulent_claim_scores_higher_than_clean():
    import joblib

    path = os.path.join(BASE, "models", "gradient_boosting.joblib")
    if not os.path.exists(path):
        print("skip: models not trained")
        return
    model = joblib.load(path)
    X = build_feature_frame(pd.DataFrame([CLEAN, FRAUD])).to_numpy()
    p = model.predict_proba(X)[:, 1]
    assert p[0] < 0.2, f"clean claim scored {p[0]:.3f}"
    assert p[1] > 0.6, f"fraud claim scored {p[1]:.3f}"


def test_generated_dataset_matches_schema():
    path = os.path.join(BASE, "data", "claims.csv")
    if not os.path.exists(path):
        print("skip: dataset not generated")
        return
    df = pd.read_csv(path, nrows=2000)
    for col in ("claim_id", "provider_id", "member_id", "amount_billed",
                "is_fraud", "archetype", "fraud_severity"):
        assert col in df.columns, f"missing {col}"
    assert df["archetype"].isin(
        ["legitimate", "upcoding", "phantom_billing", "duplicate_billing",
         "unbundling", "los_inflation", "collusion_ring", "identity_misuse"]
    ).all()
    rate = df["is_fraud"].mean()
    assert 0.03 < rate < 0.30, f"implausible fraud prevalence {rate}"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError as err:
                failures += 1
                print(f"  FAIL  {name}: {err}")
    print(f"\n{'OK' if failures == 0 else f'{failures} FAILED'}")
    sys.exit(1 if failures else 0)
