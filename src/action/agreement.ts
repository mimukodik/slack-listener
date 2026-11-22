// The agreement check: one sequence of calls, run against a fresh store once
// through the surface each call names and once through each surface alone.
// Every run must give the same observation for every call and leave the store
// in the same state; direct calls to invoke are the reference. It runs on
// Effect's default runtime, or on SimRuntime with a seed (runSimulated).
import { Context, Effect, type Layer, type Scope } from "effect";

import { host, withTripwire } from "../sim/host.ts";
import { type Limits, SimRuntime } from "../sim/runtime.ts";
import {
  type AnyAction,
  type Policy,
  type Principals,
  provideAction,
} from "./action.ts";
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

export type Run<S = Snapshot> = {
  readonly observations: readonly Observation[];
  readonly snapshot: S;
};

export type Agreement<S = Snapshot> = {
  readonly chosen: Run<S>;
  readonly bySurface: Readonly<Record<Surface, Run<S>>>;
};

// What a sequence runs against: the actions, their services given, and how
// to read the store they leave. Built afresh, in the run's scope, per run.
export type Fixture<S> = Effect.Effect<
  {
    readonly actions: ReadonlyArray<AnyAction>;
    readonly snapshot: Effect.Effect<S>;
  },
  never,
  Scope.Scope
>;

export type SequenceOptions = WorldOptions & {
  // Runs before each call, as the clock a test controls moves.
  readonly before?: ((index: number) => void) | undefined;
};

// The calls, each through its own surface or all through one, on a fresh
// fixture and a fresh world.
export function runSequenceWith<S>(
  fixture: Fixture<S>,
  calls: readonly Call[],
  through: Surface | "chosen",
  options: SequenceOptions = {},
): Effect.Effect<Run<S>, never, Principals | Policy> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { actions, snapshot } = yield* fixture;
      const world = yield* makeWorld(actions, options);
      const observations: Observation[] = [];
      for (const [index, call] of calls.entries()) {
        options.before?.(index);
        const surface = through === "chosen" ? call.surface : through;
        observations.push(yield* world.call({ ...call, surface }));
      }
      return { observations, snapshot: yield* snapshot };
    }),
  );
}

export function runAgreementWith<S>(
  fixture: Fixture<S>,
  calls: readonly Call[],
  options: SequenceOptions = {},
): Effect.Effect<Agreement<S>, never, Principals | Policy> {
  return Effect.gen(function* () {
    const run = (through: Surface | "chosen") =>
      runSequenceWith(fixture, calls, through, options);
    const chosen = yield* run("chosen");
    const rest = yield* run("rest");
    const mcp = yield* run("mcp");
    const atom = yield* run("atom");
    const rpc = yield* run("rpc");
    const direct = yield* run("direct");
    return { chosen, bySurface: { rest, mcp, atom, rpc, direct } };
  });
}

// The example's fixture: the receipt actions over a fresh in-memory store.
const receiptsFixture: Fixture<Snapshot> = Effect.sync(() => {
  const store = makeStore(events);
  const services = Context.make(ReceiptStore, store);
  return {
    actions: [
      provideAction(getReceipt, services),
      provideAction(acknowledge, services),
    ],
    snapshot: store.snapshot,
  };
});

export function runSequence(
  calls: readonly Call[],
  through: Surface | "chosen",
  options: WorldOptions = {},
): Effect.Effect<Run, never, Principals | Policy> {
  return runSequenceWith(receiptsFixture, calls, through, options);
}

export function runAgreement(
  calls: readonly Call[],
  options: WorldOptions = {},
): Effect.Effect<Agreement, never, Principals | Policy> {
  return runAgreementWith(receiptsFixture, calls, options);
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// The first way a run differs from the direct one, or undefined.
export function disagreement<S>(
  calls: readonly Call[],
  agreement: Agreement<S>,
): string | undefined {
  const reference = agreement.bySurface.direct;
  const runs: ReadonlyArray<readonly [string, Run<S>]> = [
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

export type Simulated<S = Snapshot> = {
  readonly outcome: "done" | "failed" | "stuck" | "limit";
  readonly agreement: Agreement<S> | undefined;
  readonly trace: readonly string[];
  readonly tripped: readonly string[];
};

// An agreement run as one process on SimRuntime: the seed picks the order of
// every task, each turn's yield budget and how long each REST answer takes,
// and no real timer may run.
export async function runSimulatedWith<S>(
  seed: number,
  agreement: (
    options: WorldOptions,
  ) => Effect.Effect<Agreement<S>, never, Principals | Policy>,
  platform: Layer.Layer<Principals | Policy> = platformLayer,
): Promise<Simulated<S>> {
  const runtime = new SimRuntime(seed);
  const result: { agreement: Agreement<S> | undefined } = {
    agreement: undefined,
  };
  const program = agreement({
    answer: (respond) => {
      runtime.at(runtime.choices.int(answerMsMax + 1), respond);
    },
  }).pipe(
    Effect.tap((value) =>
      Effect.sync(() => {
        result.agreement = value;
      }),
    ),
    Effect.provide(platform),
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

export async function runSimulated(
  seed: number,
  calls: readonly Call[],
): Promise<Simulated> {
  return runSimulatedWith(seed, (options) => runAgreement(calls, options));
}
