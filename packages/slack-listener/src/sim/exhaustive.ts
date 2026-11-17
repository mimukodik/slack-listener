// Bounded exhaustive check: every sequence of world actions up to a length,
// over a tiny alphabet, with deterministic timing. The seeded simulator samples
// a huge space and can only say "found none"; this says "there is none up to
// this bound" for the safety rules it checks.

import {
  initialState,
  step,
  type CoreEffect,
  type CoreEvent,
  type Saved,
  type State,
} from "../core.ts";
import { msToTs } from "../slack.ts";
import type { SlackMessage } from "../slack.ts";
import {
  SafetyChecker,
  SafetyViolation,
  checkProgress,
  simConfig,
  simStartMs,
  type SessionRecord,
} from "./simulator.ts";
import {
  SlackFake,
  authors,
  toSlack,
  watchedChannel,
  type AuthorLabel,
  type StoredMessage,
} from "./slack-fake.ts";

/**
 * A: thread starter by the other side's person. B: thread starter by our own
 * agent (never delivered, R10; its replies still are). a, b: a reply in A or
 * B. e: an edit of the latest post. d: the connection drops and stays down
 * during the next action. c: the process crashes at its next delivery, before
 * it is confirmed, or at the end of this action. u: Slack sends the latest
 * envelope again.
 */
export const alphabet = ["A", "B", "a", "b", "e", "d", "c", "u"] as const;
export type Action = (typeof alphabet)[number];

interface Envelope {
  id: string;
  message: SlackMessage;
}

interface World {
  now: number;
  messages: Map<string, StoredMessage>;
  core: State | null;
  disk: Saved | null;
  timers: Map<string, number>;
  socketOpen: boolean;
  outage: boolean;
  crashArmed: boolean;
  armedAge: number;
  postedWhileDown: string[];
  recoverNext: boolean;
  crashes: number;
  envelopes: Envelope[];
  lastEnvelope: Envelope | null;
  session: SessionRecord[];
  envelopeCounter: number;
}

export interface ExhaustiveResult {
  bound: number;
  sequences: number;
  violations: { sequence: string; reason: string }[];
  coverage: {
    possibleDuplicates: number;
    deliveredAfterOutage: number;
    editsDelivered: number;
    repliesUnderOwnAgent: number;
  };
}

const actionMs = 4000;
const config = simConfig();

function fake(world: World): SlackFake {
  const slack = new SlackFake();
  for (const [ts, stored] of world.messages) slack.messages.set(ts, stored);
  return slack;
}

function newWorld(): World {
  const world: World = {
    now: simStartMs,
    messages: new Map(),
    core: null,
    disk: null,
    timers: new Map(),
    socketOpen: false,
    outage: false,
    crashArmed: false,
    armedAge: 0,
    postedWhileDown: [],
    recoverNext: false,
    crashes: 0,
    envelopes: [],
    lastEnvelope: null,
    session: [],
    envelopeCounter: 0,
  };
  start(world);
  advance(world);
  return world;
}

function start(world: World): void {
  world.core = initialState(config);
  feed(world, { type: "started", saved: world.disk });
}

function crash(world: World): void {
  world.core = null;
  world.timers.clear();
  world.socketOpen = false;
  world.crashArmed = false;
  world.armedAge = 0;
  world.crashes += 1;
  world.recoverNext = true;
}

function feed(world: World, event: CoreEvent): void {
  const pending: CoreEvent[] = [event];
  while (pending.length > 0) {
    const next = pending.shift() as CoreEvent;
    if (world.core === null) return;
    const result = step(world.core, next, world.now);
    world.core = result.state;
    for (const effect of result.effects) {
      run(world, effect, pending);
      if (world.core === null) return;
    }
  }
}

function run(world: World, effect: CoreEffect, pending: CoreEvent[]): void {
  switch (effect.type) {
    case "connect": {
      world.socketOpen = false;
      if (world.outage) return;
      world.socketOpen = true;
      pending.push({ type: "connected", generation: effect.generation });
      pending.push({ type: "hello", generation: effect.generation });
      for (const envelope of world.envelopes)
        pending.push(envelopeEvent(world, envelope));
      return;
    }
    case "ack":
      world.envelopes = world.envelopes.filter(
        (e) => e.id !== effect.envelopeId,
      );
      return;
    case "fetch_history":
      pending.push({
        type: "history_loaded",
        catchUpId: effect.catchUpId,
        messages: fake(world).history(watchedChannel, msToTs(effect.oldestMs)),
      });
      return;
    case "fetch_replies":
      pending.push({
        type: "replies_loaded",
        catchUpId: effect.catchUpId,
        threadTs: effect.threadTs,
        messages: fake(world).replies(
          watchedChannel,
          effect.threadTs,
          msToTs(effect.oldestMs),
        ),
      });
      return;
    case "deliver":
      world.session.push({
        delivery: effect.delivery,
        atMs: world.now,
        crashesBefore: world.crashes,
      });
      if (world.crashArmed) {
        crash(world);
        return;
      }
      pending.push({ type: "delivered", key: effect.delivery.key });
      return;
    case "save":
      world.disk = structuredClone(effect.saved);
      return;
    case "set_timer":
      world.timers.set(effect.name, effect.atMs);
      return;
    case "log":
      return;
  }
}

function envelopeEvent(world: World, envelope: Envelope): CoreEvent {
  return {
    type: "envelope",
    generation: world.core?.generation ?? 0,
    envelopeId: envelope.id,
    message: structuredClone(envelope.message),
  };
}

function emit(world: World, message: SlackMessage): void {
  world.envelopeCounter += 1;
  const envelope = { id: `env-${world.envelopeCounter}`, message };
  world.envelopes.push(envelope);
  world.lastEnvelope = envelope;
  if (world.socketOpen && world.core !== null)
    feed(world, envelopeEvent(world, envelope));
}

/** Let the clock run one action's worth, firing due timers in order. */
function advance(world: World): void {
  const until = world.now + actionMs;
  for (;;) {
    let name: string | null = null;
    let at = Infinity;
    for (const [n, a] of world.timers) {
      if (world.outage && n === "reconnect") continue;
      if (a <= until && a < at) {
        name = n;
        at = a;
      }
    }
    if (name === null) break;
    world.timers.delete(name);
    world.now = Math.max(world.now, at);
    feed(world, { type: "timer", name: name as never });
    if (world.core === null) break;
  }
  world.now = until;
  if (world.crashArmed) {
    if (world.armedAge >= 1) crash(world);
    else world.armedAge += 1;
  }
}

function latest(world: World, label?: AuthorLabel): StoredMessage | null {
  let found: StoredMessage | null = null;
  for (const stored of world.messages.values())
    if (label === undefined || stored.author.label === label) found = stored;
  return found;
}

function post(
  world: World,
  label: AuthorLabel,
  threadTs: string | undefined,
  text: string,
): string {
  const ts = msToTs(world.now + world.messages.size);
  const stored: StoredMessage = {
    channel: watchedChannel,
    author: authors[label],
    ts,
    threadTs,
    broadcast: false,
    text,
    editedTs: undefined,
    deleted: false,
    noise: false,
  };
  world.messages.set(ts, stored);
  if (!world.socketOpen || world.core === null) world.postedWhileDown.push(ts);
  emit(world, toSlack(stored));
  return ts;
}

/** Applies one action; false when it cannot happen in this world. */
function apply(world: World, action: Action, starters: Starters): boolean {
  const recover = world.recoverNext;
  world.recoverNext = false;
  switch (action) {
    case "A":
      if (starters.A !== null) return false;
      starters.A = post(world, "other_person", undefined, "starter A");
      break;
    case "B":
      if (starters.B !== null) return false;
      starters.B = post(world, "own_agent", undefined, "starter B");
      break;
    case "a":
      if (starters.A === null) return false;
      post(world, "other_agent", starters.A, `reply in A ${world.now}`);
      break;
    case "b":
      if (starters.B === null) return false;
      post(world, "other_person", starters.B, `reply in B ${world.now}`);
      break;
    case "e": {
      const target = latest(world);
      if (target === null) return false;
      const previous = toSlack(target);
      target.text = `${target.text} (edited ${world.now})`;
      target.editedTs = msToTs(world.now + 1);
      emit(world, {
        type: "message",
        subtype: "message_changed",
        channel: watchedChannel,
        ts: msToTs(world.now + 2),
        message: toSlack(target),
        previous_message: previous,
      });
      break;
    }
    case "d":
      if (world.core === null || world.outage) return false;
      world.outage = true;
      world.socketOpen = false;
      feed(world, {
        type: "closed",
        generation: world.core.generation,
        reason: "exhaustive",
      });
      world.recoverNext = true;
      break;
    case "c":
      if (world.core === null || world.crashArmed) return false;
      world.crashArmed = true;
      world.armedAge = 0;
      break;
    case "u":
      if (world.lastEnvelope === null || world.core === null) return false;
      if (world.socketOpen)
        feed(world, envelopeEvent(world, world.lastEnvelope));
      break;
  }
  if (recover) {
    world.outage = false;
    if (world.core === null) start(world);
    else if (!world.socketOpen) {
      const at = world.timers.get("reconnect");
      if (at !== undefined) world.timers.set("reconnect", world.now);
    }
  }
  advance(world);
  return true;
}

interface Starters {
  A: string | null;
  B: string | null;
}

function settle(world: World): void {
  world.outage = false;
  world.crashArmed = false;
  if (world.core === null) start(world);
  for (let i = 0; i < 60; i += 1) {
    const core = world.core;
    if (
      core !== null &&
      core.live &&
      core.queue.length === 0 &&
      core.inflight === null &&
      core.held.length === 0
    )
      return;
    advance(world);
  }
}

function check(world: World, sequence: string, result: ExhaustiveResult): void {
  const slack = fake(world);
  const checker = new SafetyChecker(slack, () => world.crashes);
  try {
    for (const record of world.session) checker.onDelivery(record.delivery);
  } catch (error) {
    if (!(error instanceof SafetyViolation)) throw error;
    result.violations.push({ sequence, reason: error.message });
    return;
  }
  const settled = structuredClone(world);
  try {
    settle(settled);
  } catch (error) {
    result.violations.push({
      sequence,
      reason: `core stopped while settling: ${(error as Error).message}`,
    });
    return;
  }
  const settledSlack = fake(settled);
  const after = new SafetyChecker(settledSlack, () => settled.crashes);
  try {
    for (const record of settled.session) after.onDelivery(record.delivery);
  } catch (error) {
    if (!(error instanceof SafetyViolation)) throw error;
    result.violations.push({ sequence, reason: error.message });
    return;
  }
  const progress = checkProgress(
    settledSlack,
    settled.session,
    settled.core?.floorMs ?? simStartMs,
    settled.core,
  );
  if (progress !== null) result.violations.push({ sequence, reason: progress });
  for (const record of settled.session) {
    if (record.delivery.possibleDuplicate) result.coverage.possibleDuplicates++;
    if (record.delivery.kind === "edit") result.coverage.editsDelivered++;
  }
  if (
    settled.postedWhileDown.some((ts) =>
      settled.session.some((r) => r.delivery.ts === ts),
    )
  )
    result.coverage.deliveredAfterOutage += 1;
  if (
    sequence.includes("B") &&
    sequence.includes("b") &&
    settled.session.some((r) => r.delivery.isReply)
  )
    result.coverage.repliesUnderOwnAgent += 1;
}

export function runExhaustive(bound: number): ExhaustiveResult {
  const result: ExhaustiveResult = {
    bound,
    sequences: 0,
    violations: [],
    coverage: {
      possibleDuplicates: 0,
      deliveredAfterOutage: 0,
      editsDelivered: 0,
      repliesUnderOwnAgent: 0,
    },
  };
  const visit = (world: World, starters: Starters, sequence: string) => {
    result.sequences += 1;
    check(world, sequence, result);
    if (sequence.length >= bound) return;
    for (const action of alphabet) {
      const next = structuredClone(world);
      const nextStarters = { ...starters };
      try {
        if (!apply(next, action, nextStarters)) continue;
      } catch (error) {
        result.violations.push({
          sequence: sequence + action,
          reason: `core stopped: ${(error as Error).message}`,
        });
        continue;
      }
      visit(next, nextStarters, sequence + action);
    }
  };
  visit(newWorld(), { A: null, B: null }, "");
  return result;
}

if (import.meta.main) {
  const bound = Number(process.argv[2] ?? 5);
  const startedAt = Date.now();
  const result = runExhaustive(bound);
  for (const v of result.violations.slice(0, 10))
    console.log(`violation after "${v.sequence}": ${v.reason}`);
  console.log(
    `exhaustive: every sequence up to ${bound} actions over ${alphabet.length}, ${result.sequences} sequences, ${result.violations.length} violations, ${Date.now() - startedAt} ms`,
  );
  console.log(`coverage: ${JSON.stringify(result.coverage)}`);
  if (result.violations.length > 0) process.exit(1);
}
