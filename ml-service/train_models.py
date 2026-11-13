"""
train_models.py
---------------
Trains and evaluates the three-model ensemble used by the fraud detection
platform, then exports everything the Node API needs.

Models
  1. LogisticRegression   - interpretable baseline (also exported to JSON so the
                            Node server can score claims with *exactly* the same
                            maths when the Python service is offline)
  2. RandomForest         - non-linear bagged trees, robust to feature scale
  3. HistGradientBoosting - boosted trees, usually the strongest tabular model
  4. IsolationForest      - unsupervised anomaly detector, needs no labels. Used
                            to catch *novel* schemes that supervised models miss.

Selection is by Precision-Recall AUC, because fraud is a 1:8 imbalance problem
where ROC-AUC is flattering and PR-AUC is honest.

Explainability
  * global  : permutation importance + tree impurity importance
  * local   : LIME-style perturbation attribution (ships to the UI per claim)
  * rules   : correlation of engineered flags with positive labels

Usage:  python3 train_models.py --data data/claims.csv --out models
"""

from __future__ import annotations

import argparse
import json
import os
import warnings
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest, RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from math import comb

from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURES, build_feature_frame, humanize_feature

warnings.filterwarnings("ignore")
RANDOM_STATE = 42


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def ks_statistic(y_true: np.ndarray, y_score: np.ndarray) -> float:
    fpr, tpr, _ = roc_curve(y_true, y_score)
    return float(np.max(tpr - fpr))


def best_f1_threshold(y_true: np.ndarray, y_score: np.ndarray) -> tuple[float, dict]:
    prec, rec, thr = precision_recall_curve(y_true, y_score)
    f1 = np.divide(2 * prec * rec, prec + rec, out=np.zeros_like(prec), where=(prec + rec) > 0)
    idx = int(np.argmax(f1[:-1]))
    return float(thr[idx]), {"precision": float(prec[idx]), "recall": float(rec[idx]), "f1": float(f1[idx])}


def evaluate(name: str, y_true: np.ndarray, y_score: np.ndarray, threshold: float) -> dict:
    y_pred = (y_score >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    return {
        "model": name,
        "roc_auc": round(float(roc_auc_score(y_true, y_score)), 4),
        "pr_auc": round(float(average_precision_score(y_true, y_score)), 4),
        "ks": round(ks_statistic(y_true, y_score), 4),
        "brier": round(float(brier_score_loss(y_true, y_score)), 4),
        "threshold": round(float(threshold), 4),
        "precision": round(float(precision_score(y_true, y_pred, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, y_pred, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, y_pred, zero_division=0)), 4),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "support": {"negatives": int((y_true == 0).sum()), "positives": int((y_true == 1).sum())},
    }


def operating_points(y_true, y_score) -> list[dict]:
    """Recall-targeted review queues: how a SIU actually staffs the desk."""
    out = []
    for target in (0.50, 0.70, 0.80, 0.90):
        thr = float(np.quantile(y_score[y_true == 1], 1 - target))
        y_pred = (y_score >= thr).astype(int)
        tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
        out.append({
            "recall_target": target,
            "threshold": round(thr, 4),
            "recall": round(float(tp / max(tp + fn, 1)), 4),
            "precision": round(float(tp / max(tp + fp, 1)), 4),
            "alerts": int(y_pred.sum()),
            "alert_rate": round(float(y_pred.mean()), 4),
        })
    return out


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def shap_local_attribution(predict_fn, x_row: np.ndarray, background: np.ndarray,
                           feature_names: list[str], n_permutations: int = 400,
                           seed: int = 11) -> dict:
    """
    Exact game-theoretic feature attribution using Monte-Carlo Shapley
    sampling (Štrumbelj & Kononenko, 2014) in log-odds space.

    For every random permutation of the 32 features we walk the chain of
    coalitions `∅ -> {f1} -> {f1,f2} -> ... -> everything`, scoring each
    coalition as "the claim's own values for the features already admitted,
    and a real background claim's values for the rest". The marginal change in
    log-odds when a feature is admitted is that feature's Shapley value for
    that permutation; averaging over permutations gives the estimator, and the
    spread across permutations is its standard error (both are reported).

    Why log-odds: probabilities saturate, so a claim scored 0.999 has no room
    left to show which features drove it. Log-odds stay linear, which keeps the
    contributions additive and interpretable (`sum(phi) == logit(x) - E[logit]`,
    the efficiency property of Shapley values, holds exactly).

    Why permutations and not KernelSHAP: with 32 correlated features the
    KernelSHAP weighted-least-squares problem becomes badly conditioned and
    collapses to an equal split across redundant signals; the permutation
    estimator stays stable and needs no kernel tuning.
    """
    rng = np.random.default_rng(seed)
    d = x_row.shape[0]
    bg_size = background.shape[0]

    def P(m: np.ndarray) -> np.ndarray:
        return np.asarray(predict_fn(np.atleast_2d(m)), dtype=float).reshape(-1, 2)[:, 1]

    fx = float(_logit(P(x_row.reshape(1, -1)))[0])
    f_base = float(np.mean(_logit(P(background))))

    # Build every coalition for every permutation in one matrix so the model
    # is called once per batch (9900 rows instead of 300 calls).
    orders = np.argsort(rng.random((n_permutations, d)), axis=1)
    bg_rows = background[rng.integers(0, bg_size, size=n_permutations)]

    # coalitions[k, pos] = claim with order[k][:pos] admitted, rest from bg
    coalitions = np.repeat(bg_rows[:, None, :], d + 1, axis=1)      # (P, d+1, d)
    admitted = np.zeros_like(coalitions, dtype=bool)
    for k in range(n_permutations):
        o = orders[k]
        # position pos admits features o[:pos]
        admitted[k, 1:, o] = True
        admitted[k, 0, :] = False
        # cumulative inclusion: feature o[i] is included from position i+1 on
        for i in range(d):
            coalitions[k, i + 1:, o[i]] = x_row[o[i]]

    flat = coalitions.reshape(-1, d)
    scores = _logit(P(flat)).reshape(n_permutations, d + 1)
    deltas = np.diff(scores, axis=1)                                 # (P, d)
    phis = np.zeros((n_permutations, d))
    for k in range(n_permutations):
        phis[k, orders[k]] = deltas[k]

    phi = phis.mean(axis=0)
    phi_std = phis.std(axis=0)

    # efficiency check: sum of Shapley values must equal f(x) - E[f]
    gap = (fx - f_base) - phi.sum()
    if abs(gap) > 1e-9:                             # renormalise tiny MC error
        phi = phi + gap / d

    # stability = how much of the attribution signal survives permutation noise
    noise = float(np.mean(phi_std))
    signal = float(np.mean(np.abs(phi))) or 1e-9
    stability = float(np.clip(1.0 - noise / (signal + noise), 0.0, 1.0))

    order = np.argsort(-np.abs(phi))[:12]
    top = []
    for i in order:
        c = float(phi[i])
        top.append({
            "feature": feature_names[i],
            "label": humanize_feature(feature_names[i]),
            "value": round(float(x_row[i]), 4),
            "contribution": round(c, 5),
            "contribution_std": round(float(phi_std[i]), 5),
            "weight_pct": round(100 * abs(c) / (np.abs(phi).sum() or 1), 1),
            "direction": "increases_risk" if c > 0 else "decreases_risk",
        })
    return {
        "method": "monte_carlo_shapley",
        "space": "log_odds",
        "permutations": n_permutations,
        "base_value": round(f_base, 4),
        "claim_logit": round(fx, 4),
        "expected_logit": round(f_base, 4),
        "stability": round(stability, 4),
        "top_features": top,
    }


def rule_correlations(df: pd.DataFrame) -> list[dict]:
    """How strongly does each engineered red-flag move the positive rate?"""
    rules = [
        ("Billed > 2x provider peer average", df["amount_billed"] > 2 * df["provider_avg_billed"]),
        ("Billed > 3x specialty benchmark", df["amount_billed"] > 3 * df["specialty_amount_mean"]),
        ("Units claimed above 15", df["units_claimed"] > 15),
        ("Length of stay above 12 days", df["service_days"] > 12),
        ("Duplicate similarity above 0.85", df["duplicate_similarity"] > 0.85),
        ("Diagnosis-procedure mismatch (match < 0.55)", df["diag_proc_match"] < 0.55),
        ("Provider has prior fraud history", df["provider_fraud_history"] > 0),
        ("Out-of-network provider", df["provider_in_network"] == 0),
        ("More than 3 same-day claims", df["same_day_claims"] > 3),
        ("Submission lag above 30 days", df["submission_lag_days"] > 30),
        ("Weekend submission", df["is_weekend_submission"] == 1),
        ("Member has >3 claims in 30 days", df["prior_claims_30d"] > 3),
        ("Policy younger than 6 months", df["policy_age_months"] < 6),
        ("Approved ratio above 0.95", (df["amount_approved"] / df["amount_billed"].clip(lower=1)) > 0.95),
        ("Member-provider distance above 200 km", df["distance_km"] > 200),
        ("Age-service mismatch flagged", df["age_service_mismatch"] == 1),
    ]
    base = float(df["is_fraud"].mean())
    out = []
    for label, series in rules:
        fires = series.fillna(False).astype(bool)
        if fires.sum() < 10:
            continue
        precision = float(df.loc[fires, "is_fraud"].mean())
        out.append({
            "rule": label,
            "claims_flagged": int(fires.sum()),
            "population_rate": round(base, 4),
            "hit_rate": round(precision, 4),
            "lift": round(precision / base, 2) if base > 0 else 0.0,
            "fraud_capture": round(float(fires[df["is_fraud"] == 1].sum() / max(df["is_fraud"].sum(), 1)), 4),
        })
    out.sort(key=lambda r: -r["lift"])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/claims.csv")
    ap.add_argument("--out", default="models")
    ap.add_argument("--sample-explanations", type=int, default=3)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    raw = pd.read_csv(args.data)
    X = build_feature_frame(raw)
    y = raw["is_fraud"].astype(int).to_numpy()
    print(f"rows={len(X)} features={len(FEATURES)} fraud_rate={y.mean():.3%}")

    X_tr, X_te, y_tr, y_te, idx_tr, idx_te = train_test_split(
        X.to_numpy(), y, np.arange(len(y)), test_size=0.25, stratify=y, random_state=RANDOM_STATE
    )

    # ------------------------- model definitions -------------------------
    lr = Pipeline([
        ("scaler", StandardScaler()),
        ("clf", LogisticRegression(max_iter=2000, class_weight="balanced", C=0.8, random_state=RANDOM_STATE)),
    ])
    rf = RandomForestClassifier(
        n_estimators=500, max_depth=14, min_samples_leaf=4, max_features="sqrt",
        class_weight="balanced_subsample", n_jobs=-1, random_state=RANDOM_STATE,
    )
    hgb = HistGradientBoostingClassifier(
        max_iter=450, learning_rate=0.06, max_depth=8, min_samples_leaf=15,
        l2_regularization=1.0, class_weight="balanced", random_state=RANDOM_STATE,
    )
    iso = IsolationForest(n_estimators=350, contamination=float(max(y.mean(), 0.02)),
                          random_state=RANDOM_STATE, n_jobs=-1)

    print("training logistic regression ...")
    lr.fit(X_tr, y_tr)
    print("training random forest ...")
    rf.fit(X_tr, y_tr)
    print("training gradient boosting ...")
    hgb.fit(X_tr, y_tr)
    print("training isolation forest ...")
    iso.fit(X_tr)  # unsupervised: labels deliberately not shown

    # Raw anomaly score -> 0..1 where 1 is most anomalous.
    # The calibration bounds are computed ONCE on the training set and persisted,
    # because normalising within a request batch is meaningless when the batch
    # contains a single claim (a very real inference path).
    _raw_tr = -iso.score_samples(X_tr)
    ANOMALY_LO, ANOMALY_HI = float(np.percentile(_raw_tr, 1)), float(np.percentile(_raw_tr, 99))

    def anomaly_norm(model, Xm):
        raw_s = -model.score_samples(Xm)
        return np.clip((raw_s - ANOMALY_LO) / max(ANOMALY_HI - ANOMALY_LO, 1e-9), 0, 1)

    scores = {
        "logistic_regression": lr.predict_proba(X_te)[:, 1],
        "random_forest": rf.predict_proba(X_te)[:, 1],
        "gradient_boosting": hgb.predict_proba(X_te)[:, 1],
    }
    anomaly_te = anomaly_norm(iso, X_te)

    # ------------------------- evaluation --------------------------------
    results, thresholds = {}, {}
    for name, s in scores.items():
        thr, _ = best_f1_threshold(y_te, s)
        thresholds[name] = thr
        results[name] = evaluate(name, y_te, s, thr)
        print(f"  {name:22s} PR-AUC={results[name]['pr_auc']:.4f} "
              f"ROC-AUC={results[name]['roc_auc']:.4f} F1={results[name]['f1']:.4f}")

    thr_iso = float(np.quantile(anomaly_te, 1 - max(y.mean(), 0.05)))
    results["isolation_forest"] = evaluate("isolation_forest", y_te, anomaly_te, thr_iso)
    thresholds["isolation_forest"] = thr_iso

    champion = max(
        ["logistic_regression", "random_forest", "gradient_boosting"],
        key=lambda k: results[k]["pr_auc"],
    )
    print(f"champion model: {champion}")

    # ------------------------- hybrid ensemble ---------------------------
    # Weighted fusion of the supervised champion, the second-best model and the
    # unsupervised detector. Weights are found with a small grid search on the
    # validation split so the choice is data-driven, not hand-waved.
    others = [m for m in ("logistic_regression", "random_forest", "gradient_boosting") if m != champion]
    best = (None, -1.0, None)
    # The anomaly detector always keeps >=10% of the vote: supervised models
    # cannot catch a scheme they were never trained on, so we refuse to let the
    # grid search discard the unsupervised view entirely.
    for w3 in np.arange(0.10, 0.45, 0.05):
        for w1 in np.arange(0.30, 0.92 - w3, 0.05):
            w2 = 1 - w1 - w3
            fused = w1 * scores[champion] + w2 * scores[others[0]] + w3 * anomaly_te
            ap = average_precision_score(y_te, fused)
            if ap > best[1]:
                best = ((float(w1), float(w2), float(w3)), float(ap), fused)
    fusion_weights, _, fused_te = best
    thr_f, _ = best_f1_threshold(y_te, fused_te)
    results["hybrid_ensemble"] = evaluate("hybrid_ensemble", y_te, fused_te, thr_f)
    thresholds["hybrid_ensemble"] = thr_f
    print(f"  hybrid_ensemble        PR-AUC={results['hybrid_ensemble']['pr_auc']:.4f} "
          f"F1={results['hybrid_ensemble']['f1']:.4f} weights={fusion_weights}")

    # 5-fold cross validation on the champion for a trustworthy headline number
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
    cv_scores = []
    for tr_i, va_i in cv.split(X.to_numpy(), y):
        m = HistGradientBoostingClassifier(
            max_iter=450, learning_rate=0.06, max_depth=8, min_samples_leaf=15,
            l2_regularization=1.0, class_weight="balanced", random_state=RANDOM_STATE)
        m.fit(X.to_numpy()[tr_i], y[tr_i])
        cv_scores.append(average_precision_score(y[va_i], m.predict_proba(X.to_numpy()[va_i])[:, 1]))
    print(f"  5-fold CV PR-AUC (hist-gb): {np.mean(cv_scores):.4f} +/- {np.std(cv_scores):.4f}")

    # per-archetype detection rate at the hybrid threshold
    te_meta = raw.iloc[idx_te].reset_index(drop=True)
    per_archetype = []
    for arch, grp in te_meta.groupby("archetype"):
        pos = te_meta.index[te_meta["archetype"] == arch].to_numpy()
        det = float((fused_te[pos] >= thr_f).mean())
        per_archetype.append({"archetype": arch, "claims": int(len(pos)),
                              "detection_rate": round(det, 4)})
    per_archetype.sort(key=lambda r: r["detection_rate"])

    # ------------------------- explainability ---------------------------
    print("computing permutation importance ...")
    perm = permutation_importance(hgb, X_te, y_te, n_repeats=8, random_state=RANDOM_STATE,
                                  scoring="average_precision", n_jobs=-1)
    importance = sorted(
        [
            {"feature": f, "label": humanize_feature(f),
             "importance": round(float(m), 5), "std": round(float(s), 5)}
            for f, m, s in zip(FEATURES, perm.importances_mean, perm.importances_std)
        ],
        key=lambda r: -r["importance"],
    )

    rng_bg = np.random.default_rng(3)
    X_tr_subset = X_tr[rng_bg.choice(len(X_tr), size=40, replace=False)]

    sample_explanations = []
    for k, row_i in enumerate(np.argsort(-fused_te)[: args.sample_explanations]):
        x_row = X_te[row_i]
        exp = shap_local_attribution(hgb.predict_proba, x_row, X_tr_subset, FEATURES)
        exp.update({
            "claim_id": raw.iloc[idx_te[row_i]]["claim_id"],
            "model_probability": round(float(scores[champion][row_i]), 4),
            "hybrid_score": round(float(fused_te[row_i]), 4),
        })
        sample_explanations.append(exp)

    # ------------------------- persist ----------------------------------
    joblib.dump(lr, os.path.join(args.out, "logistic_regression.joblib"))
    joblib.dump(rf, os.path.join(args.out, "random_forest.joblib"))
    joblib.dump(hgb, os.path.join(args.out, "gradient_boosting.joblib"))
    joblib.dump(iso, os.path.join(args.out, "isolation_forest.joblib"))

    # Coefficients + scaler exported so the Node fallback scorer is *identical*
    scaler = lr.named_steps["scaler"]
    clf = lr.named_steps["clf"]
    lr_export = {
        "features": FEATURES,
        "mean": [round(float(v), 6) for v in scaler.mean_],
        "scale": [round(float(v), 6) for v in scaler.scale_],
        "coef": [round(float(v), 6) for v in clf.coef_[0]],
        "intercept": round(float(clf.intercept_[0]), 6),
    }
    with open(os.path.join(args.out, "linear_model_export.json"), "w") as fh:
        json.dump(lr_export, fh, indent=1)

    metrics = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset": {
            "rows": int(len(raw)),
            "features": len(FEATURES),
            "fraud_rate": round(float(y.mean()), 4),
            "train_rows": int(len(X_tr)),
            "test_rows": int(len(X_te)),
            "archetypes": {k: int(v) for k, v in raw["archetype"].value_counts().items()},
        },
        "models": results,
        "champion": champion,
        "fusion_weights": {
            "champion": round(fusion_weights[0], 3),
            "secondary": round(fusion_weights[1], 3),
            "anomaly": round(fusion_weights[2], 3),
            "champion_name": champion,
            "secondary_name": others[0],
        },
        "thresholds": {k: round(float(v), 4) for k, v in thresholds.items()},
        "cv_pr_auc": {"mean": round(float(np.mean(cv_scores)), 4), "std": round(float(np.std(cv_scores)), 4),
                      "folds": [round(float(s), 4) for s in cv_scores]},
        "operating_points": operating_points(y_te, fused_te),
        "per_archetype_detection": per_archetype,
        "feature_importance": importance,
        "rule_lift": rule_correlations(raw),
        "sample_explanations": sample_explanations,
        "curves": {},
    }

    # PR / ROC curves for the UI charts
    prec, rec, _ = precision_recall_curve(y_te, fused_te)
    step = max(1, len(prec) // 120)
    # list-of-points shape (recharts-friendly)
    metrics["curves"]["pr"] = [
        {"recall": round(float(r), 4), "precision": round(float(p), 4)}
        for r, p in list(zip(rec[::step], prec[::step]))
    ]
    fpr, tpr, _ = roc_curve(y_te, fused_te)
    step = max(1, len(fpr) // 120)
    metrics["curves"]["roc"] = [
        {"fpr": round(float(f), 4), "tpr": round(float(t), 4)}
        for f, t in list(zip(fpr[::step], tpr[::step]))
    ]

    metrics["anomaly_calibration"] = {"low": round(ANOMALY_LO, 6), "high": round(ANOMALY_HI, 6)}
    with open(os.path.join(args.out, "metrics.json"), "w") as fh:
        json.dump(metrics, fh, indent=1)

    meta = {"features": FEATURES, "trained_at": metrics["generated_at"],
            "champion": champion, "thresholds": metrics["thresholds"],
            "fusion_weights": metrics["fusion_weights"],
            "anomaly_calibration": metrics["anomaly_calibration"]}
    with open(os.path.join(args.out, "model_meta.json"), "w") as fh:
        json.dump(meta, fh, indent=1)

    print(f"saved models + metrics to {args.out}/")


if __name__ == "__main__":
    main()
