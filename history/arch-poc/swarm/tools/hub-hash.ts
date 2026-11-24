// Hashes every hub seed's full result: seed, outcome, failure, coverage, entries.
import { createHash } from "node:crypto";
const root = process.argv[2];
const seeds = Number(process.argv[3] ?? 500);
const steps = Number(process.argv[4] ?? 80);
const { runHubSimulation } = await import(`${root}/src/hub/sim/simulator.ts`);
const hash = createHash("sha256");
for (let seed = 1; seed <= seeds; seed += 1) {
  const r = await runHubSimulation({ seed, steps });
  hash.update(JSON.stringify({ seed, ok: r.ok, failure: r.failure, coverage: r.coverage, entries: r.entries }) + "\n");
}
console.log(`hub seeds 1..${seeds}: ${hash.digest("hex")}`);
