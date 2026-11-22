// The task hub's store: events, the tasks projected from them, and the
// answers given per request key, over effect/sql (DECISIONS.md, 2026-11-22:
// the task hub). Every mutation is one write transaction that looks up the
// request key, decides with the transition table, appends exactly one event,
// updates the task's row and records the answer. A refusal records its
// answer too, with no event, so a repeat gets the same refusal.
//
// The store is the hub's only writer. It reads the time once per mutation,
// from Effect's Clock, and nothing else of the world. The SQL is portable
// except the table definitions, which a Postgres Layer would bring in its own
// dialect.
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  type Command,
  decide,
  type Event,
  evolve,
  Change,
  limits,
  pickReady,
  Refusal,
  RequestKeyReused,
  Task,
  TaskNotFound,
  transitions,
} from "./task.ts";

// What a mutation asks of the store.
export type Request =
  | {
      readonly _tag: "create";
      readonly title: string;
      readonly labels: readonly string[];
    }
  | {
      readonly _tag: "claim";
      readonly labels: readonly string[];
      readonly leaseMs: number;
    }
  | {
      readonly _tag: "move";
      readonly taskId: string;
      readonly command: Exclude<Command, { readonly _tag: "claim" }>;
    };

// What a mutation answers: the task after its event and the event's cursor,
// or no task for a claim that found none ready.
export const Outcome = Schema.Struct({
  task: Schema.NullOr(Task),
  cursor: Schema.NullOr(Schema.Int),
});
export type Outcome = typeof Outcome.Type;

// An answer as recorded under its request key.
const Answer = Schema.Union([
  Schema.TaggedStruct("done", { outcome: Outcome }),
  Schema.TaggedStruct("refused", { refusal: Refusal }),
]);
type Answer = typeof Answer.Type;
const answerJson = Schema.fromJsonString(Answer);
const taskJson = Schema.fromJsonString(Task);
const changeJson = Schema.fromJsonString(Change);

export type Snapshot = {
  readonly tasks: readonly Task[];
  readonly events: readonly Event[];
  readonly requests: readonly string[];
};

export class TaskStore extends Context.Service<
  TaskStore,
  {
    readonly execute: (
      principal: string,
      requestKey: string,
      request: Request,
    ) => Effect.Effect<Outcome, Refusal | RequestKeyReused>;
    readonly get: (taskId: string) => Effect.Effect<Task, TaskNotFound>;
    readonly events: (
      after: number,
      limit: number,
    ) => Effect.Effect<readonly Event[]>;
    // The tasks waiting on a principal's answer, longest waiting first.
    readonly waitingOn: (
      principal: string,
      limit: number,
    ) => Effect.Effect<readonly Task[]>;
    readonly snapshot: Effect.Effect<Snapshot>;
  }
>()("hub/TaskStore") {}

const schema = [
  `CREATE TABLE IF NOT EXISTS hub_events (cursor INTEGER PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, change TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS hub_tasks (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS hub_tasks_state ON hub_tasks (state, seq)`,
  `CREATE TABLE IF NOT EXISTS hub_requests (principal TEXT NOT NULL, request_key TEXT NOT NULL, request TEXT NOT NULL, answer TEXT NOT NULL, PRIMARY KEY (principal, request_key))`,
];

const EventRow = Schema.Struct({
  cursor: Schema.Number,
  task_id: Schema.String,
  actor: Schema.String,
  at: Schema.Number,
  change: Schema.fromJsonString(Change),
});
const BodyRow = Schema.Struct({ body: Schema.String });
const RequestRow = Schema.Struct({
  request: Schema.String,
  answer: Schema.String,
});
const NextRow = Schema.Struct({ next: Schema.Number });

const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(EventRow));
const decodeBodyRows = Schema.decodeUnknownEffect(Schema.Array(BodyRow));
const decodeRequestRows = Schema.decodeUnknownEffect(Schema.Array(RequestRow));
const decodeNextRows = Schema.decodeUnknownEffect(Schema.Array(NextRow));

// The same JSON for the same value, whatever order its keys came in.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of schema) yield* sql.unsafe(statement);

  const taskRows = (rows: ReadonlyArray<unknown>) =>
    decodeBodyRows(rows).pipe(
      Effect.flatMap((decoded) =>
        Effect.forEach(decoded, ({ body }) =>
          Schema.decodeEffect(taskJson)(body),
        ),
      ),
    );

  const eventRows = (rows: ReadonlyArray<unknown>) =>
    Effect.map(decodeEventRows(rows), (decoded) =>
      decoded.map((row): Event => ({
        cursor: row.cursor,
        taskId: row.task_id,
        actor: row.actor,
        at: row.at,
        change: row.change,
      })),
    );

  const findTask = (taskId: string) =>
    sql`SELECT body FROM hub_tasks WHERE id = ${taskId}`.pipe(
      Effect.flatMap(taskRows),
      Effect.map((tasks) => tasks[0]),
    );

  // Appends the event and moves the task's row to match, in the caller's
  // transaction.
  const append = (event: Event, before: Task | undefined) =>
    Effect.gen(function* () {
      const after = evolve(before, event);
      yield* sql`INSERT INTO hub_events (cursor, task_id, kind, actor, at, change) VALUES (${event.cursor}, ${event.taskId}, ${event.change._tag}, ${event.actor}, ${event.at}, ${Schema.encodeSync(changeJson)(event.change)})`;
      const body = Schema.encodeSync(taskJson)(after);
      if (before === undefined)
        yield* sql`INSERT INTO hub_tasks (id, seq, state, body) VALUES (${after.id}, ${event.cursor}, ${after.state}, ${body})`;
      else
        yield* sql`UPDATE hub_tasks SET state = ${after.state}, body = ${body} WHERE id = ${after.id}`;
      return { task: after, cursor: event.cursor };
    });

  const nextCursor =
    sql`SELECT COALESCE(MAX(cursor), 0) + 1 AS next FROM hub_events`.pipe(
      Effect.flatMap(decodeNextRows),
      Effect.map((rows) => rows[0]?.next ?? 1),
    );

  const eventOf = (
    cursor: number,
    taskId: string,
    actor: string,
    at: number,
    change: Change,
  ): Event => ({ cursor, taskId, actor, at, change });

  // A fresh request, decided and applied.
  const apply = (principal: string, request: Request, now: number) =>
    Effect.gen(function* () {
      const cursor = yield* nextCursor;
      switch (request._tag) {
        case "create": {
          const change = {
            _tag: "created" as const,
            title: request.title,
            labels: request.labels,
          };
          const event = eventOf(cursor, `T${cursor}`, principal, now, change);
          return done(yield* append(event, undefined));
        }
        case "claim": {
          const from = transitions.claim.from;
          const candidates =
            yield* sql`SELECT body FROM hub_tasks WHERE state IN ${sql.in(from)} ORDER BY seq`.pipe(
              Effect.flatMap(taskRows),
            );
          const task = pickReady(candidates, request.labels, principal, now);
          if (task === undefined) return done({ task: null, cursor: null });
          const change = { _tag: "claimed" as const, leaseMs: request.leaseMs };
          const event = eventOf(cursor, task.id, principal, now, change);
          return done(yield* append(event, task));
        }
        case "move": {
          const task = yield* findTask(request.taskId);
          if (task === undefined)
            return refused(
              new TaskNotFound({
                message: `no task ${request.taskId}`,
                taskId: request.taskId,
              }),
            );
          const decided = decide(task, request.command, principal, now);
          if (Result.isFailure(decided)) return refused(decided.failure);
          const event = eventOf(
            cursor,
            task.id,
            principal,
            now,
            decided.success,
          );
          return done(yield* append(event, task));
        }
      }
    });

  const execute = (principal: string, requestKey: string, request: Request) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const fingerprint = canonical(request);
      const answer = yield* sql.withTransaction(
        Effect.gen(function* () {
          const prior =
            yield* sql`SELECT request, answer FROM hub_requests WHERE principal = ${principal} AND request_key = ${requestKey}`.pipe(
              Effect.flatMap(decodeRequestRows),
            );
          const first = prior[0];
          if (first !== undefined)
            return first.request === fingerprint
              ? yield* Schema.decodeEffect(answerJson)(first.answer)
              : undefined;
          const fresh = yield* apply(principal, request, now);
          yield* sql`INSERT INTO hub_requests (principal, request_key, request, answer) VALUES (${principal}, ${requestKey}, ${fingerprint}, ${Schema.encodeSync(answerJson)(fresh)})`;
          return fresh;
        }),
      );
      if (answer === undefined)
        return yield* new RequestKeyReused({
          message: `request key ${requestKey} was used for another request`,
          requestKey,
        });
      if (answer._tag === "refused") return yield* Effect.fail(answer.refusal);
      return answer.outcome;
    }).pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die));

  const get = (taskId: string) =>
    findTask(taskId).pipe(
      Effect.catchTag(["SqlError", "SchemaError"], Effect.die),
      Effect.flatMap((task) =>
        task === undefined
          ? Effect.fail(
              new TaskNotFound({ message: `no task ${taskId}`, taskId }),
            )
          : Effect.succeed(task),
      ),
    );

  const events = (after: number, limit: number) =>
    sql`SELECT cursor, task_id, actor, at, change FROM hub_events WHERE cursor > ${after} ORDER BY cursor LIMIT ${Math.min(limit, limits.eventsPerReadMax)}`.pipe(
      Effect.flatMap(eventRows),
      Effect.catchTag(["SqlError", "SchemaError"], Effect.die),
    );

  const snapshot = Effect.gen(function* () {
    const tasks = yield* sql`SELECT body FROM hub_tasks ORDER BY seq`.pipe(
      Effect.flatMap(taskRows),
    );
    const all =
      yield* sql`SELECT cursor, task_id, actor, at, change FROM hub_events ORDER BY cursor`.pipe(
        Effect.flatMap(eventRows),
      );
    const requests = yield* sql<{
      readonly principal: string;
      readonly request_key: string;
      readonly answer: string;
    }>`SELECT principal, request_key, answer FROM hub_requests ORDER BY principal, request_key`;
    return {
      tasks,
      events: all,
      requests: requests.map(
        (row) => `${row.principal} ${row.request_key} ${row.answer}`,
      ),
    };
  }).pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die));

  const waitingOn = (principal: string, limit: number) =>
    sql`SELECT body FROM hub_tasks WHERE state = ${"input-required"} ORDER BY seq`.pipe(
      Effect.flatMap(taskRows),
      Effect.map((tasks) =>
        tasks
          .filter((task) => task.input?.waitingOn === principal)
          .sort((a, b) => (a.input?.since ?? 0) - (b.input?.since ?? 0))
          .slice(0, Math.min(limit, limits.eventsPerReadMax)),
      ),
      Effect.catchTag(["SqlError", "SchemaError"], Effect.die),
    );

  return TaskStore.of({ execute, get, events, waitingOn, snapshot });
});

function done(outcome: Outcome): Answer {
  return { _tag: "done", outcome };
}

function refused(refusal: Refusal): Answer {
  return { _tag: "refused", refusal };
}

export class WriterLockHeld extends Schema.TaggedError<WriterLockHeld>()(
  "WriterLockHeld",
  { message: Schema.String, lockFile: Schema.String },
) {}

// The single-writer lock: an exclusive transaction on a file of its own, held
// until the scope closes, or WriterLockHeld when another process holds it.
// The operating system releases it when the holder dies (store spike). A
// Postgres hub would take pg_advisory_lock instead.
export const holdWriterLock = (lockFile: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      SqliteClient.layer({
        filename: lockFile,
        disableWAL: true,
        busyTimeout: 0,
      }),
    );
    yield* Context.get(context, SqlClient.SqlClient).unsafe("BEGIN EXCLUSIVE");
  }).pipe(
    Effect.catchTag("SqlError", (error) =>
      Effect.fail(
        new WriterLockHeld({
          message: `another process writes this hub (${error.reason._tag})`,
          lockFile,
        }),
      ),
    ),
  );

// The store over whatever SqlClient is provided.
export const storeLayer = Layer.effect(TaskStore)(makeStore);

// The store over one SQLite file, or ":memory:".
export const sqliteStoreLayer = (filename: string) =>
  storeLayer.pipe(Layer.provide(SqliteClient.layer({ filename })));
