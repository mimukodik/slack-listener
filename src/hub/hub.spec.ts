import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Clock, Effect, Exit, Layer, Scope } from "effect";
import fc from "fast-check";

import { SurfaceServices } from "../action/action.ts";
import {
  type Agreement,
  disagreement,
  runAgreementWith,
  runSequenceWith,
  runSimulatedWith,
} from "../action/agreement.ts";
import {
  type Call,
  makeWorld,
  type Observation,
  surfaces,
  type WorldOptions,
} from "../action/harness.ts";
import {
  hubActionsOver,
  hubBearers,
  hubFixture,
  hubPlatformLayer,
  settableClock,
} from "./fixture.ts";
import { runHubSimulation } from "./sim/simulator.ts";
import {
  holdWriterLock,
  type Snapshot,
  sqliteStoreLayer,
  TaskStore,
} from "./store.ts";

// A sequence of calls and the time each is made at.
type Timed = {
  readonly calls: readonly Call[];
  readonly at: readonly number[];
};

// The agreement over the hub, with the clock set before each call, so every
// run sees the same times and the same leases lapse.
function hubAgreement(
  timed: Timed,
  options: WorldOptions = {},
): Effect.Effect<Agreement<Snapshot>, never, never> {
  return Effect.gen(function* () {
    const beneath = yield* Clock.Clock;
    const now = { ms: 0 };
    return yield* runAgreementWith(hubFixture, timed.calls, {
      ...options,
      before: (index) => {
        now.ms = timed.at[index] ?? now.ms;
      },
    }).pipe(
      Effect.provideService(
        Clock.Clock,
        settableClock(beneath, () => now.ms),
      ),
    );
  }).pipe(Effect.provide(hubPlatformLayer));
}

const taskId = fc.oneof(
  fc.constantFrom("T1", "T2", "T3", "T4", "T5", "T6", "T7", "T9"),
  fc.constantFrom("x", "T", 7),
);
const requestKey = fc.oneof(
  fc.constantFrom("k1", "k2", "k3", "k4", "k5", "k6"),
  fc.constantFrom("", "bad key"),
);
const labels = fc.constantFrom([], ["ops"], ["ci"], ["ops", "ci"], ["Bad"]);
const leaseMs = fc.constantFrom(50, 1000, 30_000, 0);
const principal = fc.constantFrom(
  "slack-user-t0000-u0001",
  "agent-a0001",
  "agent-a0002",
);

const input: Record<string, fc.Arbitrary<Record<string, unknown>>> = {
  taskCreate: fc.record({
    requestKey,
    title: fc.constantFrom("fix ci", "review", ""),
    labels,
  }),
  taskClaim: fc.record({ requestKey, labels, leaseMs }),
  taskRenew: fc.record({ taskId, requestKey, leaseMs }),
  taskRequestInput: fc.record({
    taskId,
    requestKey,
    question: fc.constantFrom("merge?", "which?"),
    options: fc.constantFrom(["yes", "no"], ["a", "b", "c"], ["only"]),
    waitingOn: principal,
  }),
  taskAnswer: fc.record({
    taskId,
    requestKey,
    option: fc.constantFrom("yes", "no", "a", "zzz"),
  }),
  taskAmend: fc.record({
    taskId,
    requestKey,
    instructions: fc.constantFrom("also lint", "stop"),
  }),
  taskCancel: fc.record({ taskId, requestKey }),
  taskComplete: fc.record({
    taskId,
    requestKey,
    text: fc.constantFrom("done", "merged"),
    url: fc.constantFrom(null, "https://example.invalid/pr/1", "ftp://x"),
  }),
  taskFail: fc.record({
    taskId,
    requestKey,
    reason: fc.constantFrom("red ci", "gave up"),
  }),
  taskGet: fc.record({ taskId }),
  taskEvents: fc.record({
    after: fc.constantFrom(0, 1, 3, -1),
    limit: fc.constantFrom(1, 5, 200, 0),
  }),
  taskWaiting: fc.record({
    principal: fc.oneof(principal, fc.constant("")),
    limit: fc.constantFrom(1, 5, 0),
  }),
};

const call: fc.Arbitrary<Call> = fc
  .constantFrom(...Object.keys(input))
  .chain((action) =>
    fc.record({
      action: fc.constant(action),
      input: input[action] ?? fc.constant({}),
      bearer: fc.constantFrom(...hubBearers),
      surface: fc.constantFrom(...surfaces),
    }),
  );

const timed: fc.Arbitrary<Timed> = fc
  .array(fc.tuple(call, fc.constantFrom(0, 10, 400, 5000)), {
    minLength: 1,
    maxLength: 24,
  })
  .map((pairs) => {
    let ms = 1_000_000;
    return {
      calls: pairs.map(([each]) => each),
      at: pairs.map(([, gap]) => {
        ms += gap;
        return ms;
      }),
    };
  });

const kinds = (observations: readonly Observation[]) =>
  observations.map((observation) =>
    observation.kind === "failure"
      ? (observation.error as { _tag: string })._tag
      : observation.kind,
  );

describe("the task hub's actions", () => {
  it("every surface gives the same answers and leaves the same store", async () => {
    await fc.assert(
      fc.asyncProperty(timed, async (sequence) => {
        const agreement = await Effect.runPromise(hubAgreement(sequence));
        const difference = disagreement(sequence.calls, agreement);
        if (difference !== undefined) throw new Error(difference);
      }),
      { numRuns: 120 },
    );
  }, 300_000);

  it("the surfaces agree under the simulator's seeded scheduler, with no real timer", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), timed, async (seed, sequence) => {
        const run = await runSimulatedWith(seed, (options) =>
          hubAgreement(sequence, options),
        );
        expect(run.tripped).toEqual([]);
        expect(run.outcome).toBe("done");
        if (run.agreement === undefined) throw new Error("no agreement");
        const difference = disagreement(sequence.calls, run.agreement);
        if (difference !== undefined)
          throw new Error(`seed ${seed}: ${difference}`);
      }),
      { numRuns: 100 },
    );
  }, 300_000);

  it("runs a task from create to complete, with a question on the way", async () => {
    const at = (
      bearer: string,
      action: string,
      given: Record<string, unknown>,
    ): Call => ({
      action,
      input: given,
      bearer,
      surface: "direct",
    });
    const calls: Call[] = [
      at("h-ann", "taskCreate", {
        requestKey: "c",
        title: "fix ci",
        labels: ["ci"],
      }),
      at("h-agent1", "taskClaim", {
        requestKey: "a",
        labels: ["ci"],
        leaseMs: 1000,
      }),
      at("h-agent1", "taskRequestInput", {
        taskId: "T1",
        requestKey: "q",
        question: "merge?",
        options: ["yes", "no"],
        waitingOn: "slack-user-t0000-u0001",
      }),
      at("h-ben", "taskAnswer", {
        taskId: "T1",
        requestKey: "x",
        option: "yes",
      }),
      at("h-ann", "taskAnswer", {
        taskId: "T1",
        requestKey: "x",
        option: "maybe",
      }),
      at("h-ann", "taskAnswer", {
        taskId: "T1",
        requestKey: "y",
        option: "yes",
      }),
      at("h-ann", "taskAnswer", {
        taskId: "T1",
        requestKey: "y",
        option: "yes",
      }),
      at("h-ann", "taskAnswer", {
        taskId: "T1",
        requestKey: "y",
        option: "no",
      }),
      at("h-agent1", "taskComplete", {
        taskId: "T1",
        requestKey: "d",
        text: "merged",
        url: null,
      }),
      at("h-agent2", "taskClaim", {
        requestKey: "b",
        labels: [],
        leaseMs: 1000,
      }),
      at("h-ann", "taskCancel", { taskId: "T1", requestKey: "z" }),
    ];
    const run = await Effect.runPromise(
      runSequenceWith(hubFixture, calls, "chosen").pipe(
        Effect.provide(hubPlatformLayer),
      ),
    );
    expect(kinds(run.observations)).toEqual([
      "success",
      "success",
      "success",
      "NotWaitingOnYou",
      "NotAnOption",
      "success",
      "success",
      "RequestKeyReused",
      "success",
      "success",
      "WrongState",
    ]);
    expect(run.snapshot.tasks[0]?.state).toBe("completed");
    expect(run.snapshot.events.map((event) => event.change._tag)).toEqual([
      "created",
      "claimed",
      "inputRequested",
      "answered",
      "completed",
    ]);
    // The repeat returned the first answer, with no second event.
    expect(run.observations[6]).toEqual(run.observations[5]);
  });
});

describe("the inbox", () => {
  it("lists the tasks waiting on a principal, longest first, with how long each has waited", async () => {
    const ann = "slack-user-t0000-u0001";
    const step = (
      bearer: string,
      action: string,
      input: Record<string, unknown>,
    ): Call => ({ action, input, bearer, surface: "rest" });
    const ask = (taskId: string, requestKey: string) =>
      step("h-agent1", "taskRequestInput", {
        taskId,
        requestKey,
        question: "merge?",
        options: ["yes", "no"],
        waitingOn: ann,
      });
    const inbox = (principal: string) =>
      step("h-ben", "taskWaiting", { principal, limit: 10 });
    const claim = (requestKey: string) =>
      step("h-agent1", "taskClaim", {
        requestKey,
        labels: [],
        leaseMs: 60_000,
      });
    const timed: Timed = {
      calls: [
        step("h-ben", "taskCreate", {
          requestKey: "c1",
          title: "a",
          labels: [],
        }),
        step("h-ben", "taskCreate", {
          requestKey: "c2",
          title: "b",
          labels: [],
        }),
        claim("k1"),
        claim("k2"),
        ask("T2", "q2"),
        ask("T1", "q1"),
        inbox(ann),
        inbox("agent-a0002"),
        step("h-ann", "taskAnswer", {
          taskId: "T2",
          requestKey: "a",
          option: "yes",
        }),
        inbox(ann),
      ],
      at: [0, 0, 10, 10, 1000, 2500, 4000, 4000, 5000, 6000],
    };
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const beneath = yield* Clock.Clock;
        const now = { ms: 0 };
        return yield* runSequenceWith(hubFixture, timed.calls, "chosen", {
          before: (index) => {
            now.ms = timed.at[index] ?? now.ms;
          },
        }).pipe(
          Effect.provideService(
            Clock.Clock,
            settableClock(beneath, () => now.ms),
          ),
        );
      }).pipe(Effect.provide(hubPlatformLayer)),
    );
    const listed = (index: number) => {
      const observation = run.observations[index];
      if (observation?.kind !== "success") throw new Error("not a success");
      const { tasks } = observation.value as {
        tasks: Array<{ task: { id: string }; ageMs: number }>;
      };
      return tasks.map((each) => [each.task.id, each.ageMs]);
    };
    expect(listed(6)).toEqual([
      ["T2", 3000],
      ["T1", 1500],
    ]);
    expect(listed(7)).toEqual([]);
    expect(listed(9)).toEqual([["T1", 3500]]);
  });
});

describe("claim order", () => {
  // The TLC lasso from the TLA+ spike (design-oldestFirstStarves): with
  // oldest-first claims, one worker reclaims t1 each time it lapses, and t2
  // never runs. Least recently claimed first takes turns.
  it("ends a lease at its expiry instant: the old holder is refused there and a new claim succeeds", async () => {
    const step = (
      bearer: string,
      action: string,
      input: Record<string, unknown>,
    ): Call => ({ action, input, bearer, surface: "direct" });
    const timed: Timed = {
      calls: [
        step("h-ann", "taskCreate", {
          requestKey: "c",
          title: "t",
          labels: [],
        }),
        step("h-agent1", "taskClaim", {
          requestKey: "a",
          labels: [],
          leaseMs: 1000,
        }),
        step("h-agent2", "taskClaim", {
          requestKey: "b",
          labels: [],
          leaseMs: 1000,
        }),
        step("h-agent1", "taskRenew", {
          taskId: "T1",
          requestKey: "r",
          leaseMs: 1000,
        }),
        step("h-agent2", "taskClaim", {
          requestKey: "d",
          labels: [],
          leaseMs: 1000,
        }),
      ],
      // Claimed at 10 for 1000 ms: live at 1009, lapsed at 1010.
      at: [0, 10, 1009, 1010, 1010],
    };
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const beneath = yield* Clock.Clock;
        const now = { ms: 0 };
        return yield* runSequenceWith(hubFixture, timed.calls, "chosen", {
          before: (index) => {
            now.ms = timed.at[index] ?? now.ms;
          },
        }).pipe(
          Effect.provideService(
            Clock.Clock,
            settableClock(beneath, () => now.ms),
          ),
        );
      }).pipe(Effect.provide(hubPlatformLayer)),
    );
    const shape = run.observations.map((observation) =>
      observation.kind === "failure"
        ? (observation.error as { _tag: string })._tag
        : observation.kind === "success"
          ? ((observation.value as { _tag?: string })._tag ?? "success")
          : observation.kind,
    );
    expect(shape).toEqual([
      "success",
      "Claimed",
      "NoneReady",
      "LeaseNotHeld",
      "Claimed",
    ]);
  });

  it("takes the task claimed least recently, so a task that keeps lapsing starves no other", async () => {
    const step = (
      bearer: string,
      action: string,
      input: Record<string, unknown>,
    ): Call => ({ action, input, bearer, surface: "direct" });
    const claim = (requestKey: string) =>
      step("h-agent1", "taskClaim", {
        requestKey,
        labels: [],
        leaseMs: 1000,
      });
    const timed: Timed = {
      calls: [
        step("h-ann", "taskCreate", {
          requestKey: "c1",
          title: "t1",
          labels: [],
        }),
        step("h-ann", "taskCreate", {
          requestKey: "c2",
          title: "t2",
          labels: [],
        }),
        claim("k1"),
        claim("k2"),
        claim("k3"),
        claim("k4"),
      ],
      at: [0, 0, 10, 2000, 4000, 6000],
    };
    const run = await Effect.runPromise(
      Effect.gen(function* () {
        const beneath = yield* Clock.Clock;
        const now = { ms: 0 };
        return yield* runSequenceWith(hubFixture, timed.calls, "chosen", {
          before: (index) => {
            now.ms = timed.at[index] ?? now.ms;
          },
        }).pipe(
          Effect.provideService(
            Clock.Clock,
            settableClock(beneath, () => now.ms),
          ),
        );
      }).pipe(Effect.provide(hubPlatformLayer)),
    );
    const claimed = run.observations.slice(2).map((observation) => {
      if (observation.kind !== "success") throw new Error("not a success");
      return (observation.value as { task: { id: string } }).task.id;
    });
    // t1 lapsed at 1010: t2 was never claimed, so it goes first. Then both
    // have lapsed and t1 was claimed longer ago, and so on in turn.
    expect(claimed).toEqual(["T1", "T2", "T1", "T2"]);
  });
});

describe("what a hub handler receives", () => {
  const servedBy = {
    rest: "rest",
    atom: "rest",
    mcp: "mcp",
    rpc: "rpc",
    direct: "direct",
  };

  it("is the principal, on exactly the services its surface was built with, for every action", async () => {
    const built = new Map<string, readonly string[]>();
    const seen: Array<{
      readonly surface: string;
      readonly principal: string;
      readonly keys: string[];
    }> = [];
    const current = { surface: "" };
    const inputs: Record<string, Record<string, unknown>> = {
      taskCreate: { requestKey: "k", title: "t", labels: [] },
      taskClaim: { requestKey: "k", labels: [], leaseMs: 10 },
      taskRenew: { taskId: "T1", requestKey: "k", leaseMs: 10 },
      taskRequestInput: {
        taskId: "T1",
        requestKey: "k",
        question: "q",
        options: ["a", "b"],
        waitingOn: "agent-a0001",
      },
      taskAnswer: { taskId: "T1", requestKey: "k", option: "a" },
      taskAmend: { taskId: "T1", requestKey: "k", instructions: "i" },
      taskCancel: { taskId: "T1", requestKey: "k" },
      taskComplete: { taskId: "T1", requestKey: "k", text: "t", url: null },
      taskFail: { taskId: "T1", requestKey: "k", reason: "r" },
      taskGet: { taskId: "T1" },
      taskEvents: { after: 0, limit: 5 },
      taskWaiting: { principal: "agent-a0001", limit: 5 },
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { actions } = yield* hubActionsOver;
          const inspected = actions.map((action) => ({
            ...action,
            handler: (given: never, who: string) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<never>();
                seen.push({
                  surface: current.surface,
                  principal: who,
                  keys: [...context.mapUnsafe.keys()].sort(),
                });
                return yield* action.handler(given, who);
              }),
          }));
          const world = yield* makeWorld(inspected);
          for (const surface of surfaces) {
            current.surface = surface;
            for (const action of actions)
              yield* world.call({
                action: action.name,
                input: inputs[action.name] ?? {},
                bearer: "h-ann",
                surface,
              });
          }
        }),
      ).pipe(
        Effect.provide(
          Layer.merge(sqliteStoreLayer(":memory:"), hubPlatformLayer),
        ),
        Effect.provideService(SurfaceServices, {
          built: (surface, keys) => {
            built.set(surface, [...keys].sort());
          },
        }),
      ),
    );
    // Every action reached its handler on every surface (atoms read a query
    // twice: once when mounted, once refreshed).
    for (const surface of surfaces)
      expect(
        new Set(
          seen
            .filter((each) => each.surface === surface)
            .map((each) => each.keys.join(",")),
        ).size,
      ).toBe(1);
    expect(seen.length).toBeGreaterThanOrEqual(
      surfaces.length * Object.keys(inputs).length,
    );
    for (const each of seen) {
      expect(each.principal).toBe("slack-user-t0000-u0001");
      const expected = built.get(
        servedBy[each.surface as keyof typeof servedBy],
      );
      expect(expected).toBeDefined();
      expect(each.keys).toEqual([...(expected ?? [])]);
    }
  });
});

describe("the hub's store", () => {
  it("lets one process write: a second writer is refused until the first lets go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-lock-"));
    const lockFile = join(dir, "hub.lock");
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Scope.make();
        yield* holdWriterLock(lockFile).pipe(Scope.provide(first));
        const second = yield* Effect.scoped(
          Effect.flip(holdWriterLock(lockFile)),
        );
        yield* Scope.close(first, Exit.void);
        const third = yield* Effect.scoped(
          Effect.as(holdWriterLock(lockFile), "held"),
        );
        return { second: second._tag, third };
      }),
    );
    unlinkSync(lockFile);
    rmdirSync(dir);
    expect(outcome).toEqual({ second: "WriterLockHeld", third: "held" });
  });

  it("never writes an event before the last one: a clock gone back refuses the write", async () => {
    const now = { ms: 5000 };
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* TaskStore;
        const create = (requestKey: string) =>
          Effect.exit(
            store.execute("slack-user-t0000-u0001", requestKey, {
              _tag: "create",
              title: "t",
              labels: [],
            }),
          );
        const first = yield* create("a");
        now.ms = 4000;
        const back = yield* create("b");
        now.ms = 5000;
        const level = yield* create("c");
        const events = yield* store.events(0, 10);
        return { first, back, level, ats: events.map((event) => event.at) };
      }).pipe(
        Effect.provide(sqliteStoreLayer(":memory:")),
        Effect.provideServiceEffect(
          Clock.Clock,
          Effect.map(Effect.clockWith(Effect.succeed), (beneath) =>
            settableClock(beneath, () => now.ms),
          ),
        ),
      ),
    );
    expect(Exit.isSuccess(exits.first)).toBe(true);
    expect(Exit.hasDies(exits.back)).toBe(true);
    expect(Exit.isSuccess(exits.level)).toBe(true);
    expect(exits.ats).toEqual([5000, 5000]);
  });

  it("replays a seed of the hub simulator: the same run, step for step", async () => {
    const first = await runHubSimulation({ seed: 7, steps: 60 });
    const second = await runHubSimulation({ seed: 7, steps: 60 });
    const other = await runHubSimulation({ seed: 8, steps: 60 });
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(other.entries).not.toBe(first.entries);
    expect(first.coverage.crashes).toBeGreaterThan(0);
  });
});
