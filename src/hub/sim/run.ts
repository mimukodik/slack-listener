// The hub simulator's sampled pass: seeds 1..N, each a run of the hub with
// crashes, checked against T1 to T7 after every step (bun run sim:hub).
import {
  emptyCoverage,
  type HubCoverage,
  runHubSimulation,
} from "./simulator.ts";

export async function runHubSeeds(
  seeds: number,
  steps: number,
): Promise<{ failures: string[]; coverage: HubCoverage }> {
  const failures: string[] = [];
  const coverage = emptyCoverage();
  for (let seed = 1; seed <= seeds; seed += 1) {
    const result = await runHubSimulation({ seed, steps });
    if (!result.ok) failures.push(`seed ${seed}: ${result.failure}`);
    for (const key of Object.keys(coverage) as (keyof HubCoverage)[])
      coverage[key] += result.coverage[key];
  }
  return { failures, coverage };
}

if (import.meta.main) {
  const seeds = Number(process.argv[2] ?? 200);
  const steps = Number(process.argv[3] ?? 80);
  if (
    !Number.isInteger(seeds) ||
    seeds < 1 ||
    !Number.isInteger(steps) ||
    steps < 1
  ) {
    process.stderr.write("usage: bun src/hub/sim/run.ts [seeds] [steps]\n");
    process.exit(2);
  }
  const started = Date.now();
  const { failures, coverage } = await runHubSeeds(seeds, steps);
  for (const line of failures.slice(0, 10)) process.stdout.write(`${line}\n`);
  process.stdout.write(
    `hub simulator: ${seeds} seeds x ${steps} calls, ${failures.length} failures, ${Date.now() - started} ms\n`,
  );
  process.stdout.write(`coverage: ${JSON.stringify(coverage)}\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}
