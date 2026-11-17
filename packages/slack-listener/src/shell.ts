import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { Data, Effect } from "effect";

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
import { firstLine, renderDelivery } from "./format.ts";
import type { ChannelServer } from "./mcp.ts";
import { redact, type SlackApi } from "./slack-api.ts";
import { msToTs, type SlackMessage } from "./slack.ts";

export class StateFileError extends Data.TaggedError("StateFileError")<{
  reason: string;
}> {}

export function readSaved(path: string): Saved | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StateFileError({
      reason: `cannot read ${path}: ${(error as Error).message}`,
    });
  }
  const parsed = JSON.parse(text) as Partial<Saved>;
  if (parsed.version !== 1)
    throw new StateFileError({
      reason: `${path} has version ${String(parsed.version)}, expected 1`,
    });
  return {
    version: 1,
    caughtUpUntilMs: Number(parsed.caughtUpUntilMs),
    floorMs: Number(parsed.floorMs),
    claimed: parsed.claimed ?? {},
    queue: parsed.queue ?? [],
    inflight: parsed.inflight ?? null,
    held: parsed.held ?? [],
  };
}

function writeSaved(path: string, saved: Saved): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 });
  renameSync(temporary, path);
}

interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: { event?: SlackMessage };
}

export class Shell {
  private state: State;
  private readonly timers = new Map<TimerName, ReturnType<typeof setTimeout>>();
  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private readonly names = new Map<string, string>();
  private readonly parents = new Map<string, string>();
  private teamUrl: string | null = null;
  private readonly queue: CoreEvent[] = [];
  private stepping = false;
  private readonly config: ListenerConfig;
  private readonly api: SlackApi;
  private readonly sink: ChannelServer;
  private readonly log: (line: string) => void;

  constructor(
    config: ListenerConfig,
    api: SlackApi,
    sink: ChannelServer,
    log: (line: string) => void,
  ) {
    this.config = config;
    this.api = api;
    this.sink = sink;
    this.log = (line) => log(redact(line));
    this.state = initialState(config.core);
  }

  start(saved: Saved | null): void {
    void Effect.runPromise(Effect.result(this.api.teamUrl())).then((result) => {
      if (result._tag === "Success") this.teamUrl = result.success;
      else
        this.log(
          `auth.test failed, links will be missing: ${result.failure.reason}`,
        );
    });
    this.dispatch({ type: "started", saved });
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.socket?.close();
  }

  dispatch(event: CoreEvent): void {
    this.queue.push(event);
    if (this.stepping) return;
    this.stepping = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift() as CoreEvent;
        const result = step(this.state, next, Date.now());
        this.state = result.state;
        for (const effect of result.effects) this.run(effect);
      }
    } finally {
      this.stepping = false;
    }
  }

  private run(effect: CoreEffect): void {
    switch (effect.type) {
      case "save":
        try {
          writeSaved(this.config.stateFile, effect.saved);
        } catch (error) {
          this.log(
            `state file write failed, a crash now may repeat or lose a delivery: ${(error as Error).message}`,
          );
        }
        return;
      case "set_timer": {
        const existing = this.timers.get(effect.name);
        if (existing) clearTimeout(existing);
        const delay = Math.max(0, effect.atMs - Date.now());
        this.timers.set(
          effect.name,
          setTimeout(() => {
            this.timers.delete(effect.name);
            this.dispatch({ type: "timer", name: effect.name });
          }, delay),
        );
        return;
      }
      case "log":
        this.log(effect.message);
        return;
      case "ack":
        if (
          effect.generation === this.socketGeneration &&
          this.socket?.readyState === WebSocket.OPEN
        ) {
          this.socket.send(JSON.stringify({ envelope_id: effect.envelopeId }));
        }
        return;
      case "connect":
        this.connect(effect.generation);
        return;
      case "fetch_history":
        this.fetch(
          effect.generation,
          this.api.history(this.config.core.channel, msToTs(effect.oldestMs)),
          (messages) => ({
            type: "history_loaded",
            generation: effect.generation,
            messages,
          }),
        );
        return;
      case "fetch_replies":
        this.fetch(
          effect.generation,
          this.api.replies(
            this.config.core.channel,
            effect.threadTs,
            msToTs(effect.oldestMs),
          ),
          (messages) => ({
            type: "replies_loaded",
            generation: effect.generation,
            threadTs: effect.threadTs,
            messages,
          }),
        );
        return;
      case "deliver":
        this.deliver(effect.delivery);
        return;
    }
  }

  private fetch(
    generation: number,
    program: Effect.Effect<SlackMessage[], { reason: string; method: string }>,
    toEvent: (messages: SlackMessage[]) => CoreEvent,
  ): void {
    void Effect.runPromise(
      program.pipe(
        Effect.match({
          onFailure: (error): CoreEvent => ({
            type: "fetch_failed",
            generation,
            reason: `${error.method}: ${error.reason}`,
          }),
          onSuccess: toEvent,
        }),
      ),
    ).then((event) => this.dispatch(event));
  }

  private connect(generation: number): void {
    this.socket?.close();
    this.socket = null;
    void Effect.runPromise(Effect.result(this.api.openConnection())).then(
      (result) => {
        if (result._tag === "Failure") {
          this.dispatch({
            type: "connect_failed",
            generation,
            reason: `${result.failure.method}: ${result.failure.reason}`,
          });
          return;
        }
        if (generation !== this.state.generation) return;
        const socket = new WebSocket(result.success);
        this.socket = socket;
        this.socketGeneration = generation;
        socket.addEventListener("open", () =>
          this.dispatch({ type: "connected", generation }),
        );
        socket.addEventListener("close", (event) =>
          this.dispatch({
            type: "closed",
            generation,
            reason: `socket closed (${event.code})`,
          }),
        );
        socket.addEventListener("error", () => this.log("slack socket error"));
        socket.addEventListener("message", (event) =>
          this.onFrame(generation, String(event.data)),
        );
      },
    );
  }

  private onFrame(generation: number, data: string): void {
    if (this.config.recordFile !== null) {
      try {
        appendFileSync(this.config.recordFile, `${data}\n`, { mode: 0o600 });
      } catch (error) {
        this.log(`record write failed: ${(error as Error).message}`);
      }
    }
    let frame: SocketEnvelope;
    try {
      frame = JSON.parse(data) as SocketEnvelope;
    } catch {
      this.log("slack sent a frame that is not JSON");
      return;
    }
    if (frame.type === "hello") {
      this.dispatch({ type: "hello", generation });
      return;
    }
    if (frame.type === "disconnect") {
      this.log(`slack asked to reconnect: ${frame.reason ?? "no reason"}`);
      this.socket?.close();
      return;
    }
    if (frame.envelope_id === undefined) return;
    const event =
      frame.type === "events_api" ? frame.payload?.event : undefined;
    const message =
      event !== undefined && event.type === "message" ? event : null;
    this.dispatch({
      type: "envelope",
      generation,
      envelopeId: frame.envelope_id,
      message,
    });
  }

  private enrichName(user: string): Effect.Effect<string> {
    const cached = this.names.get(user);
    if (cached !== undefined) return Effect.succeed(cached);
    return this.api.userName(user).pipe(
      Effect.tap((name) => Effect.sync(() => this.names.set(user, name))),
      Effect.catch(() => Effect.succeed(user)),
    );
  }

  private enrichParent(delivery: Delivery): Effect.Effect<string | null> {
    if (!delivery.isReply) return Effect.succeed(null);
    const cached = this.parents.get(delivery.threadTs);
    if (cached !== undefined) return Effect.succeed(cached);
    return this.api.parentText(delivery.channel, delivery.threadTs).pipe(
      Effect.map((text) => firstLine(text)),
      Effect.tap((line) =>
        Effect.sync(() => this.parents.set(delivery.threadTs, line)),
      ),
      Effect.catch(() => Effect.succeed(null)),
    );
  }

  private permalink(delivery: Delivery): string | null {
    if (this.teamUrl === null || this.teamUrl === "") return null;
    const base = `${this.teamUrl}archives/${delivery.channel}/p${delivery.ts.replace(".", "")}`;
    return delivery.isReply
      ? `${base}?thread_ts=${delivery.threadTs}&cid=${delivery.channel}`
      : base;
  }

  private deliver(delivery: Delivery): void {
    if (!delivery.isReply)
      this.parents.set(delivery.ts, firstLine(delivery.text));
    const program = Effect.all({
      userName: this.enrichName(delivery.user),
      parentLine: this.enrichParent(delivery),
    }).pipe(
      Effect.flatMap(({ userName, parentLine }) => {
        const rendered = renderDelivery(delivery, {
          userName,
          channelName: this.config.channelName,
          parentLine,
          permalink: this.permalink(delivery),
        });
        return this.sink.notify(rendered.content, rendered.meta);
      }),
    );
    void Effect.runPromise(
      program.pipe(
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
      ),
    ).then((event) => {
      if (event.type === "delivered")
        this.log(
          `delivered ${delivery.kind} ${delivery.ts} from ${delivery.user}`,
        );
      this.dispatch(event);
    });
  }
}
