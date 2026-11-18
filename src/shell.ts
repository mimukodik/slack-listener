// The shell: an Effect program that runs the core's effects against the world.
// It reaches the world only through Effect services, so production and the
// simulator run the same program and differ only in the layers they provide
// (PRINCIPLES.md: world-through-services, simulator-runs-the-program):
//
// - Clock: the core's now, and its timers as sleeping fibers;
// - Socket.WebSocketConstructor: Slack's Socket Mode connection;
// - FileSystem: the state file and the frame recording;
// - SlackApi over HttpClient, and the session's ChannelServer over Stdio.
//
// One fiber steps the core, one event at a time; everything that waits on the
// world runs in a fiber of its own and comes back as an event.
import {
  Clock,
  Data,
  Deferred,
  Effect,
  FiberHandle,
  FiberMap,
  FiberSet,
  FileSystem,
  Queue,
} from "effect";
import type { Scope } from "effect";
import { Socket } from "effect/socket";

import type { ListenerConfig } from "./config.ts";
import {
  initialState,
  step,
  type CoreEffect,
  type CoreEvent,
  type Delivery,
  type Saved,
  type State,
  type TimerName,
} from "./core.ts";
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
import { msToTs, type SlackMessage } from "./slack.ts";

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
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as Partial<Saved>,
      catch: () => new StateFileError({ reason: `${path} is not JSON` }),
    });
    if (parsed.version !== 1)
      return yield* new StateFileError({
        reason: `${path} has version ${String(parsed.version)}, expected 1`,
      });
    const saved: Saved = {
      version: 1,
      caughtUpUntilMs: Number(parsed.caughtUpUntilMs),
      floorMs: Number(parsed.floorMs),
      claimed: parsed.claimed ?? {},
      queue: parsed.queue ?? [],
      inflight: parsed.inflight ?? null,
      held: parsed.held ?? [],
    };
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

interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: { event?: SlackMessage };
}

// The open connection the core may ack on; ended is done once it closed, so
// an ack never waits on a socket that will not open again.
interface Live {
  readonly generation: number;
  readonly writer: Socket.Writer;
  readonly ended: Deferred.Deferred<void>;
}

const decoder = new TextDecoder();

function parseFrame(data: string): SocketEnvelope | null {
  try {
    return JSON.parse(data) as SocketEnvelope;
  } catch {
    return null;
  }
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
          const frame = parseFrame(data);
          if (frame === null) {
            yield* log("slack sent a frame that is not JSON");
            return "continue";
          }
          if (frame.type === "hello") {
            yield* dispatch({ type: "hello", generation });
            return "continue";
          }
          if (frame.type === "disconnect") {
            yield* log(
              `slack asked to reconnect: ${frame.reason ?? "no reason"}`,
            );
            return "reconnect";
          }
          if (frame.envelope_id === undefined) return "continue";
          const event =
            frame.type === "events_api" ? frame.payload?.event : undefined;
          yield* dispatch({
            type: "envelope",
            generation,
            envelopeId: frame.envelope_id,
            message:
              event !== undefined && event.type === "message" ? event : null,
          });
          return "continue";
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

      // A timer is a sleeping fiber; setting one of the same name replaces it.
      const setTimer = (name: TimerName, atMs: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* FiberMap.run(
            timers,
            name,
            Effect.sleep(Math.max(0, atMs - now)).pipe(
              Effect.andThen(dispatch({ type: "timer", name })),
            ),
          );
        });

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
      ): Effect.Effect<void, ShellStopped, Socket.WebSocketConstructor> => {
        switch (effect.type) {
          case "save":
            return writeSaved(fs, config.stateFile, effect.saved);
          case "set_timer":
            return setTimer(effect.name, effect.atMs);
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
        for (const effect of result.effects) yield* run(effect);
      });

      yield* dispatch({ type: "started", saved });
      yield* Effect.raceFirst(
        Effect.forever(stepOnce),
        Deferred.await(sink.closed).pipe(
          Effect.andThen(log("stopping: the session closed stdin")),
        ),
      );
    }),
  );
}
