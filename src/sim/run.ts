// The sampled pass: seeds 1..N, each a whole-program run with faults. Seeds
// are independent, so ranges of them run on the pool and their failures are
// joined in seed order (BER-2216).
import { defaultWorkers, runPool } from "./pool.ts";
import { runSimulation } from "./simulator.ts";

// 80 ranges for 2000 seeds keeps a pool of up to 8 balanced.
const seedsPerTask = 25;

export async function seedFailures(
  first: number,
  last: number,
  actions: number,
): Promise<string[]> {
  const failures: string[] = [];
  for (let seed = first; seed <= last; seed += 1) {
    const result = await runSimulation({ seed, actions });
    if (!result.ok) failures.push(`seed ${seed}: ${result.failure}`);
  }
  return failures;
}

// workers above 1 split the seeds across that many threads; the failures are
// the same as a single-threaded run's, in the same order.
export async function runSeeds(
  seeds: number,
  actions: number,
  workers = 1,
): Promise<string[]> {
  if (workers <= 1) return seedFailures(1, seeds, actions);
  const tasks = [];
  for (let first = 1; first <= seeds; first += seedsPerTask)
    tasks.push({
      kind: "seeds" as const,
      first,
      last: Math.min(first + seedsPerTask - 1, seeds),
      actions,
    });
  return (await runPool(tasks, workers)).flat();
}

if (import.meta.main) {
  const seeds = Number(process.argv[2] ?? 2000);
  const actions = Number(process.argv[3] ?? 120);
  if (
    !Number.isInteger(seeds) ||
    seeds < 1 ||
    !Number.isInteger(actions) ||
    actions < 1
  ) {
    process.stderr.write("usage: bun src/sim/run.ts [seeds] [actions]\n");
    process.exit(2);
  }
  const started = Date.now();
  const failures = await runSeeds(seeds, actions, defaultWorkers);
  for (const line of failures.slice(0, 10)) process.stdout.write(`${line}\n`);
  process.stdout.write(
    `simulator: ${seeds} seeds x ${actions} actions, ${failures.length} failures, ${defaultWorkers} workers, ${Date.now() - started} ms\n`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}
