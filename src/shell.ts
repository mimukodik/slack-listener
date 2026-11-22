// The shell: an Effect program that runs the core's effects against the world.
// It reaches the world only through Effect services, so production and the
// simulator run the same program and differ only in the layers they provide
// (PRINCIPLES.md: world-through-services, simulator-runs-the-program):
//
// - Clock: the core's now, and its timers and retries as sleeping fibers;
// - Socket.WebSocketConstructor: Slack's Socket Mode connection;
// - FileSystem: the state file and the frame recording;
// - SlackApi over HttpClient, and the session's ChannelServer over Stdio.
//
// One fiber steps the core, one event at a time; everything that waits on the
// world runs in a fiber of its own and comes back as an event.
import {
  Cause,
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  FiberHandle,
  FiberMap,
  FiberSet,
  FileSystem,
  Queue,
  Schedule,
  Schema,
} from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import type { ListenerConfig } from "./config.ts";
import {
  initialState,
  step,
  type Backoff,
  type CoreEffect,
  type CoreEvent,
  type Delivery,
  type Reaction,
  type Saved,
  type State,
  type TimerName,
} from "./core.ts";
import { describeIssue } from "./decode.ts";
import {
  parentFrom,
  parentInfo,
  renderDelivery,
  type Parent,
  type ParentInfo,
} from "./format.ts";
import type { Log } from "./log.ts";
import type { ChannelServer } from "./mcp.ts";
import { redact, type SlackApi } from "./slack-api.ts";
import {
  msToTs,
  SlackMessageSchema,
  SlackTs,
  type SlackMessage,
} from "./slack.ts";

export class StateFileError extends Data.TaggedError("StateFileError")<{
  reason: string;
}> {}

// The listener stops: the core broke an invariant or the state file cannot be
// written. The process exits non-zero and a restart resumes from the disk.
export class ShellStopped extends Data.TaggedError("ShellStopped")<{
  reason: string;
}> {}

export interface ShellServices {
  readonly api: SlackApi;
  readonly sink: ChannelServer;
  readonly log: Log;
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readSaved(
  path: string,
): Effect.Effect<Saved | null, StateFileError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path).pipe(
      Effect.map((content): string | null => content),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new StateFileError({
                reason: `cannot read ${path}: ${error.message}`,
              }),
            ),
      ),
    );
    if (text === null) return null;
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new StateFileError({ reason: `${path} is not JSON` }),
    });
    // R19: a file this listener could not have written stops it here,
    // before it connects; the reason names the field, never the text.
    const decoded = decodeSavedFile(json);
    if (decoded._tag === "Failure")
      return yield* new StateFileError({
        reason: `${path} ${describeIssue(decoded.failure)}`,
      });
    const saved: Saved = decoded.success;
    return saved;
  });
}

// Written to a temporary file and renamed, so a crash leaves the old state or
// the new one, never half of one.
function writeSaved(
  fs: FileSystem.FileSystem,
  path: string,
  saved: Saved,
): Effect.Effect<void, ShellStopped> {
  const temporary = `${path}.tmp`;
  return fs.makeDirectory(parentDirectory(path), { recursive: true }).pipe(
    Effect.andThen(
      fs.writeFileString(temporary, JSON.stringify(saved), { mode: 0o600 }),
    ),
    Effect.andThen(fs.rename(temporary, path)),
    Effect.mapError(
      (error) =>
        new ShellStopped({
          reason: `state file write failed, stopping before a delivery could repeat or be lost: ${error.message}`,
        }),
    ),
  );
}

// A Socket Mode frame, decoded once where it arrives (R20). An envelope
// carries an id Slack expects back; one whose event does not decode is still
// acknowledged, with no message, so Slack does not send it again.
export type Frame =
  | { readonly kind: "hello" }
  | { readonly kind: "disconnect"; readonly reason: string }
  | {
      readonly kind: "envelope";
      readonly envelopeId: string;
      readonly message: SlackMessage | null;
      readonly undecoded: string | null;
    }
  | { readonly kind: "other" }
  | { readonly kind: "undecoded"; readonly why: string };

const FrameHead = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  envelope_id: Schema.optionalKey(Schema.String),
});
const DisconnectFrame = Schema.Struct({ reason: Schema.String });
const EventType = Schema.Struct({
  payload: Schema.Struct({
    event: Schema.Struct({ type: Schema.optionalKey(Schema.String) }),
  }),
});
const MessageEvent = Schema.Struct({
  payload: Schema.Struct({ event: SlackMessageSchema }),
});
const decodeFrameHead = Schema.decodeUnknownResult(FrameHead);
const decodeDisconnect = Schema.decodeUnknownOption(DisconnectFrame);
const decodeEventType = Schema.decodeUnknownResult(EventType);
const decodeMessageEvent = Schema.decodeUnknownResult(MessageEvent);

// The open connection the core may ack on; ended is done once it closed, so
// an ack never waits on a socket that will not open again.
interface Live {
  readonly generation: number;
  readonly writer: Socket.Writer;
  readonly ended: Deferred.Deferred<void>;
}

const decoder = new TextDecoder();

// The state file as read (R19). Every field version 1 had from the start is
// required. R18 added the reaction fields later: a file written before them
// reads them as empty, and a queued reaction call written before the check
// mark, without a mark, as a seen one. readSaved assigns the result to Saved,
// so a field added to Saved and not here fails to compile.
const DeliverySchema = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["message", "edit"]),
  channel: Schema.String,
  ts: SlackTs,
  threadTs: SlackTs,
  isReply: Schema.Boolean,
  user: Schema.String,
  text: Schema.String,
  postedAtMs: Schema.Finite,
  editedAtMs: Schema.NullOr(Schema.Finite),
  possibleDuplicate: Schema.Boolean,
});

const ReactionSchema = Schema.Struct({
  action: Schema.Literals(["add", "remove"]),
  mark: Schema.Literals(["seen", "handled"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("seen" as const)),
  ),
  ts: SlackTs,
});

const SavedFile = Schema.Struct({
  version: Schema.Literal(1),
  caughtUpUntilMs: Schema.Finite,
  floorMs: Schema.Finite,
  claimed: Schema.Record(Schema.String, Schema.Finite),
  queue: Schema.mutable(Schema.Array(DeliverySchema)),
  inflight: Schema.NullOr(DeliverySchema),
  held: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        message: SlackMessageSchema,
        arrivedAtMs: Schema.Finite,
      }),
    ),
  ),
  reactions: Schema.mutable(Schema.Array(ReactionSchema)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  reacted: Schema.Record(Schema.String, SlackTs).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  handled: Schema.Record(Schema.String, Schema.Finite).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  answered: Schema.Record(Schema.String, SlackTs).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  marked: Schema.Record(Schema.String, Schema.Finite).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

const decodeSavedFile = Schema.decodeUnknownResult(SavedFile);

// R8: the wait before each try of a run starts at 1 second and doubles, up
// to maxBackoffMs. The core says which run a failed try belongs to and when a
// run is over; each run steps its own copy of this schedule.
export const backoffSchedule = (
  maxBackoffMs: number,
): Schedule.Schedule<Duration.Duration> =>
  Schedule.exponential(Duration.seconds(1)).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(Duration.min(duration, Duration.millis(maxBackoffMs))),
    ),
  );

// R18: a reaction call is tried three times, 1 and then 2 seconds apart.
export const reactionRetry: Schedule.Schedule<Duration.Duration> =
  Schedule.exponential(Duration.seconds(1)).pipe(Schedule.upTo({ times: 2 }));

// Slack's answers that a reaction is already as asked, or that the message is
// gone: the call is done, not failed (R18).
const reactionDone = new Set([
  "already_reacted",
  "no_reaction",
  "message_not_found",
]);

function parseJson(data: string): { readonly json: unknown } | null {
  try {
    return { json: JSON.parse(data) };
  } catch {
    return null;
  }
}

// An envelope's event: a message, or null for any other event (R20).
function envelopeOf(envelopeId: string, json: unknown): Frame {
  const event = decodeEventType(json);
  if (event._tag === "Failure")
    return {
      kind: "envelope",
      envelopeId,
      message: null,
      undecoded: describeIssue(event.failure),
    };
  if (event.success.payload.event.type !== "message")
    return { kind: "envelope", envelopeId, message: null, undecoded: null };
  const message = decodeMessageEvent(json);
  return message._tag === "Failure"
    ? {
        kind: "envelope",
        envelopeId,
        message: null,
        undecoded: describeIssue(message.failure),
      }
    : {
        kind: "envelope",
        envelopeId,
        message: message.success.payload.event,
        undecoded: null,
      };
}

export function decodeFrame(data: string): Frame {
  const parsed = parseJson(data);
  if (parsed === null) return { kind: "undecoded", why: "is not JSON" };
  const head = decodeFrameHead(parsed.json);
  if (head._tag === "Failure")
    return { kind: "undecoded", why: describeIssue(head.failure) };
  const { type, envelope_id: envelopeId } = head.success;
  if (type === "hello") return { kind: "hello" };
  // Slack closes the socket after a disconnect frame whatever its reason
  // says, so a reason that does not decode still reconnects.
  if (type === "disconnect") {
    const reason = decodeDisconnect(parsed.json);
    return {
      kind: "disconnect",
      reason: reason._tag === "Some" ? reason.value.reason : "no reason",
    };
  }
  if (envelopeId === undefined) return { kind: "other" };
  if (type !== "events_api")
    return { kind: "envelope", envelopeId, message: null, undecoded: null };
  return envelopeOf(envelopeId, parsed.json);
}

function frameText(frame: string | Uint8Array): string {
  return typeof frame === "string" ? frame : decoder.decode(frame);
}

function socketEndReason(error: Socket.SocketError): string {
  return error.reason._tag === "SocketCloseError"
    ? `socket closed (${error.reason.code})`
    : "socket closed (1006)";
}

// Names, thread parents and the workspace URL, looked up once each.
class Enrichment {
  private readonly names = new Map<string, string>();
  private readonly parents = new Map<string, Parent>();
  private teamUrl: string | null = null;
  private readonly config: ListenerConfig;
  private readonly api: SlackApi;

  constructor(config: ListenerConfig, api: SlackApi) {
    this.config = config;
    this.api = api;
  }

  rememberParent(delivery: Delivery): void {
    if (delivery.isReply || delivery.kind !== "message") return;
    this.parents.set(
      delivery.ts,
      parentFrom(this.config.core, {
        type: "message",
        user: delivery.user,
        text: delivery.text,
        ts: delivery.ts,
      }),
    );
  }

  name(user: string): Effect.Effect<string> {
    const cached = this.names.get(user);
    if (cached !== undefined) return Effect.succeed(cached);
    return this.api.userName(user).pipe(
      Effect.tap((name) => Effect.sync(() => this.names.set(user, name))),
      Effect.catch(() => Effect.succeed(user)),
    );
  }

  parent(delivery: Delivery): Effect.Effect<ParentInfo | null> {
    if (!delivery.isReply) return Effect.succeed(null);
    const cached = this.parents.get(delivery.threadTs);
    const lookup: Effect.Effect<Parent | null> =
      cached !== undefined
        ? Effect.succeed(cached)
        : this.api.parentMessage(delivery.channel, delivery.threadTs).pipe(
            Effect.map((found): Parent | null =>
              found === null ? null : parentFrom(this.config.core, found),
            ),
            Effect.tap((parent) =>
              Effect.sync(() => {
                if (parent !== null)
                  this.parents.set(delivery.threadTs, parent);
              }),
            ),
            Effect.catch(() => Effect.succeed(null)),
          );
    return lookup.pipe(
      Effect.flatMap((parent): Effect.Effect<ParentInfo | null> => {
        if (parent === null) return Effect.succeed(null);
        const name = parent.allowed
          ? this.name(parent.authorId)
          : Effect.succeed("");
        return name.pipe(
          Effect.map((authorName) => parentInfo(parent, authorName)),
        );
      }),
    );
  }

  permalink(delivery: Delivery): Effect.Effect<string | null> {
    const team =
      this.teamUrl !== null
        ? Effect.succeed(this.teamUrl)
        : this.api.teamUrl().pipe(
            Effect.tap((url) => Effect.sync(() => (this.teamUrl = url))),
            Effect.catch(() => Effect.succeed("")),
          );
    return team.pipe(
      Effect.map((url) => {
        if (url === "") return null;
        const base = `${url}archives/${delivery.channel}/p${delivery.ts.replace(".", "")}`;
        return delivery.isReply
          ? `${base}?thread_ts=${delivery.threadTs}&cid=${delivery.channel}`
          : base;
      }),
    );
  }
}

// A timer is a sleeping fiber; setting one of the same name interrupts the
// one before, so only the latest fires.
export function replaceTimer(
  timers: FiberMap.FiberMap<TimerName>,
  name: TimerName,
  delayMs: number,
  fire: Effect.Effect<void>,
): Effect.Effect<void> {
  return FiberMap.run(
    timers,
    name,
    Effect.sleep(Math.max(0, delayMs)).pipe(Effect.andThen(fire)),
  ).pipe(Effect.asVoid);
}

// Runs the listener until the session closes stdin. Fails with ShellStopped
// when it must stop; closing its scope ends every fiber and the socket.
export function runShell(
  config: ListenerConfig,
  services: ShellServices,
  saved: Saved | null,
): Effect.Effect<
  void,
  ShellStopped,
  FileSystem.FileSystem | Socket.WebSocketConstructor
> {
  const { api, sink } = services;
  const log: Log = (line) => services.log(redact(line));
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events = yield* Queue.unbounded<CoreEvent>();
      const timers = yield* FiberMap.make<TimerName>();
      const connection = yield* FiberHandle.make();
      const tasks = yield* FiberSet.make();
      const enrichment = new Enrichment(config, api);
      let state: State = initialState(config.core);
      // done calls waiting for the core's answer, by message ts (R18).
      const waiting = new Map<string, Deferred.Deferred<boolean>[]>();
      let live: Live | null = null;

      const dispatch = (event: CoreEvent): Effect.Effect<void> =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const record = (data: string): Effect.Effect<void> =>
        config.recordFile === null
          ? Effect.void
          : fs
              .writeFileString(config.recordFile, `${data}\n`, {
                flag: "a",
                mode: 0o600,
              })
              .pipe(
                Effect.catch((error) =>
                  log(`record write failed: ${error.message}`),
                ),
              );

      // One frame from Slack. Says whether Slack asked to reconnect.
      const onFrame = (
        generation: number,
        data: string,
      ): Effect.Effect<"reconnect" | "continue"> =>
        Effect.gen(function* () {
          yield* record(data);
          const frame = decodeFrame(data);
          switch (frame.kind) {
            case "undecoded":
              yield* log(`slack sent a frame that ${frame.why}`);
              return "continue";
            case "hello":
              yield* dispatch({ type: "hello", generation });
              return "continue";
            case "disconnect":
              yield* log(`slack asked to reconnect: ${frame.reason}`);
              return "reconnect";
            case "other":
              return "continue";
            case "envelope":
              if (frame.undecoded !== null)
                yield* log(
                  `slack sent envelope ${frame.envelopeId} that ${frame.undecoded}; acknowledged, not delivered`,
                );
              yield* dispatch({
                type: "envelope",
                generation,
                envelopeId: frame.envelopeId,
                message: frame.message,
              });
              return "continue";
          }
        });

      // The connection is over: no ack may wait on it.
      const endLive = (ended: Deferred.Deferred<void>): Effect.Effect<void> =>
        Effect.sync(() => {
          if (live?.ended === ended) live = null;
        }).pipe(Effect.andThen(Deferred.succeed(ended, undefined)));

      // Reads one open socket until it closes or Slack asks to reconnect.
      const listen = (
        socket: Socket.Socket,
        generation: number,
      ): Effect.Effect<string, Socket.SocketError, Scope.Scope> =>
        Effect.gen(function* () {
          const reader = yield* socket.reader;
          const writer = yield* socket.writer;
          const ended = yield* Deferred.make<void>();
          live = { generation, writer, ended };
          yield* Effect.addFinalizer(() => endLive(ended));
          yield* dispatch({ type: "connected", generation });
          for (;;) {
            const frames = yield* reader.pull;
            for (const frame of frames) {
              const outcome = yield* onFrame(generation, frameText(frame));
              if (outcome === "reconnect")
                return "socket closed (slack asked to reconnect)";
            }
          }
        });

      const connectTo = (
        generation: number,
      ): Effect.Effect<void, never, Socket.WebSocketConstructor> =>
        Effect.gen(function* () {
          const opened = yield* Effect.result(api.openConnection());
          if (opened._tag === "Failure")
            return yield* dispatch({
              type: "connect_failed",
              generation,
              reason: `${opened.failure.method}: ${opened.failure.reason}`,
            });
          if (generation !== state.generation) return;
          const socket = yield* Socket.makeWebSocket(opened.success);
          const reason = yield* Effect.scoped(listen(socket, generation)).pipe(
            Effect.catch((error) =>
              error.reason._tag === "SocketCloseError"
                ? Effect.succeed(socketEndReason(error))
                : log("slack socket error").pipe(
                    Effect.as(socketEndReason(error)),
                  ),
            ),
          );
          yield* dispatch({ type: "closed", generation, reason });
        });

      const fetchInto = (
        catchUpId: number,
        program: Effect.Effect<
          SlackMessage[],
          { reason: string; method: string }
        >,
        toEvent: (messages: SlackMessage[]) => CoreEvent,
      ): Effect.Effect<void> =>
        FiberSet.run(
          tasks,
          program.pipe(
            Effect.match({
              onFailure: (error): CoreEvent => ({
                type: "fetch_failed",
                catchUpId,
                reason: `${error.method}: ${error.reason}`,
              }),
              onSuccess: toEvent,
            }),
            Effect.flatMap(dispatch),
          ),
        ).pipe(Effect.asVoid);

      const deliver = (delivery: Delivery): Effect.Effect<void> =>
        Effect.all({
          userName: enrichment.name(delivery.user),
          parent: enrichment.parent(delivery),
          permalink: enrichment.permalink(delivery),
        }).pipe(
          Effect.flatMap(({ userName, parent, permalink }) => {
            const rendered = renderDelivery(delivery, {
              userName,
              channelName: config.channelName,
              parent,
              permalink,
            });
            return sink.notify(rendered.content, rendered.meta);
          }),
          Effect.match({
            onFailure: (error): CoreEvent => ({
              type: "deliver_failed",
              key: delivery.key,
              reason: error.reason,
            }),
            onSuccess: (): CoreEvent => ({
              type: "delivered",
              key: delivery.key,
            }),
          }),
          Effect.tap((event) =>
            event.type === "delivered"
              ? log(
                  `delivered ${delivery.kind} ${delivery.ts} from ${delivery.user}`,
                )
              : Effect.void,
          ),
          Effect.flatMap(dispatch),
        );

      // R18: one reaction call, retried on reactionRetry. Slack's answers
      // that the reaction is already as asked, or that the message is gone,
      // count as done. It runs beside the deliveries, so a failing call never
      // holds one up.
      const react = (reaction: Reaction): Effect.Effect<void> => {
        const name =
          reaction.mark === "seen" ? config.reaction : config.handledReaction;
        const call =
          reaction.action === "add"
            ? api.addReaction(config.core.channel, reaction.ts, name)
            : api.removeReaction(config.core.channel, reaction.ts, name);
        return call.pipe(
          Effect.catch((error) =>
            reactionDone.has(error.reason) ? Effect.void : Effect.fail(error),
          ),
          Effect.retry(reactionRetry),
          Effect.catch((error) =>
            log(
              `reaction ${reaction.action} ${reaction.mark} on ${reaction.ts} given up: ${error.reason}`,
            ),
          ),
          Effect.andThen(dispatch({ type: "reaction_done", reaction })),
        );
      };

      // A timer is a sleeping fiber; setting one of the same name replaces it.
      const setTimer = (name: TimerName, atMs: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* replaceTimer(
            timers,
            name,
            atMs - now,
            dispatch({ type: "timer", name }),
          );
        });

      // R8: each run of tries steps its own copy of the backoff schedule, in
      // the order the core decided the waits; a reset starts a fresh copy.
      // The wait counts from the step that decided it, as a set_timer does.
      const freshBackoff = Schedule.toStep(
        backoffSchedule(config.core.maxBackoffMs),
      );
      const backoffs: Record<Backoff, Effect.Success<typeof freshBackoff>> = {
        connection: yield* freshBackoff,
        delivery: yield* freshBackoff,
      };
      const backOff = (
        backoff: Backoff,
        timer: TimerName,
        decidedAtMs: number,
      ): Effect.Effect<void> =>
        backoffs[backoff](decidedAtMs, undefined).pipe(
          // The schedule never ends, so a Done here is a defect.
          Effect.orDie,
          Effect.flatMap(([, delay]) =>
            setTimer(timer, decidedAtMs + Duration.toMillis(delay)),
          ),
        );
      const resetBackoff = (backoff: Backoff): Effect.Effect<void> =>
        freshBackoff.pipe(
          Effect.map((fresh) => {
            backoffs[backoff] = fresh;
          }),
        );

      const ack = (generation: number, envelopeId: string) =>
        Effect.suspend(() => {
          const current = live;
          if (current === null || current.generation !== generation)
            return Effect.void;
          return Effect.raceFirst(
            current.writer
              .write(JSON.stringify({ envelope_id: envelopeId }))
              .pipe(Effect.ignore),
            Deferred.await(current.ended),
          );
        });

      const run = (
        effect: CoreEffect,
        now: number,
      ): Effect.Effect<void, ShellStopped, Socket.WebSocketConstructor> => {
        switch (effect.type) {
          case "save":
            return writeSaved(fs, config.stateFile, effect.saved);
          case "set_timer":
            return setTimer(effect.name, effect.atMs);
          case "back_off":
            return backOff(effect.backoff, effect.timer, now);
          case "reset_backoff":
            return resetBackoff(effect.backoff);
          case "log":
            return log(effect.message);
          case "ack":
            return ack(effect.generation, effect.envelopeId);
          case "connect":
            return FiberHandle.run(
              connection,
              connectTo(effect.generation),
            ).pipe(Effect.asVoid);
          case "fetch_history":
            return fetchInto(
              effect.catchUpId,
              api.history(config.core.channel, msToTs(effect.oldestMs)),
              (messages) => ({
                type: "history_loaded",
                catchUpId: effect.catchUpId,
                messages,
              }),
            );
          case "fetch_replies":
            return fetchInto(
              effect.catchUpId,
              api.replies(
                config.core.channel,
                effect.threadTs,
                msToTs(effect.oldestMs),
              ),
              (messages) => ({
                type: "replies_loaded",
                catchUpId: effect.catchUpId,
                threadTs: effect.threadTs,
                messages,
              }),
            );
          case "mark_answer": {
            const answers = waiting.get(effect.ts) ?? [];
            waiting.delete(effect.ts);
            return Effect.forEach(answers, (answer) =>
              Deferred.succeed(answer, effect.taken),
            ).pipe(Effect.asVoid);
          }
          case "react":
            return FiberSet.run(tasks, react(effect.reaction)).pipe(
              Effect.asVoid,
            );
          case "deliver":
            return Effect.sync(() =>
              enrichment.rememberParent(effect.delivery),
            ).pipe(
              Effect.andThen(FiberSet.run(tasks, deliver(effect.delivery))),
              Effect.asVoid,
            );
        }
      };

      // One event through the core, then its effects in order.
      const stepOnce = Effect.gen(function* () {
        const event = yield* Queue.take(events);
        const now = yield* Clock.currentTimeMillis;
        const result = yield* Effect.try({
          try: () => step(state, event, now),
          catch: (error) =>
            new ShellStopped({ reason: `core stopped: ${message(error)}` }),
        });
        state = result.state;
        for (const effect of result.effects) yield* run(effect, now);
      });

      // A fiber that died stops the listener loudly, as an unhandled
      // rejection did before; replacing a timer or a connection is no death.
      const crashed: Effect.Effect<never, ShellStopped> = Effect.raceFirst(
        FiberSet.join(tasks),
        Effect.raceFirst(FiberHandle.join(connection), FiberMap.join(timers)),
      ).pipe(
        Effect.andThen(Effect.never),
        Effect.catchCause((cause) =>
          Effect.fail(
            new ShellStopped({
              reason: `a fiber of the shell stopped: ${message(Cause.squash(cause))}`,
            }),
          ),
        ),
      );

      yield* dispatch({ type: "started", saved });
      // R18: each message the session marks done becomes an event, after the
      // saved state, and its call is answered by the core's mark_answer. The
      // loop only moves marks between queues, so it runs outside the task
      // set, whose join must end when a task fails.
      yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(sink.marks).pipe(
            Effect.flatMap((mark) =>
              Effect.sync(() =>
                waiting.set(mark.ts, [
                  ...(waiting.get(mark.ts) ?? []),
                  mark.answer,
                ]),
              ).pipe(
                Effect.andThen(dispatch({ type: "marked_done", ts: mark.ts })),
              ),
            ),
          ),
        ),
      );
      yield* Effect.raceFirst(
        Effect.raceFirst(Effect.forever(stepOnce), crashed),
        Deferred.await(sink.closed).pipe(
          Effect.andThen(log("stopping: the session closed stdin")),
        ),
      );
    }),
  );
}
