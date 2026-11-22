// The agreement check: one sequence of calls, run against a fresh store once
// through the surface each call names and once through each surface alone.
// Every run must give the same observation for every call and leave the store
// in the same state; direct calls to invoke are the reference. It runs on
// Effect's default runtime, or on SimRuntime with a seed (runSimulated).
import { Context, Effect, Scheduler } from "effect";

import { host, withTripwire } from "../sim/host.ts";
import { type Limits, SimRuntime } from "../sim/runtime.ts";
import { type Policy, type Principals, provideAction } from "./action.ts";
import {
  type Call,
  platformLayer,
  makeWorld,
  type Observation,
  type Surface,
  surfaces,
  type WorldOptions,
} from "./harness.ts";
import {
  acknowledge,
  getReceipt,
  makeStore,
  ReceiptStore,
  type Snapshot,
} from "./receipts.ts";

export const events = ["E1", "E2", "E3"] as const;

export type Run = {
  readonly observations: readonly Observation[];
  readonly snapshot: Snapshot;
};

export type Agreement = {
  readonly chosen: Run;
  readonly bySurface: Readonly<Record<Surface, Run>>;
};

// The calls, each through its own surface or all through one, on a fresh
// store and a fresh world.
export function runSequence(
  calls: readonly Call[],
  through: Surface | "chosen",
  options: WorldOptions = {},
): Effect.Effect<Run, never, Principals | Policy> {
  return Effect.scoped(
    Effect.gen(function* () {
      const store = makeStore(events);
      const services = Context.make(ReceiptStore, store);
      const world = yield* makeWorld(
        [
          provideAction(getReceipt, services),
          provideAction(acknowledge, services),
        ],
        options,
      );
      const observations: Observation[] = [];
      for (const call of calls) {
        const surface = through === "chosen" ? call.surface : through;
        observations.push(yield* world.call({ ...call, surface }));
      }
      return { observations, snapshot: yield* store.snapshot };
    }),
  );
}

export function runAgreement(
  calls: readonly Call[],
  options: WorldOptions = {},
): Effect.Effect<Agreement, never, Principals | Policy> {
  return Effect.gen(function* () {
    const chosen = yield* runSequence(calls, "chosen", options);
    const rest = yield* runSequence(calls, "rest", options);
    const mcp = yield* runSequence(calls, "mcp", options);
    const atom = yield* runSequence(calls, "atom", options);
    const rpc = yield* runSequence(calls, "rpc", options);
    const direct = yield* runSequence(calls, "direct", options);
    return { chosen, bySurface: { rest, mcp, atom, rpc, direct } };
  });
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// The first way a run differs from the direct one, or undefined.
export function disagreement(
  calls: readonly Call[],
  agreement: Agreement,
): string | undefined {
  const reference = agreement.bySurface.direct;
  const runs: ReadonlyArray<readonly [string, Run]> = [
    ["chosen", agreement.chosen],
    ...surfaces.map(
      (surface) => [surface, agreement.bySurface[surface]] as const,
    ),
  ];
  for (const [name, run] of runs) {
    for (const [index, call] of calls.entries()) {
      const expected = reference.observations[index];
      const actual = run.observations[index];
      if (!same(actual, expected))
        return `call ${index} (${call.action} ${JSON.stringify(call.input)} as "${call.bearer}", ${name === "chosen" ? call.surface : name}): ${JSON.stringify(actual)}, direct gave ${JSON.stringify(expected)}`;
    }
    if (!same(run.snapshot, reference.snapshot))
      return `${name}: store ended ${JSON.stringify(run.snapshot)}, direct ${JSON.stringify(reference.snapshot)}`;
  }
  return undefined;
}

export const simLimits: Limits = { stepsMax: 1_000_000, timeMsMax: 3_600_000 };

// The longest a REST answer takes on the simulated clock.
export const answerMsMax = 20;

// Effect's own budget: a fiber yields after this many operations in a turn,
// as under the default scheduler.
const opsPerTurn = 2048;

// The simulator's scheduler with Effect's fixed yield budget in place of the
// seeded one. The seed still picks the order of every task and every answer's
// delay, but no longer where a fiber is preempted: SimRuntime still draws a
// budget each turn and this scheduler ignores it, so the draws, and with them
// the rest of the seed's choices, stay as they were. The seeded budget
// reaches liveness failures that the fixed one does not (DECISIONS.md,
// 2026-11-22; pinned in effect-liveness.spec.ts): on this world, 3 of 5000
// runs failed with an empty MCP 500 under it and none under the fixed one.
// A narrower floor is not enough: with no budget below 2, seed 216 still
// stalls a bare McpTest server.
export function withFixedBudget<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const seeded = yield* Scheduler.Scheduler;
    const fixed: Scheduler.Scheduler = {
      executionMode: seeded.executionMode,
      shouldYield: (fiber) => fiber.currentOpCount >= opsPerTurn,
      makeDispatcher: () => seeded.makeDispatcher(),
    };
    return yield* effect.pipe(
      Effect.provideService(Scheduler.Scheduler, fixed),
    );
  });
}

export type Simulated = {
  readonly outcome: "done" | "failed" | "stuck" | "limit";
  readonly agreement: Agreement | undefined;
  readonly trace: readonly string[];
  readonly tripped: readonly string[];
};

// The agreement run as one process on SimRuntime: the seed picks the order of
// every task and how long each REST answer takes, and no real timer may run.
export async function runSimulated(
  seed: number,
  calls: readonly Call[],
): Promise<Simulated> {
  const runtime = new SimRuntime(seed);
  const result: { agreement: Agreement | undefined } = { agreement: undefined };
  const program = runAgreement(calls, {
    answer: (respond) => {
      runtime.at(runtime.choices.int(answerMsMax + 1), respond);
    },
  }).pipe(
    Effect.tap((agreement) =>
      Effect.sync(() => {
        result.agreement = agreement;
      }),
    ),
    Effect.provide(platformLayer),
    withFixedBudget,
  );
  const { value, tripped } = await withTripwire(async () => {
    runtime.start(program);
    return runtime.run(simLimits, host);
  });
  const outcome =
    value.kind === "done"
      ? value.exit._tag === "Success"
        ? "done"
        : "failed"
      : value.kind;
  return {
    outcome,
    agreement: result.agreement,
    trace: runtime.trace,
    tripped: tripped.map((trip) => trip.name),
  };
}
