#!/usr/bin/env bash
# The orchestrator's full check of one worktree, matching CI's `check` job.
# Usage: verify.sh <absolute worktree path> <database suffix> [redis db]
# Always ends with exactly one line: VERIFY OK or VERIFY FAILED (<step>). Read that line, not the exit code alone.
set -u

wt="${1:?worktree path}"
suffix="${2:?database suffix}"
redis_db="${3:-0}"

# CI's placeholder env (.github/workflows/ci.yml), pointed at this machine's ports (environment.md).
export TEST_DATABASE_URL="postgresql://postgres:password@127.0.0.1:5435/ai-chat_test_${suffix}"
export TEST_REDIS_URL="redis://127.0.0.1:6380/${redis_db}"
export DATABASE_URL="postgresql://postgres:password@127.0.0.1:5435/ai-chat"
export BETTER_AUTH_URL="http://localhost:3001"
export BETTER_AUTH_SECRET="ci-better-auth-secret-not-for-production"
export KEY_ENCRYPTION_SECRET="ci-key-encryption-secret-not-for-production"
export RESEND_API_KEY="ci-resend-key-not-sent"
export GITHUB_CLIENT_ID="ci-github-client-id"
export GITHUB_CLIENT_SECRET="ci-github-client-secret-not-for-production"
export GOOGLE_CLIENT_ID="ci-google-client-id"
export GOOGLE_CLIENT_SECRET="ci-google-client-secret-not-for-production"
export EMAIL_FROM="AI Chat <no-reply@example.com>"
export APP_NAME="AI Chat"
export EMAIL_TRANSPORT="capture"

cd "$wt" || { echo "VERIFY FAILED (no worktree at $wt)"; exit 1; }
echo "verify: $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD), database ai-chat_test_${suffix}"

step() {
  local name="$1"
  shift
  echo "--- $name"
  if ! "$@"; then
    echo "VERIFY FAILED ($name)"
    exit 1
  fi
}

step install pnpm install --frozen-lockfile
step lint pnpm exec oxlint
step format pnpm exec oxfmt --check
step typecheck pnpm check-types
step test pnpm test

echo "VERIFY OK"
