#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# MedGuard AI - one-command development environment
#
#   ./scripts/dev.sh            full setup + run all three services
#   ./scripts/dev.sh --reset    also regenerate the dataset and retrain models
#
# Services
#   ML inference   http://localhost:8000/docs
#   API            http://localhost:5000/api
#   Web app        http://localhost:5173
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
RESET=false
[[ "${1:-}" == "--reset" ]] && RESET=true

info()  { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()    { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m! %s\033[0m\n" "$*"; }

# --------------------------------------------------------------- python env
if [[ ! -d .venv ]]; then
  info "creating Python virtualenv"
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
info "installing Python dependencies"
pip install -q --upgrade pip
pip install -q -r ml-service/requirements.txt
ok "Python environment ready"

# ------------------------------------------------------------- dataset / ML
if $RESET || [[ ! -f ml-service/data/claims.csv ]]; then
  info "generating synthetic claim ledger"
  ( cd ml-service && python data/generate_dataset.py )
fi
if $RESET || [[ ! -f ml-service/models/gradient_boosting.joblib ]]; then
  info "training models (this takes ~40s)"
  ( cd ml-service && python train_models.py )
fi
ok "models ready"

# -------------------------------------------------------------- node deps
if [[ ! -d server/node_modules ]]; then
  info "installing server dependencies"
  ( cd server && npm install --no-audit --no-fund )
fi
if [[ ! -d client/node_modules ]]; then
  info "installing client dependencies"
  ( cd client && npm install --no-audit --no-fund )
fi
[[ -f server/.env ]] || ( cd server && cp .env.example .env && sed -i.bak 's/^JWT_SECRET=.*/JWT_SECRET=dev-local-secret-medguard-2024/' .env && rm -f .env.bak )
ok "Node dependencies ready"

# ------------------------------------------------------------ start ML API
info "starting ML inference service on :8000"
( cd ml-service && python -m uvicorn app:app --host 0.0.0.0 --port 8000 > "$ROOT/.ml.log" 2>&1 ) &
ML_PID=$!
for i in $(seq 1 40); do
  if curl -sf -o /dev/null http://localhost:8000/health; then break; fi
  sleep 1
done
curl -sf -o /dev/null http://localhost:8000/health && ok "ML service up" || warn "ML service did not respond - the API will use the linear fallback"

# ---------------------------------------------------------------- seed data
if [[ ! -f server/.data/db.json ]]; then
  info "seeding database (scores every claim through the ensemble)"
  ( cd server && npm run seed )
fi
ok "database ready"

# --------------------------------------------------------------- start API
info "starting API server on :5000"
( cd server && npm start > "$ROOT/.api.log" 2>&1 ) &
API_PID=$!
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://localhost:5000/api/health; then break; fi
  sleep 1
done
ok "API server up"

cleanup() {
  echo
  info "shutting down…"
  kill "$API_PID" "$ML_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cat <<EOF

  ┌────────────────────────────────────────────────────────────┐
  │  MedGuard AI is running                                    │
  │                                                            │
  │  Web app   →  http://localhost:5173                        │
  │  API       →  http://localhost:5000/api/health             │
  │  ML docs   →  http://localhost:8000/docs                   │
  │                                                            │
  │  Login     →  admin@medguard.ai / MedGuard@2024            │
  └────────────────────────────────────────────────────────────┘

  Press Ctrl+C to stop all services.

EOF

# ------------------------------------------------------------- start client
( cd client && npm run dev )
