// Exports replay paths from TLC's state graph of Tasks.tla at the replay
// bounds (b1-export.cfg), plus the planted bugs' counterexamples, as JSON
// lines for the hub simulator's replay mode (bun run sim:hub:replay).
//
// Usage: bun src/hub/sim/tla/export.ts <b1-export.dot> <out.jsonl> [bug logs...]
// Run TLC first: spec/tasks/regenerate.sh does both.
//
// Selection (DECISIONS.md, B1c):
// - every Begin from a state at rest, grouped into a class by what the code
//   can tell apart: the input, its outcome (ok, a refusal's code, a repeated
//   or reused key), the task's state, whether the caller is its creator, its
//   holder or the principal it waits on, the lease left, the key's memo
//   (none, the same input, another), and whether the log is full;
// - one shortest path to a Begin of each class; an ok Begin gives three
//   paths: committed and answered, committed with the answer lost, and
//   crashed before the commit;
// - one shortest path to a Tick of each (state, lease left) class;
// - a path that is a prefix of a longer path is dropped: the longer one
//   checks each of its steps.
// - each planted bug's counterexample, with the first step whose model
//   transitions are not in the correct graph as the step it must fail at.
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { type Alpha, compactOf } from "../alpha.ts";
import { parseState, parseValue, type Value } from "./tla-value.ts";

type Rec = { readonly [key: string]: Value };
const rec = (value: Value | undefined): Rec =>
  typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
const seq = (value: Value | undefined): readonly Value[] =>
  Array.isArray(value) ? (value as readonly Value[]) : [];
// A scalar's text: model values, strings, numbers and booleans.
const str = (value: Value | undefined): string =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

type Inp = { op: string; t: number; arg: string };
type Info = {
  readonly view: string;
  readonly atRest: boolean;
  readonly pendOk: boolean;
  readonly logLen: number;
  readonly hasFull: boolean;
  readonly task: Rec;
  readonly memo: Rec;
};

const unescape = (text: string): string =>
  text.replace(/\\(.)/gu, (_m, c: string) => (c === "n" ? "\n" : c));

const alphaOf = (state: Record<string, Value>) =>
  compactOf(rawAlpha(state) as unknown as Alpha);

function rawAlpha(state: Record<string, Value>) {
  const task = rec(seq(state["task"])[0]);
  const log = seq(state["log"]).map((each) => {
    const e = rec(each);
    return {
      t: e["t"],
      kind: e["kind"],
      actor: e["actor"],
      key: e["key"],
      arg: e["arg"],
      to: e["to"],
    };
  });
  const memo: Record<string, Value> = {};
  for (const [p, keys] of Object.entries(rec(state["memo"])))
    for (const [k, entry] of Object.entries(rec(keys)))
      if (entry !== "Nil") memo[`${p} ${k}`] = entry;
  return {
    task: {
      st: task["st"],
      creator: task["creator"],
      holder: task["holder"],
      left: task["left"],
      waitOn: task["waitOn"],
    },
    log,
    memo,
  };
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );
  return value;
};
const canon = (value: unknown): string => JSON.stringify(sortKeys(value));

function infoOf(state: Record<string, Value>): Info {
  const pend = state["pend"];
  const memo = rec(state["memo"]);
  const view = canon([
    state["task"],
    state["log"],
    state["memo"],
    state["pend"],
    state["out"],
    state["order"],
  ]);
  let hasFull = false;
  for (const keys of Object.values(memo))
    for (const entry of Object.values(rec(keys)))
      if (str(rec(rec(entry)["ans"])["code"]) === "full") hasFull = true;
  return {
    view,
    atRest: pend === "Nil" && state["out"] === "Nil",
    pendOk: pend !== "Nil",
    logLen: seq(state["log"]).length,
    hasFull,
    task: rec(seq(state["task"])[0]),
    memo,
  };
}

function beginOf(label: string): { p: string; k: string; inp: Inp } | null {
  const match = /^Begin\((\w+),(\w+),(.*)\)$/su.exec(label);
  if (match === null) return null;
  const inp = rec(parseValue(match[3] ?? ""));
  return {
    p: match[1] ?? "",
    k: match[2] ?? "",
    inp: { op: str(inp["op"]), t: Number(inp["t"]), arg: str(inp["arg"]) },
  };
}

const relation = (who: string, actor: string): string =>
  who === "NoP" ? "none" : who === actor ? "self" : "other";

// The answer a Begin gives, from the states around it.
function answerOf(
  src: Info,
  dst: Info,
  p: string,
  k: string,
  inp: Inp,
): string {
  const prior = rec(src.memo[p])[k];
  if (prior !== undefined && prior !== "Nil") {
    const stored = rec(prior);
    return canon(stored["inp"]) === canon(inp)
      ? str(rec(stored["ans"])["code"])
      : "conflict";
  }
  if (dst.pendOk) return "ok";
  return str(rec(rec(rec(dst.memo[p])[k])["ans"])["code"]);
}

function classOf(src: Info, dst: Info, label: string): string | null {
  const begin = beginOf(label);
  if (begin === null) return null;
  const { p, k, inp } = begin;
  const task = src.task;
  const prior = rec(src.memo[p])[k];
  const memoRel =
    prior === undefined || prior === "Nil"
      ? "none"
      : canon(rec(prior)["inp"]) === canon(inp)
        ? "same"
        : "other";
  const argKind =
    inp.op === "request"
      ? relation(inp.arg, p)
      : inp.op === "answer"
        ? inp.arg === "o3"
          ? "bad"
          : "offered"
        : "-";
  return [
    inp.op,
    argKind,
    answerOf(src, dst, p, k, inp),
    str(task["st"]),
    relation(str(task["creator"]), p),
    relation(str(task["holder"]), p),
    str(task["left"]),
    relation(str(task["waitOn"]), p),
    memoRel,
    src.logLen >= 4 ? "full" : "room",
  ].join(" ");
}

type Step = Record<string, unknown>;

// Model steps (labels and the states after them) as code steps.
function codeSteps(
  start: Record<string, Value>,
  moves: readonly { label: string; state: Record<string, Value> }[],
): { steps: Step[]; ends: number[]; unreplayable: string | null } {
  const steps: Step[] = [];
  const ends: number[] = [];
  let before = start;
  let i = 0;
  while (i < moves.length) {
    const move = moves[i];
    if (move === undefined) break;
    const begin = beginOf(move.label);
    if (begin !== null) {
      const src = infoOf(before);
      const dst = infoOf(move.state);
      const base = { p: begin.p, k: begin.k, inp: begin.inp };
      if (!dst.pendOk) {
        steps.push({
          do: "call",
          ...base,
          ans: answerOf(src, dst, begin.p, begin.k, begin.inp),
          expect: alphaOf(move.state),
        });
        ends.push(i);
        before = move.state;
        i += 1;
        continue;
      }
      const next = moves[i + 1];
      if (next === undefined) return { steps, ends, unreplayable: null };
      if (next.label === "Crash") {
        steps.push({ do: "crash", ...base, expect: alphaOf(next.state) });
        ends.push(i + 1);
        before = next.state;
        i += 2;
        continue;
      }
      if (next.label !== "Commit")
        return {
          steps,
          ends,
          unreplayable: `${next.label} inside an open transaction`,
        };
      const after = moves[i + 2];
      if (after === undefined || after.label === "Reply") {
        const last = after ?? next;
        steps.push({
          do: "call",
          ...base,
          ans: "ok",
          expect: alphaOf(last.state),
        });
        ends.push(after === undefined ? i + 1 : i + 2);
        before = last.state;
        i += after === undefined ? 2 : 3;
        continue;
      }
      if (after.label === "LoseReply") {
        steps.push({ do: "lose", ...base, expect: alphaOf(after.state) });
        ends.push(i + 2);
        before = after.state;
        i += 3;
        continue;
      }
      return {
        steps,
        ends,
        unreplayable: `${after.label} between a commit and its reply`,
      };
    }
    if (move.label === "Tick") {
      steps.push({ do: "tick", expect: alphaOf(move.state) });
    } else if (move.label === "ReadEvent") {
      const read = seq(move.state["readLog"]);
      const event = rec(read[read.length - 1]);
      steps.push({
        do: "read",
        after: read.length - 1,
        event: {
          kind: event["kind"],
          actor: event["actor"],
          key: event["key"],
          arg: event["arg"],
          to: event["to"],
        },
        expect: alphaOf(move.state),
      });
    } else return { steps, ends, unreplayable: `${move.label} at rest` };
    ends.push(i);
    before = move.state;
    i += 1;
  }
  return { steps, ends, unreplayable: null };
}

async function main(): Promise<void> {
  const [dotFile, outFile, ...bugLogs] = process.argv.slice(2);
  if (dotFile === undefined || outFile === undefined) {
    process.stderr.write(
      "usage: bun src/hub/sim/tla/export.ts <dot> <out.jsonl> [bug logs...]\n",
    );
    process.exit(2);
  }
  const started = Date.now();
  const ids = new Map<string, number>();
  const raw: string[] = [];
  const infos: Info[] = [];
  const labels: string[] = [];
  const labelIds = new Map<string, number>();
  const from: number[] = [];
  const to: string[] = [];
  const via: number[] = [];
  let init = -1;
  const node = /^(-?\d+) \[label="((?:[^"\\]|\\.)*)"/u;
  const edge = /^(-?\d+) -> (-?\d+) \[label="((?:[^"\\]|\\.)*)"/u;
  const lines = createInterface({
    input: createReadStream(dotFile),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const e = edge.exec(line);
    if (e !== null) {
      const label = unescape(e[3] ?? "");
      let id = labelIds.get(label);
      if (id === undefined) {
        id = labels.length;
        labels.push(label);
        labelIds.set(label, id);
      }
      from.push(ids.get(e[1] ?? "") ?? -1);
      to.push(e[2] ?? "");
      via.push(id);
      continue;
    }
    const n = node.exec(line);
    if (n === null) continue;
    const text = unescape(n[2] ?? "");
    const index = raw.length;
    ids.set(n[1] ?? "", index);
    raw.push(text);
    infos.push(infoOf(parseState(text)));
    if (init < 0) init = index;
  }
  // Edges name their target by fingerprint; some targets come later.
  const dstOf = new Int32Array(to.length);
  for (let j = 0; j < to.length; j += 1) dstOf[j] = ids.get(to[j] ?? "") ?? -1;
  process.stderr.write(
    `read ${raw.length} states, ${from.length} edges in ${Date.now() - started} ms\n`,
  );

  // Out-edges per state, then BFS from the initial state, skipping reads and
  // states whose memo holds the model's "full" (the code has no task bound).
  const out: number[][] = raw.map(() => []);
  for (let j = 0; j < from.length; j += 1) {
    const src = from[j] ?? -1;
    if (src >= 0) out[src]?.push(j);
  }
  const parent = new Int32Array(raw.length).fill(-2);
  parent[init] = -1;
  const depth = new Int32Array(raw.length).fill(-1);
  depth[init] = 0;
  const queue = [init];
  for (let q = 0; q < queue.length; q += 1) {
    const s = queue[q] ?? 0;
    for (const j of out[s] ?? []) {
      const d = dstOf[j] ?? -1;
      if (d < 0 || parent[d] !== -2) continue;
      if (labels[via[j] ?? 0] === "ReadEvent" || infos[d]?.hasFull === true)
        continue;
      parent[d] = j;
      depth[d] = (depth[s] ?? 0) + 1;
      queue.push(d);
    }
  }
  const pathTo = (s: number): number[] => {
    const edges: number[] = [];
    let at = s;
    while ((parent[at] ?? -1) >= 0) {
      const j = parent[at] ?? 0;
      edges.unshift(j);
      at = from[j] ?? 0;
    }
    return edges;
  };

  // The classes and their shortest examples.
  const chosen = new Map<string, number>();
  for (let j = 0; j < from.length; j += 1) {
    const s = from[j] ?? -1;
    const d = dstOf[j] ?? -1;
    if (s < 0 || d < 0 || (depth[s] ?? -1) < 0) continue;
    const src = infos[s];
    const dst = infos[d];
    if (src === undefined || dst === undefined || !src.atRest || dst.hasFull)
      continue;
    const label = labels[via[j] ?? 0] ?? "";
    let key: string | null = null;
    if (label === "Tick")
      key = `tick ${str(src.task["st"])} ${str(src.task["left"])}`;
    else key = classOf(src, dst, label);
    if (key === null || key.split(" ")[2] === "full") continue;
    const best = chosen.get(key);
    if (best === undefined || (depth[s] ?? 0) < (depth[from[best] ?? 0] ?? 0))
      chosen.set(key, j);
  }
  const stateOf = (s: number): Record<string, Value> =>
    parseState(raw[s] ?? "");
  const continuation = (d: number, finish: string): number[] => {
    // From an open transaction: Commit then finish, or Crash.
    const pick = (s: number, label: string): number | undefined =>
      (out[s] ?? []).find((j) => labels[via[j] ?? 0] === label);
    if (finish === "Crash") {
      const c = pick(d, "Crash");
      return c === undefined ? [] : [c];
    }
    const commit = pick(d, "Commit");
    if (commit === undefined) return [];
    const done = pick(dstOf[commit] ?? 0, finish);
    return done === undefined ? [commit] : [commit, done];
  };
  const paths: { id: string; edges: number[] }[] = [];
  for (const [key, j] of chosen) {
    const prefix = pathTo(from[j] ?? 0);
    const d = dstOf[j] ?? 0;
    if (infos[d]?.pendOk === true)
      for (const finish of ["Reply", "LoseReply", "Crash"])
        paths.push({
          id: `${key} / ${finish}`,
          edges: [...prefix, j, ...continuation(d, finish)],
        });
    else paths.push({ id: key, edges: [...prefix, j] });
  }
  // Drop paths that are prefixes of longer ones.
  paths.sort((a, b) => b.edges.length - a.edges.length);
  const kept: typeof paths = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const signature = path.edges.join(",");
    if (seen.has(signature)) continue;
    kept.push(path);
    for (let n = 1; n <= path.edges.length; n += 1)
      seen.add(path.edges.slice(0, n).join(","));
  }
  const lines2: string[] = [];
  const initial = stateOf(init);
  for (const path of kept) {
    const moves = path.edges.map((j) => ({
      label: labels[via[j] ?? 0] ?? "",
      state: stateOf(dstOf[j] ?? 0),
    }));
    const { steps, unreplayable } = codeSteps(initial, moves);
    if (unreplayable !== null)
      throw new Error(`export: ${path.id}: ${unreplayable}`);
    lines2.push(JSON.stringify({ id: path.id, steps }));
  }

  // The planted bugs' counterexamples.
  const viewIndex = new Map<string, number>();
  infos.forEach((info, index) => viewIndex.set(info.view, index));
  for (const file of bugLogs) {
    const { readFileSync } = await import("node:fs");
    const textAll = readFileSync(file, "utf8");
    const name = /b1-bug-(\w+)/u.exec(file)?.[1] ?? file;
    const rule = /Invariant (\w+) is violated/u.exec(textAll)?.[1] ?? "?";
    const blocks = textAll.split(/^State \d+: /mu).slice(1);
    const states = blocks.map((block) => {
      const header =
        /^<(.*?)(?: line \d+, col \d+ to line \d+, col \d+ of module \w+)?>\n/su.exec(
          block,
        );
      const body = block.slice(header?.[0].length ?? 0).split(/\n\n/u)[0] ?? "";
      return {
        label: (header?.[1] ?? "").replace(/\s+/gu, " "),
        state: parseState(body),
      };
    });
    const first = states[0];
    if (first === undefined) continue;
    const moves = states.slice(1);
    // The first model step that the correct graph does not have.
    let wrongMove = -1;
    let previous = infoOf(first.state);
    for (let m = 0; m < moves.length; m += 1) {
      const move = moves[m];
      if (move === undefined) break;
      const next = infoOf(move.state);
      const s = viewIndex.get(previous.view);
      const d = viewIndex.get(next.view);
      const label = move.label.replace(/ /gu, "").replace(/\|->/gu, " |-> ");
      const found =
        s !== undefined &&
        d !== undefined &&
        (out[s] ?? []).some(
          (j) =>
            dstOf[j] === d &&
            (labels[via[j] ?? 0] ?? "").replace(/\s+/gu, "") ===
              label.replace(/\s+/gu, ""),
        );
      if (!found && !(s !== undefined && d === s)) {
        wrongMove = m;
        break;
      }
      previous = next;
    }
    const { steps, ends, unreplayable } = codeSteps(first.state, moves);
    const failAt = ends.findIndex((end) => end >= wrongMove);
    lines2.push(
      JSON.stringify({
        id: `bug ${name}`,
        bug: name,
        rule,
        failAt:
          unreplayable === null
            ? failAt < 0
              ? steps.length - 1
              : failAt
            : null,
        unreplayable,
        steps,
      }),
    );
  }
  writeFileSync(outFile, `${lines2.join("\n")}\n`);
  process.stderr.write(
    `classes ${chosen.size}, paths ${kept.length} (of ${paths.length}), bugs ${bugLogs.length}, ${Date.now() - started} ms\n`,
  );
}

await main();
