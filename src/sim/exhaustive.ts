// Bounded enumeration runs each valid prefix as the production program on the
// deterministic fake world. Live fibers cannot be cloned; the world is replayed.
// Each run reports which next actions are valid, so only valid sequences run.
import { World, alphabet } from "./world.ts";

export { alphabet, type Action } from "./world.ts";

// Every run takes the simplest choice; the tape is read-only, so one is shared.
const tape: readonly number[] = Array.from({ length: 20_000 }, () => 0);
export interface ExhaustiveResult {
  bound: number;
  sequences: number;
  violations: { sequence: string; reason: string }[];
  coverage: {
    possibleDuplicates: number;
    deliveredByCatchUp: number;
    editsDelivered: number;
    repliesUnderOwnAgent: number;
  };
}
export async function runExhaustive(bound: number): Promise<ExhaustiveResult> {
  const result: ExhaustiveResult = {
    bound,
    sequences: 0,
    violations: [],
    coverage: {
      possibleDuplicates: 0,
      deliveredByCatchUp: 0,
      editsDelivered: 0,
      repliesUnderOwnAgent: 0,
    },
  };
  const pending = [""];
  while (pending.length > 0) {
    const sequence = pending.pop();
    if (sequence === undefined)
      throw new Error("exhaustive agenda lost its entry");
    const run = await new World({ seed: 1, faults: false, tape }).sequence(
      sequence,
    );
    if (!run.valid)
      throw new Error(
        `exhaustive: "${sequence}" was predicted valid by its prefix but is not`,
      );
    result.sequences += 1;
    if (!run.result.ok)
      result.violations.push({
        sequence,
        reason: run.result.failure ?? "unknown failure",
      });
    for (const { delivery } of run.result.session) {
      if (delivery.possibleDuplicate) result.coverage.possibleDuplicates += 1;
      if (delivery.kind === "edit") result.coverage.editsDelivered += 1;
    }
    if (
      run.postedWhileDown.some((ts) =>
        run.result.session.some((record) => record.delivery.ts === ts),
      )
    )
      result.coverage.deliveredByCatchUp += 1;
    if (
      sequence.includes("B") &&
      sequence.includes("b") &&
      run.result.session.some((record) => record.delivery.isReply)
    )
      result.coverage.repliesUnderOwnAgent += 1;
    if (sequence.length < bound)
      for (const action of [...run.next].reverse())
        pending.push(sequence + action);
  }
  return result;
}
if (import.meta.main) {
  const bound = Number(process.argv[2] ?? 5);
  const startedAt = Date.now();
  const result = await runExhaustive(bound);
  for (const violation of result.violations.slice(0, 10))
    console.log(`violation after "${violation.sequence}": ${violation.reason}`);
  console.log(
    `exhaustive: every sequence up to ${bound} actions over ${alphabet.length}, ${result.sequences} sequences, ${result.violations.length} violations, ${Date.now() - startedAt} ms`,
  );
  console.log(`coverage: ${JSON.stringify(result.coverage)}`);
  if (result.violations.length > 0) process.exit(1);
}
