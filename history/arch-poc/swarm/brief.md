# Method 3: swarm testing in the listener's and the hub's simulators (BER-2419)

You are the implementer. Work only in `<experiment-checkout>`, branch `the swarm experiment branch`, based on main `3a36ac7`, with `bun install` done. The repo is PUBLIC: no private paths or people's names in committed files ("the owner" for the owner).

## Why

The experiment pairs each step with one testing method, each with a bar and a time box, and Tiger Style is the foundation: a method earns its place only if it makes assertions fire more often, proves a bound, or shortens the path from a failure to a replay. Swarm testing (Groce et al., ISSTA 2012; FoundationDB, TigerBeetle's VOPR) switches a random subset of action kinds and faults off per run, drawn from the seed, so each run goes deeper into fewer behaviours. The question is whether that finds our bugs in fewer runs.

**The bar, fixed before you measure:** a predeclared mutant's kill curve improves at equal runtime, with baseline coverage kept. A kill curve is the fraction of runs that fail, against wall-clock time or number of runs. If swarm doesn't beat plain runs on the mutants, it is dropped. That is a valid result: record the numbers and stop.

## Read first

`CLAUDE.md` (AGENTS.md), `PRINCIPLES.md`, the DECISIONS entries for the simulator (3, 3b, 3c, 3d) and for the hub simulator (BER-2368). Then `src/sim/` (run.ts, simulator.ts, world.ts, choices.ts, checker.ts, slack-fake.ts, pool.ts) and `src/hub/sim/` (run.ts, simulator.ts, model.ts). Find where each simulator picks its next action and decides faults; that is where a per-run swarm mask goes. Engineering-principles ids that matter: `experiment-beats-research`, `every-guardrail-names-its-failure`, `cheapest-work-is-work-not-done`, `the-end-is-declared-before-the-start`.

## Steps

1. **Declare the mutants first, in writing.** Write them in `scratchpad/swarm/mutants.md` (path below) before any swarm code exists. Use at least 6 for the listener and 4 for the hub, chosen so that some are hard for plain runs (a low kill rate on main's simulator). Candidates: the planted bugs recorded in DECISIONS (R18 queue order, ack twice, R20/R21 skips, stub dropped, given-up removal), and B1's T1–T7 mutants. Hard ones matter most; a mutant that every seed kills says nothing. Measure each mutant's plain kill rate on main first.
2. **Swarm mask.** For each run, draw a mask from the seed, before the run starts, through the existing choice stream. Each action kind and fault class is on with probability 1/2, with at least one action kind on. It must be deterministic (same seed, same mask, same run) and must not change plain runs: with swarm off, the 2000-seed hash stays `c837976d…3438c4` and depth-7 coverage stays identical. A CLI flag or env turns swarm on; report the mask in a failing run's output so it replays.
3. **Measure at equal runtime.** For each mutant: plain and swarm, the same wall-clock budget (or the same run count, if per-run cost matches within 10%; say which), several seed offsets. Report kills per mutant with spread, and the coverage counters for both modes on the correct code. Use the listener's sampled pass (`bun run sim`), and the hub's (`bun run sim:hub`). The exhaustive pass is out of scope.
4. **Decide per simulator, by the bar.** Where swarm improves the kill curve on the hard mutants without losing coverage, keep it. Either make it the CI default for part of the seeds (say how many) or keep it as an option, choosing by the numbers, and show one planted mutant that swarm catches in CI and plain does not, or catches clearly sooner. Where it doesn't, remove the swarm code, so main carries no dead option, and keep only the numbers.
5. **Record.** One DECISIONS.md entry dated 2026-11-22 or 2026-11-23 (use `date -u`), BER-2419: the mutants as declared, the method, the numbers in a table, the decision, and the principle ids. CLAUDE.md only if a check command changes.

## Prove it

- `bun run lint`, `bun run test`, `bun run sim 2000 120` (hash unchanged with swarm off), `bun run exhaustive 7` (coverage unchanged), `bun run sim:hub 500 80`, `bun run sim:hub:replay`.
- Mutants: copy aside, plant, run, restore with `cp`, byte-check with `cmp`. Never `git checkout` or `git stash`.
- Every measurement keeps its raw output under `<campaign-directory>/`.

## Limits

- Commits: imperative titles, no prefix, no backticks, no attribution or Co-Authored-By lines. Don't push, don't open a PR.
- Only this worktree. Never touch `<live-checkout>`, `<live-state>/` or other worktrees.
- No credentials, no rm with globs or variables. Give every background process a timeout, and kill only PIDs you started and recorded.
- Stop and report if swarm can't be added without changing plain runs, if determinism breaks, or if the swarm code exceeds about 200 non-test lines.

## Report back

The shas; the declared mutants with their plain kill rates on main; the kill table, plain against swarm, per mutant with spread; coverage in both modes; the decision per simulator, with the bar; the six checks' last lines, with the hash and depth-7 coverage compared to main; anything open.

Sign "Implementer (slack-listener swarm), wording by an agent."
