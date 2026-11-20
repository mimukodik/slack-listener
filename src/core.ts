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
  idleReconnectMs: number;
  queueLimit: number;
}

export const defaultLimits = {
  catchUpWindowMs: 24 * 60 * 60 * 1000,
  threadWindowMs: 7 * 24 * 60 * 60 * 1000,
  marginMs: 10 * 60 * 1000,
  maxBackoffMs: 60 * 1000,
  tickMs: 30 * 1000,
  holdMs: 3 * 1000,
  idleReconnectMs: 5 * 60 * 1000,
  queueLimit: 100_000,
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

// R18's two marks: seen while a delivered message waits for the own side,
// handled once the own side answered in its thread or marked it done.
export type ReactionMark = "seen" | "handled";

// One reaction call for R18: add or remove one of the own bot's two marks.
export interface Reaction {
  action: "add" | "remove";
  mark: ReactionMark;
  ts: string;
}

export interface Saved {
  version: 1;
  caughtUpUntilMs: number;
  floorMs: number;
  claimed: Record<string, number>;
  queue: Delivery[];
  inflight: Delivery | null;
  held: Held[];
  // R18. Files written before R18 lack these; reading one gives them empty,
  // and a queued call without a mark is a seen one.
  reactions: Reaction[];
  reacted: Record<string, string>;
  handled: Record<string, number>;
  answered: Record<string, string>;
  marked: Record<string, number>;
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
  | { type: "history_loaded"; catchUpId: number; messages: SlackMessage[] }
  | {
      type: "replies_loaded";
      catchUpId: number;
      threadTs: string;
      messages: SlackMessage[];
    }
  | { type: "fetch_failed"; catchUpId: number; reason: string }
  | { type: "delivered"; key: string }
  | { type: "deliver_failed"; key: string; reason: string }
  | { type: "reaction_done"; reaction: Reaction }
  | { type: "marked_done"; ts: string }
  | { type: "timer"; name: TimerName };

export type CoreEffect =
  | { type: "connect"; generation: number }
  | { type: "ack"; generation: number; envelopeId: string }
  | { type: "fetch_history"; catchUpId: number; oldestMs: number }
  | {
      type: "fetch_replies";
      catchUpId: number;
      threadTs: string;
      oldestMs: number;
    }
  | { type: "deliver"; delivery: Delivery }
  | { type: "react"; reaction: Reaction }
  | { type: "mark_answer"; ts: string; taken: boolean }
  | { type: "save"; saved: Saved }
  | { type: "set_timer"; name: TimerName; atMs: number }
  | { type: "log"; message: string };

export type Connection = "stopped" | "connecting" | "open" | "waiting";

export interface CatchUp {
  id: number;
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
  lastFrameMs: number;
  catchUpSeq: number;
  catchUp: CatchUp | null;
  held: Held[];
  caughtUpUntilMs: number;
  floorMs: number;
  claimed: Record<string, number>;
  queue: Delivery[];
  inflight: Delivery | null;
  sinkAttempt: number;
  // R18: reaction calls in order, the head in flight when reactionInflight;
  // reacted maps a message carrying the seen mark to its thread, handled the
  // messages given the handled mark, answered a thread to the latest
  // own-side post in it, marked the messages the session marked done.
  reactions: Reaction[];
  reactionInflight: boolean;
  reacted: Record<string, string>;
  handled: Record<string, number>;
  answered: Record<string, string>;
  marked: Record<string, number>;
  reactionsDropped: number;
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
    lastFrameMs: 0,
    catchUpSeq: 0,
    catchUp: null,
    held: [],
    caughtUpUntilMs: 0,
    floorMs: 0,
    claimed: {},
    queue: [],
    inflight: null,
    sinkAttempt: 0,
    reactions: [],
    reactionInflight: false,
    reacted: {},
    handled: {},
    answered: {},
    marked: {},
    reactionsDropped: 0,
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

// A post of the own side, typed or agent, by a person or the bot (R18).
export function ownSidePost(
  config: CoreConfig,
  message: SlackMessage,
): boolean {
  const user = message.user;
  if (user === undefined) return false;
  return config.ownPeople.includes(user) || config.ownBots.includes(user);
}

export function configuredAuthor(
  config: CoreConfig,
  message: SlackMessage,
): boolean {
  const user = message.user;
  if (user === undefined) return false;
  return [
    ...config.ownPeople,
    ...config.otherPeople,
    ...config.ownBots,
    ...config.otherBots,
  ].includes(user);
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
    reactions: state.reactions,
    reacted: state.reacted,
    handled: state.handled,
    answered: state.answered,
    marked: state.marked,
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
  if (message.channel !== config.channel) return state;

  if (message.subtype === "message_changed") {
    const edited = message.message;
    if (!edited?.edited) return state;
    const editedMessage = { ...edited, channel: config.channel };
    if (edited.text === message.previous_message?.text)
      return claimSilently(state, editedMessage);
    return considerEdit(state, editedMessage);
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
  const seen = ownSidePost(config, message)
    ? noteAnswer(state, message)
    : state;
  if (!senderAllowed(config, message)) return seen;
  return considerMessage(seen, message, source);
}

function considerMessage(
  state: State,
  message: SlackMessage,
  source: "live" | "history",
): State {
  const config = state.config;
  const messageKey = `m:${message.ts}`;
  const editKey = message.edited
    ? `e:${message.ts}:${message.edited.ts}`
    : null;
  if (state.claimed[messageKey] === undefined) {
    const keys = editKey !== null ? [messageKey, editKey] : [messageKey];
    return enqueue(
      state,
      toDelivery(config, message, "message", messageKey),
      keys,
    );
  }
  if (source === "history" && editKey !== null)
    return considerEdit(state, message);
  return state;
}

// A full queue drops the reaction, never a delivery; step logs the drop.
function queueReactions(state: State, reactions: Reaction[]): State {
  if (state.reactions.length + reactions.length > state.config.queueLimit)
    return {
      ...state,
      reactionsDropped: state.reactionsDropped + reactions.length,
    };
  return { ...state, reactions: [...state.reactions, ...reactions] };
}

// R18: a message the own side handled trades its seen mark for the handled
// one, the handled added first, so the sender never sees it without a mark.
function handle(state: State, done: string[]): State {
  if (done.length === 0) return state;
  const reacted = { ...state.reacted };
  const handled = { ...state.handled };
  for (const ts of done) {
    delete reacted[ts];
    handled[ts] = tsToMs(ts);
  }
  return queueReactions(
    { ...state, reacted, handled },
    done.flatMap((ts): Reaction[] => [
      { action: "add", mark: "handled", ts },
      { action: "remove", mark: "seen", ts },
    ]),
  );
}

// R18: an own-side post in a thread answers every message before it there.
// Seeing the same post again changes nothing.
function noteAnswer(state: State, message: SlackMessage): State {
  const threadTs = message.thread_ts ?? message.ts;
  const latest = state.answered[threadTs];
  const answered =
    latest === undefined || compareTs(message.ts, latest) > 0
      ? { ...state.answered, [threadTs]: message.ts }
      : state.answered;
  const answeredHere = Object.entries(state.reacted)
    .filter(
      ([ts, thread]) => thread === threadTs && compareTs(ts, message.ts) < 0,
    )
    .map(([ts]) => ts)
    .sort(compareTs);
  if (answered === state.answered && answeredHere.length === 0) return state;
  return handle({ ...state, answered }, answeredHere);
}

// R18: a message handed to the session gets the seen mark, or the handled
// one at once when the own side already answered after it in its thread or
// the session marked it done. An edit gets none.
function reactTo(state: State, delivery: Delivery): State {
  if (
    delivery.kind !== "message" ||
    state.reacted[delivery.ts] !== undefined ||
    state.handled[delivery.ts] !== undefined
  )
    return state;
  const answer = state.answered[delivery.threadTs];
  if (
    state.marked[delivery.ts] !== undefined ||
    (answer !== undefined && compareTs(answer, delivery.ts) > 0)
  )
    return queueReactions(
      {
        ...state,
        handled: { ...state.handled, [delivery.ts]: tsToMs(delivery.ts) },
      },
      [{ action: "add", mark: "handled", ts: delivery.ts }],
    );
  return queueReactions(
    {
      ...state,
      reacted: { ...state.reacted, [delivery.ts]: delivery.threadTs },
    },
    [{ action: "add", mark: "seen", ts: delivery.ts }],
  );
}

// R18: the session marked a message done. Only a message this listener took
// in counts; the mark is kept, so a mark made before the delivered event
// gives the message the handled mark straight away.
function markDone(state: State, ts: string, effects: CoreEffect[]): State {
  if (state.claimed[`m:${ts}`] === undefined) {
    effects.push({
      type: "log",
      message: `done for ${ts} ignored: not a message this listener took in`,
    });
    return state;
  }
  if (state.marked[ts] !== undefined) return state;
  const marked = { ...state.marked, [ts]: tsToMs(ts) };
  return handle(
    { ...state, marked },
    state.reacted[ts] === undefined ? [] : [ts],
  );
}

// One reaction call at a time, so a removal never overtakes its addition.
// The queue is saved before the call starts, so a restart repeats it; both
// calls are safe to repeat.
function pumpReactions(state: State, effects: CoreEffect[]): State {
  if (state.reactionInflight) return state;
  const [next] = state.reactions;
  if (next === undefined) return state;
  const pumped = { ...state, reactionInflight: true };
  effects.push({ type: "save", saved: snapshot(pumped) });
  effects.push({ type: "react", reaction: next });
  return pumped;
}

function claimSilently(state: State, message: SlackMessage): State {
  if (!message.edited) return state;
  const editKey = `e:${message.ts}:${message.edited.ts}`;
  if (state.claimed[editKey] !== undefined) return state;
  return {
    ...state,
    claimed: { ...state.claimed, [editKey]: tsToMs(message.edited.ts) },
  };
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
  assert(next !== undefined, "pump: a non-empty queue has no head");
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
  const id = state.catchUpSeq + 1;
  effects.push({
    type: "fetch_history",
    catchUpId: id,
    oldestMs: now - state.config.threadWindowMs,
  });
  return {
    ...state,
    catchUpSeq: id,
    catchUp: {
      id,
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

function connect(state: State, now: number, effects: CoreEffect[]): State {
  const generation = state.generation + 1;
  effects.push({ type: "connect", generation });
  return {
    ...state,
    connection: "connecting",
    generation,
    live: false,
    catchUp: null,
    lastFrameMs: now,
  };
}

function prune(state: State, now: number): State {
  const horizon =
    now - state.config.threadWindowMs - state.config.catchUpWindowMs;
  const claimed: Record<string, number> = {};
  for (const [key, at] of Object.entries(state.claimed)) {
    if (at >= horizon) claimed[key] = at;
  }
  const reacted: Record<string, string> = {};
  for (const [ts, thread] of Object.entries(state.reacted)) {
    if (tsToMs(ts) >= horizon) reacted[ts] = thread;
  }
  const handled: Record<string, number> = {};
  for (const [ts, at] of Object.entries(state.handled)) {
    if (at >= horizon) handled[ts] = at;
  }
  const answered: Record<string, string> = {};
  for (const [thread, ts] of Object.entries(state.answered)) {
    if (tsToMs(ts) >= horizon) answered[thread] = ts;
  }
  const marked: Record<string, number> = {};
  for (const [ts, at] of Object.entries(state.marked)) {
    if (at >= horizon) marked[ts] = at;
  }
  return { ...state, claimed, reacted, handled, answered, marked };
}

export function step(state: State, event: CoreEvent, now: number): StepResult {
  const effects: CoreEffect[] = [];
  const next = pumpReactions(reduce(state, event, now, effects), effects);
  if (next.reactionsDropped > state.reactionsDropped)
    effects.push({
      type: "log",
      message: `reaction queue full, ${next.reactionsDropped - state.reactionsDropped} reaction calls dropped`,
    });
  assert(next.queue.length <= next.config.queueLimit, "queue over limit");
  assert(
    next.reactions.length <= next.config.queueLimit,
    "reaction queue over limit",
  );
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
            reactions: [...saved.reactions],
            reacted: { ...saved.reacted },
            handled: { ...saved.handled },
            answered: { ...saved.answered },
            marked: { ...saved.marked },
          }
        : { ...state, caughtUpUntilMs: now, floorMs: now };
      next = connect(next, now, effects);
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
      const alive = { ...state, lastFrameMs: now };
      if (state.live || state.catchUp !== null) return alive;
      return startCatchUp(alive, now, effects);
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
        return { ...state, lastFrameMs: now };
      }
      const next = {
        ...state,
        lastFrameMs: now,
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
      if (catchUp === null || event.catchUpId !== catchUp.id) return state;
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
            catchUpId: catchUp.id,
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
      if (catchUp === null || event.catchUpId !== catchUp.id) return state;
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
      if (catchUp === null || event.catchUpId !== catchUp.id) return state;
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
      const next = reactTo(
        { ...state, inflight: null, sinkAttempt: 0 },
        state.inflight,
      );
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
    case "reaction_done": {
      const [head, ...rest] = state.reactions;
      if (
        !state.reactionInflight ||
        head?.action !== event.reaction.action ||
        head.mark !== event.reaction.mark ||
        head.ts !== event.reaction.ts
      )
        return state;
      return { ...state, reactions: rest, reactionInflight: false };
    }
    case "marked_done": {
      // A mark exists nowhere else, so it is saved before the session hears
      // it was taken; an answer can be read again from Slack by catch-up, a
      // mark cannot.
      const next = markDone(state, event.ts, effects);
      if (next.marked !== state.marked)
        effects.push({ type: "save", saved: snapshot(next) });
      effects.push({
        type: "mark_answer",
        ts: event.ts,
        taken: next.marked[event.ts] !== undefined,
      });
      return next;
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
      return connect(state, now, effects);
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
      const connected =
        state.connection === "connecting" || state.connection === "open";
      if (connected && now - state.lastFrameMs > state.config.idleReconnectMs) {
        effects.push({
          type: "log",
          message: `no frame from slack for ${Math.round((now - state.lastFrameMs) / 1000)} s, reconnecting`,
        });
        return connect(state, now, effects);
      }
      if (!state.live) return state;
      const next = prune(
        {
          ...state,
          caughtUpUntilMs: Math.max(state.caughtUpUntilMs, state.lastFrameMs),
        },
        now,
      );
      effects.push({ type: "save", saved: snapshot(next) });
      return next;
    }
  }
}
