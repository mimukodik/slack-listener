import { compareTs, msToTs, tsToMs, type SlackMessage } from "./slack.ts";

export interface CoreConfig {
  channel: string;
  ownPeople: readonly string[];
  otherPeople: readonly string[];
  ownBots: readonly string[];
  otherBots: readonly string[];
  catchUpWindowMs: number;
  threadWindowMs: number;
  marginMs: number;
  maxBackoffMs: number;
  tickMs: number;
  holdMs: number;
  queueLimit: number;
}

export const defaultLimits = {
  catchUpWindowMs: 24 * 60 * 60 * 1000,
  threadWindowMs: 7 * 24 * 60 * 60 * 1000,
  marginMs: 10 * 60 * 1000,
  maxBackoffMs: 60 * 1000,
  tickMs: 30 * 1000,
  holdMs: 3 * 1000,
  queueLimit: 1000,
} as const;

export interface Delivery {
  key: string;
  kind: "message" | "edit";
  channel: string;
  ts: string;
  threadTs: string;
  isReply: boolean;
  user: string;
  text: string;
  postedAtMs: number;
  editedAtMs: number | null;
  possibleDuplicate: boolean;
}

export interface Saved {
  version: 1;
  caughtUpUntilMs: number;
  floorMs: number;
  claimed: Record<string, number>;
  queue: Delivery[];
  inflight: Delivery | null;
  held: Held[];
}

export type TimerName = "reconnect" | "sink" | "tick" | "catch_up" | "release";

export type CoreEvent =
  | { type: "started"; saved: Saved | null }
  | { type: "connected"; generation: number }
  | { type: "connect_failed"; generation: number; reason: string }
  | { type: "hello"; generation: number }
  | { type: "closed"; generation: number; reason: string }
  | {
      type: "envelope";
      generation: number;
      envelopeId: string;
      message: SlackMessage | null;
    }
  | { type: "history_loaded"; generation: number; messages: SlackMessage[] }
  | {
      type: "replies_loaded";
      generation: number;
      threadTs: string;
      messages: SlackMessage[];
    }
  | { type: "fetch_failed"; generation: number; reason: string }
  | { type: "delivered"; key: string }
  | { type: "deliver_failed"; key: string; reason: string }
  | { type: "timer"; name: TimerName };

export type CoreEffect =
  | { type: "connect"; generation: number }
  | { type: "ack"; generation: number; envelopeId: string }
  | { type: "fetch_history"; generation: number; oldestMs: number }
  | {
      type: "fetch_replies";
      generation: number;
      threadTs: string;
      oldestMs: number;
    }
  | { type: "deliver"; delivery: Delivery }
  | { type: "save"; saved: Saved }
  | { type: "set_timer"; name: TimerName; atMs: number }
  | { type: "log"; message: string };

export type Connection = "stopped" | "connecting" | "open" | "waiting";

export interface CatchUp {
  generation: number;
  startedAtMs: number;
  pending: number;
  items: SlackMessage[];
}

export interface Held {
  message: SlackMessage;
  arrivedAtMs: number;
}

export interface State {
  config: CoreConfig;
  connection: Connection;
  generation: number;
  attempt: number;
  live: boolean;
  liveFromTs: string | null;
  catchUp: CatchUp | null;
  held: Held[];
  caughtUpUntilMs: number;
  floorMs: number;
  claimed: Record<string, number>;
  queue: Delivery[];
  inflight: Delivery | null;
  sinkAttempt: number;
}

export interface StepResult {
  state: State;
  effects: CoreEffect[];
}

export class InvariantError extends Error {
  override name = "InvariantError";
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}

export function initialState(config: CoreConfig): State {
  return {
    config,
    connection: "stopped",
    generation: 0,
    attempt: 0,
    live: false,
    liveFromTs: null,
    catchUp: null,
    held: [],
    caughtUpUntilMs: 0,
    floorMs: 0,
    claimed: {},
    queue: [],
    inflight: null,
    sinkAttempt: 0,
  };
}

export function backoffMs(config: CoreConfig, attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 16), config.maxBackoffMs);
}

export function isAgentPost(message: SlackMessage): boolean {
  return (
    message.bot_id !== undefined ||
    message.app_id !== undefined ||
    message.subtype === "bot_message"
  );
}

export function senderAllowed(
  config: CoreConfig,
  message: SlackMessage,
): boolean {
  const user = message.user;
  if (user === undefined) return false;
  if (config.otherPeople.includes(user) || config.otherBots.includes(user))
    return true;
  if (config.ownPeople.includes(user)) return !isAgentPost(message);
  return false;
}

const deliverableSubtypes = new Set<string | undefined>([
  undefined,
  "thread_broadcast",
  "file_share",
  "bot_message",
]);

function snapshot(state: State): Saved {
  return {
    version: 1,
    caughtUpUntilMs: state.caughtUpUntilMs,
    floorMs: state.floorMs,
    claimed: state.claimed,
    queue: state.queue,
    inflight: state.inflight,
    held: state.held,
  };
}

function toDelivery(
  config: CoreConfig,
  message: SlackMessage,
  kind: Delivery["kind"],
  key: string,
): Delivery {
  const threadTs = message.thread_ts ?? message.ts;
  return {
    key,
    kind,
    channel: config.channel,
    ts: message.ts,
    threadTs,
    isReply: threadTs !== message.ts,
    user: message.user ?? "",
    text: message.text ?? "",
    postedAtMs: tsToMs(message.ts),
    editedAtMs:
      kind === "edit" && message.edited ? tsToMs(message.edited.ts) : null,
    possibleDuplicate: false,
  };
}

function enqueue(state: State, delivery: Delivery, claimKeys: string[]): State {
  assert(
    state.queue.length < state.config.queueLimit,
    "delivery queue is full",
  );
  const claimed = { ...state.claimed };
  for (const key of claimKeys)
    claimed[key] = delivery.editedAtMs ?? delivery.postedAtMs;
  return { ...state, claimed, queue: [...state.queue, delivery] };
}

function consider(
  state: State,
  message: SlackMessage,
  source: "live" | "history",
): State {
  const config = state.config;
  if (message.channel !== undefined && message.channel !== config.channel)
    return state;

  if (message.subtype === "message_changed") {
    const edited = message.message;
    if (!edited?.edited) return state;
    if (edited.text === message.previous_message?.text) return state;
    return considerEdit(state, { ...edited, channel: config.channel });
  }
  if (!deliverableSubtypes.has(message.subtype)) return state;
  if (
    source === "live" &&
    state.liveFromTs !== null &&
    compareTs(message.ts, state.liveFromTs) < 0
  ) {
    return state;
  }
  if (tsToMs(message.ts) < state.floorMs) {
    return source === "history" && message.edited
      ? considerEdit(state, message)
      : state;
  }
  if (!senderAllowed(config, message)) return state;

  const messageKey = `m:${message.ts}`;
  const editKey = message.edited
    ? `e:${message.ts}:${message.edited.ts}`
    : null;
  if (state.claimed[messageKey] === undefined) {
    const keys = editKey ? [messageKey, editKey] : [messageKey];
    return enqueue(
      state,
      toDelivery(config, message, "message", messageKey),
      keys,
    );
  }
  if (source === "history" && editKey) return considerEdit(state, message);
  return state;
}

function considerEdit(state: State, message: SlackMessage): State {
  if (!message.edited) return state;
  if (tsToMs(message.edited.ts) < state.floorMs) return state;
  if (!senderAllowed(state.config, message)) return state;
  const editTs = message.edited.ts;
  const prefix = `e:${message.ts}:`;
  const superseded = Object.keys(state.claimed).some(
    (key) =>
      key.startsWith(prefix) &&
      compareTs(key.slice(prefix.length), editTs) >= 0,
  );
  if (superseded) return state;
  const editKey = `${prefix}${editTs}`;
  return enqueue(state, toDelivery(state.config, message, "edit", editKey), [
    editKey,
  ]);
}

function pump(state: State, effects: CoreEffect[]): State {
  if (state.inflight !== null || state.queue.length === 0) return state;
  const [next, ...rest] = state.queue;
  const pumped = { ...state, inflight: next, queue: rest };
  effects.push({ type: "save", saved: snapshot(pumped) });
  effects.push({ type: "deliver", delivery: next });
  return pumped;
}

function scheduleReconnect(
  state: State,
  now: number,
  effects: CoreEffect[],
): State {
  effects.push({
    type: "set_timer",
    name: "reconnect",
    atMs: now + backoffMs(state.config, state.attempt),
  });
  return {
    ...state,
    connection: "waiting",
    live: false,
    catchUp: null,
    attempt: state.attempt + 1,
  };
}

function startCatchUp(state: State, now: number, effects: CoreEffect[]): State {
  effects.push({
    type: "fetch_history",
    generation: state.generation,
    oldestMs: now - state.config.threadWindowMs,
  });
  return {
    ...state,
    catchUp: {
      generation: state.generation,
      startedAtMs: now,
      pending: 1,
      items: [],
    },
  };
}

function catchUpLowerBound(state: State, now: number): number {
  return Math.max(
    state.caughtUpUntilMs - state.config.marginMs,
    now - state.config.catchUpWindowMs,
    state.floorMs,
  );
}

function inWindow(message: SlackMessage, lowerBound: number): boolean {
  if (tsToMs(message.ts) >= lowerBound) return true;
  return (
    message.edited !== undefined && tsToMs(message.edited.ts) >= lowerBound
  );
}

function release(
  state: State,
  now: number,
  history: SlackMessage[],
  effects: CoreEffect[],
): State {
  const due = state.held.filter(
    (h) => h.arrivedAtMs + state.config.holdMs <= now,
  );
  const latestDue = due.reduce<string | null>(
    (latest, h) =>
      latest === null || compareTs(h.message.ts, latest) > 0
        ? h.message.ts
        : latest,
    null,
  );
  const isReady = (h: Held) =>
    latestDue !== null && compareTs(h.message.ts, latestDue) <= 0;
  const ready = state.held.filter(isReady);
  const waiting = state.held.filter((h) => !isReady(h));
  const batch: Array<{ message: SlackMessage; source: "live" | "history" }> = [
    ...history.map((message) => ({ message, source: "history" as const })),
    ...ready.map((h) => ({ message: h.message, source: "live" as const })),
  ].sort((a, b) => compareTs(a.message.ts, b.message.ts));
  let next: State = { ...state, held: waiting };
  for (const item of batch) next = consider(next, item.message, item.source);
  if (waiting.length > 0) {
    const earliest = Math.min(...waiting.map((h) => h.arrivedAtMs));
    effects.push({
      type: "set_timer",
      name: "release",
      atMs: earliest + state.config.holdMs,
    });
  }
  return next;
}

function finishCatchUp(
  state: State,
  now: number,
  effects: CoreEffect[],
): State {
  const catchUp = state.catchUp;
  if (catchUp === null || catchUp.pending > 0) return state;
  let next: State = {
    ...state,
    catchUp: null,
    live: true,
    attempt: 0,
    liveFromTs: msToTs(catchUp.startedAtMs),
  };
  next = release(next, now, catchUp.items, effects);
  next = {
    ...next,
    caughtUpUntilMs: Math.max(next.caughtUpUntilMs, catchUp.startedAtMs),
  };
  effects.push({ type: "save", saved: snapshot(next) });
  return pump(next, effects);
}

function prune(state: State, now: number): State {
  const horizon =
    now - state.config.threadWindowMs - state.config.catchUpWindowMs;
  const claimed: Record<string, number> = {};
  for (const [key, at] of Object.entries(state.claimed)) {
    if (at >= horizon) claimed[key] = at;
  }
  return { ...state, claimed };
}

export function step(state: State, event: CoreEvent, now: number): StepResult {
  const effects: CoreEffect[] = [];
  const next = reduce(state, event, now, effects);
  assert(next.queue.length <= next.config.queueLimit, "queue over limit");
  assert(next.generation >= state.generation, "generation went back");
  assert(
    next.inflight === null ||
      next.queue.every((d) => d.key !== next.inflight?.key),
    "inflight delivery also queued",
  );
  return { state: next, effects };
}

function reduce(
  state: State,
  event: CoreEvent,
  now: number,
  effects: CoreEffect[],
): State {
  switch (event.type) {
    case "started": {
      assert(state.connection === "stopped", "started twice");
      const saved = event.saved;
      let next: State = saved
        ? {
            ...state,
            caughtUpUntilMs: saved.caughtUpUntilMs,
            floorMs: saved.floorMs,
            claimed: { ...saved.claimed },
            queue: saved.inflight
              ? [{ ...saved.inflight, possibleDuplicate: true }, ...saved.queue]
              : [...saved.queue],
            held: [...saved.held],
          }
        : { ...state, caughtUpUntilMs: now, floorMs: now };
      next = {
        ...next,
        connection: "connecting",
        generation: state.generation + 1,
      };
      effects.push({ type: "connect", generation: next.generation });
      effects.push({
        type: "set_timer",
        name: "tick",
        atMs: now + state.config.tickMs,
      });
      effects.push({ type: "save", saved: snapshot(next) });
      return pump(next, effects);
    }
    case "connected": {
      if (
        event.generation !== state.generation ||
        state.connection !== "connecting"
      )
        return state;
      return { ...state, connection: "open" };
    }
    case "connect_failed":
    case "closed": {
      if (event.generation !== state.generation) return state;
      if (state.connection !== "connecting" && state.connection !== "open")
        return state;
      effects.push({
        type: "log",
        message: `slack connection ${event.type}: ${event.reason}`,
      });
      return scheduleReconnect(state, now, effects);
    }
    case "hello": {
      if (event.generation !== state.generation || state.connection !== "open")
        return state;
      if (state.live || state.catchUp !== null) return state;
      return startCatchUp(state, now, effects);
    }
    case "envelope": {
      if (event.generation !== state.generation || state.connection !== "open")
        return state;
      if (event.message === null) {
        effects.push({
          type: "ack",
          generation: event.generation,
          envelopeId: event.envelopeId,
        });
        return state;
      }
      const next = {
        ...state,
        held: [...state.held, { message: event.message, arrivedAtMs: now }],
      };
      effects.push({ type: "save", saved: snapshot(next) });
      effects.push({
        type: "ack",
        generation: event.generation,
        envelopeId: event.envelopeId,
      });
      if (state.live && state.held.length === 0) {
        effects.push({
          type: "set_timer",
          name: "release",
          atMs: now + state.config.holdMs,
        });
      }
      return next;
    }
    case "history_loaded": {
      const catchUp = state.catchUp;
      if (catchUp === null || event.generation !== catchUp.generation)
        return state;
      const lowerBound = catchUpLowerBound(state, now);
      const items = [...catchUp.items];
      let pending = catchUp.pending - 1;
      for (const message of event.messages) {
        const withChannel = { ...message, channel: state.config.channel };
        if (inWindow(withChannel, lowerBound)) items.push(withChannel);
        const latest = message.latest_reply;
        if (
          latest !== undefined &&
          (message.reply_count ?? 0) > 0 &&
          tsToMs(latest) >= lowerBound
        ) {
          effects.push({
            type: "fetch_replies",
            generation: catchUp.generation,
            threadTs: message.ts,
            oldestMs: lowerBound,
          });
          pending += 1;
        }
      }
      return finishCatchUp(
        { ...state, catchUp: { ...catchUp, items, pending } },
        now,
        effects,
      );
    }
    case "replies_loaded": {
      const catchUp = state.catchUp;
      if (catchUp === null || event.generation !== catchUp.generation)
        return state;
      const lowerBound = catchUpLowerBound(state, now);
      const items = [...catchUp.items];
      for (const message of event.messages) {
        if (message.ts === event.threadTs) continue;
        const withChannel = { ...message, channel: state.config.channel };
        if (inWindow(withChannel, lowerBound)) items.push(withChannel);
      }
      const pending = catchUp.pending - 1;
      return finishCatchUp(
        { ...state, catchUp: { ...catchUp, items, pending } },
        now,
        effects,
      );
    }
    case "fetch_failed": {
      const catchUp = state.catchUp;
      if (catchUp === null || event.generation !== catchUp.generation)
        return state;
      effects.push({
        type: "log",
        message: `catch-up failed: ${event.reason}`,
      });
      effects.push({
        type: "set_timer",
        name: "catch_up",
        atMs: now + backoffMs(state.config, state.attempt),
      });
      return { ...state, catchUp: null, attempt: state.attempt + 1 };
    }
    case "delivered": {
      if (state.inflight?.key !== event.key) return state;
      const next = { ...state, inflight: null, sinkAttempt: 0 };
      effects.push({ type: "save", saved: snapshot(next) });
      return pump(next, effects);
    }
    case "deliver_failed": {
      if (state.inflight?.key !== event.key) return state;
      effects.push({
        type: "log",
        message: `delivery failed: ${event.reason}`,
      });
      effects.push({
        type: "set_timer",
        name: "sink",
        atMs: now + backoffMs(state.config, state.sinkAttempt),
      });
      return { ...state, sinkAttempt: state.sinkAttempt + 1 };
    }
    case "timer":
      return onTimer(state, event.name, now, effects);
  }
}

function onTimer(
  state: State,
  name: TimerName,
  now: number,
  effects: CoreEffect[],
): State {
  switch (name) {
    case "reconnect": {
      if (state.connection !== "waiting") return state;
      const generation = state.generation + 1;
      effects.push({ type: "connect", generation });
      return { ...state, connection: "connecting", generation };
    }
    case "catch_up": {
      if (state.connection !== "open" || state.live || state.catchUp !== null)
        return state;
      return startCatchUp(state, now, effects);
    }
    case "release": {
      if (!state.live) return state;
      return pump(release(state, now, [], effects), effects);
    }
    case "sink": {
      if (state.inflight === null) return state;
      effects.push({ type: "deliver", delivery: state.inflight });
      return state;
    }
    case "tick": {
      effects.push({
        type: "set_timer",
        name: "tick",
        atMs: now + state.config.tickMs,
      });
      if (!state.live) return state;
      const next = prune(
        { ...state, caughtUpUntilMs: Math.max(state.caughtUpUntilMs, now) },
        now,
      );
      effects.push({ type: "save", saved: snapshot(next) });
      return next;
    }
  }
}
