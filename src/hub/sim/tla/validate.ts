// Code-to-model trace validation (local; CI has no Java, DECISIONS.md B1c).
// Runs the hub simulator's bounded mode for a range of seeds, writes each
// recorded trace into TraceTasks.tla and has TLC look for a behaviour of
// Tasks.tla that consumes it. A trace is accepted when TLC reaches its end.
//
// Usage: bun src/hub/sim/tla/validate.ts [first-seed] [seeds] [calls]
// Env: TLA2TOOLS_JAR, JAVA as for tlc.sh; TRACE_OUT for the written traces.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tlaOf } from "../alpha.ts";
import { BoundedMode, type TraceLine } from "../conform.ts";
import { runHubSimulation } from "../simulator.ts";

// The spec and its trace module live in spec/tasks.
const here = join(import.meta.dir, "../../../../spec/tasks");
// Both required, with no default (spec/tasks/README.md names the jar).
const jar = process.env["TLA2TOOLS_JAR"] ?? "";
const java = process.env["JAVA"] ?? "";
const out =
  process.env["TRACE_OUT"] ??
  join(process.env["TMPDIR"] ?? "/tmp", "tasks-traces");

function lineOf(line: TraceLine): string {
  const alpha = tlaOf(line.alpha);
  if (line.kind === "init" || line.kind === "tick")
    return `[kind |-> "${line.kind}", alpha |-> ${alpha}]`;
  const inp = line.inp;
  if (inp === undefined || line.p === undefined || line.k === undefined)
    throw new Error("validate: a call line without its call");
  const call = `p |-> ${line.p}, k |-> ${line.k}, inp |-> [op |-> "${inp.op}", t |-> ${String(inp.t)}, arg |-> ${inp.arg}]`;
  return `[kind |-> "${line.kind}", ${call}, ans |-> "${line.ans ?? "none"}", alpha |-> ${alpha}]`;
}

// Runs TLC on one trace; true when the trace's first `upto` lines are
// reached (upto = 0: the whole trace).
function tlc(dir: string, lines: readonly TraceLine[], upto: number): boolean {
  const template = readFileSync(join(here, "TraceTasks.tla"), "utf8");
  const module = template
    .replace(
      /^Tr == .*$/mu,
      `Tr == <<\n  ${lines.map(lineOf).join(",\n  ")}\n>>`,
    )
    .replace(/^Upto == .*$/mu, `Upto == ${String(upto)}`);
  writeFileSync(join(dir, "TraceTasks.tla"), module);
  const cfg = readFileSync(join(here, "TraceTasks.cfg"), "utf8").replace(
    "INVARIANT NotAccepted",
    upto === 0 ? "INVARIANT NotAccepted" : "INVARIANT NotReached",
  );
  writeFileSync(join(dir, "TraceTasks.cfg"), cfg);
  const run = spawnSync(
    "timeout",
    [
      "120",
      java,
      "-Xmx2g",
      "-cp",
      jar,
      "tlc2.TLC",
      "-workers",
      "1",
      "-cleanup",
      "-noGenerateSpecTE",
      "-metadir",
      join(dir, "states"),
      "-config",
      "TraceTasks.cfg",
      "TraceTasks",
    ],
    { cwd: dir, encoding: "utf8" },
  );
  const text = `${run.stdout}${run.stderr}`;
  writeFileSync(join(dir, `tlc-${String(upto)}.log`), text);
  if (/Invariant Not(Accepted|Reached) is violated/u.test(text)) return true;
  if (/Model checking completed. No error has been found/u.test(text))
    return false;
  throw new Error(`validate: TLC failed in ${dir}:\n${text.slice(-2000)}`);
}

// How far a rejected trace got: the last line TLC can reach at rest.
function reached(dir: string, lines: readonly TraceLine[]): number {
  let low = 1;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tlc(dir, lines, mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

export async function validate(
  seed: number,
  calls: number,
): Promise<{
  readonly accepted: boolean;
  readonly lines: number;
  readonly detail: string;
}> {
  const mode = new BoundedMode(calls);
  const result = await runHubSimulation({ seed, steps: calls, mode });
  if (mode.lines[0]?.kind !== "init")
    throw new Error(
      `validate: seed ${String(seed)} recorded no initial state: ${String(result.failure)}`,
    );
  const dir = join(out, `seed-${String(seed)}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(here, "Tasks.tla"), join(dir, "Tasks.tla"));
  writeFileSync(join(dir, "trace.json"), JSON.stringify(mode.lines, null, 1));
  const accepted = tlc(dir, mode.lines, 0);
  const sim = result.ok
    ? "checker passed"
    : `checker: ${String(result.failure)}`;
  if (accepted) return { accepted, lines: mode.lines.length, detail: sim };
  const last = reached(dir, mode.lines);
  const next = mode.lines[last];
  return {
    accepted,
    lines: mode.lines.length,
    detail: `${sim}; TLC reaches line ${String(last)} of ${String(mode.lines.length)}, not line ${String(last + 1)}: ${next === undefined ? "?" : `${next.kind} ${next.p ?? ""} ${next.k ?? ""} ${JSON.stringify(next.inp ?? {})} ${next.ans ?? ""}`}`,
  };
}

if (import.meta.main) {
  if (jar === "" || java === "") {
    process.stderr.write(
      "validate.ts: set TLA2TOOLS_JAR (the pinned tla2tools.jar) and JAVA (a Java 17)\n",
    );
    process.exit(2);
  }
  const first = Number(process.argv[2] ?? 1);
  const seeds = Number(process.argv[3] ?? 20);
  const calls = Number(process.argv[4] ?? 20);
  const started = Date.now();
  let accepted = 0;
  let lines = 0;
  for (let seed = first; seed < first + seeds; seed += 1) {
    const outcome = await validate(seed, calls);
    lines += outcome.lines;
    if (outcome.accepted) accepted += 1;
    process.stdout.write(
      `seed ${String(seed)}: ${outcome.accepted ? "accepted" : "REJECTED"}, ${String(outcome.lines)} lines; ${outcome.detail}\n`,
    );
  }
  process.stdout.write(
    `trace validation: ${String(seeds)} traces, ${String(lines)} lines, ${String(accepted)} accepted, ${String(seeds - accepted)} rejected, ${String(Date.now() - started)} ms\n`,
  );
}
