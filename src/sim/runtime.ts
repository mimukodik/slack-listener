// The simulation runtime: owns time, randomness and the order in which fibers
// run, so the same Effect program as production runs in a world the seed
// decides (PRINCIPLES.md: simulator-runs-the-program, one-seed-one-run).
//
// Effect asks this runtime to run every task (the Scheduler), to wait (the
// Clock) and for random numbers (Random.withSeed). Each choice comes from one
// Choices stream; picking task 0 is the simplest choice, first come first run.
// The loop that drives the world lives here; the one thing it needs from the
// host, letting promise callbacks run between steps, is passed in.
import { Clock, Duration, Effect, Random } from "effect";
import type { Exit } from "effect";
import type { Fiber } from "effect/Fiber";
import type { Scheduler, SchedulerDispatcher } from "effect/Scheduler";

import { Choices } from "./choices.ts";

export type Limits = {
  readonly stepsMax: number;
  readonly timeMsMax: number;
};

export type Outcome<A, E> =
  | { readonly kind: "done"; readonly exit: Exit.Exit<A, E> }
  | { readonly kind: "stuck" }
  | { readonly kind: "limit"; readonly reason: "steps" | "time" };

type Task = { readonly epoch: number; readonly run: () => void };
type Timer = {
  readonly atMs: number;
  readonly seq: number;
  readonly epoch: number;
  readonly fire: () => void;
};

// Effect's own budget of operations per turn. Each turn the choices may cut
// it shorter, so a busy fiber is preempted at a point the seed picks; choice
// 0 keeps the full budget.
const opsPerTurnMax = 64;

// Tasks may schedule tasks; one step runs at most this many.
const tasksPerStepMax = 100_000;

// Process epochs start at 1; timers of the world carry 0.
const worldEpoch = 0;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`simulation runtime: ${message}`);
}

export class SimRuntime {
  readonly choices: Choices;
  readonly trace: string[] = [];
  private nowMsValue = 0;
  private epochValue = 0;
  private seq = 0;
  private ready: Task[] = [];
  private timers: Timer[] = [];
  private fiberCurrent: Fiber<unknown, unknown> | null = null;
  private opsThisTurnMax = opsPerTurnMax;

  constructor(seed: number, tape: readonly number[] = []) {
    assert(Number.isInteger(seed), "seed is not an integer");
    this.choices = new Choices(seed, tape);
  }

  get nowMs(): number {
    return this.nowMsValue;
  }

  get epoch(): number {
    return this.epochValue;
  }

  // Calls fire after delayMs of simulated time, unless the returned cancel
  // runs first. A process timer dies with its process: an answer to a request
  // the process made is a process timer, so it never reaches a crashed one
  // (Effect resumes a waiting fiber directly, not through the scheduler). A
  // world timer, such as a planned crash, belongs to no process; it must not
  // resume a process's fiber.
  at(
    delayMs: number,
    fire: () => void,
    owner: "process" | "world" = "process",
  ): () => void {
    assert(Number.isFinite(delayMs) && delayMs >= 0, `bad delay ${delayMs}`);
    this.seq += 1;
    const timer: Timer = {
      atMs: this.nowMsValue + delayMs,
      seq: this.seq,
      epoch: owner === "world" ? worldEpoch : this.epochValue,
      fire,
    };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  scheduler(): Scheduler {
    const epoch = this.epochValue;
    const dispatcher: SchedulerDispatcher = {
      scheduleTask: (run) => {
        this.ready.push({ epoch, run });
      },
      flush: () => {},
    };
    return {
      executionMode: "async",
      shouldYield: (fiber) => fiber.currentOpCount >= this.opsThisTurnMax,
      makeDispatcher: () => dispatcher,
    };
  }

  clock(): Clock.Clock {
    const nanos = (): bigint => BigInt(this.nowMsValue) * 1_000_000n;
    return {
      currentTimeMillisUnsafe: () => this.nowMsValue,
      currentTimeMillis: Effect.sync(() => this.nowMsValue),
      currentTimeNanosUnsafe: nanos,
      currentTimeNanos: Effect.sync(nanos),
      monotonicTimeNanosUnsafe: nanos,
      monotonicTimeNanos: Effect.sync(nanos),
      sleep: (duration) =>
        Effect.callback<void>((resume) => {
          const delayMs = Math.max(0, Duration.toMillis(duration));
          const cancel = this.at(delayMs, () => resume(Effect.void));
          return Effect.sync(cancel);
        }),
    };
  }

  // Starts a process: a program on this runtime's scheduler, clock and a
  // seeded Random. A new epoch, so a crash can drop exactly its work.
  start<A, E>(program: Effect.Effect<A, E>): Fiber<A, E> {
    assert(this.fiberCurrent === null, "a process is already running");
    this.epochValue += 1;
    this.trace.push(`${this.nowMsValue} start ${this.epochValue}`);
    const seeded = program.pipe(
      Effect.provideService(Clock.Clock, this.clock()),
      Random.withSeed(this.choices.int(2 ** 31)),
    );
    const fiber = Effect.runFork(seeded, { scheduler: this.scheduler() });
    this.fiberCurrent = fiber;
    return fiber;
  }

  // A process crash: its tasks and timers vanish and no finalizer runs, as
  // when the operating system kills it. What it wrote elsewhere stays.
  crash(): void {
    const epoch = this.epochValue;
    assert(this.fiberCurrent !== null, "crash with no process running");
    this.fiberCurrent = null;
    this.trace.push(`${this.nowMsValue} crash ${epoch}`);
    this.ready = this.ready.filter((t) => t.epoch !== epoch);
    this.timers = this.timers.filter((t) => t.epoch !== epoch);
    assert(
      this.ready.every((t) => t.epoch !== epoch),
      "crash left a task",
    );
  }

  private live(epoch: number): boolean {
    return epoch === this.epochValue || epoch === worldEpoch;
  }

  // Runs ready tasks one at a time, in an order the choices pick, each with
  // an operation budget the choices pick. Choice 0 is first come, first run.
  private runReady(): void {
    for (let count = 0; this.ready.length > 0; count += 1) {
      assert(count < tasksPerStepMax, "tasks keep scheduling tasks");
      const size = this.ready.length;
      const index = this.choices.int(size);
      const [task] = this.ready.splice(index, 1);
      assert(task !== undefined, "picked a task that is not there");
      this.opsThisTurnMax = opsPerTurnMax - this.choices.int(opsPerTurnMax);
      this.trace.push(`${this.nowMsValue} task ${index}/${size}`);
      // A crash drops its tasks; one of a dead process here means something
      // outside it, a world timer, woke it.
      assert(this.live(task.epoch), `a task of crashed process ${task.epoch}`);
      task.run();
    }
  }

  // Moves time to the next due timers of the live process and the world and
  // makes each a ready task, so timers due together run in a seeded order.
  private dueTimersToReady(): boolean {
    assert(
      this.timers.every((t) => this.live(t.epoch)),
      "a timer of a crashed process outlived the crash",
    );
    if (this.timers.length === 0) return false;
    const dueMs = Math.min(...this.timers.map((t) => t.atMs));
    assert(dueMs >= this.nowMsValue, "timer in the past");
    const due = this.timers.filter((t) => t.atMs === dueMs);
    this.timers = this.timers.filter((t) => t.atMs !== dueMs);
    assert(due.length > 0, "no due timer after a non-empty check");
    this.nowMsValue = dueMs;
    for (const timer of due.sort((a, b) => a.seq - b.seq)) {
      this.trace.push(`${this.nowMsValue} timer ${timer.seq}`);
      this.ready.push({ epoch: timer.epoch, run: timer.fire });
    }
    return true;
  }

  // Drives the world until the process ends, nothing is left to happen
  // (stuck: a liveness failure), or a limit is reached. settle lets promise
  // callbacks run; it is the only thing taken from the host.
  async run(
    limits: Limits,
    settle: () => Promise<void>,
  ): Promise<Outcome<unknown, unknown>> {
    assert(limits.stepsMax > 0 && limits.timeMsMax > 0, "limits not positive");
    for (let steps = 0; steps < limits.stepsMax; steps += 1) {
      this.runReady();
      await settle();
      if (this.ready.length > 0) continue;
      const exit = this.fiberCurrent?.pollUnsafe();
      if (exit !== undefined) return { kind: "done", exit };
      if (!this.dueTimersToReady()) return { kind: "stuck" };
      if (this.nowMsValue > limits.timeMsMax)
        return { kind: "limit", reason: "time" };
    }
    return { kind: "limit", reason: "steps" };
  }
}
