// Two liveness failures that the simulator's seeded yield budget reaches and
// Effect's default budget does not: an interrupt Effect 4.1.4 loses, shown
// with Effect alone, and a stall of a bare in-memory MCP server whose cause
// is not found. They are pinned here, so that a change that fixes either
// fails these tests and withFixedBudget (agreement.ts) can be reconsidered
// (DECISIONS.md, 2026-11-22).
import { describe, expect, it } from "bun:test";

import { Deferred, Effect, Layer, Scheduler, Schema } from "effect";
import { McpProtocol, McpServer, McpTest, Tool, Toolkit } from "effect/ai";

import { host, withTripwire } from "../sim/host.ts";
import { SimRuntime } from "../sim/runtime.ts";
import { withFixedBudget } from "./agreement.ts";

describe("Effect 4.1.4 loses an interrupt under a yield budget of one", () => {
  // A scheduler whose tasks run only when the test drains them, and whose
  // budget the test sets, as the simulator's turn budget is set.
  function manual() {
    const tasks: Array<() => void> = [];
    const state = { budget: 2048 };
    const dispatcher: Scheduler.SchedulerDispatcher = {
      scheduleTask: (task) => {
        tasks.push(task);
      },
      flush: () => {},
    };
    const scheduler: Scheduler.Scheduler = {
      executionMode: "async",
      shouldYield: (fiber) => fiber.currentOpCount >= state.budget,
      makeDispatcher: () => dispatcher,
    };
    const drain = (): void => {
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift())
        task();
    };
    return { scheduler, state, drain };
  }

  // A fiber forked but not yet started is interrupted; the interrupt's own
  // evaluation yields at its first operation. The fiber's pending start task
  // then cancels that yield and runs the body: the interrupt is lost, and the
  // fiber waits on. It is detached, so no parent's end interrupts it again;
  // in the simulator a scope's close waited on such a fiber forever.
  function forkThenInterrupt(budget: number) {
    const { scheduler, state, drain } = manual();
    const program = Effect.gen(function* () {
      const never = yield* Deferred.make<void>();
      const child = yield* Effect.forkDetach(Deferred.await(never));
      state.budget = budget;
      child.interruptUnsafe();
      state.budget = 2048;
      return child;
    });
    const parent = Effect.runFork(program, { scheduler });
    drain();
    const child = parent.pollUnsafe();
    if (child?._tag !== "Success") throw new Error("parent did not finish");
    drain();
    return child.value.pollUnsafe();
  }

  it("ends the interrupted child under the default budget", () => {
    const exit = forkThenInterrupt(2048);
    expect(exit?._tag).toBe("Failure");
  });

  it("loses the interrupt of a child that has not started yet", () => {
    expect(forkThenInterrupt(1)).toBeUndefined();
  });
});

// The second failure is not attributed. A bare McpTest server with one tool
// of its own, and none of the contract's code, stalls for some seeds under
// the seeded budget and for none under the fixed one; nothing here shows
// whether Effect or the simulator is the cause.
describe("a bare in-memory MCP server under the simulator's seeded budget", () => {
  const Noop = Tool.make("noop", {
    description: "Does nothing.",
    success: Schema.Boolean,
  });
  const tools = Toolkit.make(Noop);
  const registrations = McpServer.toolkit(tools).pipe(
    Layer.provide(tools.toLayer({ noop: () => Effect.succeed(true) })),
  );
  const pings = Effect.gen(function* () {
    for (let round = 0; round < 3; round++)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* McpTest.makeClient(registrations, {
            protocols: [McpProtocol.v2026_07_28],
          });
          yield* client.ping;
        }),
      );
  }).pipe(Effect.orDie);

  async function outcome(seed: number, program: Effect.Effect<void>) {
    const runtime = new SimRuntime(seed);
    const { value, tripped } = await withTripwire(async () => {
      runtime.start(program);
      return runtime.run({ stepsMax: 1_000_000, timeMsMax: 3_600_000 }, host);
    });
    expect(tripped).toEqual([]);
    return value.kind;
  }

  it("leaves a ping unanswered for seed 216, and answers it under the fixed budget", async () => {
    expect(await outcome(216, pings)).toBe("stuck");
    expect(await outcome(216, withFixedBudget(pings))).toBe("done");
  });
});
