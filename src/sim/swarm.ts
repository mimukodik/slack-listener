// Swarm testing (BER-2419; Groce et al., ISSTA 2012): a run switches a
// random subset of the world's action kinds and fault classes off, so it
// goes deeper into the behaviours left on. The subset is drawn from the
// run's own choices before the run starts, so a seed replays its mask. A
// plain run draws no mask and every behaviour stays on.
import type { Choices } from "./choices.ts";

// Each kind and class is on with probability 1/2, and at least one of
// `actions` is on, so the run still does something.
export function drawSwarm<F extends string>(
  choices: Choices,
  actions: readonly F[],
  faults: readonly F[],
): ReadonlySet<F> {
  const on = new Set<F>();
  for (const feature of [...actions, ...faults])
    if (choices.int(2) === 1) on.add(feature);
  if (!actions.some((action) => on.has(action))) on.add(choices.pick(actions));
  return on;
}
