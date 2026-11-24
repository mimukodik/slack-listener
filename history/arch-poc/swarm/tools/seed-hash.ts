// Hashes every seed's full result: seed, outcome, failure, steps, coverage, session.
import { createHash } from "node:crypto";
const root = process.argv[2];
const seeds = Number(process.argv[3] ?? 2000);
const actions = Number(process.argv[4] ?? 120);
const { runSimulation } = await import(`${root}/src/sim/simulator.ts`);
const hash = createHash("sha256");
const perSeed: string[] = [];
for (let seed = 1; seed <= seeds; seed += 1) {
  const r = await runSimulation({ seed, actions });
  const line = JSON.stringify({ seed, ok: r.ok, failure: r.failure, steps: r.steps, coverage: r.coverage, session: r.session });
  hash.update(line + "\n");
  perSeed.push(createHash("sha256").update(line).digest("hex").slice(0, 16));
}
console.log(perSeed.join("\n"));
console.log(`seeds 1..${seeds}: ${hash.digest("hex")}`);
