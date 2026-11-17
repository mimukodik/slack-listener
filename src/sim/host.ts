// The simulator's only contact with the real host. Everything else in the
// simulation runs on SimRuntime's clock and choices.
//
// settle lets pending promise callbacks run between simulated steps.
// withTripwire makes any real timer during a simulated run throw, so code
// that slips past Effect's services cannot go unnoticed
// (PRINCIPLES.md: world-through-services, one-seed-one-run).

const realSetImmediate = globalThis.setImmediate;

export function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });
}

export type Tripped = { readonly name: string; readonly stack: string };

const watched = ["setTimeout", "setInterval", "setImmediate"] as const;

export async function withTripwire<T>(
  run: () => Promise<T>,
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
