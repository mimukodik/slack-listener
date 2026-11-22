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

import { Effect, Exit, Layer, Scope } from "effect";

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
import {
  canonical,
  type Snapshot,
  sqliteStoreLayer,
  type WritePoint,
  WritePoints,
} from "../store.ts";
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
const inTransaction: readonly WritePoint[] = [
  "begun",
  "evented",
  "projected",
  "recorded",
];

type Step = { readonly call: Call };
type InFlight = {
  readonly step: Step;
  readonly before: Model;
  readonly after: Model;
  readonly expected: Expected;
  readonly repeat: boolean;
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

// The rule a wrong answer to this call breaks.
function ruleOf(action: string, repeat: boolean): string {
  if (repeat) return "T6";
  if (action === "taskAnswer") return "T5";
  if (action === "taskEvents") return "T4";
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

  constructor(runtime: SimRuntime, steps: number) {
    this.runtime = runtime;
    this.steps = steps;
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
    const repeat = after.repeats(
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
    this.inFlight = { step, before, after, expected, repeat };
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
    const wrong = observed(flight.expected, actual);
    if (wrong !== undefined) {
      this.failure = `${ruleOf(call.action, flight.repeat)}: ${call.action} ${JSON.stringify(call.input)} as ${call.bearer} over ${call.surface} answered ${wrong}`;
      return;
    }
    this.count(flight, actual);
    this.model = flight.after;
    this.check(snapshot, flight.repeat ? "T6" : "T1");
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
    else if (!this.model.snapshotEquals(snapshot))
      this.failure = `${rule}: the store differs from the model: ${canonical(snapshot.events.slice(-3))}, the model ${canonical(this.model.events.slice(-3))}`;
  }

  crashed(where: WritePoint | "timer"): void {
    this.coverage.crashes += 1;
    if (inTransaction.includes(where as WritePoint))
      this.coverage.crashesInTransaction += 1;
  }

  // A restarted process's first look at the store: as of the last commit,
  // with or without the call that was in flight.
  restarted(snapshot: Snapshot): void {
    const flight = this.inFlight;
    if (flight === undefined) {
      if (!this.model.snapshotEquals(snapshot))
        this.failure = "T7: the store after a crash differs from the model";
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
    const fault = ruleFault(snapshot);
    if (fault !== undefined) this.failure = `T7, then ${fault}`;
  }

  get crashable(): boolean {
    return this.failure === null && this.coverage.crashes < crashesMax;
  }

  private plan(): Call {
    const surface = this.pick(surfaces);
    if (this.last !== undefined && this.chance(8)) {
      const last = this.last;
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
    ]);
    const input = this.inputFor(action, bearer);
    const call = {
      action,
      bearer: this.answerer(action, input) ?? bearer,
      surface,
      input,
    };
    if (!["taskGet", "taskEvents"].includes(action)) this.last = call;
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
}): Promise<HubResult> {
  const runtime = new SimRuntime(options.seed, [], startMs, false);
  const driver = new Driver(runtime, options.steps);
  const disk = new Disk();
  // Connections live in the world's scope: a crashed process abandons its
  // own, and they close only when the run ends.
  const connections = Effect.runSync(Scope.make());
  const state = { file: disk.fresh() };

  const restart = (where: WritePoint | "timer") => {
    runtime.crash();
    driver.crashed(where);
    state.file = disk.copy(state.file);
    runtime.at(0, () => runtime.start(processOn(state.file, true)), "world");
  };

  const crashTimer = () => {
    if (!driver.crashable) return;
    runtime.at(
      runtime.choices.int(options.steps * 150) + 1,
      () => {
        if (!driver.crashable) return;
        restart("timer");
        crashTimer();
      },
      "world",
    );
  };

  const points = {
    reached: (point: WritePoint) =>
      Effect.suspend(() => {
        if (!driver.crashable || runtime.choices.int(100) >= 3)
          return Effect.void;
        restart(point);
        return Effect.never;
      }),
  };

  const processOn = (file: string, again: boolean) =>
    Effect.gen(function* () {
      // SimRuntime runs a process's first turn inside start, before it knows
      // the process; nothing that may crash runs in it.
      yield* Effect.yieldNow;
      const store = yield* Layer.buildWithScope(
        sqliteStoreLayer(file),
        connections,
      ).pipe(Effect.orDie);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { actions, snapshot } = yield* hubActionsOver.pipe(
            Effect.provideContext(store),
          );
          const world = yield* makeWorld(actions, {
            answer: (respond) => {
              runtime.at(runtime.choices.int(answerMsMax + 1), respond);
            },
          });
          if (again) driver.restarted(yield* snapshot);
          for (;;) {
            const step = driver.next();
            if (step === undefined) return;
            if ("waitMs" in step) {
              yield* Effect.sleep(step.waitMs);
              continue;
            }
            const observation = yield* world.call(step.call);
            driver.answered(observation, yield* snapshot);
          }
        }),
      );
    }).pipe(
      Effect.provide(hubPlatformLayer),
      Effect.provideService(WritePoints, points),
      withFixedBudget,
    );

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
