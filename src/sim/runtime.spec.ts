import { Clock, Duration, Effect, Fiber, Random, Schedule } from "effect";
import { describe, expect, it } from "vitest";

import { host, withTripwire } from "./host.ts";
import { type Limits, type Outcome, SimRuntime } from "./runtime.ts";

const limits: Limits = { stepsMax: 50_000, timeMsMax: 3_600_000 };

// A small program that uses what the real one will: concurrent fibers,
// sleeps, a timeout, a jittered retry, a race and random numbers.
function program(runtime: SimRuntime, log: string[]): Effect.Effect<void> {
  // The time comes from the program's Clock, as the real program's will.
  const note = (text: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((nowMs) => log.push(`${nowMs} ${text}`)),
    );
  const worker = (name: string) =>
    Effect.gen(function* () {
      for (let i = 0; i < 4; i += 1) {
        const waitMs = yield* Random.nextIntBetween(10, 500);
        yield* Effect.sleep(Duration.millis(waitMs));
        yield* note(`${name} ${i}`);
      }
    });
  const flaky = Effect.gen(function* () {
    const waitMs = yield* Random.nextIntBetween(100, 600);
    yield* Effect.sleep(Duration.millis(waitMs));
    yield* note(`flaky answered after ${waitMs}`);
  }).pipe(
    Effect.timeout(Duration.millis(300)),
    Effect.retry({
      schedule: Schedule.exponential(Duration.millis(50)).pipe(
        Schedule.jittered,
      ),
      times: 3,
    }),
    Effect.catch(() => note("flaky gave up")),
  );
  const race = Effect.race(
    Effect.sleep(Duration.millis(200)).pipe(Effect.as("slow")),
    Random.nextIntBetween(0, 400).pipe(
      Effect.flatMap((ms) => Effect.sleep(Duration.millis(ms))),
      Effect.as("random"),
    ),
  ).pipe(Effect.flatMap((winner) => note(`race won by ${winner}`)));
  return Effect.all([worker("a"), worker("b"), flaky, race], {
    concurrency: "unbounded",
    discard: true,
  });
}

type Run = {
  readonly outcome: Outcome<unknown, unknown>["kind"];
  readonly trace: readonly string[];
  readonly log: readonly string[];
  readonly tripped: number;
};

async function runSeed(
  seed: number,
  crashAtMs: number | null,
  traced = true,
): Promise<Run & { entries: number }> {
  const runtime = new SimRuntime(seed, [], 0, traced);
  const log: string[] = [];
  // The tripwire is on before the program starts: Effect runs a forked
  // program synchronously up to its first wait.
  const { value, tripped } = await withTripwire(async () => {
    runtime.start(program(runtime, log));
    if (crashAtMs !== null)
      runtime.at(
        crashAtMs,
        () => {
          runtime.crash();
          log.push(`${runtime.nowMs} restarted`);
          runtime.start(program(runtime, log));
        },
        "world",
      );
    return runtime.run(limits, host);
  });
  return {
    outcome: value.kind,
    trace: runtime.trace,
    log,
    tripped: tripped.length,
    entries: runtime.entries,
  };
}

describe("simulation runtime: one seed, one run", () => {
  it("replays every seed identically, with no real timer", async () => {
    const seedCount = 200;
    const distinct = new Set<string>();
    for (let seed = 1; seed <= seedCount; seed += 1) {
      const crashAtMs = seed % 2 === 0 ? seed * 7 : null;
      const first = await runSeed(seed, crashAtMs);
      const second = await runSeed(seed, crashAtMs);
      expect(second, `seed ${seed}`).toEqual(first);
      expect(first.outcome, `seed ${seed}`).toBe("done");
      expect(first.tripped, `seed ${seed}`).toBe(0);
      distinct.add(JSON.stringify(first.log));
    }
    // The seed must matter: a runtime that ignored it would replay too.
    expect(distinct.size).toBeGreaterThan(seedCount * 0.9);
  });

  // Untraced runs skip building the lines, and must still run the same
  // schedule: the same log and the same count of scheduler events.
  it("an untraced run keeps no lines and runs the same schedule", async () => {
    for (const seed of [2, 3, 8]) {
      const traced = await runSeed(seed, seed * 7);
      const untraced = await runSeed(seed, seed * 7, false);
      expect(untraced.trace).toEqual([]);
      expect(untraced.log).toEqual(traced.log);
      expect(untraced.entries).toBe(traced.trace.length);
      expect(traced.entries).toBe(traced.trace.length);
    }
  });

  it("a crash drops the process's work and runs no finalizer", async () => {
    const runtime = new SimRuntime(7);
    const log: string[] = [];
    runtime.start(
      Effect.sleep(Duration.seconds(10)).pipe(
        Effect.ensuring(Effect.sync(() => log.push("finalizer"))),
      ),
    );
    runtime.at(
      1000,
      () => {
        runtime.crash();
        runtime.start(
          Effect.sync(() => log.push(`second at ${runtime.nowMs}`)),
        );
      },
      "world",
    );
    const outcome = await runtime.run(limits, host);
    expect(outcome.kind).toBe("done");
    expect(log).toEqual(["second at 1000"]);
  });

  it("laptop sleep parks process timers and ready tasks while the world continues", async () => {
    const runtime = new SimRuntime(
      1,
      Array.from({ length: 1000 }, () => 0),
    );
    const log: string[] = [];
    runtime.start(
      Effect.sleep(5000).pipe(
        Effect.andThen(Effect.sync(() => log.push(`process ${runtime.nowMs}`))),
      ),
    );
    const cancel = runtime.at(5000, () => log.push("canceled callback ran"));
    runtime.at(1000, () => runtime.pause(10_000), "world");
    runtime.at(
      3000,
      () => {
        cancel();
        log.push(`world ${runtime.nowMs}`);
      },
      "world",
    );
    expect((await runtime.run(limits, host)).kind).toBe("done");
    expect(log).toEqual(["world 3000", "process 11000"]);

    const ready = new SimRuntime(
      1,
      Array.from({ length: 1000 }, () => 0),
    );
    const parked: number[] = [];
    ready.start(
      Effect.yieldNow.pipe(
        Effect.andThen(Effect.sync(() => parked.push(ready.nowMs))),
      ),
    );
    ready.pause(10_000);
    expect((await ready.run(limits, host)).kind).toBe("done");
    expect(parked).toEqual([10_000]);
  });

  it("reports a process that waits for nothing as stuck", async () => {
    const runtime = new SimRuntime(1);
    runtime.start(Effect.never);
    expect((await runtime.run(limits, host)).kind).toBe("stuck");
  });

  it("stops a run that outlives its limits", async () => {
    const runtime = new SimRuntime(1);
    runtime.start(Effect.forever(Effect.sleep(Duration.seconds(1))));
    const outcome = await runtime.run(
      { stepsMax: 1_000_000, timeMsMax: 60_000 },
      host,
    );
    expect(outcome).toEqual({ kind: "limit", reason: "time" });
  });

  it("the tripwire catches every real timer and is removed afterwards", async () => {
    const saved = [
      globalThis.setTimeout,
      globalThis.setInterval,
      globalThis.setImmediate,
    ];
    const { tripped } = await withTripwire(() => {
      const calls = [
        () => setInterval(() => {}, 10),
        () => setImmediate(() => {}),
      ];
      for (const call of calls) expect(call).toThrow(/during a simulated run/);
    });
    expect(tripped.map((t) => t.name)).toEqual(["setInterval", "setImmediate"]);
    await expect(
      withTripwire(() => {
        throw new Error("run failed");
      }),
    ).rejects.toThrow("run failed");
    await expect(
      withTripwire(async () => {
        await Promise.resolve();
        throw new Error("run rejected");
      }),
    ).rejects.toThrow("run rejected");
    expect([
      globalThis.setTimeout,
      globalThis.setInterval,
      globalThis.setImmediate,
    ]).toEqual(saved);
  });

  it("a real process.nextTick inside the program stops it", async () => {
    const runtime = new SimRuntime(1);
    const saved = process.nextTick;
    runtime.start(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(5));
        process.nextTick(() => {});
      }),
    );
    const outcome = await runtime.run(limits, host);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") {
      expect(outcome.exit._tag).toBe("Failure");
      expect(String(outcome.exit)).toMatch(
        /process\.nextTick during a simulated run/,
      );
    }
    expect(process.nextTick).toBe(saved);
  });

  it("the tripwire catches a real timer inside the program", async () => {
    const runtime = new SimRuntime(1);
    const { value, tripped } = await withTripwire(async () => {
      runtime.start(
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(5));
          setTimeout(() => {}, 10);
        }),
      );
      return runtime.run(limits, host);
    });
    expect(value.kind).toBe("done");
    if (value.kind === "done") expect(value.exit._tag).toBe("Failure");
    expect(tripped.map((t) => t.name)).toEqual(["setTimeout"]);
  });

  it("the seed picks the order of fibers woken together; choice 0 is first come", async () => {
    const order = async (seed: number, tape: readonly number[] = []) => {
      const runtime = new SimRuntime(seed, tape);
      const log: number[] = [];
      const fiber = (id: number) =>
        Effect.forEach([1, 2, 3], () =>
          Effect.sleep(Duration.millis(100)).pipe(
            Effect.andThen(Effect.sync(() => log.push(id))),
          ),
        );
      runtime.start(
        Effect.all([1, 2, 3, 4].map(fiber), { concurrency: "unbounded" }),
      );
      await runtime.run(limits, host);
      picksPastFirst += runtime.trace.filter((line) =>
        / task [1-9]\d*\//.test(line),
      ).length;
      return log.join("");
    };
    let picksPastFirst = 0;
    const orders = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) orders.add(await order(seed));
    expect(orders.size).toBeGreaterThan(20);
    // The seed picks among ready tasks, not only the turn budgets.
    expect(picksPastFirst).toBeGreaterThan(0);
    expect(await order(1, new Array<number>(500).fill(0))).toBe("123412341234");
  });

  it("an answer that arrives after a crash does not wake the dead process", async () => {
    const runtime = new SimRuntime(3);
    const log: string[] = [];
    // A pending request, answered at 2000 by a fake on the process's behalf;
    // the process crashes at 1000.
    runtime.start(
      Effect.callback<void>((resume) => {
        runtime.at(2000, () => {
          log.push("answered");
          resume(Effect.void);
        });
      }).pipe(Effect.andThen(Effect.sync(() => log.push("old process woke")))),
    );
    runtime.at(
      1000,
      () => {
        runtime.crash();
        runtime.start(Effect.sleep(Duration.seconds(5)));
      },
      "world",
    );
    expect((await runtime.run(limits, host)).kind).toBe("done");
    expect(log).toEqual([]);
  });

  it("a busy fiber is preempted at a point the seed picks; choice 0 is Effect's own order", async () => {
    // Two fibers that never wait: only the per-turn budget interleaves them.
    const busyPair = (log: string[]) => {
      const busy = (id: string) =>
        Effect.forEach(
          Array.from({ length: 1000 }, (_, i) => i),
          () => Effect.sync(() => log.push(id)),
          { discard: true },
        );
      return Effect.all([busy("a"), busy("b")], { concurrency: "unbounded" });
    };
    const simulated = async (seed: number, tape: readonly number[] = []) => {
      const runtime = new SimRuntime(seed, tape);
      const log: string[] = [];
      runtime.start(busyPair(log));
      expect((await runtime.run(limits, host)).kind).toBe("done");
      return log.join("");
    };
    const orders = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) orders.add(await simulated(seed));
    // Measured: 20 distinct orders over these 30 seeds.
    expect(orders.size).toBeGreaterThan(10);
    // The same program on Effect's real, default scheduler.
    const realLog: string[] = [];
    await Effect.runPromise(busyPair(realLog));
    const real = realLog.join("");
    expect(real).toMatch(/ab|ba/);
    expect(await simulated(1, new Array<number>(5000).fill(0))).toBe(real);
  });

  it("a crash drops the process's ready tasks", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const runtime = new SimRuntime(seed);
      const log: string[] = [];
      // At 1000 the process wakes into an endless run of turns, and the world
      // crashes it; whichever runs first, the other's work must vanish.
      runtime.start(
        Effect.sleep(Duration.seconds(1)).pipe(
          Effect.andThen(
            Effect.forever(
              Effect.sync(() => log.push("old turn")).pipe(
                Effect.andThen(Effect.yieldNow),
              ),
            ),
          ),
        ),
      );
      runtime.at(
        1000,
        () => {
          runtime.crash();
          log.push("crashed");
          runtime.start(Effect.void);
        },
        "world",
      );
      expect((await runtime.run(limits, host)).kind).toBe("done");
      expect(log.slice(log.indexOf("crashed") + 1), `seed ${seed}`).toEqual([]);
    }
  });

  it("a promise answered in the same moment as a crash never wakes the dead process", async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const runtime = new SimRuntime(seed);
      const log: string[] = [];
      runtime.start(
        Effect.promise(
          async () =>
            new Promise<void>((resolve) => {
              runtime.at(1000, resolve);
            }),
        ).pipe(Effect.andThen(Effect.sync(() => log.push("answered")))),
      );
      runtime.at(
        1000,
        () => {
          runtime.crash();
          log.push("crashed");
          runtime.start(Effect.void);
        },
        "world",
      );
      expect((await runtime.run(limits, host)).kind).toBe("done");
      expect(log.slice(log.indexOf("crashed") + 1), `seed ${seed}`).toEqual([]);
    }
  });

  it("a fiber that never waits ends at the step limit", async () => {
    const runtime = new SimRuntime(1);
    runtime.start(Effect.forever(Effect.yieldNow));
    const outcome = await runtime.run(
      { stepsMax: 2_000, timeMsMax: 60_000 },
      host,
    );
    expect(outcome).toEqual({ kind: "limit", reason: "steps" });
  });

  it("the program's clock is the simulated clock", async () => {
    const runtime = new SimRuntime(1);
    const read: number[] = [];
    runtime.start(
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(1500));
        read.push(yield* Clock.currentTimeMillis);
        read.push(Number((yield* Clock.currentTimeNanos) / 1_000_000n));
        const clock = yield* Clock.Clock;
        read.push(Number(clock.monotonicTimeNanosUnsafe() / 1_000_000n));
        read.push(runtime.nowMs);
      }),
    );
    expect((await runtime.run(limits, host)).kind).toBe("done");
    expect(read).toEqual([1500, 1500, 1500, 1500]);
  });

  it("forked fibers that never wait are preempted by seeded budgets", async () => {
    // The parent only forks and joins, so every busy turn is a task the
    // runtime runs, with the budget it picks for that task.
    const forked = (log: string[]) => {
      const busy = (id: string) =>
        Effect.forEach(
          Array.from({ length: 1000 }, (_, i) => i),
          () => Effect.sync(() => log.push(id)),
          { discard: true },
        );
      return Effect.gen(function* () {
        const a = yield* Effect.forkChild(busy("a"));
        const b = yield* Effect.forkChild(busy("b"));
        yield* Fiber.join(a);
        yield* Fiber.join(b);
      });
    };
    const orders = new Set<string>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const runtime = new SimRuntime(seed);
      const log: string[] = [];
      runtime.start(forked(log));
      expect((await runtime.run(limits, host)).kind).toBe("done");
      orders.add(log.join(""));
    }
    // Measured: 18 distinct orders; 2 with a fixed budget per task.
    expect(orders.size).toBeGreaterThan(5);
  });

  it("a crashed process woken from outside stops the run", async () => {
    const runtime = new SimRuntime(1);
    // Breaks the rule on purpose: a world timer answers the process.
    runtime.start(
      Effect.callback<void>((resume) => {
        runtime.at(2000, () => resume(Effect.void), "world");
      }).pipe(Effect.andThen(Effect.yieldNow)),
    );
    runtime.at(
      1000,
      () => {
        runtime.crash();
        runtime.start(Effect.sleep(Duration.seconds(5)));
      },
      "world",
    );
    await expect(runtime.run(limits, host)).rejects.toThrow(
      "a task of crashed process 1",
    );
  });
});
