// The hub simulator: seeded sequences of calls from several principals,
// through every surface, on SimRuntime's clock, with crashes (RULES.md, T1
// to T7). The hub is one process: a store over a SQLite file and the surfaces
// over it. The driver, the model and the disk live in the world, outside it.
//
// A crash comes from a world timer at a seeded time, or at a write point
// inside a mutation's transaction. The process stops where it is, the world
// copies the database and its write-ahead log as they are on disk, and a new
// process starts on the copy (store spike, 2026-11-22). The call in flight is
// then sent again with the same request key, as a client whose answer was
// lost sends it. After every step a checker replays the store's events
// against the rules and compares the store and the answer with the model.
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { withFixedBudget } from "../../action/agreement.ts";
import {
  type Call,
  makeWorld,
  type Observation,
  surfaces,
} from "../../action/harness.ts";
import { host, withTripwire } from "../../sim/host.ts";
import { SimRuntime } from "../../sim/runtime.ts";
import { hubActionsOver, hubPlatformLayer, hubPrincipals } from "../fixture.ts";
import { canonical, type Snapshot, storeLayer, TaskStore } from "../store.ts";
import { type Expected, type Input, Model, ruleFault } from "./model.ts";

export type HubCoverage = {
  calls: number;
  events: number;
  crashes: number;
  crashesInTransaction: number;
  crashesCommittedUnanswered: number;
  lapsedReclaimed: number;
  staleHolderRefused: number;
  repeatedKeys: number;
  reusedKeys: number;
  inputRoundTrips: number;
  wrongAnswerers: number;
  notAnOption: number;
  eventReads: number;
  // Inbox reads that found at least one task waiting.
  inboxHits: number;
  // Calls whose key another principal had already used.
  sharedKeys: number;
  finals: number;
};

export const emptyCoverage = (): HubCoverage => ({
  calls: 0,
  events: 0,
  crashes: 0,
  crashesInTransaction: 0,
  crashesCommittedUnanswered: 0,
  lapsedReclaimed: 0,
  staleHolderRefused: 0,
  repeatedKeys: 0,
  reusedKeys: 0,
  inputRoundTrips: 0,
  wrongAnswerers: 0,
  notAnOption: 0,
  eventReads: 0,
  inboxHits: 0,
  sharedKeys: 0,
  finals: 0,
});

export type HubResult = {
  readonly ok: boolean;
  readonly failure: string | null;
  readonly coverage: HubCoverage;
  // How many scheduler events the run took: two runs of a seed take the same.
  readonly entries: number;
};

const callers = ["h-ann", "h-ben", "h-agent1", "h-agent2"] as const;
const outsiders = ["h-chan", "h-eve", "h-nobody"] as const;
const crashesMax = 4;
const startMs = 1_794_900_000_000;
const answerMsMax = 20;
// Where a crash lands: before a statement inside a write transaction,
// before one outside, or at a seeded time.
type CrashPoint = "transaction" | "statement" | "timer" | "reply";

// A statement runs on the client's own connection and needs no service.
function isStatement(
  value: unknown,
): value is Effect.Effect<unknown, SqlError.SqlError> {
  return Effect.isEffect(value);
}

// The store the checker reads the world's state through.
class CheckerStore extends Context.Service<
  CheckerStore,
  TaskStore["Service"]
>()("hub/sim/CheckerStore") {}

type Step = { readonly call: Call };

// What a mode plans next: a wait, a call with its fate, or nothing more.
export type Planned =
  | { readonly waitMs: number }
  | { readonly call: Call; readonly fate: "answer" | "lose" | "crash" };

// A fixed or bounded way of driving the hub instead of the seeded random
// one (src/hub/sim/conform.ts): the replay of the TLA+ model's paths, and
// runs inside the model's bounds that record a trace for it.
export interface Mode {
  // Whether the call in flight is sent again after a crash.
  readonly retries: boolean;
  // Seeded crashes before a statement, per thousand, besides planned ones.
  readonly crashPerMille: number;
  started(snapshot: Snapshot, nowMs: number): void;
  next(
    model: Model,
    nowMs: number,
    surface: () => Call["surface"],
    int: (n: number) => number,
  ): Planned | undefined;
  // Each returns a failure, or undefined; each sees every step, even one the
  // checker already failed.
  answered(
    call: Call,
    actual: Observation,
    snapshot: Snapshot,
    nowMs: number,
  ): string | undefined;
  waited(waitMs: number, snapshot: Snapshot, nowMs: number): string | undefined;
  restarted(
    call: Call | undefined,
    committed: boolean,
    snapshot: Snapshot,
    nowMs: number,
  ): string | undefined;
}
type InFlight = {
  readonly step: Step;
  readonly before: Model;
  readonly after: Model;
  readonly expected: Expected;
  readonly repeat: boolean;
  readonly keyUsed: boolean;
};

const observed = (
  expected: Expected,
  actual: Observation,
): string | undefined => {
  if (actual.kind === "failure" && expected.kind === "failure") {
    const tag = (actual.error as { readonly _tag?: unknown })._tag;
    return tag === expected.tag
      ? undefined
      : `${String(tag)}, the model ${expected.tag}`;
  }
  if (actual.kind === "success" && expected.kind === "success")
    return canonical(actual.value) === canonical(expected.value)
      ? undefined
      : `${canonical(actual.value)}, the model ${canonical(expected.value)}`;
  return `${JSON.stringify(actual)}, the model ${JSON.stringify(expected)}`;
};

// Which fields of the answered task differ from the model's, when both
// answers carry a task.
function taskDiff(expected: Expected, actual: Observation): readonly string[] {
  if (actual.kind !== "success" || expected.kind !== "success") return [];
  const taskOf = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== "object" || value === null || !("task" in value))
      return undefined;
    const { task } = value;
    return typeof task === "object" && task !== null
      ? Object.fromEntries(Object.entries(task))
      : undefined;
  };
  const got = taskOf(actual.value);
  const want = taskOf(expected.value);
  if (got === undefined || want === undefined) return [];
  return Object.keys(want).filter(
    (key) => canonical(got[key]) !== canonical(want[key]),
  );
}

const leaseFields = [
  "claimant",
  "claimedAt",
  "leaseExpiresAt",
  "leaseRemainingMs",
];

// The rule a wrong answer to this call breaks: from the field that went
// wrong when the answer carries a task, else from the action.
function ruleOf(
  action: string,
  keyUsed: boolean,
  wasFinal: boolean,
  diff: readonly string[],
): string {
  if (keyUsed) return "T6";
  if (wasFinal) return "T3";
  if (diff.some((key) => leaseFields.includes(key))) return "T2";
  if (diff.includes("input")) return "T5";
  if (diff.includes("state")) return "T1";
  if (action === "taskAnswer") return "T5";
  if (action === "taskEvents") return "T4";
  if (action === "taskWaiting") return "inbox";
  if (
    [
      "taskRenew",
      "taskRequestInput",
      "taskComplete",
      "taskFail",
      "taskClaim",
    ].includes(action)
  )
    return "T2";
  return "T1";
}

class Driver {
  model = new Model();
  readonly coverage = emptyCoverage();
  failure: string | null = null;
  private inFlight: InFlight | undefined;
  private done = 0;
  private keys = 0;
  private last: Call | undefined;

  private readonly runtime: SimRuntime;
  private readonly steps: number;

  private readonly mode: Mode | undefined;
  private fate: "answer" | "lose" | "crash" = "answer";

  constructor(runtime: SimRuntime, steps: number, mode?: Mode) {
    this.runtime = runtime;
    this.steps = steps;
    this.mode = mode;
  }

  // Whether to crash before this statement: a mode's planned crash comes
  // at the first statement inside the call's transaction.
  crashHere(inTransaction: boolean): boolean {
    if (this.mode === undefined) return this.int(1000) < 5;
    if (this.fate === "crash" && inTransaction) {
      this.fate = "answer";
      return true;
    }
    // Seeded ones only while a call is in flight: the trace starts from a
    // store that opened.
    return (
      this.inFlight !== undefined &&
      this.mode.crashPerMille > 0 &&
      this.int(1000) < this.mode.crashPerMille
    );
  }

  // Whether the answer that just came is lost: the process dies first.
  loseReply(): boolean {
    if (this.fate !== "lose") return false;
    this.fate = "answer";
    return true;
  }

  // A mode's first look at the store.
  started(snapshot: Snapshot): void {
    this.mode?.started(snapshot, this.runtime.nowMs);
  }

  // A mode's look after a wait.
  waited(waitMs: number, snapshot: Snapshot): void {
    const failure = this.mode?.waited(waitMs, snapshot, this.runtime.nowMs);
    if (this.failure === null && failure !== undefined) this.failure = failure;
  }

  private nextOf(mode: Mode): { readonly waitMs: number } | Step | undefined {
    if (this.failure !== null) return undefined;
    if (this.inFlight !== undefined && mode.retries)
      return this.send(this.inFlight.step, true);
    const planned = mode.next(
      this.model,
      this.runtime.nowMs,
      () => this.pick(surfaces),
      (n) => this.int(n),
    );
    if (planned === undefined || "waitMs" in planned) return planned;
    this.fate = planned.fate;
    return this.send({ call: planned.call }, false);
  }

  private int(n: number): number {
    return this.runtime.choices.int(n);
  }

  private pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("hub sim: pick from nothing");
    return item;
  }

  private chance(percent: number): boolean {
    return this.int(100) < percent;
  }

  // The next thing the process does: wait, call, or stop.
  next(): { readonly waitMs: number } | Step | undefined {
    if (this.mode !== undefined) return this.nextOf(this.mode);
    if (this.failure !== null || this.done >= this.steps) return undefined;
    if (this.inFlight !== undefined) return this.send(this.inFlight.step, true);
    if (this.chance(15)) return { waitMs: this.pick([50, 400, 1500, 4000]) };
    return this.send({ call: this.plan() }, false);
  }

  private send(step: Step, again: boolean): Step {
    const now = this.runtime.nowMs;
    const before =
      again && this.inFlight !== undefined ? this.inFlight.before : this.model;
    const after = before.clone();
    const use = after.keyUse(
      step.call.bearer,
      step.call.action,
      step.call.input,
    );
    const expected = after.call(
      step.call.bearer,
      step.call.action,
      step.call.input,
      now,
    );
    this.inFlight = {
      step,
      before,
      after,
      expected,
      repeat: use === "repeat",
      keyUsed: use !== "new",
    };
    return step;
  }

  answered(actual: Observation, snapshot: Snapshot): void {
    const flight = this.inFlight;
    if (flight === undefined)
      throw new Error("hub sim: an answer with nothing in flight");
    this.inFlight = undefined;
    this.done += 1;
    this.coverage.calls += 1;
    const { call } = flight.step;
    const seen = this.mode?.answered(
      call,
      actual,
      snapshot,
      this.runtime.nowMs,
    );
    this.judge(flight, actual, snapshot);
    if (this.failure === null && seen !== undefined) this.failure = seen;
  }

  private judge(
    flight: InFlight,
    actual: Observation,
    snapshot: Snapshot,
  ): void {
    const { call } = flight.step;
    // The store's own events first: a change the rules forbid names its rule.
    const fault = ruleFault(snapshot);
    if (fault !== undefined) {
      this.failure = fault;
      return;
    }
    const wrong = observed(flight.expected, actual);
    const state = flight.before.tasks.get(String(call.input["taskId"]))?.state;
    const wasFinal =
      state === "completed" || state === "failed" || state === "canceled";
    if (wrong !== undefined) {
      const diff = taskDiff(flight.expected, actual);
      this.failure = `${ruleOf(call.action, flight.keyUsed, wasFinal, diff)}: ${call.action} ${JSON.stringify(call.input)} as ${call.bearer} over ${call.surface} answered ${wrong}`;
      return;
    }
    this.count(flight, actual);
    this.model = flight.after;
    this.check(snapshot, flight.keyUsed ? "T6" : "T1");
  }

  private count(flight: InFlight, actual: Observation): void {
    const { call } = flight.step;
    const tag =
      actual.kind === "failure"
        ? String((actual.error as { _tag?: unknown })._tag)
        : "";
    const prior = flight.before.tasks.get(String(call.input["taskId"]));
    const principal = hubPrincipals[call.bearer];
    if (flight.repeat) this.coverage.repeatedKeys += 1;
    if (tag === "RequestKeyReused") this.coverage.reusedKeys += 1;
    if (tag === "NotWaitingOnYou") this.coverage.wrongAnswerers += 1;
    if (tag === "NotAnOption") this.coverage.notAnOption += 1;
    if (tag === "LeaseNotHeld" && prior?.claimant === principal)
      this.coverage.staleHolderRefused += 1;
    if (call.action === "taskEvents") this.coverage.eventReads += 1;
    if (
      call.action === "taskWaiting" &&
      actual.kind === "success" &&
      canonical(actual.value).includes('"ageMs"')
    )
      this.coverage.inboxHits += 1;
    if (flight.repeat || actual.kind !== "success") return;
    const added = flight.after.events.slice(flight.before.events.length);
    for (const event of added) {
      this.coverage.events += 1;
      const was = flight.before.tasks.get(event.taskId);
      if (event.change._tag === "claimed" && was?.state === "working")
        this.coverage.lapsedReclaimed += 1;
      if (event.change._tag === "answered") this.coverage.inputRoundTrips += 1;
      if (["completed", "failed", "canceled"].includes(event.change._tag))
        this.coverage.finals += 1;
    }
  }

  private check(snapshot: Snapshot, rule: string): void {
    const fault = ruleFault(snapshot);
    if (fault !== undefined) this.failure = fault;
    else {
      const part = this.model.snapshotDiff(snapshot);
      if (part !== undefined)
        this.failure = `${part === "keys" ? "T6" : rule}: the store's ${part} differ from the model's: ${canonical(snapshot.events.slice(-3))}, the model ${canonical(this.model.events.slice(-3))}`;
    }
  }

  crashed(where: CrashPoint): void {
    this.coverage.crashes += 1;
    if (where === "transaction") this.coverage.crashesInTransaction += 1;
  }

  // A restarted process's first look at the store: as of the last commit,
  // with or without the call that was in flight.
  restarted(snapshot: Snapshot): void {
    // The store's own events first, so a forbidden change names its rule.
    const fault = ruleFault(snapshot);
    if (fault !== undefined) {
      this.failure = fault;
      return;
    }
    const flight = this.inFlight;
    if (flight === undefined) {
      if (!this.model.snapshotEquals(snapshot))
        this.failure = "T7: the store after a crash differs from the model";
      const seen = this.mode?.restarted(
        undefined,
        false,
        snapshot,
        this.runtime.nowMs,
      );
      if (this.failure === null && seen !== undefined) this.failure = seen;
      return;
    }
    const committed = flight.after.snapshotEquals(snapshot);
    if (!committed && !flight.before.snapshotEquals(snapshot)) {
      this.failure = `T7: after a crash the store is neither before nor after ${flight.step.call.action}`;
      return;
    }
    if (committed && !flight.before.snapshotEquals(snapshot)) {
      this.coverage.crashesCommittedUnanswered += 1;
      // The first attempt committed: the retry must get its answer back.
      this.inFlight = { ...flight, before: flight.after };
    }
    const mode = this.mode;
    if (mode === undefined) return;
    const seen = mode.restarted(
      flight.step.call,
      committed,
      snapshot,
      this.runtime.nowMs,
    );
    if (seen !== undefined) this.failure = seen;
    if (!mode.retries) {
      // No retry: the model moves on as of the store.
      this.model = committed ? flight.after : flight.before;
      this.inFlight = undefined;
    }
  }

  get crashable(): boolean {
    return (
      this.failure === null &&
      (this.mode !== undefined || this.coverage.crashes < crashesMax)
    );
  }

  private plan(): Call {
    const surface = this.pick(surfaces);
    if (this.last !== undefined && this.chance(8)) {
      const last = this.last;
      if (this.chance(15)) {
        // The same key from another principal: a call of its own.
        this.coverage.sharedKeys += 1;
        const others = callers.filter((each) => each !== last.bearer);
        return { ...last, surface, bearer: this.pick(others) };
      }
      return this.chance(70)
        ? { ...last, surface }
        : {
            ...last,
            surface,
            input: { ...last.input, ...this.variant(last.action) },
          };
    }
    const bearer = this.chance(5) ? this.pick(outsiders) : this.pick(callers);
    const action = this.pick([
      "taskCreate",
      "taskCreate",
      "taskClaim",
      "taskClaim",
      "taskRenew",
      "taskRequestInput",
      "taskRequestInput",
      "taskAnswer",
      "taskAnswer",
      "taskAmend",
      "taskCancel",
      "taskComplete",
      "taskComplete",
      "taskFail",
      "taskGet",
      "taskEvents",
      "taskWaiting",
    ]);
    const input = this.inputFor(action, bearer);
    const call = {
      action,
      bearer: this.answerer(action, input) ?? bearer,
      surface,
      input,
    };
    if (!["taskGet", "taskEvents", "taskWaiting"].includes(action))
      this.last = call;
    return call;
  }

  private variant(action: string): Input {
    if (action === "taskCreate") return { title: "another" };
    if (action === "taskClaim") return { leaseMs: 7 };
    return { taskId: "T999" };
  }

  private target(
    bearer: string,
    wanted: (task: {
      readonly claimant: string | null;
      readonly input: { readonly waitingOn: string } | null;
      readonly creator: string;
    }) => boolean,
  ): string {
    const principal = hubPrincipals[bearer];
    const tasks = [...this.model.tasks.values()];
    const mine = tasks.filter(
      (task) => principal !== undefined && wanted(task),
    );
    if (mine.length > 0 && this.chance(75)) return this.pick(mine).id;
    if (tasks.length > 0 && this.chance(90)) return this.pick(tasks).id;
    return "T999";
  }

  private inputFor(action: string, bearer: string): Input {
    this.keys += 1;
    const requestKey = `k${this.keys}`;
    const principal = hubPrincipals[bearer] ?? "";
    const labels = this.pick([[], ["ops"], ["ci"], ["ops", "ci"]]);
    const holder = () =>
      this.target(bearer, (task) => task.claimant === principal);
    switch (action) {
      case "taskCreate":
        return {
          requestKey,
          title: this.pick(["fix ci", "review pr", "answer"]),
          labels,
        };
      case "taskClaim":
        return {
          requestKey,
          labels: this.pick([[], [], ["ci"]]),
          leaseMs: this.pick([200, 1000, 3000]),
        };
      case "taskRenew":
        return {
          requestKey,
          taskId: holder(),
          leaseMs: this.pick([200, 1000, 3000]),
        };
      case "taskRequestInput":
        return {
          requestKey,
          taskId: holder(),
          question: "merge?",
          options: this.pick([
            ["yes", "no"],
            ["a", "b", "c"],
          ]),
          waitingOn: hubPrincipals[this.pick(callers)] ?? "",
        };
      case "taskAnswer": {
        const waiting = [...this.model.tasks.values()].filter(
          (task) => task.input !== null,
        );
        const task =
          waiting.length > 0 && this.chance(85)
            ? this.pick(waiting)
            : undefined;
        const options = task?.input?.options ?? ["yes"];
        return {
          requestKey,
          taskId: task?.id ?? this.target(bearer, () => false),
          option: this.chance(85) ? this.pick(options) : "nope",
        };
      }
      case "taskAmend":
        return {
          requestKey,
          taskId: this.target(bearer, (task) => task.creator === principal),
          instructions: "also lint",
        };
      case "taskCancel":
        return {
          requestKey,
          taskId: this.target(bearer, (task) => task.creator === principal),
        };
      case "taskComplete":
        return {
          requestKey,
          taskId: holder(),
          text: "merged",
          url: this.pick([null, "https://example.invalid/pr/1"]),
        };
      case "taskFail":
        return { requestKey, taskId: holder(), reason: "red ci" };
      case "taskGet":
        return { taskId: this.target(bearer, () => false) };
      case "taskWaiting": {
        const waited = [...this.model.tasks.values()].flatMap((task) =>
          task.input === null ? [] : [task.input.waitingOn],
        );
        return {
          principal:
            waited.length > 0 && this.chance(70)
              ? this.pick(waited)
              : (hubPrincipals[this.pick(callers)] ?? ""),
          limit: this.pick([1, 5, 200]),
        };
      }
      default:
        return {
          after: this.int(this.model.events.length + 2),
          limit: this.pick([1, 5, 200]),
        };
    }
  }

  // The bearer a call to answer comes from: mostly the principal waited on.
  private answerer(action: string, input: Input): string | undefined {
    if (action !== "taskAnswer" || !this.chance(70)) return undefined;
    const task = this.model.tasks.get(String(input["taskId"]));
    return Object.entries(hubPrincipals).find(
      ([, id]) => id === task?.input?.waitingOn,
    )?.[0];
  }
}

// The files a run made, removed by their exact names when it ends.
class Disk {
  readonly dir = mkdtempSync(join(tmpdir(), "hub-sim-"));
  private readonly files: string[] = [];
  private count = 0;

  fresh(): string {
    this.count += 1;
    const file = join(this.dir, `hub-${this.count}.db`);
    this.files.push(file, `${file}-wal`, `${file}-shm`);
    return file;
  }

  // The database as a crash leaves it on disk: the file and its log.
  copy(from: string): string {
    const to = this.fresh();
    copyFileSync(from, to);
    if (existsSync(`${from}-wal`)) copyFileSync(`${from}-wal`, `${to}-wal`);
    return to;
  }

  remove(): void {
    for (const file of this.files) if (existsSync(file)) unlinkSync(file);
    rmdirSync(this.dir);
  }
}

export async function runHubSimulation(options: {
  readonly seed: number;
  readonly steps: number;
  // A fixed or bounded mode: answers come at once, no timer crashes, and
  // the mode's crashes and lost answers instead of seeded ones.
  readonly mode?: Mode;
}): Promise<HubResult> {
  const runtime = new SimRuntime(options.seed, [], startMs, false);
  const driver = new Driver(runtime, options.steps, options.mode);
  const moded = options.mode !== undefined;
  const disk = new Disk();
  // Connections live in the world's scope: a crashed process abandons its
  // own, and they close only when the run ends.
  const connections = Effect.runSync(Scope.make());
  const state = { file: disk.fresh(), crashing: false };

  const restart = (where: CrashPoint) => {
    runtime.crash();
    driver.crashed(where);
    state.file = disk.copy(state.file);
    runtime.at(0, () => runtime.start(processOn(state.file, true)), "world");
  };

  const crashTimer = () => {
    if (moded || !driver.crashable) return;
    runtime.at(
      runtime.choices.int(options.steps * 150) + 1,
      () => {
        if (!driver.crashable || state.crashing) return;
        restart("timer");
        crashTimer();
      },
      "world",
    );
  };

  // The process's SQL client, with a seeded crash before any statement the
  // store runs; BEGIN and COMMIT belong to the client and are not hooked.
  const crashing = Layer.effect(SqlClient.SqlClient)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The statement's fiber stops here for good, and the crash itself is
      // a world timer due at once: a fiber may run inside the host's drain,
      // where a crash would let the rest of the drain schedule timers for
      // the dead process. Until the timer fires nothing else writes: the
      // fiber holds the connection.
      const point = Effect.withFiber((fiber) => {
        const open = Context.getOrUndefined(
          fiber.context,
          sql.transactionService,
        );
        if (
          !driver.crashable ||
          state.crashing ||
          !driver.crashHere(open !== undefined)
        )
          return Effect.void;
        state.crashing = true;
        runtime.at(
          0,
          () => {
            state.crashing = false;
            restart(open === undefined ? "statement" : "transaction");
          },
          "world",
        );
        return Effect.never;
      });
      return new Proxy(sql, {
        apply: (target, self, args: unknown[]) => {
          // A tagged template is a statement, an Effect on the client's own
          // connection; anything else (an identifier, a fragment) passes.
          const statement: unknown = Reflect.apply(target, self, args);
          const template = Array.isArray(args[0]) && "raw" in args[0];
          return template && isStatement(statement)
            ? Effect.andThen(point, statement)
            : statement;
        },
      });
    }),
  );

  const storesOn = (file: string) => {
    const client = SqliteClient.layer({ filename: file });
    // The checker reads through a store of its own, which never crashes.
    const checker = Layer.effect(CheckerStore)(
      Effect.gen(function* () {
        return yield* TaskStore;
      }),
    ).pipe(Layer.provide(storeLayer));
    return Layer.merge(storeLayer.pipe(Layer.provide(crashing)), checker).pipe(
      Layer.provide(client),
    );
  };

  const processOn = (file: string, again: boolean) =>
    Effect.gen(function* () {
      // SimRuntime runs a process's first turn inside start, before it knows
      // the process; nothing that may crash runs in it.
      yield* Effect.yieldNow;
      const store = yield* Layer.buildWithScope(
        storesOn(file),
        connections,
      ).pipe(Effect.orDie);
      const checker = Context.get(store, CheckerStore);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { snapshot } = checker;
          const { actions } = yield* hubActionsOver.pipe(
            Effect.provideContext(store),
          );
          const world = yield* makeWorld(actions, {
            answer: (respond) => {
              runtime.at(
                moded ? 0 : runtime.choices.int(answerMsMax + 1),
                respond,
              );
            },
          });
          if (again) driver.restarted(yield* snapshot);
          else if (moded) driver.started(yield* snapshot);
          for (;;) {
            const step = driver.next();
            if (step === undefined) return;
            if ("waitMs" in step) {
              yield* Effect.sleep(step.waitMs);
              if (moded) driver.waited(step.waitMs, yield* snapshot);
              continue;
            }
            const observation = yield* world.call(step.call);
            if (driver.loseReply()) {
              // The process dies with the answer committed and undelivered.
              state.crashing = true;
              runtime.at(
                0,
                () => {
                  state.crashing = false;
                  restart("reply");
                },
                "world",
              );
              return yield* Effect.never;
            }
            driver.answered(observation, yield* snapshot);
          }
        }),
      );
    }).pipe(Effect.provide(hubPlatformLayer), withFixedBudget);

  try {
    const { value, tripped } = await withTripwire(async () => {
      runtime.start(processOn(state.file, false));
      crashTimer();
      return runtime.run(
        { stepsMax: 5_000_000, timeMsMax: startMs + 86_400_000 },
        host,
      );
    });
    const failure =
      tripped.length > 0
        ? `a real ${tripped[0]?.name ?? "timer"} ran`
        : (driver.failure ??
          (value.kind !== "done"
            ? `the run ended ${value.kind}`
            : Exit.isFailure(value.exit)
              ? `the process failed: ${String(value.exit.cause)}`
              : null));
    return {
      ok: failure === null,
      failure,
      coverage: driver.coverage,
      entries: runtime.entries,
    };
  } finally {
    Effect.runSync(Scope.close(connections, Exit.void));
    disk.remove();
  }
}
