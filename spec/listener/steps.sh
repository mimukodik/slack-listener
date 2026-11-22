#!/bin/sh
# A counterexample in short: the violated property, then the actions in order.
# Usage: spec/listener/steps.sh <cfg>; reads $TLC_OUT/<cfg>.log (see tlc.sh).
log="${TLC_OUT:-${TMPDIR:-/tmp}/listener-tlc}/$1.log"
grep -m1 "violated" "$log"
grep -E '^State [0-9]+: <' "$log" | sed -E 's/^State ([0-9]+): <([^ >]*).*/\2/' | tr '\n' ' '; echo
