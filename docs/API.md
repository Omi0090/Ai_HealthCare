# MedGuard AI — API Reference

Base URL: `http://localhost:5000/api`
All routes except `POST /auth/login`, `POST /auth/register` and `GET /health` require:

```
Authorization: Bearer <jwt>
```

Errors return `{ "error": "message", "details": [...] }` with an appropriate HTTP status.

---

## Authentication

### `POST /auth/register`
Creates an account. **The first account in an empty database always becomes `admin`**; later
registrations default to `analyst` unless a role is supplied by an admin.

```json
{ "name": "Rohit Kulkarni", "email": "rohit@siu.in", "password": "S3curePass!", "role": "investigator" }
```
→ `201 { "token": "...", "user": { "id", "name", "email", "role", "department" } }`

### `POST /auth/login`
```json
{ "email": "admin@medguard.ai", "password": "MedGuard@2024" }
```
→ `200 { "token", "user" }` · `401` on bad credentials · `403` if disabled.

### `GET /auth/me`
Returns the decoded identity of the caller.

### `GET /auth/users` · `PATCH /auth/users/:id` — admin only
List accounts / toggle `active`, change `role`, `department`.

### `GET /auth/audit` — admin, investigator
Immutable audit trail (`auth.login`, `claim.create`, `case.update`, `admin.rescore_all`, …).

---

## Claims

### `GET /claims`
Paginated, filterable claim list.

| Query | Type | Notes |
|---|---|---|
| `page`, `limit` | int | default 1 / 20, max 200 |
| `search` | string | claim id, provider, member, diagnosis |
| `riskLevel` | enum | `critical \| high \| medium \| low \| minimal` |
| `status` | enum | `pending \| flagged \| under_review \| approved \| rejected \| paid` |
| `claimType`, `specialty`, `state`, `providerId`, `memberId` | string | exact match |
| `flagged` | `true` | only escalated claims |
| `minRisk`, `maxRisk` | 0–100 | risk-score band |
| `from`, `to` | ISO date | service-date range |
| `sort`, `order` | string | default `riskScore desc` |

→ `{ claims: [...], total, page, pages, limit }`

Each claim document includes the model output (`fraudProbability`, `riskScore`, `riskLevel`,
`anomalyScore`, `ruleScore`, `triggeredRules[]`, `modelScores{}`, `explanation{}`, `scoringSource`),
workflow fields (`status`, `assignedTo`, `notes[]`) and `groundTruth{}` (demo label).

### `GET /claims/:id`
Full detail: `{ claim, features (32), provider, member, ruleEvaluation, relatedClaims, case, narrative }`.

### `GET /claims/:id/explain`
Recomputes the Shapley attribution live. Flagged and high-risk claims already carry a stored
`explanation` from seeding, so this endpoint exists for the long tail — the claim page calls it
automatically when a claim has no stored attribution.
```json
{
  "claimId": "CLM-2025-003405",
  "explanation": {
    "method": "monte_carlo_shapley", "space": "log_odds", "permutations": 300,
    "base_value": -3.70, "claim_logit": 12.75, "expected_logit": -3.70, "stability": 0.47,
    "feature_count": 32, "explained_contribution": 15.31,
    "other_features_contribution": 1.14, "other_feature_count": 20,
    "top_features": [
      { "feature": "distance_member_provider_km", "label": "Member-provider distance",
        "value": 420, "contribution": 4.80, "contribution_std": 2.45,
        "weight_pct": 26.4, "direction": "increases_risk" }
    ]
  },
  "features": { ... }
}
```

`base_value + sum(top_features[].contribution) + other_features_contribution == claim_logit`
exactly (Shapley efficiency), which is what the UI waterfall displays and what the API test asserts.

### `POST /claims` — admin, investigator, analyst
Submits and scores a claim, persisting it.

```json
{
  "providerId": "PRV00014", "memberId": "MEM00001",
  "claimType": "pharmacy",              // inpatient|outpatient|pharmacy|laboratory|dental|vision
  "procedureCode": "Specialty drug dispense", "diagnosisCode": "E78",
  "serviceDate": "2025-09-01",
  "amountBilled": 640000, "amountApproved": 630000,
  "unitsClaimed": 42, "numProcedures": 14, "pharmacyQty": 60
}
```
→ `201 { claim, narrative }` · `400` on validation failure · `400` unknown provider/member.

### `POST /claims/preview`
**Same scoring pipeline, nothing persisted.** Powers the live adjudication simulator.
→ `{ fraudProbability, riskScore, riskLevel, isFlagged, threshold, ruleScore, anomalyScore,
modelScores, triggeredRules, explanation, features, narrative, scoringSource, persisted: false }`

### `POST /claims/:id/rescore`
Re-runs the ensemble and rule engine on a stored claim; updates its risk fields.

### `PATCH /claims/:id/status` — admin, investigator
`{ "status": "under_review", "assignedTo": "Rohit Kulkarni" }`

### `POST /claims/:id/notes`
`{ "text": "Requested discharge summary from the hospital." }` → appends a timestamped note.

---

## Dashboard & analytics

| Route | Returns |
|---|---|
| `GET /dashboard/overview` | KPIs (totals, exposure, precision/recall, hours saved), risk + status distribution, 120-day trend, ML status |
| `GET /dashboard/analytics` | By specialty / claim type / state, risk histogram, scheme mix, top providers & members, model performance, rule lift |
| `GET /dashboard/providers` | Provider league table with composite provider risk (mean + p90 + flag volume) |
| `GET /dashboard/providers/:id` | Provider 360: profile, claims, monthly billing series, summary |
| `GET /dashboard/members/:id` | Member 360: profile, claims, summary |
| `GET /dashboard/network` | Bipartite graph `{ nodes[], edges[] }` of flagged claims (weights = repeated links) |

---

## Cases

| Route | Body | Notes |
|---|---|---|
| `GET /cases` | — | filter by `status`, `priority`, `assignedTo` |
| `POST /cases` | `{ claimId }` | idempotent: `409` if an open case already exists; sets claim `under_review` |
| `GET /cases/:caseNumber` | — | case + claim + provider + member |
| `PATCH /cases/:caseNumber` | `{ status, decision, findings, recoverableAmount, assignedTo }` | `decision: confirmed_fraud` increments the provider's `fraudHistory` and adds them to the watchlist |

---

## Admin

| Route | Notes |
|---|---|
| `GET /admin/system` | DB kind + counts, ML health, model metrics, feature importance, operating points, uptime |
| `GET /admin/rules` | Rule catalogue (17 rules) + observed lift per rule |
| `POST /admin/rescore-all` | `{ "limit": 500 }` — batch re-score, returns `{ updated, source }` |
| `GET /admin/audit` | Audit log |

---

## ML service (Python, port 8000)

| Route | Notes |
|---|---|
| `GET /health` | models loaded, champion, feature count, training timestamp |
| `GET /model-info` | full metric report (models, thresholds, CV, PR/ROC curves, operating points, per-scheme detection) |
| `GET /feature-importance` | permutation importances |
| `GET /rules` | rule lift measured on the labelled dataset |
| `POST /predict` | score one claim (`explain: true` includes Shapley) |
| `POST /predict-batch` | `{ claims: [...], explain }` — up to 500 per call |
| `POST /explain` | attribution only |
| `POST /explain-batch` | `{ claims: [...] }` — batch attribution, used at seed time |
| `POST /score-provider` | provider-level composite risk from a claim list |

Interactive docs: **http://localhost:8000/docs**

---

## Health check

```bash
curl http://localhost:5000/api/health
```
```json
{
  "status": "ok",
  "database": "json",
  "ml": {
    "reachable": true,
    "models": ["logistic_regression", "random_forest", "gradient_boosting", "isolation_forest"],
    "champion": "gradient_boosting",
    "url": "http://localhost:8000",
    "fallbackAvailable": true
  }
}
```
