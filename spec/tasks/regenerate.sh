#!/bin/sh
# Regenerates replay.jsonl from TLC: the correct spec's graph at the replay
# bounds (b1-export.cfg, dumped as dot, about 1.3 GB under $TLC_OUT) and the
# planted bugs' counterexamples (b1-bug-*.cfg). Local only: needs Java and
# the pinned TLC jar: TLA2TOOLS_JAR and JAVA must be set (see tlc.sh).
# About 10 minutes.
set -eu
if [ -z "${TLA2TOOLS_JAR:-}" ] || [ -z "${JAVA:-}" ]; then
  echo "regenerate.sh: set TLA2TOOLS_JAR (the pinned tla2tools.jar) and JAVA (a Java 17)" >&2
  exit 2
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${TLC_OUT:-${TMPDIR:-/tmp}/tasks-tlc}
export TLC_OUT="$out"
# One worker: TLC explores in the same order every time, so the export is
# the same file every time.
export WORKERS=1
mkdir -p "$out"
"$here/tlc.sh" b1-export 900 -dump dot,actionlabels "$out/b1-export"
logs=""
for cfg in "$here"/b1-bug-*.cfg; do
  name=$(basename "$cfg" .cfg)
  # A planted bug's run ends with its invariant violated: TLC exits 12.
  "$here/tlc.sh" "$name" 300 > /dev/null || true
  grep -q "is violated" "$out/$name.log" || { echo "$name: no violation" >&2; exit 1; }
  logs="$logs $out/$name.log"
done
# shellcheck disable=SC2086
timeout 600 bun "$here/../../src/hub/sim/tla/export.ts" "$out/b1-export.dot" "${REPLAY_OUT:-$here/replay.jsonl}" $logs
ls -l "${REPLAY_OUT:-$here/replay.jsonl}"
