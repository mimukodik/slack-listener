// The task hub's domain: a task, the changes that happen to it, and the one
// transition table that decides them (DECISIONS.md, 2026-11-22: the task
// hub, BER-2368). Pure: no clock, no storage, no Effect service. The store
// applies decide and evolve inside one write transaction; the actions only
// translate inputs.
//
// The states are A2A's. A submitted task, or a working one whose lease has
// lapsed, is ready: the next claim may take it. A task waiting on input keeps
// its claimant, and its lease is suspended until the answer, since the
// claimant cannot finish while someone else holds the next move.
import { Result, Schema } from "effect";

export const states = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
] as const;
export type State = (typeof states)[number];

export const finalStates: readonly State[] = [
  "completed",
  "failed",
  "canceled",
];
const openStates: readonly State[] = ["submitted", "working", "input-required"];

// The limits every field has (PRINCIPLES.md: everything has a limit).
export const limits = {
  titleMax: 200,
  labelsMax: 8,
  textMax: 2000,
  optionsMax: 8,
  leaseMsMax: 3_600_000,
  eventsPerReadMax: 200,
} as const;

const text = (max: number) =>
  Schema.String.check(Schema.isBetweenLength(1, max));

export const TaskId = Schema.String.check(Schema.isPattern(/^T[0-9]{1,12}$/u));
export const Label = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u),
);
export const Labels = Schema.Array(Label).check(
  Schema.isMaxLength(limits.labelsMax),
  Schema.isUnique(),
);
export const PrincipalId = text(128);
export const Title = text(limits.titleMax);
export const Text = text(limits.textMax);
export const Option = text(100);
export const Options = Schema.Array(Option).check(
  Schema.isBetweenLength(2, limits.optionsMax),
  Schema.isUnique(),
);
export const Url = Schema.String.check(
  Schema.isPattern(/^https?:\/\/\S{1,2000}$/u),
);
export const LeaseMs = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: limits.leaseMsMax }),
);
export const Cursor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const InputRequest = Schema.Struct({
  question: Text,
  options: Options,
  waitingOn: PrincipalId,
});

export const TaskResult = Schema.Struct({
  text: Text,
  url: Schema.NullOr(Url),
});

export const Task = Schema.Struct({
  id: TaskId,
  title: Title,
  labels: Labels,
  creator: PrincipalId,
  state: Schema.Literals(states),
  // The principal that claimed it last, kept once it is final.
  claimant: Schema.NullOr(PrincipalId),
  // When the lease lapses; null when no lease runs (not claimed, suspended
  // while waiting on input, or final).
  leaseExpiresAt: Schema.NullOr(Schema.Int),
  // What was left of the lease when it was suspended for input.
  leaseRemainingMs: Schema.NullOr(Schema.Int),
  input: Schema.NullOr(InputRequest),
  result: Schema.NullOr(TaskResult),
  reason: Schema.NullOr(Text),
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});
export type Task = typeof Task.Type;

// A change to a task: what an event records, enough to replay it.
export const Change = Schema.Union([
  Schema.TaggedStruct("created", { title: Title, labels: Labels }),
  Schema.TaggedStruct("claimed", { leaseMs: LeaseMs }),
  Schema.TaggedStruct("renewed", { leaseMs: LeaseMs }),
  Schema.TaggedStruct("inputRequested", InputRequest.fields),
  Schema.TaggedStruct("answered", { option: Option }),
  Schema.TaggedStruct("amended", { instructions: Text }),
  Schema.TaggedStruct("canceled", {}),
  Schema.TaggedStruct("completed", TaskResult.fields),
  Schema.TaggedStruct("failed", { reason: Text }),
]);
export type Change = typeof Change.Type;

export const Event = Schema.Struct({
  cursor: Cursor,
  taskId: TaskId,
  actor: PrincipalId,
  at: Schema.Int,
  change: Change,
});
export type Event = typeof Event.Type;

// What a caller asks of an existing task; create and claim are the two that
// do not name one.
export type Command =
  | { readonly _tag: "claim"; readonly leaseMs: number }
  | { readonly _tag: "renew"; readonly leaseMs: number }
  | {
      readonly _tag: "requestInput";
      readonly question: string;
      readonly options: readonly string[];
      readonly waitingOn: string;
    }
  | { readonly _tag: "answer"; readonly option: string }
  | { readonly _tag: "amend"; readonly instructions: string }
  | { readonly _tag: "cancel" }
  | {
      readonly _tag: "complete";
      readonly text: string;
      readonly url: string | null;
    }
  | { readonly _tag: "fail"; readonly reason: string };
export type CommandTag = Command["_tag"];

// The refusals, each a typed error with its HTTP status (action.ts: the
// error-mapping rule).
export class TaskNotFound extends Schema.TaggedError<TaskNotFound>()(
  "TaskNotFound",
  { message: Schema.String, taskId: Schema.String },
  { httpApiStatus: 404 },
) {}

export class WrongState extends Schema.TaggedError<WrongState>()(
  "WrongState",
  { message: Schema.String, taskId: Schema.String, state: Schema.String },
  { httpApiStatus: 409 },
) {}

export class LeaseNotHeld extends Schema.TaggedError<LeaseNotHeld>()(
  "LeaseNotHeld",
  { message: Schema.String, taskId: Schema.String },
  { httpApiStatus: 409 },
) {}

export class NotWaitingOnYou extends Schema.TaggedError<NotWaitingOnYou>()(
  "NotWaitingOnYou",
  { message: Schema.String, taskId: Schema.String },
  { httpApiStatus: 403 },
) {}

export class NotAnOption extends Schema.TaggedError<NotAnOption>()(
  "NotAnOption",
  { message: Schema.String, taskId: Schema.String },
  { httpApiStatus: 422 },
) {}

export class NotCreator extends Schema.TaggedError<NotCreator>()(
  "NotCreator",
  { message: Schema.String, taskId: Schema.String },
  { httpApiStatus: 403 },
) {}

export class RequestKeyReused extends Schema.TaggedError<RequestKeyReused>()(
  "RequestKeyReused",
  { message: Schema.String, requestKey: Schema.String },
  { httpApiStatus: 422 },
) {}

export const Refusal = Schema.Union([
  TaskNotFound,
  WrongState,
  LeaseNotHeld,
  NotWaitingOnYou,
  NotAnOption,
  NotCreator,
]);
export type Refusal = typeof Refusal.Type;

// Who may make a move: anyone the Policy lets call the action, the principal
// holding a live lease, the principal the task waits on, or its creator.
type Actor = "anyone" | "holder" | "waitedOn" | "creator";
// What the lease must be: free (none live), held by the actor and live, or
// not looked at.
type Lease = "free" | "held" | "any";
type Next = State | "same";

export type Rule = {
  readonly from: readonly State[];
  readonly actor: Actor;
  readonly lease: Lease;
  readonly to: Next;
  readonly change: Change["_tag"];
  // The refusals the rule can give, beyond a missing task.
  readonly refusals: ReadonlyArray<Refusal["_tag"]>;
};

// The task lifecycle, in one table. Nothing else moves a task between
// states: decide checks a command against its row and evolve applies the
// row's change.
export const transitions: { readonly [Tag in CommandTag]: Rule } = {
  claim: {
    from: ["submitted", "working"],
    actor: "anyone",
    lease: "free",
    to: "working",
    change: "claimed",
    refusals: ["WrongState"],
  },
  renew: {
    from: ["working"],
    actor: "holder",
    lease: "held",
    to: "same",
    change: "renewed",
    refusals: ["WrongState", "LeaseNotHeld"],
  },
  requestInput: {
    from: ["working"],
    actor: "holder",
    lease: "held",
    to: "input-required",
    change: "inputRequested",
    refusals: ["WrongState", "LeaseNotHeld"],
  },
  answer: {
    from: ["input-required"],
    actor: "waitedOn",
    lease: "any",
    to: "working",
    change: "answered",
    refusals: ["WrongState", "NotWaitingOnYou", "NotAnOption"],
  },
  amend: {
    from: openStates,
    actor: "creator",
    lease: "any",
    to: "same",
    change: "amended",
    refusals: ["WrongState", "NotCreator"],
  },
  cancel: {
    from: openStates,
    actor: "creator",
    lease: "any",
    to: "canceled",
    change: "canceled",
    refusals: ["WrongState", "NotCreator"],
  },
  complete: {
    from: ["working"],
    actor: "holder",
    lease: "held",
    to: "completed",
    change: "completed",
    refusals: ["WrongState", "LeaseNotHeld"],
  },
  fail: {
    from: ["working"],
    actor: "holder",
    lease: "held",
    to: "failed",
    change: "failed",
    refusals: ["WrongState", "LeaseNotHeld"],
  },
};

export const isFinal = (state: State): boolean => finalStates.includes(state);

// A lease is live until the instant it expires.
export const leaseLive = (task: Task, now: number): boolean =>
  task.leaseExpiresAt !== null && now < task.leaseExpiresAt;

function changeOf(command: Command): Change {
  switch (command._tag) {
    case "claim":
      return { _tag: "claimed", leaseMs: command.leaseMs };
    case "renew":
      return { _tag: "renewed", leaseMs: command.leaseMs };
    case "requestInput":
      return {
        _tag: "inputRequested",
        question: command.question,
        options: command.options,
        waitingOn: command.waitingOn,
      };
    case "answer":
      return { _tag: "answered", option: command.option };
    case "amend":
      return { _tag: "amended", instructions: command.instructions };
    case "cancel":
      return { _tag: "canceled" };
    case "complete":
      return { _tag: "completed", text: command.text, url: command.url };
    case "fail":
      return { _tag: "failed", reason: command.reason };
  }
}

function actorRefusal(
  rule: Rule,
  task: Task,
  actor: string,
  now: number,
): Refusal | undefined {
  const taskId = task.id;
  const live = leaseLive(task, now);
  if (rule.lease === "free" && live)
    return new WrongState({
      message: `${taskId} is leased`,
      taskId,
      state: task.state,
    });
  const holds = live && task.claimant === actor;
  if (rule.lease === "held" && !holds)
    return new LeaseNotHeld({
      message: `${actor} holds no live lease on ${taskId}`,
      taskId,
    });
  if (rule.actor === "waitedOn" && task.input?.waitingOn !== actor)
    return new NotWaitingOnYou({
      message: `${taskId} does not wait on ${actor}`,
      taskId,
    });
  if (rule.actor === "creator" && task.creator !== actor)
    return new NotCreator({
      message: `${actor} did not create ${taskId}`,
      taskId,
    });
  return undefined;
}

// Whether a command may move a task now, and the change it makes: the
// table's row for the command, checked state first, then lease and actor.
export function decide(
  task: Task,
  command: Command,
  actor: string,
  now: number,
): Result.Result<Change, Refusal> {
  const rule = transitions[command._tag];
  if (!rule.from.includes(task.state))
    return Result.fail(
      new WrongState({
        message: `${task.id} is ${task.state}`,
        taskId: task.id,
        state: task.state,
      }),
    );
  const refused = actorRefusal(rule, task, actor, now);
  if (refused !== undefined) return Result.fail(refused);
  if (
    command._tag === "answer" &&
    task.input?.options.includes(command.option) !== true
  )
    return Result.fail(
      new NotAnOption({
        message: `not an option of ${task.id}`,
        taskId: task.id,
      }),
    );
  return Result.succeed(changeOf(command));
}

// The first task, oldest first, that has every label asked for and that a
// claim by this actor may take now.
export function pickReady(
  candidates: readonly Task[],
  labels: readonly string[],
  actor: string,
  now: number,
): Task | undefined {
  return candidates.find(
    (task) =>
      labels.every((label) => task.labels.includes(label)) &&
      Result.isSuccess(decide(task, { _tag: "claim", leaseMs: 1 }, actor, now)),
  );
}

function created(event: Event, title: string, labels: readonly string[]) {
  return {
    id: event.taskId,
    title,
    labels,
    creator: event.actor,
    state: "submitted",
    claimant: null,
    leaseExpiresAt: null,
    leaseRemainingMs: null,
    input: null,
    result: null,
    reason: null,
    createdAt: event.at,
    updatedAt: event.at,
  } satisfies Task;
}

function nextState(task: Task, tag: Change["_tag"]): State {
  const rule = Object.values(transitions).find((each) => each.change === tag);
  if (rule === undefined) throw new Error(`task: no rule makes ${tag}`);
  return rule.to === "same" ? task.state : rule.to;
}

function applied(task: Task, event: Event): Task {
  const { change, at } = event;
  const moved = {
    ...task,
    state: nextState(task, change._tag),
    updatedAt: at,
  };
  switch (change._tag) {
    case "created":
      throw new Error(`task: ${task.id} created twice`);
    case "claimed":
      return {
        ...moved,
        claimant: event.actor,
        leaseExpiresAt: at + change.leaseMs,
      };
    case "renewed":
      return { ...moved, leaseExpiresAt: at + change.leaseMs };
    case "inputRequested":
      return {
        ...moved,
        input: {
          question: change.question,
          options: change.options,
          waitingOn: change.waitingOn,
        },
        leaseRemainingMs: (task.leaseExpiresAt ?? at) - at,
        leaseExpiresAt: null,
      };
    case "answered":
      return {
        ...moved,
        input: null,
        leaseExpiresAt: at + (task.leaseRemainingMs ?? 0),
        leaseRemainingMs: null,
      };
    case "amended":
      return moved;
    case "canceled":
      return { ...moved, ...noLease };
    case "completed":
      return {
        ...moved,
        ...noLease,
        result: { text: change.text, url: change.url },
      };
    case "failed":
      return { ...moved, ...noLease, reason: change.reason };
  }
}

const noLease = { leaseExpiresAt: null, leaseRemainingMs: null, input: null };

// The task after an event: the fold that makes the tasks table a projection
// of the events.
export function evolve(task: Task | undefined, event: Event): Task {
  if (event.change._tag === "created") {
    if (task !== undefined) throw new Error(`task: ${task.id} created twice`);
    return created(event, event.change.title, event.change.labels);
  }
  if (task === undefined)
    throw new Error(`task: ${event.taskId} changed before it was created`);
  return applied(task, event);
}
