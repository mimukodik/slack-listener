# BER-2419 swarm testing: the predeclared mutants

The declaration lived first in `tools/mutants.py` (exact plant text, one match each), written on 2026-11-22 before any measurement and before any swarm code. This file writes it out, with the plain kill rates measured on main `3a36ac7` (no swarm code in the tree). L13 and L14 were added on 2026-11-23, after the screen, to replace L8 and L12 (below); still before any swarm code existed.

Plain kill rate: failing runs of the sampled pass, listener seeds 1..10000 x 120 actions, hub seeds 1..2500 x 80 calls. Raw rows: `raw/main-plain-<id>.tsv`; L7, L11, L13 and L14 from the second screen (`raw/main-listener-screen2.log`), after a parser fix: a failure text holding a Unicode line separator split a row, which crashed the first screen's summary for L7 and L11. A "hard" mutant is one plain kills in under 10% of runs.

## Listener (`bun run sim`, 2000 seeds in CI)

| Id  | Plant (file) | Rule it breaks | Plain kills, main | Hard? |
| --- | --- | --- | --- | --- |
| L1  | `afterReaction` ignores a give-up: the queued seen-mark removal is not dropped (core.ts) | R18: a delivered message keeps one of its two marks | 803 / 10000 (8.0%) | yes |
| L2  | the shell reports a given-up reaction call as `ok` (shell.ts) | R18, same | 803 / 10000 (8.0%) | yes |
| L3  | a session line that is not JSON is only logged, no JSON-RPC parse error (mcp.ts) | R22 | 828 / 10000 (8.3%) | yes |
| L4  | a skipped catch-up message's thread stub is dropped (slack-api.ts) | R21 with R7 | 5443 / 10000 (54.4%) | no |
| L5  | an in-flight delivery read back after a restart is not flagged as a possible duplicate (core.ts) | R5/R2 duplicate marking | 12 / 10000 (0.12%) | yes |
| L6  | release does not sort history and held live messages by ts (core.ts) | R4 order | 9576 / 10000 (95.8%) | no |
| L7  | an older edit is delivered after a newer one (the superseded check is `=== 0`, not `>= 0`) (core.ts) | R2/R4 edits | 334 / 10000 (3.3%) | yes |
| L8  | a live message posted before the catch-up started is not dropped (`liveFromTs` check never true) (core.ts) | R7/R4 (owner's R21 resend sentence) | 0 / 10000 | replaced |
| L9  | catch-up reads from the watermark without the margin (core.ts) | R7 | 224 / 10000 (2.2%) | yes |
| L10 | a done mark made before the delivered event is ignored at delivery (core.ts) | R18 | 10 / 10000 (0.10%) | yes |
| L11 | the in-flight delivery is lost on restart (core.ts) | R7 | 5500 / 10000 (55.0%) | no |
| L12 | prune uses only the catch-up window, not thread window + catch-up window (core.ts) | R5 duplicates after pruning | 0 / 10000 | replaced |
| L13 | catch-up drops an edit made in the gap to a message older than its lower bound (`inWindow`'s edit clause never true) (core.ts) | R7 edits | 1402 / 10000 (14.0%) | borderline |
| L14 | a failed catch-up read is never tried again (the `catch_up` back-off dropped) (core.ts) | R7/R8 | 2695 / 10000 (27.0%) | no |

Why L8 and L12 kill nothing, and why they are replaced: the plants took (each matched its text exactly once and the file was restored and `cmp`-checked), but the sampled world never reaches the code.

- L8: the only message the `liveFromTs` check drops that nothing else drops is one that decodes live but not in that catch-up's history (the owner's R21 resend case). The fake's unreadable messages never decode, live or in history, so a live copy of a message older than the catch-up's start is always already claimed by that catch-up and the claim stops it. The checker would see it (R4, R7); the world never makes it. Swarm only switches existing behaviours off, so it cannot reach it either.
- L12: pruning only forgets entries older than 24 h before now, and no sampled run lasts 24 simulated hours (120 actions of up to 40 s plus a few sleeps of 30 min to 3 h). Nothing is ever pruned in a run, with or without the plant.

Both stay in this record with their zero. Neither can tell plain and swarm apart, so they are not in the kill table.

## Hub (`bun run sim:hub`, 500 seeds in CI)

| Id | Plant (file) | Rule it breaks | Plain kills, main | Hard? |
| --- | --- | --- | --- | --- |
| H1 | an answer outside the offered options is taken (task.ts) | T5 | 170 / 2500 (6.8%) | yes |
| H2 | no transaction: each statement commits on its own (store.ts) | T7 | 309 / 2500 (12.4%) | borderline |
| H3 | the inbox lists every waiting task, not those waiting on the caller (store.ts) | inbox (taskWaiting) | 199 / 2500 (8.0%) | yes |
| H4 | the lease runs on while the task waits on input (task.ts) | T2 | 878 / 2500 (35.1%) | no |
| H5 | claim also starts from `completed` (task.ts) | T3 | 460 / 2500 (18.4%) | no |
| H6 | claim skips the lease check (`lease: "any"`) (task.ts) | T2 | 985 / 2500 (39.4%) | no |
| H7 | renew accepted after the lease lapsed (task.ts) | T2 | 919 / 2500 (36.8%) | no |
