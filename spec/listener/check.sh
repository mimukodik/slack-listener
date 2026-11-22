#!/bin/sh
# Runs every configuration and checks its expected outcome: the correct
# protocol passes (TLC exits 0), each planted bug and design finding fails
# the named property. Local only; needs TLA2TOOLS_JAR and JAVA (see tlc.sh).
# About 11 minutes on 4 workers. Prints one line per configuration.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${TLC_OUT:-${TMPDIR:-/tmp}/listener-tlc}
export TLC_OUT="$out"
fail=0
expect() { # cfg cap expected ("pass" or the violated property)
  "$here/tlc.sh" "$1" "$2" > /dev/null 2>&1 || true
  log="$out/$1.log"
  got=$(grep -m1 -oE "(Invariant|Temporal property) [A-Za-z0-9]+ (is|was) violated" "$log" \
          | sed -E 's/^(Invariant|Temporal property) ([A-Za-z0-9]+).*/\2/' || true)
  if [ -z "$got" ]; then
    if grep -q "exit 0$" "$log"; then got=pass; else got="no result ($(tail -n 1 "$log"))"; fi
  fi
  states=$(grep -oE "[0-9]+ distinct states found" "$log" | tail -n 1 | cut -d' ' -f1)
  if [ "$got" = "$3" ]; then echo "ok    $1: $got (${states:-?} states)"
  else echo "FAIL  $1: expected $3, got $got"; fail=1; fi
}
expect Listener 300 pass
expect edits 300 pass
expect decodes 300 pass
expect live 300 pass
expect live3 900 pass
expect Marks 300 pass
expect marks-giveUp 300 pass
expect design-releaseMargin 300 pass
expect design-dropGathered 300 pass
expect design-badTsParent 120 pass
expect design-live-badTsParent 120 pass
expect r20 300 pass
expect design-r21resend 300 pass
expect marks-design-giveUp 120 pass
expect marks-design-literal 120 DoneMeansAnswered
expect noexcuse-badTsParent 120 R7Safe
expect noexcuse-live-badTsParent 120 R7
expect noexcuse-r20 300 R4
expect bug-saveBeforeWrite 120 R7Safe
expect bug-noIntent 120 R2
expect bug-ackTwice 120 AckOnce
expect bug-skipDropsNext 120 R7Safe
expect bug-skipParentNoThread 120 R7Safe
expect bug-window24h 120 R7Safe
expect bug-noVersionCheck 120 R5
expect bug-releaseOnDisconnect 120 R7Safe
expect bug-takeResend 300 R4
expect bug-liveFromAtEnd 300 R7Safe
expect marks-bug-removeFirst 120 NeverBare
expect marks-bug-unordered 120 NeverBare
expect marks-bug-ignoreHandled 120 DoneHolds
expect marks-bug-lazySave 120 DoneSticks
expect marks-bug-doneNotSaved 120 DoneMeansAnswered
expect marks-bug-giveUpRemoves 120 NeverBare
exit "$fail"
