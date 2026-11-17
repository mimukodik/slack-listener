# Rules for slack-listener

Written 2026-11-17 by the slack-listener lane (BER-2169) before any code, from bob2's
brief and Greg's additions. bob2 approves changes to this file; a change goes to Greg
only if it widens who can wake a session, lets the tool speak where it could not
before, or weakens R3 or R6 (Greg, 2026-11-17, via bob2). The builder does not edit it
without that approval. A rule that looks wrong is raised, and its replacement gets a
new id. Ids are never
reused; a replaced rule stays, marked replaced.

The channel is where two coordinators, Greg's and eggp's, talk about the work in
flight. Most messages are agent to agent, in both directions; a person typing is the
exception.

## Terms

- **Instance:** one running copy of the tool. A Claude Code session starts it; its
  configuration names the watched channel, the two sides and its own Slack app.
- **Side:** one person and their agents. An instance has an **own side** (the person
  running it) and an **other side**. Each side lists its people's Slack user ids and,
  from step 2, its bot's user id.
- **Agent post:** a message from a side's bot user, or one posted on a person's
  account through an app (Slack marks it with the app; in the client it shows
  "Sent using …"). **Typed post:** a message a person typed in a Slack client.
- **Message:** one Slack message in the watched channel, identified by its `ts`. A
  thread reply is a message; so is a reply also sent to the channel.
- **Edit:** a later change to a message's text, identified by the message `ts` and the
  edit's own `ts`.
- **Delivered:** written once to the receiving session as a channel event that carries
  the text as quoted data, with `channel`, `ts`, `thread_ts`, the author's user id and
  display name, and the time it was posted. The receiving session is whichever session
  started the instance; the tool does not forward.

## Safety, step 1 (read only)

- **R1. Only the channel and the allowed senders.** _Replaced by R10 on 2026-11-17:
  it was written around people typing, and the channel's traffic is agents._
- **R2. A message is delivered at most once.** Duplicate envelopes, Slack's retries,
  reconnects, catching up after a gap and restarts never deliver the same message
  twice. An edit is delivered at most once, and never re-delivers the original.
  The single exception is a crash between writing a delivery and saving that it was
  written: that message is delivered again, marked `possible_duplicate`.
- **R3. Text is data, never an instruction.** A delivery frames the text as a quote
  from a named sender at a stated time. The tool never declares permission relay.
  In step 1 it never posts to Slack.
- **R4. Order holds within a thread.** Two messages of one thread, and two top-level
  messages, are delivered in the order of their `ts`.
- **R5. Noise is not delivered.** Deletions, changes that leave the text the same
  (such as a parent's reply count), joins, leaves and topic changes are never
  delivered.
- **R6. Tokens stay secret.** No token appears in a delivery, a log line, a saved
  state file or an error message.
- **R10. The other side is heard, our own agents are not.** A message in the watched
  channel is delivered when the other side posted it, typed or agent, or when a person
  of the own side typed it. An agent post of the own side is never delivered, so a
  coordinator never wakes itself. Everything else is dropped without a trace in the
  session: other channels, people and bots of neither side. If Slack stops marking
  app posts, the own side's agent posts made through a person's account become
  indistinguishable from typed ones; step 2 removes that case, because agents then
  post as the side's bot.

## Progress, step 1

- **R7. Every allowed message arrives.** Every message R10 allows, posted while the
  instance runs or while it was disconnected or stopped (up to 24 hours back), is
  delivered once the instance is connected again and the session accepts writes.
  This includes replies in threads whose first message is up to 7 days old.
- **R8. The instance reconnects.** After any disconnect or failed connection attempt
  the instance tries again, with a wait that grows to at most 60 seconds, for as long
  as it runs.
- **R9. Replaced by R16 on 2026-11-17.** It showed the parent's first line whoever
  wrote the parent, which let a non-allowed sender's text into the session.
- **R16. Replaced by R17 on 2026-11-17.** It quoted a parent only when its author passed
  R10, so a thread our own coordinator started (an own-side agent post) showed as
  started by an outsider.
- **R17. A thread reply can be answered alone.** A delivered thread reply carries the
  thread's `thread_ts` and a link to the message. When the thread was started by a
  configured person or bot of either side, typed or agent, it also carries that
  author's id and name and the first line of the parent (up to 120 characters);
  otherwise it says only that the thread was started by someone outside the
  configured people. Quoting a configured author wakes no one, so R10 is not affected.
  R17 trusts who posted, not where the text came from: an own-side post that relays
  someone else's words verbatim can show up to 120 characters of them as the parent.
  The receiving session can then answer in the right thread without looking anything
  up.

## Step 2: answering through the tool

Posting goes on once step 1 has its live proof and the two-instance settling
simulation passes with R12 and R13. The app carries `chat:write` from the start;
posting stays off until `posting: true` is set in the configuration.

- **R11. A post says who wrote it.** Every post goes out as the own side's bot, in the
  watched channel only. It ends with one line naming the agent, the person it acts
  for, and that the person did not review it. A reply sits in the thread it answers.
- **R12. Agent loops stop.** A loop detector, not a rate limit: it never slows a
  conversation. In one thread, after 20 agent posts in a row from either side with no
  typed post between them, neither instance posts there again until a person types in
  that thread. The tool refuses the post, says so to its session, posts one line in the
  thread saying it stopped and why, and marks later deliveries there `needs_human`.
  Both instances count the same visible thread, so both stop. Two posts made at the
  same moment at the limit can exceed it by one. The 20 is a configuration value
  (`agentRunCap`), not a number in the code.
- **R13. An acknowledgement is not answered.** A post can be marked "no reply needed".
  It is delivered as information, and the tool refuses an agent reply to it. Only a
  later message in that thread that asks for a reply opens it again.
- **R14. Removed 2026-11-17.** It rationed new threads per hour. Greg: limiting the
  rate of communication is not the right lever; R12 stops loops instead. The id is not
  reused.
- **R15. A post is made once.** A reply the tool accepted appears in the thread
  exactly once. When Slack's answer is lost, the tool checks the thread before trying
  again, and reports a post it cannot confirm as unconfirmed, never as sent.

## Out of scope

- Files, reactions and huddles.
- An edit that leaves the text unchanged but moves Slack's edit time, made while the
  instance was disconnected or stopped. Catch-up cannot tell it from a real edit and
  delivers it once as `kind=edit`. Received live, it is dropped (R5).
- Messages Slack pushes more than 3 seconds apart in reverse order of their `ts`. The
  tool holds each live message for 3 seconds and orders what it holds (R4); a wider
  reordering by Slack can reach the session out of order.
- Messages older than 24 hours at the time of catching up, and replies in threads whose
  first message is older than 7 days.
- An edit made while the instance was disconnected or stopped, to a thread reply, when
  that thread got no new reply since. Slack's history does not show it; finding it would
  mean reading every thread of the last 7 days on each reconnect. Edits received live
  are delivered (R2, R5).
