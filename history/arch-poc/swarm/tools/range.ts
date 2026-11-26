// Runs seeds first..last of one simulator, plain or swarm, and prints one line
// per seed: seed, ok, ms, failure. Usage: bun range.ts root listener|hub 0|1 first last length
const [root, kind, swarmArg, firstArg, lastArg, lengthArg] =
  process.argv.slice(2);
const swarm = swarmArg === "1";
const first = Number(firstArg),
  last = Number(lastArg),
  length = Number(lengthArg);
const out: string[] = [];
const covTotal: Record<string, number> = {};
const add = (c: Record<string, number>) => {
  for (const [k, v] of Object.entries(c)) covTotal[k] = (covTotal[k] ?? 0) + v;
};
if (kind === "listener") {
  const { runSimulation } = await import(`${root}/src/sim/simulator.ts`);
  for (let seed = first; seed <= last; seed += 1) {
    const t = performance.now();
    const r = await runSimulation({
      seed,
      actions: length,
      ...(swarm ? { swarm: true } : {}),
    });
    const ms = performance.now() - t;
    add(r.coverage);
    out.push(
      `${seed}\t${r.ok ? 1 : 0}\t${ms.toFixed(2)}\t${(r.failure ?? "").replace(/[^\x20-\x7e]+/g, " ").slice(0, 300)}`,
    );
  }
} else {
  const { runHubSimulation } = await import(`${root}/src/hub/sim/simulator.ts`);
  for (let seed = first; seed <= last; seed += 1) {
    const t = performance.now();
    const r = await runHubSimulation({
      seed,
      steps: length,
      ...(swarm ? { swarm: true } : {}),
    });
    const ms = performance.now() - t;
    add(r.coverage);
    out.push(
      `${seed}\t${r.ok ? 1 : 0}\t${ms.toFixed(2)}\t${(r.failure ?? "").replace(/[^\x20-\x7e]+/g, " ").slice(0, 300)}`,
    );
  }
}
out.push(`COV\t${JSON.stringify(covTotal)}`);
process.stdout.write(out.join("\n") + "\n");
