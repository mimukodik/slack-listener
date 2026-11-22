// The model-to-code replay (bun run sim:hub:replay): every path in
// spec/tasks/replay.jsonl, exported from TLC's graph of Tasks.tla, through
// the hub's real actions on a seeded random surface. A path of the correct
// model must pass every step; a planted bug's counterexample must fail at
// the step where the bug's model leaves the correct one (DECISIONS.md, B1c).
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ReplayMode, type ReplayPath } from "./conform.ts";
import { runHubSimulation } from "./simulator.ts";

export const fixture = join(
  import.meta.dir,
  "../../../spec/tasks/replay.jsonl",
);

export type ReplayOutcome = {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly steps: number;
};

export function readPaths(file = fixture): ReplayPath[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ReplayPath);
}

// One path: passes, or for a bug's counterexample, fails where it must.
export async function replayPath(
  path: ReplayPath,
  seed: number,
): Promise<ReplayOutcome> {
  const base = { id: path.id, steps: path.steps.length };
  if (path.bug !== undefined && (path.failAt ?? null) === null)
    return {
      ...base,
      ok: true,
      detail: `not replayable: ${String(path.unreplayable)}`,
    };
  const mode = new ReplayMode(path);
  const result = await runHubSimulation({
    seed,
    steps: path.steps.length,
    mode,
  });
  // The step the run stopped at: where a failure the checker names came.
  const at = `stopped at step ${String(mode.stepsDone - 1)}`;
  if (path.bug === undefined)
    return {
      ...base,
      ok: result.ok,
      detail: result.ok ? "passed" : `${at}: ${String(result.failure)}`,
    };
  const expected = `replay step ${String(path.failAt)}:`;
  const failure = result.failure ?? "passed";
  return {
    ...base,
    ok: failure.startsWith(expected),
    detail: `${path.bug} (${String(path.rule)}) must fail at step ${String(path.failAt)}; ${at}: ${failure}`,
  };
}

if (import.meta.main) {
  const started = Date.now();
  const paths = readPaths(process.argv[2]);
  let steps = 0;
  const bad: ReplayOutcome[] = [];
  const bugs: ReplayOutcome[] = [];
  for (const [index, path] of paths.entries()) {
    const outcome = await replayPath(path, index + 1);
    steps += outcome.steps;
    if (!outcome.ok) bad.push(outcome);
    if (path.bug !== undefined) bugs.push(outcome);
  }
  for (const each of bugs)
    process.stdout.write(
      `${each.ok ? "ok" : "WRONG"} ${each.detail.slice(0, 220)}\n`,
    );
  for (const each of bad.slice(0, 10))
    process.stdout.write(`failed: ${each.id}: ${each.detail.slice(0, 400)}\n`);
  process.stdout.write(
    `hub replay: ${String(paths.length)} paths (${String(bugs.length)} planted bugs), ${String(steps)} steps, ${String(bad.length)} failures, ${String(Date.now() - started)} ms\n`,
  );
  process.exitCode = bad.length === 0 ? 0 : 1;
}
