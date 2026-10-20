#!/usr/bin/env bash
# start.sh — ZaFarBot panel startup with self-healing (Pterodactyl-ready).
#
# Point the egg's startup command at:  bash /home/container/start.sh
#
# What it does:
#   1. Fast-path heal: if the WhatsApp adapter is missing, install just it.
#   2. Reconcile the full dependency tree (3 attempts, survives registry hiccups).
#   3. Boot via the egg's JS_FILE (default index.js).
#   4. Optional supervisor: RESTART_LOOP=1 restarts the bot 5s after any exit
#      (use this OR the egg's crash detection — not both, to avoid double loops).
set -u
cd /home/container 2>/dev/null || cd "$(dirname "$0")" || exit 1

PKG="@whiskeysockets/baileys"
QPKG="qrcode-terminal"

log() { echo "[zafar-start] $*"; }
have_pkg() { node -e "require.resolve('$1')" >/dev/null 2>&1; }

# npm 12 blocks git-hosted dependencies by default (EALLOWGIT); baileys needs
# its libsignal fork from git. Project .npmrc already opts in — this export is
# belt & braces for shells that skip .npmrc (ignored by older npm versions).
export NPM_CONFIG_ALLOW_GIT=all

# 1) fast path — heal the adapter alone (works even without package.json)
if ! have_pkg "$PKG"; then
  log "$PKG missing — installing adapter..."
  npm install "$PKG" "$QPKG" --no-save --no-audit --no-fund --maxsockets=1 || true
fi

# 2) reconcile the full tree — deterministic via the committed package-lock.json
for attempt in 1 2 3; do
  if npm install --omit=dev --no-audit --no-fund --maxsockets=1; then
    break
  fi
  log "install attempt $attempt failed, retrying in 5s..."
  sleep 5
  if [ "$attempt" = "3" ]; then
    log "npm install kept failing — booting anyway; the bot self-installs at runtime (degraded mode keeps the server online)."
  fi
done

# 3/4) boot — supervised or exec'd
if [ "${RESTART_LOOP:-0}" = "1" ]; then
  log "supervisor loop enabled (RESTART_LOOP=1)"
  while true; do
    node "${JS_FILE:-index.js}"
    code=$?
    log "exited with $code — restarting in 5s (stop from the panel to end)"
    sleep 5
  done
else
  exec node "${JS_FILE:-index.js}"
fi
