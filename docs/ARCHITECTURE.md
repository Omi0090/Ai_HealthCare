# Architecture & Design Decisions

## 1. Why a three-tier (polyglot) split?

The requested stack is MERN. Two facts shaped the design:

1. **The ML lives in Python.** Tabular ML (scikit-learn, calibration, Shapley attribution) is a
   Python-first ecosystem. Re-implementing gradient boosting in JavaScript would be worse on every axis.
2. **Payers really do run model servers separately.** Production fraud platforms keep the inference
   service isolated so it can be redeployed, versioned and scaled without touching the API tier.

So: **React (client) → Express (application/API) → FastAPI (inference) → MongoDB (state)**.
The browser only ever talks to Express through a Vite dev proxy, which also makes the app work
behind the sandbox's origin-restricted preview host.

## 2. The scoring pipeline (one claim, end to end)

```
POST /api/claims/preview
        │
        ├─ 1. Resolve provider + member from the store (peer averages, history, policy age)
        │
        ├─ 2. Build the 32-feature vector            server/src/services/featureService.js
        │        — identical formulas to ml-service/features.py
        │
        ├─ 3. Score                                 server/src/services/mlService.js
        │        ├─ POST :8000/predict  -> GBM + RF + LogReg + IsolationForest
        │        └─ on failure: replay exported LogReg coefficients locally
        │
        ├─ 4. Evaluate 17 red-flag rules            server/src/services/ruleEngine.js
        │
        ├─ 5. Fuse                                  server/src/services/riskService.js
        │        risk = 0.60·model + 0.30·rules + 0.10·anomaly
        │             + consensus bonus (all models ≥ 0.7  ->  +0.04)
        │             + decisive-rule floor (dup/age-mismatch/units  ->  ≥ 0.66 / 0.82)
        │
        ├─ 6. Explain                               ml-service (Monte-Carlo Shapley, log-odds)
        │
        └─ 7. Persist (only on POST /claims) + audit log
```

### Feature engineering is a shared contract

`FEATURES` is an ordered list duplicated in three places by necessity:
`ml-service/features.py`, `server/src/services/featureService.js`, and the saved `.joblib` models.
Order changes break the models, so:

* `features.py` is the source of truth and orders the DataFrame explicitly at the end of
  `build_feature_frame()`;
* `ml-service/tests/test_pipeline.py::test_feature_frame_is_ordered_and_finite` asserts the order;
* any change must be mirrored in `featureService.js` (documented at the top of both files).

## 3. Why the fusion weights, and why a rule floor?

The weights (60/30/10) were tuned on validation and are exposed as env vars (`W_MODEL`, `W_RULES`,
`W_ANOMALY`) so an SIU can shift the emphasis without a code change.

The **decisive-rule floor** exists because of a concrete failure mode found during development:
the ensemble consistently under-scored *near-duplicate* claims. A duplicate bill is low-prevalence,
low-variance evidence — a tree ensemble barely moves on it. Operationally, though, a 90%-similar
resubmission is actionable on its own. So three rules (near-duplicate, impossible age-service
combination, 15+ billed units) can force a minimum score. `provider fraud history` was deliberately
*excluded* from this set after measurement: ~20% of providers carry a historic finding, so flooring on
it flooded the queue with false positives (precision collapsed from 74% to 33%).

That measurement is the clearest example in this project of "the model is not the system".

## 4. Explainability: why Monte-Carlo Shapley, and why log-odds

Attribution was rewritten twice during development, which is worth documenting because each failure
is a real trap:

| Attempt | Result | Why it failed |
|---|---|---|
| LIME (ridge on masked neighbours) | Fidelity 0.13–0.45 | Tree ensembles are discontinuous under hard feature deletion |
| KernelSHAP (weighted least squares) | "Fidelity" 0.99 but equal 1/32 attribution per feature | With 32 correlated features the weighted design matrix is ill-conditioned (cond ≈ 3×10⁴); the regularised solve collapses to the minimum-norm solution |
| KernelSHAP with *sampled real background rows* | Same collapse | Condition number is a property of the mask design, not the baseline |
| **Monte-Carlo permutation Shapley, 400 permutations, real background rows** | Stable, claim-specific, `Σφ = logit(x) − E[logit]` holds | ✔ |

Two details matter:

* **Log-odds space.** Probabilities saturate: a claim at 0.999 has no room to show *which* feature
  pushed it there. Log-odds stay additive, so contributions are interpretable and the efficiency
  property is exact (asserted in `test_shapley_efficiency_property`).
* **Real background claims, not the feature mean.** The mean of 32 features is a fictional claim
  off the data manifold; scoring it produces meaningless marginals.

## 5. Why the synthetic generator has severity + signal dropout

The first dataset produced **PR-AUC 1.0000** — a red flag, not a triumph. Diagnosis: each fraud
archetype wrote a deterministic fingerprint into the features (`provider_claims_30d` alone had
ROC-AUC 0.98), so the model simply learned the generator.

Three fixes made the problem real:

1. **Benign data-quality noise** on legitimate claims (5% coding drift, 4.5% honest resubmissions,
   3% age-service mismatches) — real ledgers are messy.
2. **Graded severity** — `severity ~ Beta(1.7, 2.5)`, and the distorted fields are interpolated
   between the honest baseline and the full-strength scheme. The same archetype can be a whisper or a scream.
3. **Independent signal dropout** — each distorted signal is withheld with probability 0.3, so a fraud
   claim triggers only a *subset* of its usual red flags. This produces partially-observable evidence,
   which is what an investigator actually works with.

Result: max single-feature ROC-AUC fell to 0.77, PR-AUC to 0.72, and per-scheme detection rates
became genuinely heterogeneous (97% for phantom billing, 18% for subtle upcoding). That spread is the
most defensible finding in the project.

## 6. Data layer: MongoDB first, JSON store as a safety net

`server/src/db/store.js` picks a backend at boot:

* `MONGO_URI` reachable → Mongoose models from `src/models/index.js` (production path)
* otherwise → `MemoryStore`, a JSON-file document store implementing the *same* interface
  (`insert/find/findOne/count/updateOne/pushToArray/aggregate/deleteMany/distinct`) with
  `$gte/$lte/$in/$regex/$or` and per-collection unique keys mirroring the Mongoose `unique: true`
  declarations.

Rationale: a final-year project must run with `npm install && npm start`. The store reports its kind at
`/api/health`, and the README states plainly that the JSON backend is a demo fallback, not a
production substitute. Because the interface is shared, no route or service knows which is live —
which is also why the 14 integration tests need no database server.

## 7. Security

| Concern | Mitigation |
|---|---|
| Credentials | bcrypt (cost 12), passwords never serialised (`select: false`) |
| Sessions | JWT, 12 h expiry, re-validated against the user record on every request (so disabling an account takes effect immediately) |
| Authorisation | Role guard middleware: `admin`, `investigator`, `analyst`, `viewer` |
| Input validation | Zod schemas; failures become clean 400s with field-level detail |
| Abuse | `express-rate-limit` (600 req/min/IP), `helmet`, CORS restricted to the app origin |
| Accountability | Every mutation writes an audit entry with actor, role, target, IP |
| PHI | The dataset is synthetic; no real patient data exists in this repo |

## 8. Scaling notes (what would change in production)

* Scoring is synchronous in-request. At payer volume it belongs on a queue (Kafka / BullMQ) with
  idempotent workers and a dead-letter topic.
* The JSON store's `find()` is O(n) per query; MongoDB indexes are already declared
  (`claimId`, `providerId + serviceDate`, `memberId + serviceDate`, `riskScore + status`).
* Model versioning should move to MLflow with the model URI stored on each claim
  (`modelVersion` already exists in the schema for exactly this reason).
* The network explorer recomputes layout client-side for ≤ 800 nodes; beyond that, run layout server-side
  (igraph/networkx) or swap in a WebGL renderer.
