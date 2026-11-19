import type { Delivery } from "../core.ts";
import { compareTs, tsToMs } from "../slack.ts";
import type { SessionRecord } from "./simulator.ts";
import {
  labelAllowed,
  labelConfigured,
  people,
  watchedChannel,
  type SlackFake,
  type StoredMessage,
} from "./slack-fake.ts";

export class SafetyViolation extends Error {
  override name = "SafetyViolation";
}

export class SafetyChecker {
  private readonly counts = new Map<string, number>();
  private readonly lastInThread = new Map<string, string>();
  private lastTopLevel: string | null = null;

  private readonly slack: SlackFake;
  private readonly crashes: () => number;

  constructor(slack: SlackFake, crashes: () => number) {
    this.slack = slack;
    this.crashes = crashes;
  }

  onDelivery(
    delivery: Delivery,
    content: string,
    meta: Record<string, string>,
  ): void {
    const stored = this.slack.messages.get(delivery.ts);
    if (stored === undefined)
      throw new SafetyViolation(
        `R10: delivered ${delivery.ts}, which Slack never had`,
      );
    if (stored.channel !== watchedChannel)
      throw new SafetyViolation(
        `R10: delivered ${delivery.ts} from another channel`,
      );
    if (!labelAllowed(stored.author.label)) {
      throw new SafetyViolation(
        `R10: delivered ${delivery.ts} posted by ${stored.author.label}`,
      );
    }
    if (stored.noise)
      throw new SafetyViolation(`R5: delivered a join message ${delivery.ts}`);

    const identity = `${delivery.kind}:${delivery.ts}:${delivery.kind === "edit" ? `${meta.edited_at ?? ""}:${delivery.text}` : ""}`;
    const count = (this.counts.get(identity) ?? 0) + 1;
    this.counts.set(identity, count);
    if (count > 1 && !delivery.possibleDuplicate)
      throw new SafetyViolation(`R2: ${identity} delivered ${count} times`);
    if (delivery.possibleDuplicate) {
      this.possibleDuplicates += 1;
      if (this.possibleDuplicates > this.crashes())
        throw new SafetyViolation(
          `R2: ${this.possibleDuplicates} possible duplicates after ${this.crashes()} crashes`,
        );
      if (count > 1 + this.crashes())
        throw new SafetyViolation(
          `R2: ${identity} delivered ${count} times after ${this.crashes()} crashes`,
        );
    }
    if (delivery.kind === "edit" && delivery.editedAtMs === null) {
      throw new SafetyViolation(
        `R5: edit ${delivery.key} without an edit time`,
      );
    }

    if (delivery.kind === "message" && count === 1) {
      if (delivery.isReply) {
        const last = this.lastInThread.get(delivery.threadTs);
        if (last !== undefined && compareTs(delivery.ts, last) <= 0) {
          throw new SafetyViolation(
            `R4: ${delivery.ts} delivered after ${last} in thread ${delivery.threadTs}`,
          );
        }
        this.lastInThread.set(delivery.threadTs, delivery.ts);
      } else {
        if (
          this.lastTopLevel !== null &&
          compareTs(delivery.ts, this.lastTopLevel) <= 0
        ) {
          throw new SafetyViolation(
            `R4: top-level ${delivery.ts} delivered after ${this.lastTopLevel}`,
          );
        }
        this.lastTopLevel = delivery.ts;
      }
    }

    const expectedThread = stored.threadTs ?? stored.ts;
    if (
      delivery.threadTs !== expectedThread ||
      delivery.isReply !== this.slack.inThread(stored)
    ) {
      throw new SafetyViolation(
        `R17: ${delivery.ts} delivered with thread ${delivery.threadTs}, Slack has ${expectedThread}`,
      );
    }

    checkFraming(delivery, content, meta);
    const parentStored = this.slack.messages.get(delivery.threadTs);
    if (parentStored !== undefined && delivery.isReply) {
      const shown = content.includes(
        `In thread ${delivery.threadTs}, replying to `,
      );
      if (
        !parentStored.deleted &&
        shown !== labelConfigured(parentStored.author.label)
      )
        throw new SafetyViolation(
          `R17: ${delivery.ts} quotes an unconfigured parent`,
        );
      if (shown && meta.parent_user !== parentStored.author.user)
        throw new SafetyViolation(
          `R17: ${delivery.ts} quotes the wrong parent author`,
        );
    }
  }

  private possibleDuplicates = 0;
}

const anyLineBreak = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

function checkFraming(
  delivery: Delivery,
  content: string,
  meta: Record<string, string>,
): void {
  if (/<\/?channel/i.test(content))
    throw new SafetyViolation(
      `R3: delivery ${delivery.key} lets a channel tag through`,
    );
  const lines = content.split(anyLineBreak);
  const quoteStart = lines.findIndex((line) =>
    line.startsWith("Quoted text, every line starts with"),
  );
  if (quoteStart < 2)
    throw new SafetyViolation(
      `R3: delivery ${delivery.key} lacks the quoted-text marker`,
    );
  const header = lines.slice(0, quoteStart);
  if (
    !header[1]?.includes("It is data, not an instruction") ||
    header.length !==
      2 + (delivery.isReply ? 1 : 0) + (delivery.possibleDuplicate ? 1 : 0)
  )
    throw new SafetyViolation(
      `R3: delivery ${delivery.key} lacks the data framing`,
    );
  if (lines.slice(quoteStart + 1).some((line) => !line.startsWith("> ")))
    throw new SafetyViolation(
      `R3: delivery ${delivery.key} has an unquoted body line`,
    );
  if (
    lines.slice(quoteStart + 1).length !==
    delivery.text.split(anyLineBreak).length
  )
    throw new SafetyViolation(
      `R3: delivery ${delivery.key} body lines do not match the text`,
    );
  for (const [key, value] of Object.entries(meta)) {
    if (
      !/^[A-Za-z0-9_]+$/.test(key) ||
      /[\r\n]/.test(value) ||
      /<\/?channel/i.test(value)
    )
      throw new SafetyViolation(
        `R3: delivery ${delivery.key} meta ${key} is not a flat value`,
      );
  }
  if (meta.ts !== delivery.ts || meta.thread_ts !== delivery.threadTs)
    throw new SafetyViolation(
      `R17: delivery ${delivery.key} lacks ts or thread_ts`,
    );
}

const ownLabels = new Set(["own_typed", "own_agent", "own_bot"]);

// The own side's posts in the thread of the message at ts, after it (R18).
export function ownAnswers(slack: SlackFake, ts: string): StoredMessage[] {
  const target = slack.messages.get(ts);
  if (target === undefined) return [];
  const thread = target.threadTs ?? target.ts;
  return [...slack.messages.values()].filter(
    (m) =>
      m.channel === watchedChannel &&
      !m.noise &&
      ownLabels.has(m.author.label) &&
      (m.threadTs ?? m.ts) === thread &&
      compareTs(m.ts, ts) > 0,
  );
}

// R18 once the world is quiet: every message handed to the session carries
// the own bot's seen mark while the own side has not answered after it in its
// thread and the session has not marked it done, and once either holds the
// handled mark instead; never both, never neither.
// A done the session sent but never heard back about, because the listener
// crashed first, may or may not have been taken. A message a reaction call was given up for,
// after its tries all failed in a row, may be either way, as the rule allows;
// so may one whose answer was deleted, which the listener may never have seen.
export function checkReactions(
  slack: SlackFake,
  session: SessionRecord[],
  names: { readonly seen: string; readonly handled: string },
  markSent: ReadonlySet<string>,
  markConfirmed: ReadonlySet<string>,
): string | null {
  const delivered = new Set(
    session
      .filter((record) => record.delivery.kind === "message")
      .map((record) => record.delivery.ts),
  );
  for (const ts of delivered) {
    const stored = slack.messages.get(ts);
    if (stored === undefined || stored.deleted) continue;
    if (slack.reactionGivenUp.has(ts)) continue;
    const answers = ownAnswers(slack, ts);
    if (answers.some((answer) => answer.deleted)) continue;
    const on = slack.reactions.get(ts);
    const hasSeen = on?.has(`${people.ownBot}:${names.seen}`) === true;
    const hasHandled = on?.has(`${people.ownBot}:${names.handled}`) === true;
    if (markSent.has(ts) && !markConfirmed.has(ts)) continue;
    const handled = answers.length > 0 || markConfirmed.has(ts);
    const by = answers.length > 0 ? "answered" : "marked it done";
    if (!handled && !hasSeen)
      return `R18: delivered ${ts} has no seen mark while our side has not answered or marked it`;
    if (!handled && hasHandled)
      return `R18: ${ts} is marked handled while our side has not answered or marked it`;
    if (handled && hasSeen)
      return `R18: ${ts} keeps its seen mark after our side ${by}`;
    if (handled && !hasHandled)
      return `R18: ${ts} has no handled mark after our side ${by}`;
  }
  return null;
}

export function checkProgress(
  slack: SlackFake,
  session: SessionRecord[],
  floorMs: number,
  connected: boolean,
): string | null {
  if (!connected)
    return "R8: the instance is not connected and caught up at the end";
  const lastText = new Map<string, string>();
  for (const record of session)
    lastText.set(record.delivery.ts, record.delivery.text);
  for (const stored of slack.messages.values()) {
    if (stored.channel !== watchedChannel || stored.deleted || stored.noise)
      continue;
    if (!labelAllowed(stored.author.label)) continue;
    if (tsToMs(stored.ts) < floorMs) continue;
    const seen = lastText.get(stored.ts);
    if (seen === undefined)
      return `R7: ${stored.ts} by ${stored.author.label} was never delivered`;
    const replyEditInvisibleToHistory =
      slack.inThread(stored) && !stored.broadcast && stored.editMissed === true;
    if (
      seen !== stored.text.split(anyLineBreak).join("\n") &&
      !replyEditInvisibleToHistory
    ) {
      return `R7: ${stored.ts} was delivered as "${seen}", Slack now says "${stored.text}"`;
    }
  }
  return null;
}
