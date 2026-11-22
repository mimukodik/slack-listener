#!/bin/sh
# A Listener counterexample, one line per state with the key variables.
# Usage: spec/listener/trace.sh <cfg>; reads $TLC_OUT/<cfg>.log (see tlc.sh).
log="${TLC_OUT:-${TMPDIR:-/tmp}/listener-tlc}/$1.log"
awk '
/^State [0-9]+: / { if (st) print st" | "line; st=$0; sub(/ line [0-9].*$/,"",st); sub(/^State /,"",st); line=""; next }
/^\/\\ (posted|msg|conn|slog|cursor|sCursor|sInflight|held|gath|wip|redo|age|r20drop|rx|q|doneReq|gaveUp) = / { v=$0; sub(/^\/\\ /,"",v); line=line" "v }
END { if (st) print st" | "line }
' "$log"
