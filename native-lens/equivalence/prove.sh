#!/usr/bin/env bash
# prove.sh <impl-name> <comando-que-sobe-o-listener...>
# Sobe o listener numa porta livre, com HOME temporário vazio, roda run.mjs e o derruba (por PID).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${NL_WORK:?defina NL_WORK (pasta com cases.jsonl)}"
PORT="${NL_PORT:-47311}"
TOKEN="nl-token-$$"
HOME_TMP="$(mktemp -d)"
LOG="$WORK/prove-$1.log"
shift
TEMP="$WORK/fixtures" TMP="$WORK/fixtures" HOME="$HOME_TMP" USERPROFILE="$HOME_TMP" LOCALAPPDATA="$HOME_TMP/lad" TOKEN_GUARD_SID="nl-$$" "$@" --port "$PORT" --token "$TOKEN" > "$LOG.listener" 2>&1 &
PID=$!
for i in $(seq 1 100); do grep -q READY "$LOG.listener" 2>/dev/null && break; sleep 0.1; done
node "$HERE/run.mjs" "$WORK/cases.jsonl" --port "$PORT" --token "$TOKEN" | tee "$LOG"
RC=${PIPESTATUS[0]}
kill "$PID" 2>/dev/null
node -e "const fs=require('fs'),p=process.argv[1];try{fs.rmSync(p,{recursive:true,force:true})}catch{}" "$(cygpath -w "$HOME_TMP" 2>/dev/null || echo "$HOME_TMP")"
echo "exit=$RC"
exit "$RC"
