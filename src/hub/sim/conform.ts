// The round trip between the hub and its TLA+ model, spec/tasks/Tasks.tla
// (DECISIONS.md, B1c).
//
// Model to code: ReplayMode drives the hub along a path TLC found, one
// model step group at a time (a call, a call whose answer is lost, a call
// that crashes before its commit, a tick), and compares α of the store, and
// each answer's code, with what the model says after that step.
//
// Code to model: BoundedMode drives the hub at random inside the model's
// bounds (two principals, one task, two keys each, at most four events) and
// records α after every step, for TLC to check against the spec
// (spec/tasks/TraceTasks.tla).
import type { Call, Observation } from "../../action/harness.ts";
import type { Snapshot } from "../store.ts";
import {
  type Alpha,
  alphaKey,
  alphaOf,
  callOf,
  codeOf,
  type CompactAlpha,
  compactOf,
  type ModelInput,
  type ModelPrincipal,
  principalOf,
  tickMs,
} from "./alpha.ts";
import type { Model } from "./model.ts";
import type { Mode, Planned } from "./simulator.ts";

export type ReplayStep =
  | {
      readonly do: "call" | "lose" | "crash";
      readonly p: ModelPrincipal;
      readonly k: string;
      readonly inp: ModelInput;
      readonly ans?: string;
      readonly expect: CompactAlpha;
    }
  | { readonly do: "tick"; readonly expect: CompactAlpha }
  | { readonly do: "read"; readonly expect: CompactAlpha };

export type ReplayPath = {
  readonly id: string;
  readonly steps: readonly ReplayStep[];
  // For a planted bug's counterexample: the step it must fail at on a
  // correct hub, or null when it cannot be replayed (and why).
  readonly bug?: string;
  readonly rule?: string;
  readonly failAt?: number | null;
  readonly unreplayable?: string | null;
};

const same = (a: CompactAlpha, b: CompactAlpha): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export class ReplayMode implements Mode {
  readonly retries = false;
  readonly crashPerMille = 0;
  private index = -1;
  private readonly path: ReplayPath;

  constructor(path: ReplayPath) {
    this.path = path;
  }

  started(): void {
    // The path starts from the empty store, as the model's Init.
  }

  get stepsDone(): number {
    return this.index + 1;
  }

  private current(): ReplayStep | undefined {
    return this.path.steps[this.index];
  }

  next(
    _model: Model,
    _nowMs: number,
    surface: () => Call["surface"],
  ): Planned | undefined {
    this.index += 1;
    const step = this.current();
    if (step === undefined) return undefined;
    if (step.do === "tick") return { waitMs: tickMs };
    if (step.do === "read")
      throw new Error(
        "replay: a read inside an open transaction cannot be replayed",
      );
    const made = callOf(step.p, step.k, step.inp);
    const fate =
      step.do === "call" ? "answer" : step.do === "lose" ? "lose" : "crash";
    return { call: { ...made, surface: surface() }, fate };
  }

  private compare(snapshot: Snapshot, nowMs: number): string | undefined {
    const step = this.current();
    if (step === undefined) return undefined;
    const actual = compactOf(alphaOf(snapshot, nowMs));
    return same(actual, step.expect)
      ? undefined
      : `replay step ${String(this.index)}: α ${JSON.stringify(actual)}, the model ${JSON.stringify(step.expect)}`;
  }

  answered(
    _call: Call,
    actual: Observation,
    snapshot: Snapshot,
    nowMs: number,
  ): string | undefined {
    const step = this.current();
    if (step === undefined || step.do !== "call") return undefined;
    const code = codeOf(actual);
    if (code !== step.ans)
      return `replay step ${String(this.index)}: answered ${code}, the model ${String(step.ans)}`;
    return this.compare(snapshot, nowMs);
  }

  waited(
    _waitMs: number,
    snapshot: Snapshot,
    nowMs: number,
  ): string | undefined {
    return this.compare(snapshot, nowMs);
  }

  restarted(
    _call: Call | undefined,
    _committed: boolean,
    snapshot: Snapshot,
    nowMs: number,
  ): string | undefined {
    return this.compare(snapshot, nowMs);
  }
}

// One line of a recorded trace: what happened and α after it.
export type TraceLine = {
  readonly kind: "init" | "call" | "lost" | "tick";
  readonly p?: ModelPrincipal;
  readonly k?: string;
  readonly inp?: ModelInput;
  readonly ans?: string;
  readonly ticks?: number;
  readonly alpha: Alpha;
};

const ops = [
  "create",
  "claim",
  "claim",
  "renew",
  "renew",
  "request",
  "answer",
  "answer",
  "amend",
  "cancel",
  "complete",
  "fail",
] as const;

export class BoundedMode implements Mode {
  readonly retries = true;
  readonly crashPerMille = 20;
  readonly lines: TraceLine[] = [];
  private calls = 0;
  private int: (n: number) => number = () => 0;
  private readonly callsMax: number;
  private planned:
    | { p: ModelPrincipal; k: string; inp: ModelInput }
    | undefined;

  constructor(callsMax: number) {
    this.callsMax = callsMax;
  }

  private pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("bounded: pick from nothing");
    return item;
  }

  next(
    model: Model,
    _nowMs: number,
    surface: () => Call["surface"],
    int: (n: number) => number,
  ): Planned | undefined {
    this.int = int;
    if (this.lines.length === 0)
      throw new Error("bounded: record the initial state first");
    if (model.events.length >= 4 || this.calls >= this.callsMax)
      return undefined;
    if (this.int(100) < 20) return { waitMs: tickMs * (1 + this.int(2)) };
    this.calls += 1;
    const p = this.pick(["p1", "p2"] as const);
    // Four keys in all: mostly a fresh one while there is one, so a trace
    // reaches past the first refusals; a used one tests T6.
    const fresh = ["k1", "k2"].filter(
      (key) => !model.requests.has(`${principalOf[p]} ${key}`),
    );
    const k = this.pick(
      fresh.length > 0 && this.int(100) < 85 ? fresh : ["k1", "k2"],
    );
    const keyUsed = model.requests.has(`${principalOf[p]} ${k}`);
    // One task: a create on a fresh key once it exists would make a second,
    // beyond the bound.
    const op: string =
      model.tasks.size === 0
        ? this.int(100) < 60
          ? "create"
          : this.pick(ops)
        : this.pick(keyUsed ? ops : ops.filter((each) => each !== "create"));
    const arg =
      op === "request"
        ? this.pick(["p1", "p2"])
        : op === "answer"
          ? this.pick(["o1", "o2", "o3"])
          : "NoArg";
    const inp = { op, t: op === "create" || op === "claim" ? 0 : 1, arg };
    this.planned = { p, k, inp };
    return {
      call: { ...callOf(p, k, inp), surface: surface() },
      fate: "answer",
    };
  }

  started(snapshot: Snapshot, nowMs: number): void {
    this.lines.push({ kind: "init", alpha: alphaOf(snapshot, nowMs) });
  }

  answered(
    _call: Call,
    actual: Observation,
    snapshot: Snapshot,
    nowMs: number,
  ): undefined {
    if (this.planned !== undefined)
      this.lines.push({
        kind: "call",
        ...this.planned,
        ans: codeOf(actual),
        alpha: alphaOf(snapshot, nowMs),
      });
    return undefined;
  }

  waited(waitMs: number, snapshot: Snapshot, nowMs: number): undefined {
    this.lines.push({
      kind: "tick",
      ticks: waitMs / tickMs,
      alpha: alphaOf(snapshot, nowMs),
    });
    return undefined;
  }

  restarted(
    call: Call | undefined,
    _committed: boolean,
    snapshot: Snapshot,
    nowMs: number,
  ): undefined {
    const alpha = alphaOf(snapshot, nowMs);
    const last = this.lines[this.lines.length - 1];
    // A crash that left the store as it was is a stutter: no line.
    if (call === undefined || this.planned === undefined || last === undefined)
      return undefined;
    if (alphaKey(last.alpha) === alphaKey(alpha)) return undefined;
    this.lines.push({ kind: "lost", ...this.planned, alpha });
    return undefined;
  }
}
