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

// What the runtime needs from the real process: a fresh macrotask to run the
// loop in, and a synchronous drain of pending promise callbacks.
export type SimHost = {
  readonly enter: <A>(run: () => A) => Promise<A>;
  readonly drain: () => void;
};

type Task = { readonly epoch: number; readonly run: () => void };
type Timer = {
  readonly atMs: number;
  readonly seq: number;
  readonly epoch: number;
  readonly fire: () => void;
};

// Effect's own budget of operations per turn (the default of
// Scheduler.MaxOpsBeforeYield). Each turn the choices may halve it up to
// eleven times, down to one operation, so a busy fiber is preempted at a
// point the seed picks and small budgets come up often; choice 0 keeps
// Effect's budget.
const opsPerTurnMax = 2048;
const halvingsMax = 11;

// Process epochs start at 1; timers of the world carry 0.
const worldEpoch = 0;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`simulation runtime: ${message}`);
}

export class SimRuntime {
  readonly choices: Choices;
  // One line per scheduler event, kept only when traced, since building the
  // lines is a measurable part of a short run; entries counts them either
  // way.
  readonly trace: string[] = [];
  private entriesValue = 0;
  private readonly traced: boolean;
  private nowMsValue = 0;
  private epochValue = 0;
  private seq = 0;
  private ready: Task[] = [];
  private timers: Timer[] = [];
  private fiberCurrent: Fiber<unknown, unknown> | null = null;
  private opsThisTurnMax = opsPerTurnMax;
  private pausedUntilMs = 0;

  constructor(
    seed: number,
    tape: readonly number[] = [],
    startMs = 0,
    traced = true,
  ) {
    assert(Number.isInteger(seed), "seed is not an integer");
    this.choices = new Choices(seed, tape);
    this.nowMsValue = startMs;
    this.traced = traced;
  }

  // The scheduler events so far, traced or not.
  get entries(): number {
    return this.entriesValue;
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
      atMs:
        owner === "world"
          ? this.nowMsValue + delayMs
          : Math.max(this.nowMsValue + delayMs, this.pausedUntilMs),
      seq: this.seq,
      epoch: owner === "world" ? worldEpoch : this.epochValue,
      fire,
    };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t.seq !== timer.seq);
    };
  }

  scheduler(): Scheduler {
    const epoch = this.epochValue;
    const dispatcher: SchedulerDispatcher = {
      scheduleTask: (run) => {
        if (epoch === this.epochValue && this.nowMsValue < this.pausedUntilMs)
          this.at(this.pausedUntilMs - this.nowMsValue, run);
        else this.ready.push({ epoch, run });
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
    this.pausedUntilMs = 0;
    this.entriesValue += 1;
    if (this.traced)
      this.trace.push(`${this.nowMsValue} start ${this.epochValue}`);
    const seeded = program.pipe(
      Effect.provideService(Clock.Clock, this.clock()),
      Random.withSeed(this.choices.int(2 ** 31)),
    );
    // Effect runs the first turn at once, inside runFork; seed its budget too.
    this.opsThisTurnMax = this.turnBudget();
    const fiber = Effect.runFork(seeded, { scheduler: this.scheduler() });
    this.fiberCurrent = fiber;
    return fiber;
  }

  // A process crash: its tasks and timers vanish and no finalizer runs, as
  // when the operating system kills it. What it wrote elsewhere stays. The
  // fiber itself cannot be stopped: whatever resumes it from outside the
  // runtime, a world timer or a promise settled in the same task as the
  // crash, runs its code; that code is caught only when it next schedules a
  // task. Fakes therefore answer through timers of the process that asked.
  crash(): void {
    const epoch = this.epochValue;
    assert(this.fiberCurrent !== null, "crash with no process running");
    this.fiberCurrent = null;
    this.entriesValue += 1;
    if (this.traced) this.trace.push(`${this.nowMsValue} crash ${epoch}`);
    this.ready = this.ready.filter((t) => t.epoch !== epoch);
    this.timers = this.timers.filter((t) => t.epoch !== epoch);
    assert(
      this.ready.every((t) => t.epoch !== epoch),
      "crash left a task",
    );
  }

  // Laptop sleep parks only the process. World actions keep running; timers
  // whose deadlines pass during sleep become runnable together at wake-up.
  pause(durationMs: number): void {
    assert(Number.isFinite(durationMs) && durationMs > 0, "bad sleep duration");
    const until = this.nowMsValue + durationMs;
    this.pausedUntilMs = Math.max(this.pausedUntilMs, until);
    this.timers = this.timers.map((timer) =>
      timer.epoch === this.epochValue
        ? { ...timer, atMs: Math.max(timer.atMs, until) }
        : timer,
    );
    const parked = this.ready.filter((task) => task.epoch === this.epochValue);
    this.ready = this.ready.filter((task) => task.epoch !== this.epochValue);
    for (const task of parked) this.at(until - this.nowMsValue, task.run);
    this.entriesValue += 1;
    if (this.traced) this.trace.push(`${this.nowMsValue} sleep until ${until}`);
  }

  private live(epoch: number): boolean {
    return epoch === this.epochValue || epoch === worldEpoch;
  }

  private turnBudget(): number {
    const budget = opsPerTurnMax >> this.choices.int(halvingsMax + 1);
    assert(budget >= 1 && budget <= opsPerTurnMax, `bad budget ${budget}`);
    return budget;
  }

  // Runs one ready task, picked by the choices, with an operation budget the
  // choices pick. Choice 0 is first come, first run, with the full budget.
  private runOne(): void {
    const size = this.ready.length;
    assert(size > 0, "no ready task to run");
    const index = this.choices.int(size);
    const [task] = this.ready.splice(index, 1);
    assert(task !== undefined, "picked a task that is not there");
    this.opsThisTurnMax = this.turnBudget();
    this.entriesValue += 1;
    if (this.traced)
      this.trace.push(`${this.nowMsValue} task ${index}/${size}`);
    // A crash drops its tasks; a task of a dead process here means something
    // outside the runtime woke it: a world timer, or a promise answered on
    // its behalf by something other than one of its own timers.
    assert(this.live(task.epoch), `a task of crashed process ${task.epoch}`);
    task.run();
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
      this.entriesValue += 1;
      if (this.traced) this.trace.push(`${this.nowMsValue} timer ${timer.seq}`);
      this.ready.push({ epoch: timer.epoch, run: timer.fire });
    }
    return true;
  }

  // Drives the world until the process ends, nothing is left to happen
  // (stuck: a liveness failure), or a limit is reached. A step is one task.
  // After each task the host drains promise callbacks, as Node drains
  // microtasks after each macrotask, so a promise answered before a crash
  // finishes while its process is alive. The loop runs synchronously inside
  // one macrotask the host enters, because a drain inside a microtask does
  // nothing. The host is the only thing taken from the real process.
  async run(limits: Limits, host: SimHost): Promise<Outcome<unknown, unknown>> {
    assert(limits.stepsMax > 0 && limits.timeMsMax > 0, "limits not positive");
    return host.enter(() => {
      try {
        return this.loop(limits, host);
      } finally {
        // No turn runs between runs, so the world's own code after a run (a
        // scope it closes, whose finalizers interrupt the process's fibers)
        // gets Effect's budget. With the last turn's, an interrupt could yield
        // into this runtime's queue, which nothing drains once the loop ends.
        this.opsThisTurnMax = opsPerTurnMax;
      }
    });
  }

  private loop(limits: Limits, host: SimHost): Outcome<unknown, unknown> {
    for (let steps = 0; steps < limits.stepsMax; steps += 1) {
      if (this.ready.length > 0) {
        this.runOne();
        host.drain();
        continue;
      }
      host.drain();
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
