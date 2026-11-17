import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { senderAllowed } from "../../core.ts";
import type { SlackMessage } from "../../slack.ts";
import { simConfig } from "../simulator.ts";
import {
  authors,
  changedEvent,
  deletedEvent,
  toSlack,
  watchedChannel,
  type StoredMessage,
} from "../slack-fake.ts";
import { authorOf, fixtureKinds, kindOf, type Fixture } from "./fixture.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("fixtures.json", import.meta.url), "utf8"),
) as Fixture[];

function stored(
  fixture: Fixture,
  extra: Partial<StoredMessage>,
): StoredMessage {
  return {
    channel: watchedChannel,
    author: authors[fixture.label],
    ts: "1794900000.000010",
    threadTs: undefined,
    broadcast: false,
    text: "fake text",
    editedTs: undefined,
    deleted: false,
    noise: false,
    ...extra,
  };
}

/** The event the fake produces for the same kind and author. */
function fakeEvent(fixture: Fixture): SlackMessage {
  switch (fixture.kind) {
    case "join":
      return toSlack(stored(fixture, { noise: true }));
    case "top_level":
      return toSlack(stored(fixture, {}));
    case "thread_reply":
      return toSlack(stored(fixture, { threadTs: "1794900000.000001" }));
    case "broadcast":
      return toSlack(
        stored(fixture, { threadTs: "1794900000.000001", broadcast: true }),
      );
    case "edit": {
      const before = stored(fixture, {});
      const after = stored(fixture, {
        text: "fake text, edited",
        editedTs: "1794900000.000011",
      });
      return changedEvent(toSlack(before), toSlack(after), "1794900000.000012");
    }
    case "delete":
      return deletedEvent(toSlack(stored(fixture, {})), "1794900000.000012");
  }
}

/** Which of the core's fields are present, and the values that steer it. */
function shape(message: SlackMessage): unknown {
  return {
    type: message.type,
    subtype: message.subtype ?? null,
    channel:
      message.channel === undefined ? null : message.channel === watchedChannel,
    reply_count: message.reply_count !== undefined,
    latest_reply: message.latest_reply !== undefined,
    thread_before_ts:
      message.thread_ts === undefined
        ? null
        : Number(message.thread_ts) <= Number(message.ts),
    user: message.user !== undefined,
    bot_id: message.bot_id !== undefined,
    app_id: message.app_id !== undefined,
    text: message.text !== undefined,
    thread_ts: message.thread_ts !== undefined,
    in_thread:
      message.thread_ts !== undefined && message.thread_ts !== message.ts,
    edited: message.edited === undefined ? null : Object.keys(message.edited),
    message: message.message === undefined ? null : shape(message.message),
    previous_message:
      message.previous_message === undefined
        ? null
        : shape(message.previous_message),
  };
}

describe("conformance: the fake Slack against recorded events", () => {
  for (const fixture of fixtures) {
    it(`${fixture.kind} by ${fixture.label} (recorded ${fixture.recordedAt})`, () => {
      const fake = fakeEvent(fixture);
      expect(kindOf(fake)).toBe(fixture.kind);
      expect(shape(fake)).toEqual(shape(fixture.event));
      expect(senderAllowed(simConfig(), authorOf(fake))).toBe(
        senderAllowed(simConfig(), authorOf(fixture.event)),
      );
    });
  }
  for (const kind of fixtureKinds) {
    if (!fixtures.some((f) => f.kind === kind))
      it.todo(`${kind}: no recorded event yet`);
  }
});
