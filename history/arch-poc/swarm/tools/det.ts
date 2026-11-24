// Same seed, same mask, same run: swarm runs of seeds 1..20 twice each.
const root = process.argv[2];
const { runSimulation } = await import(`${root}/src/sim/simulator.ts`);
const { runHubSimulation } = await import(`${root}/src/hub/sim/simulator.ts`);
let same = 0, masks = new Set<string>();
for (let seed = 1; seed <= 20; seed += 1) {
  const a = await runSimulation({ seed, actions: 60, swarm: true });
  const b = await runSimulation({ seed, actions: 60, swarm: true });
  const ka = JSON.stringify([a.ok, a.failure, a.steps, a.coverage, a.session, a.swarm]);
  const kb = JSON.stringify([b.ok, b.failure, b.steps, b.coverage, b.session, b.swarm]);
  if (ka === kb) same += 1; else console.log("listener differs", seed);
  masks.add(JSON.stringify(a.swarm));
}
console.log(`listener: ${same}/20 identical, ${masks.size} distinct masks; seed 1 mask ${JSON.stringify((await runSimulation({ seed: 1, actions: 60, swarm: true })).swarm)}`);
same = 0; masks = new Set();
for (let seed = 1; seed <= 10; seed += 1) {
  const a = await runHubSimulation({ seed, steps: 40, swarm: true });
  const b = await runHubSimulation({ seed, steps: 40, swarm: true });
  if (JSON.stringify(a) === JSON.stringify(b)) same += 1; else console.log("hub differs", seed);
  masks.add(JSON.stringify(a.swarm));
}
console.log(`hub: ${same}/10 identical, ${masks.size} distinct masks`);
