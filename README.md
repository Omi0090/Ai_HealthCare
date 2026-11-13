# 🛡️ MedGuard AI — AI-Based Healthcare Insurance Fraud Detection

A **full-stack, working** web application for detecting fraudulent healthcare insurance claims.
Built on the **MERN stack** (MongoDB · Express · React · Node.js) with a **Python/scikit-learn
ML microservice** that scores every claim, explains its decision with Shapley values, and feeds a
complete Special Investigation Unit (SIU) workflow.

> Final-year B.Tech project · fully synthetic dataset (no real patient data) · runs offline.

---

## 1. What it does

| Capability | Detail |
|---|---|
| **Real-time claim scoring** | 32 engineered features → 4 ML models → fused risk score in < 400 ms |
| **Explainable AI** | Monte-Carlo Shapley attribution per claim, in log-odds space, with stability scores |
| **Hybrid detection** | Supervised (GBM/RF/LogReg) **+** unsupervised Isolation Forest → catches schemes never seen in training |
| **In-app project overview** | `/about` summarises the pipeline, live system state, dataset and limitations — written for the viva |
| **Deterministic rule engine** | 17 auditable red-flag rules that run *alongside* the model, with measured lift per rule |
| **Investigation workflow** | Flagged claim → case → findings → decision → provider risk feedback loop |
| **Provider risk scoring** | Combines mean claim risk, 90th-percentile risk and flag volume (the classic "few blatant claims among many normal" profile) |
| **Collusion network explorer** | Force-directed provider ⇄ member bipartite graph; thick repeated edges = ring |
| **Analytics** | Per-scheme detection rates, geographic exposure, specialty league tables, PR/ROC curves, operating points |
| **Governance** | JWT auth, 4 RBAC roles, rate limiting, immutable audit trail |

### Fraud schemes modelled

The synthetic payer ledger contains **7 documented fraud archetypes** plus legitimate care,
each with a **graded severity** and **independent signal dropout** (so the model cannot learn one
perfect rule per scheme — exactly like reality):

| Scheme | What it is |
|---|---|
| **Upcoding** | Billing a costlier procedure code than the care delivered |
| **Phantom billing** | Services never rendered — impossible units, volume and approval rates |
| **Duplicate billing** | The same claim re-submitted with small edits |
| **Unbundling** | One bundled procedure billed as many separately-charged components |
| **Length-of-stay inflation** | Hospital days stretched beyond medical necessity |
| **Collusion ring** | Provider + member transacting far more often than chance |
| **Identity misuse** | Policy details inconsistent with the service performed |

---

## 2. Architecture

```
┌──────────────────────────┐        ┌───────────────────────────┐        ┌────────────────────────┐
│   React 18 + Vite        │  /api  │   Express + Mongoose      │  HTTP  │  FastAPI + scikit-learn│
│   Tailwind · Recharts    │ ─────► │   JWT · RBAC · Zod        │ ─────► │  GBM · RF · LogReg ·   │
│   Port 5173 (proxy)      │        │   Port 5000               │        │  IsolationForest       │
└──────────────────────────┘        └────────────┬──────────────┘        │  Port 8000             │
                                                 │                       └────────────────────────┘
                                    ┌────────────▼──────────────┐                    ▲
                                    │  MongoDB (or JSON store)  │                    │
                                    │  claims · providers ·     │   linear_model_export.json
                                    │  members · cases · audit  │   (faithful offline fallback)
                                    └───────────────────────────┘
```

**Two-tier ML design.** The Node API calls the Python service first. If it is unreachable, it
replays the *exported* logistic-regression coefficients (`ml-service/models/linear_model_export.json`)
— the identical maths scikit-learn uses — so the API never returns "AI unavailable". The UI labels
which tier produced the score.

**Database fallback.** If `MONGO_URI` is unreachable, the API transparently switches to a
MongoDB-compatible JSON document store (`server/.data/db.json`) implementing the same query
operators. This means `npm install && npm start` always works, even on a laptop without MongoDB.
Set `MONGO_URI` to use real MongoDB — nothing else changes.

---

## 3. Quick start

### One command (recommended)

```bash
./scripts/dev.sh
```

That installs dependencies, generates the dataset, trains the models, seeds the database and
starts all three services. Then open **http://localhost:5173**.

### Manual (four terminals)

```bash
# 0 · prerequisites: Node 18+, Python 3.10+
python3 -m venv .venv && source .venv/bin/activate
pip install -r ml-service/requirements.txt

# 1 · ML service  (dataset generation + training is part of this step)
cd ml-service
python data/generate_dataset.py          # ~9,000 synthetic claims
python train_models.py                   # trains + evaluates + exports
uvicorn app:app --host 0.0.0.0 --port 8000

# 2 · API server
cd server
cp .env.example .env
npm install
npm run seed                             # loads the ledger, scores every claim
npm start                                # http://localhost:5000/api

# 3 · React client
cd client
npm install
npm run dev                              # http://localhost:5173
```

> **MongoDB (optional but recommended for the report).** Install MongoDB locally and set
> `MONGO_URI=mongodb://127.0.0.1:27017/medguard` in `server/.env`. The API will report
> `database: mongodb` at `/api/health`. Without it, the JSON store is used automatically.

### Demo login

| Email | Role | Password |
|---|---|---|
| `admin@medguard.ai` | Admin | `MedGuard@2024` |
| `investigator@medguard.ai` | Investigator | `MedGuard@2024` |
| `analyst@medguard.ai` | Analyst | `MedGuard@2024` |
| `viewer@medguard.ai` | Viewer | `MedGuard@2024` |

---

## 4. Model performance

Held-out test set: 2,250 claims (25% split, stratified), fraud prevalence **10.3%**.

| Model | PR-AUC | ROC-AUC | F1 | Precision | Recall |
|---|---|---|---|---|---|
| Logistic Regression | 0.641 | 0.860 | 0.610 | 0.675 | 0.556 |
| Random Forest | 0.660 | 0.874 | 0.621 | 0.724 | 0.543 |
| **Histogram Gradient Boosting** ⭐ | **0.719** | **0.882** | **0.681** | **0.735** | **0.634** |
| Isolation Forest (unsupervised) | 0.312 | 0.732 | 0.332 | 0.332 | 0.332 |
| **Hybrid ensemble (production)** | **0.721** | 0.878 | **0.685** | **0.783** | **0.608** |

5-fold cross-validated PR-AUC of the champion: **0.730 ± 0.020**.
Ensemble fusion weights found by validation grid search: champion 0.75 · secondary 0.15 · anomaly 0.10.

After rule-engine fusion and thresholding at 0.62, the deployed system operating on the full ledger:

```
claims: 9,000 · actually fraudulent: 928 (10.3%)
flagged for review: 842 (9.4%)   ← a human-reviewable queue
precision: 74.8%                 ← 3 in 4 reviews find real fraud
recall:    67.9%                 ← 2 in 3 fraudulent claims are caught
```

The review queue is deliberately sized to what a real SIU can actually work: escalating 9% of a
portfolio is aggressive but staffable; escalating 25% (what the raw model threshold produces) is not.
`GET /model-info` exposes the full operating-point table so that trade-off can be re-argued.

Per-scheme detection rates (the number that matters operationally):

| Scheme | Detected |
|---|---|
| Phantom billing | 97% |
| Collusion ring | 92% |
| Length-of-stay inflation | 61% |
| Unbundling | 52% |
| Identity misuse | 33% |
| Duplicate billing | 30% |
| Upcoding | 18% |

*Low-severity upcoding and duplicates are deliberately hard — they hide inside normal variation.
That is the honest result, and the report should say so: raising recall on subtle schemes needs
external data (prior-auth records, clinical notes), not a better tabular model.*

Metrics are regenerated on every `train_models.py` run and served live at `GET /model-info`.

---

## 5. Explainability

Three complementary layers:

1. **Global** — permutation importance on the held-out set (drop in PR-AUC when a feature is shuffled).
2. **Local** — Monte-Carlo **Shapley values** (Štrumbelj & Kononenko 2014) per claim, computed in
   **log-odds space** so contributions stay additive even when the model is saturated. The property
   `Σφᵢ = logit(x) − E[logit]` is displayed next to the chart and verified in the test suite.
3. **Rule attribution** — the deterministic red flags that fired, each with weight, category and the
   scheme it targets.

The UI renders Shapley values as a waterfall from the population baseline to the claim's score, so an
investigator can literally read *"units claimed pushed this up by 2.6 log-odds, the diagnosis–procedure
match being plausible pulled it down by 0.7"*. If an explanation is challenged in a dispute, that is
the evidence you present.

---

## 6. Project layout

```
├── ml-service/                  Python ML microservice
│   ├── data/generate_dataset.py  synthetic payer ledger (7 fraud archetypes)
│   ├── features.py              32-feature engineering (shared contract)
│   ├── train_models.py          training, evaluation, Shapley, model export
│   ├── app.py                   FastAPI inference API
│   ├── models/                  *.joblib + metrics.json + linear export
│   └── tests/test_pipeline.py   8 unit tests
├── server/                      Express + Mongoose API
│   ├── src/models/              Mongoose schemas
│   ├── src/db/                  mongodb store + JSON fallback store
│   ├── src/services/            feature, rule engine, ML client, risk fusion
│   ├── src/routes/              auth, claims, dashboard, cases, admin
│   ├── src/seed/seed.js         dataset → scored ledger → cases → users
│   └── tests/api.test.js        14 end-to-end tests
├── client/                      React 18 + Vite + Tailwind
│   ├── src/pages/               Dashboard, Claims, ClaimDetail, ScoreClaim,
│   │                            Cases, Analytics, Providers, Network,
│   │                            ModelInsights, Admin, About, Login
│   └── scripts/render-check.mjs headless render smoke-test for every route
├── docs/                        architecture, dataset, API reference
└── scripts/dev.sh               one-command setup
```

---

## 7. Testing

```bash
cd server      && npm test                       # 25 tests: API integration + data contracts
cd ml-service  && python tests/test_pipeline.py  # 8 ML pipeline tests
cd client      && npm run build                  # production build check
cd client      && npm run render-check           # renders all 14 routes headless
```

The API tests spin up the JSON store in a temp file, so they need **no** MongoDB and no network.

**The contract tests matter most.** They assert that the 32-feature list, the exported logistic
coefficients and the seed dataset columns all agree across Python and JavaScript. Silent drift there
would make every score subtly wrong without any error ever being thrown — the worst possible bug in
this system.

---

## 8. Technology choices (viva answers)

| Choice | Why |
|---|---|
| **MERN** | Requested stack; MongoDB's flexible schema suits heterogeneous claim documents, React gives the dashboard interactivity the domain needs |
| **Python microservice** | The whole tabular ML ecosystem (scikit-learn, calibration, SHAP-style attribution) is Python-first. A polyglot split is standard in real fraud platforms |
| **PR-AUC as the primary metric** | At 10% prevalence, accuracy is meaningless — a "always legitimate" model scores 90%. PR-AUC only rewards finding positives |
| **Isolation Forest alongside supervised models** | Supervised models cannot detect a scheme absent from the labels; the anomaly detector can |
| **Logistic regression kept in production** | It is the interpretable baseline *and* the offline fallback, because its coefficients can be exported and replayed exactly in JavaScript |
| **Rules fused with the model** | Investigators must be able to trust that a near-duplicate bill always surfaces. A hard-rule floor guarantees severe, low-prevalence evidence cannot be diluted by an unsure model |
| **Severity + signal dropout in the generator** | Without them every scheme becomes a deterministic rule and the model scores a fake PR-AUC of 1.0. Both are what make this a genuine imbalanced-learning problem |

---

## 9. Limitations & future work

* **Synthetic data.** The models are trained on a simulated ledger, so the absolute metrics are not a
  claim about real-world performance. Retraining on a de-identified payer extract is the natural next step.
* **No clinical text.** Notes, prior-authorisation documents and provider–patient relationships would
  substantially improve detection of subtle upcoding.
* **Batch scoring is in-process.** For production volume, move scoring to a queue (Kafka/BullMQ) and
  version the models with MLflow.
* **Network graph is static.** A temporal graph model (e.g. GraphSAGE) would detect rings as they form.

---

## 10. Disclaimer

All data in this repository is **synthetically generated** (`ml-service/data/generate_dataset.py`).
No real patient, member, provider or claim information is included, and the system is an academic
project — not a certified adjudication tool.
