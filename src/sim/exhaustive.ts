// Bounded enumeration runs each valid prefix as the production program on the
// deterministic fake world. Live fibers cannot be cloned; the world is replayed.
// Each run reports which next actions are valid, so only valid sequences run.
// Runs are independent, so the tree splits across worker threads: the main
// thread runs every sequence shorter than the split and hands the subtrees
// below it to a pool, one root at a time (BER-2207).
import { defaultWorkers, runPool } from "./pool.ts";
import { type Action, World, alphabet } from "./world.ts";

export { alphabet, type Action } from "./world.ts";

// Every run takes the simplest choice; the tape is read-only, so one is shared.
const tape: readonly number[] = Array.from({ length: 20_000 }, () => 0);

// Subtrees start at this length: 184 roots over the eleven letters, the
// largest about 0.85% of depth 7, so a pool of up to 8 stays balanced.
const split = 3;

export interface ExhaustiveResult {
  bound: number;
  sequences: number;
  violations: { sequence: string; reason: string }[];
  coverage: {
    possibleDuplicates: number;
    deliveredByCatchUp: number;
    editsDelivered: number;
    repliesUnderOwnAgent: number;
    // R18 (BER-2285): runs where a seen mark came off, where the session's
    // done was confirmed, and where the armed failure hit a reaction call or
    // a read.
    seenMarksRemoved: number;
    doneMarks: number;
    failedReactionCalls: number;
    failedReads: number;
  };
}

export function emptyResult(bound: number): ExhaustiveResult {
  return {
    bound,
    sequences: 0,
    violations: [],
    coverage: {
      possibleDuplicates: 0,
      deliveredByCatchUp: 0,
      editsDelivered: 0,
      repliesUnderOwnAgent: 0,
      seenMarksRemoved: 0,
      doneMarks: 0,
      failedReactionCalls: 0,
      failedReads: 0,
    },
  };
}

// Runs root and every valid sequence below it up to bound, depth first in
// alphabet order, into result. With stopAt, sequences of that length are
// collected in visiting order instead of run.
export async function explore(
  root: string,
  result: ExhaustiveResult,
  stopAt?: { readonly length: number; readonly roots: string[] },
): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const sequence = pending.pop();
    if (sequence === undefined)
      throw new Error("exhaustive agenda lost its entry");
    if (stopAt !== undefined && sequence.length === stopAt.length) {
      stopAt.roots.push(sequence);
      continue;
    }
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
    if (run.result.coverage.reactionsRemoved > 0)
      result.coverage.seenMarksRemoved += 1;
    if (run.result.coverage.doneMarks > 0) result.coverage.doneMarks += 1;
    if (run.failedOnce.some((method) => method.startsWith("reactions.")))
      result.coverage.failedReactionCalls += 1;
    if (run.failedOnce.some((method) => method.startsWith("conversations.")))
      result.coverage.failedReads += 1;
    if (sequence.length < result.bound)
      for (const action of [...run.next].reverse())
        pending.push(sequence + action);
  }
}

// The order a single depth-first run visits sequences in: alphabet order per
// action, a prefix before its extensions.
const rank = new Map<string, number>(alphabet.map((action, i) => [action, i]));
function visitingOrder(left: string, right: string): number {
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const difference =
      (rank.get(left[i] as Action) ?? -1) -
      (rank.get(right[i] as Action) ?? -1);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function add(into: ExhaustiveResult, part: ExhaustiveResult): void {
  into.sequences += part.sequences;
  into.violations.push(...part.violations);
  for (const key of Object.keys(
    into.coverage,
  ) as (keyof ExhaustiveResult["coverage"])[])
    into.coverage[key] += part.coverage[key];
}

// workers above 1 split the tree across that many threads; the result is the
// same as a single-threaded run, violations in the same order.
export async function runExhaustive(
  bound: number,
  workers = 1,
): Promise<ExhaustiveResult> {
  const result = emptyResult(bound);
  if (workers <= 1 || bound <= split) {
    await explore("", result);
    return result;
  }
  const roots: string[] = [];
  await explore("", result, { length: split, roots });
  const tasks = roots.map((root) => ({
    kind: "subtree" as const,
    root,
    bound,
  }));
  for (const part of await runPool(tasks, workers)) add(result, part);
  result.violations.sort((left, right) =>
    visitingOrder(left.sequence, right.sequence),
  );
  return result;
}

if (import.meta.main) {
  const bound = Number(process.argv[2] ?? 5);
  const workers = defaultWorkers;
  const startedAt = Date.now();
  const result = await runExhaustive(bound, workers);
  for (const violation of result.violations.slice(0, 10))
    console.log(`violation after "${violation.sequence}": ${violation.reason}`);
  console.log(
    `exhaustive: every sequence up to ${bound} actions over ${alphabet.length}, ${result.sequences} sequences, ${result.violations.length} violations, ${workers} workers, ${Date.now() - startedAt} ms`,
  );
  console.log(`coverage: ${JSON.stringify(result.coverage)}`);
  if (result.violations.length > 0) process.exit(1);
}
