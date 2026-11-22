// The task hub's actions: one definition each, so every surface of the
// action contract serves them (DECISIONS.md, 2026-11-22: the task hub). A
// handler translates its input into a store request; the store decides with
// the transition table. Action names are camelCase (taskCreate), as the
// contract requires; each has its own permission, named task.<verb>.
//
// Every mutation takes a requestKey chosen by the caller. The same key with
// the same input returns the first answer, refusal or not, and adds no
// event; the same key with another input is RequestKeyReused.
import { Clock, Effect, Schema } from "effect";

import { defineAction, type ErrorSchema } from "../action/action.ts";
import { type Outcome, type Request, TaskStore } from "./store.ts";
import {
  Cursor,
  Labels,
  LeaseMs,
  LeaseNotHeld,
  limits,
  NotAnOption,
  NotCreator,
  NotWaitingOnYou,
  Option,
  Options,
  PrincipalId,
  type Refusal,
  RequestKeyReused,
  Task,
  TaskId,
  TaskNotFound,
  Text,
  Title,
  Url,
  WrongState,
  Event,
} from "./task.ts";

export const permissions = {
  create: "task.create",
  claim: "task.claim",
  renew: "task.renew",
  requestInput: "task.requestInput",
  answer: "task.answer",
  amend: "task.amend",
  cancel: "task.cancel",
  complete: "task.complete",
  fail: "task.fail",
  get: "task.get",
  events: "task.events",
  waiting: "task.waiting",
} as const;

export const RequestKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/u),
);

export const Changed = Schema.Struct({ task: Task, cursor: Cursor });

export const Claimed = Schema.TaggedStruct("Claimed", {
  task: Task,
  cursor: Cursor,
});
export const NoneReady = Schema.TaggedStruct("NoneReady", {});

type ErrorClass = ErrorSchema & { readonly identifier: string };

// The store answers with any refusal; an action declares the ones its row of
// the transition table can give. Narrowing checks it: an undeclared refusal
// is a bug, so it dies.
function narrowed<const Errors extends ReadonlyArray<ErrorClass>>(
  errors: Errors,
) {
  const tags = new Set(errors.map((error) => error.identifier));
  return <A>(
    effect: Effect.Effect<A, Refusal | RequestKeyReused>,
  ): Effect.Effect<A, Errors[number]["Type"]> =>
    Effect.catch(effect, (error) =>
      tags.has(error._tag)
        ? Effect.fail(error as Errors[number]["Type"])
        : Effect.die(new Error(`hub: undeclared refusal ${error._tag}`)),
    );
}

function changedOf(outcome: Outcome) {
  if (outcome.task === null || outcome.cursor === null)
    return Effect.die(new Error("hub: a change with no task"));
  return Effect.succeed({ task: outcome.task, cursor: outcome.cursor });
}

type MoveCommand = Extract<Request, { readonly _tag: "move" }>["command"];

// The handler of a mutation on one existing task, for the errors its row of
// the transition table gives.
function mover<const Errors extends ReadonlyArray<ErrorClass>>(errors: Errors) {
  const narrow = narrowed(errors);
  return (
    principal: string,
    input: { readonly taskId: string; readonly requestKey: string },
    command: MoveCommand,
  ) =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const outcome = yield* narrow(
        store.execute(principal, input.requestKey, {
          _tag: "move",
          taskId: input.taskId,
          command,
        }),
      );
      return yield* changedOf(outcome);
    });
}

const target = { taskId: TaskId, requestKey: RequestKey };

export const taskCreate = defineAction({
  name: "taskCreate",
  description: "Creates a task with a title and labels; it starts submitted.",
  kind: "mutation",
  input: { requestKey: RequestKey, title: Title, labels: Labels },
  success: Changed,
  errors: [RequestKeyReused],
  permission: permissions.create,
  handler: ({ requestKey, title, labels }, principal) =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const outcome = yield* narrowed([RequestKeyReused])(
        store.execute(principal, requestKey, { _tag: "create", title, labels }),
      );
      return yield* changedOf(outcome);
    }),
});

export const taskClaim = defineAction({
  name: "taskClaim",
  description:
    "Claims the ready task claimed least recently (never claimed first, then in creation order) that has every label given, with a lease of leaseMs; NoneReady when there is none.",
  kind: "mutation",
  input: { requestKey: RequestKey, labels: Labels, leaseMs: LeaseMs },
  success: Schema.Union([Claimed, NoneReady]),
  errors: [RequestKeyReused],
  permission: permissions.claim,
  handler: ({ requestKey, labels, leaseMs }, principal) =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const outcome = yield* narrowed([RequestKeyReused])(
        store.execute(principal, requestKey, {
          _tag: "claim",
          labels,
          leaseMs,
        }),
      );
      return outcome.task === null || outcome.cursor === null
        ? NoneReady.make({})
        : Claimed.make({ task: outcome.task, cursor: outcome.cursor });
    }),
});

const holderErrors = [
  TaskNotFound,
  WrongState,
  LeaseNotHeld,
  RequestKeyReused,
] as const;
const creatorErrors = [
  TaskNotFound,
  WrongState,
  NotCreator,
  RequestKeyReused,
] as const;
const answerErrors = [
  TaskNotFound,
  WrongState,
  NotWaitingOnYou,
  NotAnOption,
  RequestKeyReused,
] as const;
const byHolder = mover(holderErrors);
const byCreator = mover(creatorErrors);
const byWaitedOn = mover(answerErrors);

export const taskRenew = defineAction({
  name: "taskRenew",
  description:
    "Extends the caller's live lease on a working task to leaseMs from now.",
  kind: "mutation",
  input: { ...target, leaseMs: LeaseMs },
  success: Changed,
  errors: holderErrors,
  permission: permissions.renew,
  handler: (input, principal) =>
    byHolder(principal, input, { _tag: "renew", leaseMs: input.leaseMs }),
});

export const taskRequestInput = defineAction({
  name: "taskRequestInput",
  description:
    "Asks a principal a question with at least two options; the task waits on them and its lease is suspended.",
  kind: "mutation",
  input: {
    ...target,
    question: Text,
    options: Options,
    waitingOn: PrincipalId,
  },
  success: Changed,
  errors: holderErrors,
  permission: permissions.requestInput,
  handler: (input, principal) =>
    byHolder(principal, input, {
      _tag: "requestInput",
      question: input.question,
      options: input.options,
      waitingOn: input.waitingOn,
    }),
});

export const taskAnswer = defineAction({
  name: "taskAnswer",
  description:
    "Answers the question a task waits on with one of its options; the task is working again and its lease resumes.",
  kind: "mutation",
  input: { ...target, option: Option },
  success: Changed,
  errors: answerErrors,
  permission: permissions.answer,
  handler: (input, principal) =>
    byWaitedOn(principal, input, { _tag: "answer", option: input.option }),
});

export const taskAmend = defineAction({
  name: "taskAmend",
  description:
    "Adds instructions from the task's creator to a task that is not final; its state does not change.",
  kind: "mutation",
  input: { ...target, instructions: Text },
  success: Changed,
  errors: creatorErrors,
  permission: permissions.amend,
  handler: (input, principal) =>
    byCreator(principal, input, {
      _tag: "amend",
      instructions: input.instructions,
    }),
});

export const taskCancel = defineAction({
  name: "taskCancel",
  description: "Cancels a task that is not final; only its creator may.",
  kind: "mutation",
  input: target,
  success: Changed,
  errors: creatorErrors,
  permission: permissions.cancel,
  handler: (input, principal) =>
    byCreator(principal, input, { _tag: "cancel" }),
});

export const taskComplete = defineAction({
  name: "taskComplete",
  description:
    "Completes a working task with a result, from the holder of its live lease.",
  kind: "mutation",
  input: { ...target, text: Text, url: Schema.NullOr(Url) },
  success: Changed,
  errors: holderErrors,
  permission: permissions.complete,
  handler: (input, principal) =>
    byHolder(principal, input, {
      _tag: "complete",
      text: input.text,
      url: input.url,
    }),
});

export const taskFail = defineAction({
  name: "taskFail",
  description:
    "Fails a working task with a reason, from the holder of its live lease.",
  kind: "mutation",
  input: { ...target, reason: Text },
  success: Changed,
  errors: holderErrors,
  permission: permissions.fail,
  handler: (input, principal) =>
    byHolder(principal, input, { _tag: "fail", reason: input.reason }),
});

export const taskGet = defineAction({
  name: "taskGet",
  description: "Reads one task.",
  kind: "query",
  input: { taskId: TaskId },
  success: Task,
  errors: [TaskNotFound],
  permission: permissions.get,
  handler: ({ taskId }) =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      return yield* store.get(taskId);
    }),
});

export const EventLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: limits.eventsPerReadMax }),
);

export const taskEvents = defineAction({
  name: "taskEvents",
  description:
    "Reads every event after a cursor, in commit order, at most limit of them.",
  kind: "query",
  input: { after: Cursor, limit: EventLimit },
  success: Schema.Struct({ events: Schema.Array(Event) }),
  errors: [],
  permission: permissions.events,
  handler: ({ after, limit }) =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      return { events: yield* store.events(after, limit) };
    }),
});

export const Waiter = Schema.Struct({
  task: Task,
  // How long the task has waited on the principal, at the time of the read.
  ageMs: Schema.Int,
});

export const taskWaiting = defineAction({
  name: "taskWaiting",
  description:
    "Reads the tasks waiting on a principal's answer, longest waiting first, each with how long it has waited: that principal's inbox.",
  kind: "query",
  input: { principal: PrincipalId, limit: EventLimit },
  success: Schema.Struct({ tasks: Schema.Array(Waiter) }),
  errors: [],
  permission: permissions.waiting,
  handler: ({ principal, limit }) =>
    Effect.gen(function* () {
      const store = yield* TaskStore;
      const now = yield* Clock.currentTimeMillis;
      const tasks = yield* store.waitingOn(principal, limit);
      return {
        tasks: tasks.map((task) => ({
          task,
          ageMs: now - (task.input?.since ?? now),
        })),
      };
    }),
});

export const hubActions = [
  taskCreate,
  taskClaim,
  taskRenew,
  taskRequestInput,
  taskAnswer,
  taskAmend,
  taskCancel,
  taskComplete,
  taskFail,
  taskGet,
  taskEvents,
  taskWaiting,
] as const;
