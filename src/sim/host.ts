// The simulator's only contact with the real host. Everything else in the
// simulation runs on SimRuntime's clock and choices.
//
// host gives the runtime a fresh macrotask to run its loop in, and a
// synchronous drain of pending promise callbacks between simulated steps.
// The drain is drainMicrotasks from bun:jsc, which runs JavaScriptCore's
// microtask queue and Bun's process.nextTick queue (BER-2338); it replaces a
// real setImmediate per step, which made the waiting, not the program, most
// of a run's cost (BER-2207). Every loop starts with a self-test and fails by
// name if the drain does not drain. Bun's drain also drains inside a
// microtask, so the self-test proves that the drain runs callbacks, not that
// the loop sits in a macrotask; the loop enters one anyway.
// withTripwire makes any real timer during a simulated run throw, and the
// loop itself refuses process.nextTick, which the drain would run in its own
// order, so code that slips past Effect's services cannot go unnoticed
// (PRINCIPLES.md: world-through-services, one-seed-one-run). The refusal
// replaces only the global: code that kept its own reference to
// process.nextTick at load would get past it. Identical seed traces show
// nothing does today.
import { drainMicrotasks } from "bun:jsc";

import type { SimHost } from "./runtime.ts";

const realSetImmediate = globalThis.setImmediate;

function drainSelfTest(): void {
  const drain = { done: false };
  void Promise.resolve().then(() => {
    drain.done = true;
  });
  drainMicrotasks();
  if (!drain.done)
    throw new Error(
      "simulation host: the microtask drain did not drain; the loop must start in a macrotask",
    );
}

function refuseNextTick<A>(run: () => A): A {
  const saved = Object.getOwnPropertyDescriptor(process, "nextTick");
  if (saved === undefined)
    throw new Error("simulation host: process.nextTick is not an own property");
  Object.defineProperty(process, "nextTick", {
    ...saved,
    value: () => {
      throw new Error(
        "real process.nextTick during a simulated run; the drain does not run it",
      );
    },
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "nextTick", saved);
  }
}

export const host: SimHost = {
  enter: async <A>(run: () => A) =>
    new Promise<A>((resolve, reject) => {
      realSetImmediate(() => {
        try {
          drainSelfTest();
          resolve(refuseNextTick(run));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }),
  drain: drainMicrotasks,
};

export type Tripped = { readonly name: string; readonly stack: string };

const watched = ["setTimeout", "setInterval", "setImmediate"] as const;

export async function withTripwire<T>(
  run: () => T | Promise<T>,
): Promise<{ readonly value: T; readonly tripped: readonly Tripped[] }> {
  const tripped: Tripped[] = [];
  const saved = watched.map((name) => [name, globalThis[name]] as const);
  for (const name of watched) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: () => {
        const stack = new Error(`real ${name}`).stack ?? "";
        tripped.push({ name, stack });
        throw new Error(`real ${name} during a simulated run`);
      },
    });
  }
  try {
    return { value: await run(), tripped };
  } finally {
    for (const [name, value] of saved)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
  }
}
