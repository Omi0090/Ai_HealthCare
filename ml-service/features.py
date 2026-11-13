"""
features.py
-----------
Single source of truth for the feature engineering pipeline used by the
Healthcare Insurance Fraud Detection system.

The exact same ordered list of features is used by:
  * data/generate_dataset.py   (synthetic claim generation)
  * train_models.py            (model training + evaluation)
  * app.py                     (FastAPI inference endpoints)

IMPORTANT: any change here must be mirrored in
server/src/services/mlService.js (JS fallback scorer) if you want the
offline fallback to stay in sync.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------- #
# Canonical feature order.  Do not re-order: saved models depend on it.
# --------------------------------------------------------------------------- #
FEATURES: List[str] = [
    # ---- monetary -----------------------------------------------------------
    "amount_billed",
    "approved_ratio",
    "billed_vs_peer_ratio",
    "amount_zscore_specialty",
    "procedure_avg_cost_ratio",
    "units_claimed",
    # ---- utilisation --------------------------------------------------------
    "service_days",
    "nights_in_hospital",
    "los_expected_ratio",
    "num_procedures",
    "prior_claims_30d_member",
    "member_claim_frequency_12m",
    "provider_claims_30d",
    "same_day_multiple_claims",
    # ---- integrity / duplication -------------------------------------------
    "duplicate_similarity",
    "diag_proc_match",
    "age_service_mismatch",
    "diagnosis_severity_score",
    # ---- temporal -----------------------------------------------------------
    "submission_lag_days",
    "is_weekend_submission",
    # ---- provider / network -------------------------------------------------
    "provider_specialty_risk",
    "provider_license_age_years",
    "provider_fraud_history",
    "provider_network_status",
    "distance_member_provider_km",
    # ---- member / policy ----------------------------------------------------
    "member_age",
    "member_chronic_conditions",
    "policy_age_months",
    "premium_to_billed_ratio",
    # ---- categorical encodings ---------------------------------------------
    "claim_type_risk",
    "is_emergency",
    "pharmacy_qty_ratio",
]

CATEGORICAL_FEATURES = [
    "claim_type",
    "specialty",
    "diagnosis_code",
    "procedure_code",
    "state",
    "plan_type",
]

# Risk priors used for the numeric encoding of categorical variables.
CLAIM_TYPE_RISK = {
    "inpatient": 0.55,
    "outpatient": 0.32,
    "pharmacy": 0.61,
    "laboratory": 0.47,
    "dental": 0.25,
    "vision": 0.15,
}

SPECIALTY_RISK = {
    "Cardiology": 0.55,
    "Orthopedics": 0.62,
    "Oncology": 0.58,
    "Dermatology": 0.22,
    "General Medicine": 0.35,
    "Radiology": 0.48,
    "Pathology": 0.44,
    "Pharmacy": 0.66,
    "Dentistry": 0.28,
    "Ophthalmology": 0.20,
    "Neurology": 0.45,
    "Gastroenterology": 0.40,
}

# Expected length-of-stay per claim type (days) used by los_expected_ratio
EXPECTED_LOS = {
    "inpatient": 4.0,
    "outpatient": 1.0,
    "pharmacy": 1.0,
    "laboratory": 1.0,
    "dental": 1.0,
    "vision": 1.0,
}

# Average cost per procedure family (INR) used by procedure_avg_cost_ratio
PROCEDURE_BENCHMARK = {
    "Cardiology": 95_000,
    "Orthopedics": 120_000,
    "Oncology": 150_000,
    "Dermatology": 8_000,
    "General Medicine": 15_000,
    "Radiology": 12_000,
    "Pathology": 4_000,
    "Pharmacy": 6_000,
    "Dentistry": 9_000,
    "Ophthalmology": 25_000,
    "Neurology": 60_000,
    "Gastroenterology": 45_000,
}


def _safe_div(a: Any, b: Any, default: float = 0.0) -> Any:
    """Division that never raises and never returns inf/nan."""
    a = np.asarray(a, dtype="float64")
    b = np.asarray(b, dtype="float64")
    out = np.where(np.abs(b) < 1e-9, default, a / np.where(np.abs(b) < 1e-9, 1.0, b))
    return np.clip(out, -1e6, 1e6)


def build_feature_frame(raw: pd.DataFrame) -> pd.DataFrame:
    """
    Turn a raw claim table (the shape stored in MongoDB) into the numeric
    feature matrix used by every model.

    Every engineered column here mirrors `buildDerivedFeatures()` in
    server/src/services/featureService.js so that online and offline paths
    agree.
    """
    df = raw.copy()

    def num(col, default=0.0):
        if col in df.columns:
            return pd.to_numeric(df[col], errors="coerce").fillna(default)
        return pd.Series(np.full(len(df), default), index=df.index)

    claim_type = df.get("claim_type", pd.Series("outpatient", index=df.index)).astype(str)
    specialty = df.get("specialty", pd.Series("General Medicine", index=df.index)).astype(str)

    amount = num("amount_billed")
    f: Dict[str, Any] = {}

    f["amount_billed"] = np.log1p(amount.clip(lower=0))
    f["approved_ratio"] = _safe_div(num("amount_approved"), amount, 0.75)
    f["billed_vs_peer_ratio"] = _safe_div(amount, num("provider_avg_billed", 20000.0), 1.0)
    std = num("specialty_amount_std", 25000.0).replace(0, 25000.0)
    f["amount_zscore_specialty"] = np.clip((amount - num("specialty_amount_mean", 30000.0)) / std, -10, 10)

    bench = specialty.map(PROCEDURE_BENCHMARK).fillna(30_000).astype(float).to_numpy()
    f["procedure_avg_cost_ratio"] = np.clip(amount.to_numpy() / bench, 0, 40)

    f["units_claimed"] = np.clip(num("units_claimed", 1.0), 0, 400)
    f["service_days"] = np.clip(num("service_days", 1.0), 0, 400)
    f["nights_in_hospital"] = np.clip(num("nights_in_hospital", 0.0), 0, 400)

    expected_los = claim_type.map(EXPECTED_LOS).fillna(1.0).astype(float)
    f["los_expected_ratio"] = np.clip(
        (num("service_days", 1.0).to_numpy() + 0.5) / (expected_los.to_numpy() + 0.5), 0, 60
    )

    f["num_procedures"] = np.clip(num("num_procedures", 1.0), 0, 60)
    f["prior_claims_30d_member"] = np.clip(num("prior_claims_30d"), 0, 80)
    f["member_claim_frequency_12m"] = np.clip(num("member_claims_12m"), 0, 200)
    f["provider_claims_30d"] = np.clip(num("provider_claims_30d"), 0, 3000)
    f["same_day_multiple_claims"] = np.clip(num("same_day_claims"), 0, 20)

    f["duplicate_similarity"] = np.clip(num("duplicate_similarity"), 0, 1)
    f["diag_proc_match"] = np.clip(num("diag_proc_match", 1.0), 0, 1)
    f["age_service_mismatch"] = np.clip(num("age_service_mismatch"), 0, 1)
    f["diagnosis_severity_score"] = np.clip(num("diagnosis_severity", 0.5), 0, 1)

    f["submission_lag_days"] = np.clip(num("submission_lag_days", 3.0), 0, 400)
    f["is_weekend_submission"] = num("is_weekend_submission").astype(int).clip(0, 1)

    f["provider_specialty_risk"] = specialty.map(SPECIALTY_RISK).fillna(0.4).astype(float)
    f["provider_license_age_years"] = np.clip(num("provider_license_age_years", 8.0), 0, 60)
    f["provider_fraud_history"] = np.clip(num("provider_fraud_history"), 0, 25)
    f["provider_network_status"] = np.clip(num("provider_in_network", 1.0), 0, 1)
    f["distance_member_provider_km"] = np.clip(num("distance_km", 12.0), 0, 3000)

    f["member_age"] = np.clip(num("member_age", 40.0), 0, 110)
    f["member_chronic_conditions"] = np.clip(num("chronic_conditions"), 0, 15)
    f["policy_age_months"] = np.clip(num("policy_age_months", 24.0), 0, 400)
    f["premium_to_billed_ratio"] = np.clip(
        amount.to_numpy() / np.maximum(num("annual_premium", 30000.0).to_numpy(), 1.0), 0, 60
    )

    f["claim_type_risk"] = claim_type.map(CLAIM_TYPE_RISK).fillna(0.4).astype(float)
    f["is_emergency"] = num("is_emergency").astype(int).clip(0, 1)

    qty = num("pharmacy_qty", 1.0)
    refill = num("pharmacy_refill_days", 30.0).replace(0, 30.0)
    f["pharmacy_qty_ratio"] = np.clip((qty.to_numpy() + 1) / (refill.to_numpy() + 1), 0, 30)

    out = pd.DataFrame({k: np.asarray(v, dtype="float64") for k, v in f.items()})

    # Guarantee the canonical column order and no NaN/inf leaks.
    for col in FEATURES:
        if col not in out.columns:
            out[col] = 0.0
    out = out[FEATURES].replace([np.inf, -np.inf], 0.0).fillna(0.0)
    return out


def humanize_feature(name: str) -> str:
    """Readable label for the UI."""
    return {
        "amount_billed": "Billed amount (log)",
        "approved_ratio": "Approved / billed ratio",
        "billed_vs_peer_ratio": "Billed vs provider peer average",
        "amount_zscore_specialty": "Amount vs specialty benchmark (z-score)",
        "procedure_avg_cost_ratio": "Procedure cost vs benchmark",
        "units_claimed": "Units claimed",
        "service_days": "Service days",
        "nights_in_hospital": "Nights in hospital",
        "los_expected_ratio": "Length of stay vs expected",
        "num_procedures": "Number of procedures",
        "prior_claims_30d_member": "Member claims in last 30 days",
        "member_claim_frequency_12m": "Member claim frequency (12m)",
        "provider_claims_30d": "Provider claim volume (30d)",
        "same_day_multiple_claims": "Same-day multiple claims",
        "duplicate_similarity": "Duplicate claim similarity",
        "diag_proc_match": "Diagnosis-procedure consistency",
        "age_service_mismatch": "Age-service mismatch",
        "diagnosis_severity_score": "Diagnosis severity",
        "submission_lag_days": "Submission lag (days)",
        "is_weekend_submission": "Weekend submission",
        "provider_specialty_risk": "Provider specialty risk prior",
        "provider_license_age_years": "Provider licence age",
        "provider_fraud_history": "Provider fraud history",
        "provider_network_status": "In-network provider",
        "distance_member_provider_km": "Member-provider distance",
        "member_age": "Member age",
        "member_chronic_conditions": "Chronic conditions",
        "policy_age_months": "Policy age (months)",
        "premium_to_billed_ratio": "Billed vs annual premium",
        "claim_type_risk": "Claim type risk prior",
        "is_emergency": "Emergency admission",
        "pharmacy_qty_ratio": "Pharmacy quantity / refill ratio",
    }.get(name, name.replace("_", " ").title())
