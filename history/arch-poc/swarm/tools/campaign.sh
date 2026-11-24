# The measurement: every reachable mutant, plain and swarm, same seeds, one at a time.
S=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$S" || exit 1
for m in none L1-giveup-fix-reverted L2-shell-giveup-as-ok L3-bad-line-only-logged L4-stub-dropped L5-restart-not-flagged-duplicate L6-release-unsorted L7-older-edit-after-newer L9-no-catchup-margin L10-done-before-delivered-ignored L11-inflight-lost-on-restart L13-gap-edit-of-old-message-missed L14-failed-catchup-not-retried; do
  for w in 0 1; do timeout 1200 python3 -I tools/measure.py listener $m $w 1 10000 120 m-listener-$m-s$w; done
done
for m in none H1-T5-any-option H2-T7-no-transaction H3-inbox-ignores-waited-on H4-lease-runs-during-input H5-completed-back-to-working H6-claim-skips-lease H7-renew-after-lapse; do
  for w in 0 1; do timeout 1800 python3 -I tools/measure.py hub $m $w 1 2500 80 m-hub-$m-s$w; done
done
echo CAMPAIGN DONE
