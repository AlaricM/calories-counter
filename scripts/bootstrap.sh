#!/usr/bin/env bash
#
# bootstrap.sh — one-shot local setup + deploy for food-tracker-mcp (macOS).
#
# This automates everything that CAN be automated. You must do these MANUAL
# steps first (they can't be scripted — see the README "From scratch" section):
#
#   1. Create an AWS account            (https://portal.aws.amazon.com/billing/signup)
#   2. Create a non-root IAM admin user with MFA + access keys
#   3. Run `aws configure` (or `aws configure sso`) so the CLI has credentials
#
# Then run:   ./scripts/bootstrap.sh
#
# What it does, each step idempotent and safe to re-run:
#   - installs Homebrew, Node (>=20, via nvm if missing), and the AWS CLI if missing
#   - installs project dependencies (npm ci)
#   - runs `cdk bootstrap` (first deploy per account/region only) and `cdk deploy`
#   - creates your first user + API key and prints it (skipped if one exists)
#   - shows the URL + Bearer header to paste into Joey
#
set -euo pipefail

# Resolve repo root (this script lives in <repo>/scripts).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# --- 0. Sanity: macOS + a shell we can work with -----------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "This script targets macOS. On Linux, install node (see .nvmrc), the AWS CLI, then run: npm ci && npx cdk bootstrap && npx cdk deploy"
fi

# --- 1. Homebrew -------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available in this shell (Apple Silicon default prefix).
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
else
  brew_ver="$(brew --version)"
  say "Homebrew present: ${brew_ver%%$'\n'*}"
fi

# --- 2. Node -----------------------------------------------------------------
# The Lambda runtime is pinned in code to .nvmrc (24). Local tooling (CDK, tsx)
# only needs Node >= 20, so reuse an existing recent Node and fall back to nvm.
NODE_TARGET="$(tr -d '[:space:]' < .nvmrc)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

load_nvm() { # source nvm from ~/.nvm or Homebrew; return non-zero if absent
  set +u
  local ok=1
  if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "${NVM_DIR}/nvm.sh"
  elif command -v brew >/dev/null 2>&1 && [[ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "$(brew --prefix nvm)/nvm.sh"
  else
    ok=0
  fi
  set -u
  [[ ${ok} -eq 1 ]]
}

install_node_via_nvm() {
  if ! load_nvm; then
    say "Installing nvm"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    load_nvm || die "nvm installed but couldn't be loaded in this shell — open a new terminal and re-run."
  fi
  nvm install "${NODE_TARGET}" >/dev/null
  nvm use "${NODE_TARGET}" >/dev/null
}

if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]]; then
  say "Using existing $(node --version) (>=20 is fine for CDK; Lambda runtime is pinned to Node ${NODE_TARGET})"
else
  say "Installing Node ${NODE_TARGET} via nvm"
  install_node_via_nvm
fi
say "Node $(node --version) / npm $(npm --version)"

# --- 3. AWS CLI --------------------------------------------------------------
if ! command -v aws >/dev/null 2>&1; then
  say "Installing AWS CLI"
  brew install awscli
else
  say "AWS CLI present: $(aws --version 2>&1)"
fi

# --- 4. Verify AWS credentials (the manual prerequisite) ---------------------
say "Checking AWS credentials"
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  die "No working AWS credentials. Finish the manual steps first:
   1. Create an AWS account
   2. Create a non-root IAM admin user with MFA + access keys
   3. Run: aws configure   (enter the access key, secret, and a region such as us-east-1)
  Then re-run this script."
fi
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION="$(aws configure get region || true)"
REGION="${REGION:-${AWS_REGION:-us-east-1}}"
export CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}"
export CDK_DEFAULT_REGION="${REGION}"
export AWS_REGION="${REGION}"   # used by describe-stacks and `npm run user` below
say "AWS account ${ACCOUNT_ID}, region ${REGION}"

# --- 5. Project dependencies -------------------------------------------------
# Idempotent: only (re)install when node_modules is missing or the lockfile has
# changed since the last install (npm ci otherwise wipes + reinstalls every run).
LOCK_MARKER="node_modules/.bootstrap-lock-sha"
LOCK_SHA="$(shasum -a 256 package-lock.json | awk '{print $1}')"
if [[ -d node_modules && -f "${LOCK_MARKER}" && "$(cat "${LOCK_MARKER}")" == "${LOCK_SHA}" ]]; then
  say "Dependencies already up to date — skipping npm ci"
else
  say "Installing project dependencies (npm ci)"
  npm ci
  printf '%s\n' "${LOCK_SHA}" > "${LOCK_MARKER}"
fi

# --- 6. Optional config (.env) ----------------------------------------------
# Deploys no longer need a shared secret — auth is per-user, stored in DynamoDB.
# .env is optional and only carries the cost-alert settings.
if [[ ! -f .env ]]; then
  say "Creating .env from .env.example (optional cost-alert settings)"
  cp .env.example .env
fi
warn "Optional: set ALERT_EMAIL in .env for AWS cost alerts, then re-run 'npx cdk deploy'."

# --- 7. Bootstrap + deploy ---------------------------------------------------
say "Bootstrapping CDK (no-op if already bootstrapped)"
npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"

say "Deploying the stack (a no-op if nothing changed)"
npx cdk deploy --require-approval never

# Read the endpoint back from CloudFormation — reliable even on a no-change
# deploy, which may not write deploy outputs.
MCP_URL="$(aws cloudformation describe-stacks --stack-name FoodTrackerMcpStack \
  --query "Stacks[0].Outputs[?OutputKey=='McpServerUrl'].OutputValue" \
  --output text 2>/dev/null || true)"
if [[ "${MCP_URL}" == "None" ]]; then MCP_URL=""; fi

# --- 8. First user -----------------------------------------------------------
# Create your own user + API key. Idempotent: skipped if any user already exists.
say "Creating your first user (skipped if one already exists)"
npm run user -- add --name "$(id -un)" --url "${MCP_URL}" --only-if-empty

say "Done. If a key was printed above, paste the URL + 'Authorization: Bearer <key>' into Joey."
say "Add a friend anytime:  npm run user -- add --name \"Their Name\" --url ${MCP_URL}"
