// Recorded Slack events as test fixtures. Only the fields the core reads are
// kept; ids are mapped to the simulator's placeholders by side, and texts are
// replaced, so a fixture carries the shape of a real event and nothing else.

import type { SlackMessage } from "../../slack.ts";
import { people, watchedChannel, type AuthorLabel } from "../slack-fake.ts";

export type FixtureKind =
  | "join"
  | "top_level"
  | "thread_reply"
  | "edit"
  | "broadcast"
  | "delete";

export const fixtureKinds: readonly FixtureKind[] = [
  "join",
  "top_level",
  "thread_reply",
  "edit",
  "broadcast",
  "delete",
];

export interface Fixture {
  kind: FixtureKind;
  label: AuthorLabel;
  recordedAt: string;
  event: SlackMessage;
}

export interface Sides {
  channel: string;
  ownPeople: string[];
  otherPeople: string[];
  ownBots: string[];
  otherBots: string[];
}

const keptKeys = [
  "type",
  "subtype",
  "channel",
  "user",
  "bot_id",
  "app_id",
  "text",
  "ts",
  "thread_ts",
  "latest_reply",
  "reply_count",
  "edited",
  "message",
  "previous_message",
] as const;

function isAgent(message: SlackMessage): boolean {
  return (
    message.bot_id !== undefined ||
    message.app_id !== undefined ||
    message.subtype === "bot_message"
  );
}

export function labelOf(sides: Sides, message: SlackMessage): AuthorLabel {
  const user = message.user;
  const agent = isAgent(message);
  if (user !== undefined && sides.ownPeople.includes(user))
    return agent ? "own_agent" : "own_typed";
  if (user !== undefined && sides.otherPeople.includes(user))
    return agent ? "other_agent" : "other_person";
  if (user !== undefined && sides.ownBots.includes(user)) return "own_bot";
  if (user !== undefined && sides.otherBots.includes(user)) return "other_bot";
  return message.bot_id !== undefined ? "stranger_bot" : "stranger";
}

export function kindOf(event: SlackMessage): FixtureKind {
  if (event.subtype === "message_changed") return "edit";
  if (event.subtype === "message_deleted") return "delete";
  if (event.subtype === "thread_broadcast") return "broadcast";
  if (event.subtype === "channel_join" || event.subtype === "channel_leave")
    return "join";
  if (event.thread_ts !== undefined && event.thread_ts !== event.ts)
    return "thread_reply";
  return "top_level";
}

const userFor: Record<AuthorLabel, string | undefined> = {
  other_person: people.other,
  other_agent: people.other,
  other_bot: people.otherBot,
  own_typed: people.own,
  own_agent: people.own,
  own_bot: people.ownBot,
  stranger: people.stranger,
  stranger_bot: undefined,
};

/** Keeps the core's fields, maps ids by side, replaces text and timestamps. */
export function anonymise(sides: Sides, event: SlackMessage): SlackMessage {
  const tsMap = new Map<string, string>();
  const ts = (value: string) => {
    if (!tsMap.has(value))
      tsMap.set(value, `1794900000.${String(tsMap.size + 1).padStart(6, "0")}`);
    return tsMap.get(value) as string;
  };
  const strip = (message: SlackMessage): SlackMessage => {
    const out: Record<string, unknown> = {};
    for (const key of keptKeys) {
      const value = message[key];
      if (value === undefined) continue;
      out[key] = value;
    }
    const label = labelOf(sides, message);
    if (message.user !== undefined) {
      const mapped = userFor[label];
      if (mapped === undefined) delete out.user;
      else out.user = mapped;
    }
    if (message.bot_id !== undefined) out.bot_id = "BRECORDED";
    if (message.app_id !== undefined) out.app_id = "ARECORDED";
    if (message.channel !== undefined)
      out.channel =
        message.channel === sides.channel ? watchedChannel : "COTHER001";
    if (message.text !== undefined) out.text = "recorded text";
    if (message.ts !== undefined) out.ts = ts(message.ts);
    if (message.thread_ts !== undefined) out.thread_ts = ts(message.thread_ts);
    if (message.latest_reply !== undefined)
      out.latest_reply = ts(message.latest_reply);
    if (message.edited !== undefined) {
      const edited: Record<string, string> = { ts: ts(message.edited.ts) };
      if (message.edited.user !== undefined) edited.user = userFor[label] ?? "";
      out.edited = edited;
    }
    if (message.message !== undefined) out.message = strip(message.message);
    if (message.previous_message !== undefined)
      out.previous_message = strip(message.previous_message);
    return out as unknown as SlackMessage;
  };
  return strip(event);
}

/** The label that matters for an event: the author of the message it is about. */
export function authorOf(event: SlackMessage): SlackMessage {
  return event.message ?? event.previous_message ?? event;
}
