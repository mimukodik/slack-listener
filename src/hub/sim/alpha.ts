// The abstraction map α from the hub's store to the state of the TLA+ model
// in spec/tasks/Tasks.tla, at the model's replay bounds: two principals, one
// task, two request keys each, a lease of L ticks (DECISIONS.md, B1c).
//
// α keeps what T1 to T7 read: the task's state, creator, claimant, the lease
// as whole ticks left, whom it waits on, every event with its actor, key,
// argument and the state it led to, and every request key's input and the
// code of its answer. It drops what no rule reads: titles, labels, texts,
// the question, timestamps other than the lease's, and the cursor numbers
// (the log's order is kept). The model's ghosts (first, t6ok, acked), its
// reader and its pending transaction are not in α: between two calls the
// code has no open transaction and no undelivered answer.
import type { Observation } from "../../action/harness.ts";
import type { MemoRow, Snapshot } from "../store.ts";
import type { Event, Task } from "../task.ts";

// The model's values, by name.
export type ModelPrincipal = "p1" | "p2";
export type ModelKey = "k1" | "k2";
export type ModelArg = "NoArg" | ModelPrincipal | "o1" | "o2" | "o3";

export type ModelInput = {
  readonly op: string;
  readonly t: number;
  readonly arg: string;
};

export type AlphaTask = {
  readonly st: string;
  readonly creator: string;
  readonly holder: string;
  readonly left: number;
  readonly waitOn: string;
};

export type AlphaEvent = {
  readonly t: number;
  readonly kind: string;
  readonly actor: string;
  readonly key: string;
  readonly arg: string;
  readonly to: string;
};

export type AlphaMemo = {
  readonly inp: ModelInput;
  readonly ans: { readonly code: string; readonly t: number };
};

export type Alpha = {
  readonly task: AlphaTask;
  readonly log: readonly AlphaEvent[];
  // "p1 k1" and so on, only the keys that hold an answer.
  readonly memo: Readonly<Record<string, AlphaMemo>>;
};

// The model's principals as the hub's: bearers with every grant.
export const principalOf: Readonly<Record<ModelPrincipal, string>> = {
  p1: "slack-user-t0000-u0001",
  p2: "slack-user-t0000-u0002",
};
export const bearerOf: Readonly<Record<ModelPrincipal, string>> = {
  p1: "h-ann",
  p2: "h-ben",
};
export const modelOptions = ["o1", "o2"] as const;
export const tickMs = 1000;
// L in b1.cfg.
export const leaseTicks = 2;
const leaseMs = leaseTicks * tickMs;

const nameOf = (principal: string | null): string => {
  if (principal === null) return "NoP";
  for (const [name, id] of Object.entries(principalOf))
    if (id === principal) return name;
  return `outside:${principal}`;
};

const kindOf: Readonly<Record<string, string>> = {
  created: "create",
  claimed: "claim",
  renewed: "renew",
  inputRequested: "request",
  answered: "answer",
  amended: "amend",
  canceled: "cancel",
  completed: "complete",
  failed: "fail",
};

const commandOps: Readonly<Record<string, string>> = {
  renew: "renew",
  requestInput: "request",
  answer: "answer",
  amend: "amend",
  cancel: "cancel",
  complete: "complete",
  fail: "fail",
};

export const refusalCodes: Readonly<Record<string, string>> = {
  WrongState: "wrongState",
  LeaseNotHeld: "notHolder",
  NotCreator: "notCreator",
  TaskNotFound: "notFound",
  NotWaitingOnYou: "notWaitedOn",
  NotAnOption: "badOption",
  RequestKeyReused: "conflict",
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const taskNumber = (taskId: string): number =>
  /^T\d+$/u.test(taskId) ? Number(taskId.slice(1)) : -1;

// A stored request, as the model's input.
export function inputOfRequest(request: string): ModelInput {
  const parsed = record(JSON.parse(request));
  const tag = text(parsed["_tag"]);
  if (tag === "create" || tag === "claim")
    return { op: tag, t: 0, arg: "NoArg" };
  const command = record(parsed["command"]);
  const op =
    commandOps[text(command["_tag"])] ?? `unknown:${text(command["_tag"])}`;
  const arg =
    op === "request"
      ? nameOf(text(command["waitingOn"]))
      : op === "answer"
        ? text(command["option"])
        : "NoArg";
  return { op, t: taskNumber(text(parsed["taskId"])), arg };
}

// A stored answer, as the model's: ok with its task, or a refusal's code.
export function answerOfStored(answer: string): AlphaMemo["ans"] {
  const parsed = record(JSON.parse(answer));
  if (parsed["_tag"] === "refused") {
    const tag = text(record(parsed["refusal"])["_tag"]);
    return { code: refusalCodes[tag] ?? `unknown:${tag}`, t: 0 };
  }
  const outcome = record(parsed["outcome"]);
  const task = outcome["task"];
  if (task === null) return { code: "noneReady", t: 0 };
  return { code: "ok", t: taskNumber(text(record(task)["id"])) };
}

// The cursor of the event a stored answer made, if it made one.
function cursorOfStored(answer: string): number | null {
  const parsed = record(JSON.parse(answer));
  if (parsed["_tag"] !== "done") return null;
  const cursor = record(parsed["outcome"])["cursor"];
  return typeof cursor === "number" ? cursor : null;
}

// The state a stored answer left its task in.
function stateOfStored(answer: string): string {
  const parsed = record(JSON.parse(answer));
  return text(record(record(parsed["outcome"])["task"])["state"]);
}

// The lease as whole ticks left. Calls in the replay and the bounded runs
// happen on tick boundaries, so the remainders are whole.
function leftOf(task: Task, nowMs: number): number {
  if (task.state === "input-required")
    return Math.floor((task.leaseRemainingMs ?? 0) / tickMs);
  if (task.leaseExpiresAt === null) return 0;
  return Math.max(0, Math.ceil((task.leaseExpiresAt - nowMs) / tickMs));
}

const absent: AlphaTask = {
  st: "none",
  creator: "NoP",
  holder: "NoP",
  left: 0,
  waitOn: "NoP",
};

function eventOf(
  event: Event,
  byCursor: ReadonlyMap<number, MemoRow>,
): AlphaEvent {
  const row = byCursor.get(event.cursor);
  const { change } = event;
  const arg =
    change._tag === "inputRequested"
      ? nameOf(change.waitingOn)
      : change._tag === "answered"
        ? change.option
        : "NoArg";
  return {
    t: taskNumber(event.taskId),
    kind: kindOf[change._tag] ?? change._tag,
    actor: nameOf(event.actor),
    key: row?.requestKey ?? "nokey",
    arg,
    to: row === undefined ? "unknown" : stateOfStored(row.answer),
  };
}

export function alphaOf(snapshot: Snapshot, nowMs: number): Alpha {
  const byCursor = new Map<number, MemoRow>();
  const memo: Record<string, AlphaMemo> = {};
  for (const row of snapshot.memo) {
    const cursor = cursorOfStored(row.answer);
    if (cursor !== null) byCursor.set(cursor, row);
    memo[`${nameOf(row.principal)} ${row.requestKey}`] = {
      inp: inputOfRequest(row.request),
      ans: answerOfStored(row.answer),
    };
  }
  const [only] = snapshot.tasks;
  const task =
    only === undefined
      ? absent
      : {
          st: only.state,
          creator: nameOf(only.creator),
          holder: nameOf(only.claimant),
          left: leftOf(only, nowMs),
          waitOn: nameOf(only.input?.waitingOn ?? null),
        };
  return {
    task,
    log: snapshot.events.map((event) => eventOf(event, byCursor)),
    memo,
  };
}

// α in the replay fixture's compact form: one string for the task, one per
// event and one per stored key, keys in order. It says exactly what α says.
export type CompactAlpha = {
  readonly task: string;
  readonly log: readonly string[];
  readonly memo: readonly string[];
};

export function compactOf(alpha: Alpha): CompactAlpha {
  const { task } = alpha;
  return {
    task: `${task.st} ${task.creator} ${task.holder} ${String(task.left)} ${task.waitOn}`,
    log: alpha.log.map(
      (event) =>
        `${String(event.t)} ${event.kind} ${event.actor} ${event.key} ${event.arg} ${event.to}`,
    ),
    memo: Object.keys(alpha.memo)
      .sort()
      .map((slot) => {
        const entry = alpha.memo[slot];
        return entry === undefined
          ? slot
          : `${slot} ${entry.inp.op} ${String(entry.inp.t)} ${entry.inp.arg} ${entry.ans.code} ${String(entry.ans.t)}`;
      }),
  };
}

// The same α as one string, keys sorted: two αs are equal when these are.
export function alphaKey(alpha: Alpha): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, inner]) => [key, sorted(inner)]),
      );
    return value;
  };
  return JSON.stringify(sorted(alpha));
}

// The hub call a model input makes, under a principal and a key.
export function callOf(
  principal: ModelPrincipal,
  key: string,
  inp: ModelInput,
): {
  readonly bearer: string;
  readonly action: string;
  readonly input: Record<string, unknown>;
} {
  const bearer = bearerOf[principal];
  const taskId = `T${inp.t}`;
  const on = { taskId, requestKey: key };
  switch (inp.op) {
    case "create":
      return {
        bearer,
        action: "taskCreate",
        input: { requestKey: key, title: "t", labels: [] },
      };
    case "claim":
      return {
        bearer,
        action: "taskClaim",
        input: { requestKey: key, labels: [], leaseMs },
      };
    case "renew":
      return { bearer, action: "taskRenew", input: { ...on, leaseMs } };
    case "request":
      return {
        bearer,
        action: "taskRequestInput",
        input: {
          ...on,
          question: "q",
          options: [...modelOptions],
          waitingOn: principalOf[inp.arg === "p2" ? "p2" : "p1"],
        },
      };
    case "answer":
      return {
        bearer,
        action: "taskAnswer",
        input: { ...on, option: inp.arg },
      };
    case "amend":
      return {
        bearer,
        action: "taskAmend",
        input: { ...on, instructions: "x" },
      };
    case "cancel":
      return { bearer, action: "taskCancel", input: on };
    case "complete":
      return {
        bearer,
        action: "taskComplete",
        input: { ...on, text: "done", url: null },
      };
    case "fail":
      return { bearer, action: "taskFail", input: { ...on, reason: "r" } };
    default:
      throw new Error(`alpha: no call for ${inp.op}`);
  }
}

// What a hub call answered, as the model's answer code.
export function codeOf(observation: Observation): string {
  if (observation.kind === "success")
    return record(observation.value)["_tag"] === "NoneReady"
      ? "noneReady"
      : "ok";
  if (observation.kind === "failure") {
    const tag = text(record(observation.error)["_tag"]);
    return refusalCodes[tag] ?? `unknown:${tag}`;
  }
  return observation.kind;
}

// α as TLA+ values, for a trace module (spec/tasks/TraceTasks.tla).
export function tlaOf(alpha: Alpha): string {
  const value = (name: string): string => (/^-?\d+$/u.test(name) ? name : name);
  const str = (name: string): string => JSON.stringify(name);
  const inp = (each: ModelInput): string =>
    `[op |-> ${str(each.op)}, t |-> ${String(each.t)}, arg |-> ${value(each.arg)}]`;
  const { task } = alpha;
  const taskText = `<<[st |-> ${str(task.st)}, creator |-> ${task.creator}, holder |-> ${task.holder}, left |-> ${String(task.left)}, waitOn |-> ${task.waitOn}]>>`;
  const log = alpha.log
    .map(
      (event) =>
        `[t |-> ${String(event.t)}, kind |-> ${str(event.kind)}, actor |-> ${event.actor}, key |-> ${event.key}, arg |-> ${event.arg}, to |-> ${str(event.to)}]`,
    )
    .join(", ");
  const slot = (p: string, k: string): string => {
    const entry = alpha.memo[`${p} ${k}`];
    return entry === undefined
      ? "Nil"
      : `[inp |-> ${inp(entry.inp)}, ans |-> [code |-> ${str(entry.ans.code)}, t |-> ${String(entry.ans.t)}]]`;
  };
  const memo = (["p1", "p2"] as const)
    .map((p) => `${p} :> (k1 :> ${slot(p, "k1")} @@ k2 :> ${slot(p, "k2")})`)
    .join(" @@ ");
  return `[task |-> ${taskText}, log |-> <<${log}>>, memo |-> (${memo})]`;
}
