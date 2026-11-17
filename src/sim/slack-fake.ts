import { compareTs, type SlackMessage } from "../slack.ts";

export type AuthorLabel =
  | "other_person"
  | "other_agent"
  | "other_bot"
  | "own_typed"
  | "own_agent"
  | "own_bot"
  | "stranger"
  | "stranger_bot";

export interface Author {
  label: AuthorLabel;
  user: string | undefined;
  botId?: string;
  appId?: string;
  subtype?: string;
}

export const people = {
  own: "UOWN00001",
  other: "UOTHER001",
  ownBot: "UBOTOWN01",
  otherBot: "UBOTOTH01",
  stranger: "USTRANGE1",
} as const;

export const watchedChannel = "CWATCHED1";
export const otherChannel = "COTHER001";

export const authors: Record<AuthorLabel, Author> = {
  other_person: { label: "other_person", user: people.other },
  other_agent: { label: "other_agent", user: people.other, appId: "ACLAUDE01" },
  other_bot: {
    label: "other_bot",
    user: people.otherBot,
    botId: "BOTHER001",
    appId: "AOTHER001",
  },
  own_typed: { label: "own_typed", user: people.own },
  own_agent: { label: "own_agent", user: people.own, appId: "ACLAUDE01" },
  own_bot: {
    label: "own_bot",
    user: people.ownBot,
    botId: "BOWN00001",
    appId: "AOWN00001",
  },
  stranger: { label: "stranger", user: people.stranger },
  stranger_bot: {
    label: "stranger_bot",
    user: undefined,
    botId: "BSTRANGE1",
    subtype: "bot_message",
  },
};

export function labelConfigured(label: AuthorLabel): boolean {
  return label !== "stranger" && label !== "stranger_bot";
}

export function labelAllowed(label: AuthorLabel): boolean {
  return (
    label === "other_person" ||
    label === "other_agent" ||
    label === "other_bot" ||
    label === "own_typed"
  );
}

export interface StoredMessage {
  channel: string;
  author: Author;
  ts: string;
  threadTs: string | undefined;
  broadcast: boolean;
  text: string;
  editedTs: string | undefined;
  deleted: boolean;
  noise: boolean;
  /** An edit Slack never pushed to a live connection (RULES.md, out of scope for replies). */
  editMissed?: boolean;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`fake Slack: ${message}`);
}

function channelOf(message: SlackMessage): string {
  assert(message.channel !== undefined, `message ${message.ts} has no channel`);
  return message.channel;
}

export function toSlack(stored: StoredMessage): SlackMessage {
  const message: SlackMessage = {
    type: "message",
    channel: stored.channel,
    ts: stored.ts,
    text: stored.text,
  };
  if (stored.author.user !== undefined) message.user = stored.author.user;
  if (stored.author.botId !== undefined) message.bot_id = stored.author.botId;
  if (stored.author.appId !== undefined) message.app_id = stored.author.appId;
  if (stored.author.subtype !== undefined)
    message.subtype = stored.author.subtype;
  if (stored.noise) message.subtype = "channel_join";
  if (stored.broadcast) message.subtype = "thread_broadcast";
  if (stored.threadTs !== undefined) message.thread_ts = stored.threadTs;
  if (stored.editedTs !== undefined) {
    message.edited = { ts: stored.editedTs };
    if (stored.author.user !== undefined)
      message.edited.user = stored.author.user;
  }
  return message;
}

/** The event Slack sends when a message's text changes. */
export function changedEvent(
  previous: SlackMessage,
  current: SlackMessage,
  ts: string,
): SlackMessage {
  return {
    type: "message",
    subtype: "message_changed",
    channel: channelOf(current),
    ts,
    message: current,
    previous_message: previous,
  };
}

/** The event Slack sends when a message is deleted. */
export function deletedEvent(previous: SlackMessage, ts: string): SlackMessage {
  return {
    type: "message",
    subtype: "message_deleted",
    channel: channelOf(previous),
    ts,
    previous_message: previous,
  };
}

function tombstone(stored: StoredMessage): SlackMessage {
  return {
    type: "message",
    subtype: "tombstone",
    channel: stored.channel,
    user: "USLACKBOT",
    text: "This message was deleted.",
    ts: stored.ts,
  };
}

export class SlackFake {
  readonly messages = new Map<string, StoredMessage>();
  private counter = 0;

  nextTs(nowMs: number): string {
    this.counter = (this.counter + 1) % 1000;
    const seconds = Math.floor(nowMs / 1000);
    const millis = String(nowMs % 1000).padStart(3, "0");
    return `${seconds}.${millis}${String(this.counter).padStart(3, "0")}`;
  }

  inThread(stored: StoredMessage): boolean {
    return stored.threadTs !== undefined && stored.threadTs !== stored.ts;
  }

  history(channel: string, oldestTs: string): SlackMessage[] {
    const result: SlackMessage[] = [];
    for (const stored of this.messages.values()) {
      if (stored.channel !== channel) continue;
      if (this.inThread(stored) && !stored.broadcast) continue;
      if (compareTs(stored.ts, oldestTs) < 0) continue;
      const replies = this.replyList(stored.ts);
      if (stored.deleted && replies.length === 0) continue;
      const message = stored.deleted ? tombstone(stored) : toSlack(stored);
      if (replies.length > 0) {
        message.thread_ts = stored.ts;
        message.reply_count = replies.length;
        const latest = replies.at(-1);
        assert(latest !== undefined, `thread ${stored.ts} lost its last reply`);
        message.latest_reply = latest.ts;
      }
      result.push(message);
    }
    return result.sort((a, b) => compareTs(b.ts, a.ts));
  }

  replies(channel: string, threadTs: string, oldestTs: string): SlackMessage[] {
    const parent = this.messages.get(threadTs);
    const result: SlackMessage[] = [];
    if (parent && !parent.deleted && parent.channel === channel)
      result.push(toSlack(parent));
    for (const reply of this.replyList(threadTs)) {
      if (compareTs(reply.ts, oldestTs) >= 0) result.push(toSlack(reply));
    }
    return result;
  }

  private replyList(threadTs: string): StoredMessage[] {
    return [...this.messages.values()]
      .filter((m) => m.threadTs === threadTs && m.ts !== threadTs && !m.deleted)
      .sort((a, b) => compareTs(a.ts, b.ts));
  }
}
