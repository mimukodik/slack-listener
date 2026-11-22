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
import { holdWriterLock, type Snapshot, sqliteStoreLayer } from "./store.ts";

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
