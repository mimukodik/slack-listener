#!/bin/sh
# Runs TLC on one configuration of Tasks.tla with a wall-clock cap.
# Usage: spec/tasks/tlc.sh <cfg-name-without-.cfg> [cap-seconds] [extra TLC args...]
# TLC is local only (CI has no Java). Both are required, with no default:
# TLA2TOOLS_JAR names the pinned jar (TLC 2026.11.02, sha256 in README.md)
# and JAVA a Java 17. The log goes to $TLC_OUT/<cfg>.log, by default under
# $TMPDIR.
set -eu
if [ -z "${TLA2TOOLS_JAR:-}" ] || [ -z "${JAVA:-}" ]; then
  echo "tlc.sh: set TLA2TOOLS_JAR (the pinned tla2tools.jar) and JAVA (a Java 17)" >&2
  exit 2
fi
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cfg=$1
cap=${2:-900}
shift
[ $# -gt 0 ] && shift
jar=$TLA2TOOLS_JAR
java=$JAVA
out=${TLC_OUT:-${TMPDIR:-/tmp}/tasks-tlc}
mkdir -p "$out/states"
log="$out/$cfg.log"
spec=${TLC_SPEC:-Tasks}
echo "jar sha256 $(shasum -a 256 "$jar" | cut -d' ' -f1)" > "$log"
echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ) cap ${cap}s" >> "$log"
status=0
cd "$here"
timeout "$cap" "$java" -Xmx4g -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -workers "${WORKERS:-4}" -cleanup -noGenerateSpecTE -metadir "$out/states/$cfg" \
  -config "$cfg.cfg" "$@" "$spec" >> "$log" 2>&1 || status=$?
echo "end $(date -u +%Y-%m-%dT%H:%M:%SZ) exit $status" >> "$log"
tail -n 8 "$log"
exit "$status"
