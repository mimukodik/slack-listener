import { runSimulation } from "./simulator.ts";

const seeds = Number(process.argv[2] ?? 2000);
const actions = Number(process.argv[3] ?? 120);
if (
  !Number.isInteger(seeds) ||
  seeds < 1 ||
  !Number.isInteger(actions) ||
  actions < 1
) {
  process.stderr.write("usage: node src/sim/run.ts [seeds] [actions]\n");
  process.exit(2);
}
const started = Date.now();
const failures: string[] = [];
for (let seed = 1; seed <= seeds; seed += 1) {
  const result = await runSimulation({ seed, actions });
  if (!result.ok) failures.push(`seed ${seed}: ${result.failure}`);
}
for (const line of failures.slice(0, 10)) process.stdout.write(`${line}\n`);
process.stdout.write(
  `simulator: ${seeds} seeds x ${actions} actions, ${failures.length} failures, ${Date.now() - started} ms\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
