# The task hub's TLA+ model

`Tasks.tla` models the task hub's protocol (`src/hub`, RULES.md's task rules, DECISIONS.md B1 and B1c). When they disagree, RULES.md is right, then `Tasks.tla`, then the transition table in `src/hub/task.ts`. TLC runs locally only: CI has no Java and no TLC, and must not get them. What CI runs is the replay of the fixture this folder exports (`bun run sim:hub:replay`).

## Running TLC

`tlc.sh <cfg> [cap-seconds] [extra TLC args]` runs one configuration with a wall-clock cap (default 900 s). It needs two variables, with no default: `TLA2TOOLS_JAR`, the TLC 2026.11.02 `tla2tools.jar` with sha256 `c57d4d7bbee3ed2c89c32cb9c60cac728f751e80e2570bc4b7368ae39291fc21` (each log's first line records the jar's sha256), and `JAVA`, a Java 17 binary. `regenerate.sh` and `src/hub/sim/tla/validate.ts` need the same two. The log goes to `$TLC_OUT/<cfg>.log` (default `$TMPDIR/tasks-tlc`).

| Configuration                   | What it checks                                                                      | Result, 2026-11-22                          |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `b1.cfg`                        | T1–T7 and the waiting query, 2 principals, 1 task, 2 keys each, at most 4 events    | passes: 1,068,408 states, depth 23, 55 s    |
| `b1-bug-<name>.cfg` (10)        | one planted bug each                                                                | each violates its rule (TLC exits 12)       |
| `live.cfg`                      | liveness with fair workers                                                          | not rerun for B1c                           |
| `design-oldestFirstStarves.cfg` | oldest-first claims starve a lapsed task (`OldestFirst = TRUE`)                     | the lasso, as recorded in B1                |
| `b1-export.cfg`                 | `b1.cfg` with `VIEW ExportView` and no invariants: the graph the replay is cut from | 144,148 states, 5,093,309 edges, about 70 s |
| `TraceTasks.cfg`                | one recorded hub trace against the spec (written by `src/hub/sim/tla/validate.ts`)  | see below                                   |

## Model to code: the replay fixture

`regenerate.sh` rewrites `replay.jsonl` (about 9 minutes; one TLC worker, so the file is the same on every run): it dumps `b1-export`'s state graph as dot (about 1.3 GB under `$TLC_OUT`), runs the ten bug configurations, and `src/hub/sim/tla/export.ts` cuts the paths:

- one shortest path to every class of at-rest call (action, answer, state, and the caller's relation to the creator, holder and waited-on principal, the lease left, the key's memo) and every class of tick, each call that commits three times: answered, its answer lost after the commit, and crashed before it;
- every planted bug's counterexample, with the step where it leaves the correct graph (`failAt`), or why it cannot be replayed (`dirtyRead` needs two callers at once).

Each step carries α, the abstract state the model says the store has after it (`src/hub/sim/alpha.ts`). `bun run sim:hub:replay` drives the real actions along every path and compares.

## Code to model: trace validation

`bun src/hub/sim/tla/validate.ts [first-seed] [seeds] [calls]` runs the hub simulator in its bounded mode (the model's bounds), records α after every call, lost answer and wait, writes each trace into `TraceTasks.tla` and has TLC look for a behaviour of `Tasks.tla` that consumes it. It prints, per seed, accepted or rejected with the last line TLC could reach. Local only, about 0.4 s per trace.
