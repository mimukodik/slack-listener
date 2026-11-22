// The hub simulator's reference model and its rule checks (RULES.md, T1 to
// T7). The model is a second, plain implementation of the hub's rules,
// written without the transition table, so a fault in the table or the store
// shows up as a difference. It predicts every answer and every event; the
// checks replay the store's events against the rules on their own.
import type { Principal } from "../../action/action.ts";
import { hubGrants, hubPrincipals } from "../fixture.ts";
import { canonical, type Snapshot } from "../store.ts";
import type { Event, State, Task } from "../task.ts";

export type Expected =
  | { readonly kind: "success"; readonly value: unknown }
  | { readonly kind: "failure"; readonly tag: string };

export type Input = Readonly<Record<string, unknown>>;

const final: readonly State[] = ["completed", "failed", "canceled"];
const queries = new Set(["taskGet", "taskEvents", "taskWaiting"]);
const permissionOf = (action: string) =>
  `task.${action.slice(4, 5).toLowerCase()}${action.slice(5)}`;

const str = (input: Input, field: string): string => {
  const value = input[field];
  if (typeof value !== "string") throw new Error(`model: ${field} not text`);
  return value;
};
const num = (input: Input, field: string): number => {
  const value = input[field];
  if (typeof value !== "number")
    throw new Error(`model: ${field} not a number`);
  return value;
};
const strs = (input: Input, field: string): readonly string[] => {
  const value = input[field];
  if (!Array.isArray(value)) throw new Error(`model: ${field} not a list`);
  return value.map(String);
};

const fail = (tag: string): Expected => ({ kind: "failure", tag });
const ok = (value: unknown): Expected => ({ kind: "success", value });

export class Model {
  tasks = new Map<string, Task>();
  events: Event[] = [];
  requests = new Map<
    string,
    { readonly fingerprint: string; readonly answer: Expected }
  >();

  clone(): Model {
    const copy = new Model();
    copy.tasks = new Map(this.tasks);
    copy.events = [...this.events];
    copy.requests = new Map(this.requests);
    return copy;
  }

  // Whether a key was answered before, for this input or another.
  keyUse(
    bearer: string,
    action: string,
    input: Input,
  ): "new" | "repeat" | "reuse" {
    const principal = hubPrincipals[bearer];
    if (principal === undefined || !("requestKey" in input)) return "new";
    const prior = this.requests.get(`${principal} ${str(input, "requestKey")}`);
    if (prior === undefined) return "new";
    return prior.fingerprint === fingerprintOf(action, input)
      ? "repeat"
      : "reuse";
  }

  // One call, as the hub must answer it at now; the model moves with it.
  call(bearer: string, action: string, input: Input, now: number): Expected {
    const principal = hubPrincipals[bearer];
    if (principal === undefined) return fail("Unauthenticated");
    const granted: readonly string[] =
      (hubGrants as Readonly<Record<string, readonly string[]>>)[principal] ??
      [];
    if (!granted.includes(permissionOf(action))) return fail("NotAllowed");
    if (queries.has(action)) return this.query(action, input, now);
    const key = `${principal} ${str(input, "requestKey")}`;
    const fingerprint = fingerprintOf(action, input);
    const prior = this.requests.get(key);
    if (prior !== undefined)
      return prior.fingerprint === fingerprint
        ? prior.answer
        : fail("RequestKeyReused");
    const answer = this.mutate(principal, action, input, now);
    this.requests.set(key, { fingerprint, answer });
    return answer;
  }

  private query(action: string, input: Input, now: number): Expected {
    if (action === "taskWaiting") {
      const principal = str(input, "principal");
      const waiting = [...this.tasks.values()]
        .filter(
          (task) =>
            task.state === "input-required" &&
            task.input?.waitingOn === principal,
        )
        .sort((a, b) => (a.input?.since ?? 0) - (b.input?.since ?? 0))
        .slice(0, num(input, "limit"));
      return ok({
        tasks: waiting.map((task) => ({
          task,
          ageMs: now - (task.input?.since ?? now),
        })),
      });
    }
    if (action === "taskEvents") {
      const after = num(input, "after");
      return ok({
        events: this.events
          .filter((event) => event.cursor > after)
          .slice(0, num(input, "limit")),
      });
    }
    const task = this.tasks.get(str(input, "taskId"));
    return task === undefined ? fail("TaskNotFound") : ok(task);
  }

  private record(
    task: Task,
    actor: Principal,
    now: number,
    change: Event["change"],
  ): { task: Task; cursor: number } {
    const cursor = this.events.length + 1;
    this.events.push({ cursor, taskId: task.id, actor, at: now, change });
    const updated = { ...task, updatedAt: now };
    this.tasks.set(task.id, updated);
    return { task: updated, cursor };
  }

  private mutate(
    principal: Principal,
    action: string,
    input: Input,
    now: number,
  ): Expected {
    if (action === "taskCreate") {
      const id = `T${this.events.length + 1}`;
      const title = str(input, "title");
      const labels = strs(input, "labels");
      const task: Task = {
        id,
        title,
        labels,
        creator: principal,
        state: "submitted",
        claimant: null,
        claimedAt: null,
        leaseExpiresAt: null,
        leaseRemainingMs: null,
        input: null,
        result: null,
        reason: null,
        createdAt: now,
        updatedAt: now,
      };
      return ok(
        this.record(task, principal, now, { _tag: "created", title, labels }),
      );
    }
    if (action === "taskClaim") return this.claim(principal, input, now);
    const task = this.tasks.get(str(input, "taskId"));
    if (task === undefined) return fail("TaskNotFound");
    return this.move(task, principal, action, input, now);
  }

  private claim(principal: Principal, input: Input, now: number): Expected {
    const wanted = strs(input, "labels");
    // Least recently claimed first, never claimed first, ties by creation.
    const task = [...this.tasks.values()]
      .sort(
        (a, b) =>
          (a.claimedAt ?? Number.MIN_SAFE_INTEGER) -
          (b.claimedAt ?? Number.MIN_SAFE_INTEGER),
      )
      .find(
        (each) =>
          wanted.every((label) => each.labels.includes(label)) &&
          (each.state === "submitted" ||
            (each.state === "working" &&
              each.leaseExpiresAt !== null &&
              each.leaseExpiresAt <= now)),
      );
    if (task === undefined) return ok({ _tag: "NoneReady" });
    const leaseMs = num(input, "leaseMs");
    const claimed = this.record(
      {
        ...task,
        state: "working",
        claimant: principal,
        claimedAt: now,
        leaseExpiresAt: now + leaseMs,
      },
      principal,
      now,
      { _tag: "claimed", leaseMs },
    );
    return ok({ _tag: "Claimed", ...claimed });
  }

  private move(
    task: Task,
    principal: Principal,
    action: string,
    input: Input,
    now: number,
  ): Expected {
    const holds =
      task.claimant === principal &&
      task.leaseExpiresAt !== null &&
      now < task.leaseExpiresAt;
    const done = { leaseExpiresAt: null, leaseRemainingMs: null, input: null };
    switch (action) {
      case "taskRenew":
      case "taskRequestInput":
      case "taskComplete":
      case "taskFail": {
        if (task.state !== "working") return fail("WrongState");
        if (!holds) return fail("LeaseNotHeld");
        return ok(this.byHolder(task, principal, action, input, now));
      }
      case "taskAnswer": {
        if (task.state !== "input-required") return fail("WrongState");
        if (task.input?.waitingOn !== principal) return fail("NotWaitingOnYou");
        const option = str(input, "option");
        if (!task.input.options.includes(option)) return fail("NotAnOption");
        const next: Task = {
          ...task,
          state: "working",
          input: null,
          leaseExpiresAt: now + (task.leaseRemainingMs ?? 0),
          leaseRemainingMs: null,
        };
        return ok(
          this.record(next, principal, now, { _tag: "answered", option }),
        );
      }
      default: {
        if (final.includes(task.state)) return fail("WrongState");
        if (task.creator !== principal) return fail("NotCreator");
        if (action === "taskAmend") {
          const instructions = str(input, "instructions");
          return ok(
            this.record(task, principal, now, {
              _tag: "amended",
              instructions,
            }),
          );
        }
        const next: Task = { ...task, ...done, state: "canceled" };
        return ok(this.record(next, principal, now, { _tag: "canceled" }));
      }
    }
  }

  private byHolder(
    task: Task,
    principal: Principal,
    action: string,
    input: Input,
    now: number,
  ) {
    const done = { leaseExpiresAt: null, leaseRemainingMs: null, input: null };
    switch (action) {
      case "taskRenew": {
        const leaseMs = num(input, "leaseMs");
        return this.record(
          { ...task, leaseExpiresAt: now + leaseMs },
          principal,
          now,
          {
            _tag: "renewed",
            leaseMs,
          },
        );
      }
      case "taskRequestInput": {
        const request = {
          question: str(input, "question"),
          options: strs(input, "options"),
          waitingOn: str(input, "waitingOn"),
        };
        const next: Task = {
          ...task,
          state: "input-required",
          input: { ...request, since: now },
          leaseRemainingMs: (task.leaseExpiresAt ?? now) - now,
          leaseExpiresAt: null,
        };
        return this.record(next, principal, now, {
          _tag: "inputRequested",
          ...request,
        });
      }
      case "taskComplete": {
        const result = {
          text: str(input, "text"),
          url: input["url"] === null ? null : str(input, "url"),
        };
        return this.record(
          { ...task, ...done, state: "completed", result },
          principal,
          now,
          {
            _tag: "completed",
            ...result,
          },
        );
      }
      default: {
        const reason = str(input, "reason");
        return this.record(
          { ...task, ...done, state: "failed", reason },
          principal,
          now,
          {
            _tag: "failed",
            reason,
          },
        );
      }
    }
  }

  // The store as the model has it: the tasks, the events and which request
  // keys were answered.
  snapshotEquals(snapshot: Snapshot): boolean {
    const keys = snapshot.requests.map((row) =>
      row.split(" ").slice(0, 2).join(" "),
    );
    return (
      canonical(snapshot.tasks) === canonical([...this.tasks.values()]) &&
      canonical(snapshot.events) === canonical(this.events) &&
      canonical(keys) === canonical([...this.requests.keys()].sort())
    );
  }
}

export function fingerprintOf(action: string, input: Input): string {
  const { requestKey: _key, ...rest } = input;
  return canonical({ action, rest });
}

// Each change, the states it may come from (checked from the events alone).
const from: Readonly<Record<string, readonly (State | "none")[]>> = {
  created: ["none"],
  claimed: ["submitted", "working"],
  renewed: ["working"],
  inputRequested: ["working"],
  answered: ["input-required"],
  amended: ["submitted", "working", "input-required"],
  canceled: ["submitted", "working", "input-required"],
  completed: ["working"],
  failed: ["working"],
};
const to: Readonly<Record<string, State | "same">> = {
  created: "submitted",
  claimed: "working",
  renewed: "same",
  inputRequested: "input-required",
  answered: "working",
  amended: "same",
  canceled: "canceled",
  completed: "completed",
  failed: "failed",
};
const byHolder = new Set(["renewed", "inputRequested", "completed", "failed"]);

type Replayed = {
  state: State;
  creator: string;
  claimant: string | null;
  expires: number | null;
  remaining: number | null;
  waitingOn: string | null;
  options: readonly string[];
  lastAt: number;
};

function lease(seen: Replayed, event: Event): void {
  const { change, at } = event;
  if (change._tag === "claimed" || change._tag === "renewed")
    seen.expires = at + change.leaseMs;
  if (change._tag === "claimed") seen.claimant = event.actor;
  if (change._tag === "inputRequested") {
    seen.remaining = (seen.expires ?? at) - at;
    seen.expires = null;
    seen.waitingOn = change.waitingOn;
    seen.options = change.options;
  }
  if (change._tag === "answered") {
    seen.expires = at + (seen.remaining ?? 0);
    seen.waitingOn = null;
  }
}

// One event against T1 to T5, given what the events before it left.
function eventFault(
  seen: Replayed | undefined,
  event: Event,
): string | undefined {
  const kind = event.change._tag;
  const expires = seen?.expires ?? null;
  const live = expires !== null && event.at < expires;
  if (seen !== undefined && final.includes(seen.state))
    return `T3: ${kind} on ${event.taskId} after it was ${seen.state}`;
  if (from[kind]?.includes(seen?.state ?? "none") !== true)
    return `T1: ${kind} on ${event.taskId} from ${seen?.state ?? "none"}`;
  if (seen === undefined) return undefined;
  if (kind === "claimed" && live)
    return `T2: ${event.actor} claimed ${event.taskId} while ${seen.claimant} held a live lease`;
  if (byHolder.has(kind) && !(live && seen.claimant === event.actor))
    return `T2: ${kind} on ${event.taskId} by ${event.actor}, not the live holder`;
  if (event.change._tag === "answered") {
    if (seen.waitingOn !== event.actor)
      return `T5: ${event.actor} answered ${event.taskId}, which waits on ${seen.waitingOn}`;
    if (!seen.options.includes(event.change.option))
      return `T5: ${event.taskId} answered with an option it did not offer`;
  }
  if (
    (kind === "amended" || kind === "canceled") &&
    seen.creator !== event.actor
  )
    return `T1: ${kind} on ${event.taskId} by ${event.actor}, not its creator`;
  return undefined;
}

// The store's own events, replayed against the rules without the model.
export function ruleFault(snapshot: Snapshot): string | undefined {
  const replay = new Map<string, Replayed>();
  let previous = 0;
  for (const event of snapshot.events) {
    if (event.cursor <= previous)
      return `T4: cursor ${event.cursor} after ${previous}`;
    previous = event.cursor;
    const seen = replay.get(event.taskId);
    const fault = eventFault(seen, event);
    if (fault !== undefined) return fault;
    const next: Replayed = seen ?? {
      state: "submitted",
      creator: event.actor,
      claimant: null,
      expires: null,
      remaining: null,
      waitingOn: null,
      options: [],
      lastAt: event.at,
    };
    next.lastAt = event.at;
    const target = to[event.change._tag] ?? "same";
    if (target !== "same") next.state = target;
    lease(next, event);
    replay.set(event.taskId, next);
  }
  for (const task of snapshot.tasks) {
    const seen = replay.get(task.id);
    // A row changed later than its last event is a change with no event.
    if (seen !== undefined && seen.lastAt !== task.updatedAt)
      return `T4: ${task.id} changed at ${task.updatedAt}, its last event is at ${seen.lastAt}`;
    if (seen?.state !== task.state)
      return `T1: ${task.id} is ${task.state}, its events say ${seen?.state ?? "nothing"}`;
  }
  if (replay.size !== snapshot.tasks.length)
    return `T4: ${replay.size} tasks in the events, ${snapshot.tasks.length} in the table`;
  return undefined;
}
