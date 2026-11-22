# The listener's TLA+ model

`Listener.tla` and `Marks.tla` model the listener's protocol (`src/core.ts`, `src/shell.ts`, RULES.md's R rules): delivery, catch-up, Socket Mode and the state file in the first, R18's seen and done marks in the second. Both were written from RULES.md's R rules alone (the version with R19–R22), before the code was read; the comparison with the code came after. When they disagree, RULES.md is right, then the model, then `src/core.ts`. TLC runs locally only: CI has no Java and no TLC, and must not get them. Nothing in CI reads this folder yet (see "Replay: later"). The task hub's model is in `spec/tasks/`.

## Running TLC

`tlc.sh <cfg> [cap-seconds] [extra TLC args]` runs one configuration with a wall-clock cap (default 900 s). `Marks.cfg` and `marks-*.cfg` run `Marks.tla`, the rest `Listener.tla`. It needs two variables, with no default:

- `TLA2TOOLS_JAR`: the TLC 2026.11.02 `tla2tools.jar`, sha256 `c57d4d7bbee3ed2c89c32cb9c60cac728f751e80e2570bc4b7368ae39291fc21`. Each log's first line records the jar's sha256.
- `JAVA`: a Java 17 binary.

The log goes to `$TLC_OUT/<cfg>.log` (default `$TMPDIR/listener-tlc`).

`check.sh` runs every configuration below and checks each outcome: a pass, or the named property violated. It prints one line per configuration and exits non-zero on any surprise. It takes about 6 minutes on 4 workers; `Listener-2crash.cfg` is left out (about 4 minutes more).

For one log: `steps.sh <cfg>` prints a counterexample's actions, and `trace.sh <cfg>` its key variables per state. `mkcfg.sh` writes a Listener configuration from its constants.

## What is modelled

**Listener.tla.** Messages are posted with ts 1..N, top-level or as a reply in an earlier top-level message's thread, by the other side (heard, R10) or by an own-side agent (never delivered).

| Rules                   | Model                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack                   | Slack pushes one envelope per post or edit while connected, FIFO, and may resend an unacked envelope (`MaxDup`). Top-level messages age: 0 (under 24 h), 1 (1 to 7 days), 2 (older). `Decodes`: a message reads as `ok`, `bad` or `badTs` in a history or replies page. `LiveBads`: its envelope payload does or does not decode                                |
| R20                     | each frame is acked once (`AckOnce`). A payload that does not decode is acked and dropped                                                                                                                                                                                                                                                                       |
| R7, R21 catch-up        | on connect, history pages of `PS` top-level messages, newest first, back 7 days, then each scheduled thread. A thread is scheduled when it has a reply above the cursor, or when its parent was skipped but its ts decodes. A message that does not decode in a page is skipped. A failed whole-page read is a retry, which is a stutter, so it is not modelled |
| live waits for catch-up | live messages are held. They are delivered only once the last catch-up's reads have ended, and none has started since; Connect, Disconnect and Crash clear that. Delivery also waits until what Slack pushed has landed, which models the 3-second hold (R4 out of scope)                                                                                       |
| R2                      | a delivery is three steps: save the intent, write to the session, save delivered plus cursor (`Margin` re-reads below the cursor). A crash restarts from the file, and a saved intent is delivered again, marked `possible_duplicate`                                                                                                                           |

Invariants:

- `R2`: every repeat in the session log is marked.
- `R2Edit`: an edit never comes before its message.
- `R5`: an edit never repeats the text the session has.
- `R4`: ts order within a thread and among top-level messages.
- `R10`: only allowed senders are delivered.
- `AckOnce`: each frame is acked once.
- `R7Safe`: an allowed, unexcused message not yet in the session can still reach it, both from memory and from the saved file after a crash.

The temporal property `R7`: every allowed message is eventually written, or excused because it aged out, was skipped under R21, or was dropped live under R20. `FairSpec` gives weak fairness to the listener's own steps and to Connect (R8), and none to Slack, time or faults.

**Marks.tla.** Messages are by `other`, `ownTyped` or `ownAgent`; the first two are delivered.

- Deliver adds the seen mark, or the done mark at once when the message is already handled.
- An own post later in the thread, or the session's `done`, replaces seen with done: add the done mark, then remove the seen one.
- Reaction calls run one at a time from a queue saved after each call. A call is `ok`, fails, or applies with its reply lost (`already_reacted` and `no_reaction` count as success). After 3 tries it is given up.
- `done` is saved before it is answered.
- A crash restores marks, queue, done requests and the delivered set from the file. A delivery that was not saved is delivered again, so it is marked again. A seen message whose thread got an own post since is made done.

Invariants:

- `NeverBare`: a message once marked never shows no own mark, unless a call on it was given up.
- `DoneSticks`: seen never comes back after done.
- `AtRest`: with an empty queue, the marks are exact.
- `DoneMeansAnswered`: done means the session said so, or the own side posted later in the thread.
- `DoneHolds`: a saved `done` shows on a delivered message.

**Not modelled:**

- R3, R6, R11 and R17: they are about content, not protocol.
- R19: a restart always reads a good file.
- R22: line framing.
- R12–R15: step 2.
- R8's back-off times: only the retrying matters to R7.

There is no symmetry, because the ts order makes every message slot distinct.

## Configurations

These are the results on 2026-11-22, exhaustive BFS on 4 workers.

| Configuration                 | What it checks                                                      | Result                                          |
| ----------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| `Listener.cfg`                | 3 msgs, 1 crash, 1 disconnect, 1 resend, ageing, other + own        | passes: 4,868,069 states, depth 38, 34 s        |
| `Listener-2crash.cfg`         | the same with 2 crashes and 2 disconnects                           | passes: 27,538,817 states, depth 46, 3 min 32 s |
| `edits.cfg`                   | 2 msgs and one edit                                                 | passes: 1,551,886 states, depth 38, 9 s         |
| `decodes.cfg`                 | R21 skips (`ok`, `bad`), no resends                                 | passes: 2,219,845 states, depth 40, 14 s        |
| `live.cfg`                    | R7 liveness, 2 msgs, other + own, crash, disconnect, resend, ageing | passes: 124,614 states, 7 s                     |
| `live3.cfg`                   | R7 liveness, 3 msgs, R21 skips                                      | passes: 2,219,845 states, 3 min 35 s            |
| `Marks.cfg`                   | R18, 3 msgs, 1 crash, 2 failures                                    | passes: 4,398,346 states, depth 24, 24 s        |
| `design-releaseMargin.cfg`    | the `releaseOnDisconnect` bug with a margin of one message          | passes: the margin covers it                    |
| `design-badTsParent.cfg`      | finding 1                                                           | R7Safe violated, 11 states                      |
| `design-live-badTsParent.cfg` | finding 1 as a lasso                                                | R7 violated                                     |
| `marks-design-giveUp.cfg`     | finding 2                                                           | NeverBare violated, 14 states                   |
| `marks-design-literal.cfg`    | finding 3 (`Handled = "literal"`)                                   | DoneMeansAnswered violated, 5 states            |
| `r20.cfg`                     | finding 4                                                           | R4 violated, 20 states                          |
| `design-r21resend.cfg`        | finding 5                                                           | R4 violated, 19 states                          |

### Planted bugs: 13, each caught

Each is one guard, through the constant `Bug`. The trace column counts states, including the initial one. Every one was caught in under a second.

| Configuration             | Bug                                                                              | Caught by         | Trace |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------- | ----- |
| `bug-saveBeforeWrite`     | the save that records a delivery is written before it                            | R7Safe            | 9     |
| `bug-noIntent`            | no intent saved, so a redelivery after a crash is not marked                     | R2                | 17    |
| `bug-ackTwice`            | a resent envelope is acked twice                                                 | AckOnce           | 6     |
| `bug-skipDropsNext`       | a skipped message also skips the next one in its page                            | R7Safe            | 12    |
| `bug-skipParentNoThread`  | catch-up never reads a skipped parent's thread                                   | R7Safe            | 11    |
| `bug-window24h`           | threads are read only for parents under 24 h, not 7 days                         | R7Safe            | 12    |
| `bug-noVersionCheck`      | an edit is delivered without comparing it with the text delivered                | R5                | 15    |
| `bug-releaseOnDisconnect` | after a disconnect, what catch-up gathered is delivered before the next catch-up | R7Safe            | 13    |
| `marks-bug-removeFirst`   | remove seen before adding done                                                   | NeverBare         | 8     |
| `marks-bug-unordered`     | reaction calls run out of order                                                  | NeverBare         | 8     |
| `marks-bug-ignoreHandled` | a message handled before delivery still gets seen                                | DoneHolds         | 5     |
| `marks-bug-lazySave`      | the reaction queue is saved lazily, so a restart replays several calls           | DoneSticks        | 9     |
| `marks-bug-doneNotSaved`  | `done` is answered before it is saved                                            | DoneMeansAnswered | 10    |

## Design findings

Each is a case the rules let go wrong, leave undefined, or contradict.

1. **A reply under a parent whose ts does not decode is lost on catch-up, and R7 does not excuse it.**
   - The trace: while the listener is down, parent p fails to decode down to its ts, r is a fine reply to p, and m3 is a fine top-level message. Catch-up skips p (R21), cannot know its thread exists, and delivers m3. r is never read.
   - R7 promises replies in threads up to 7 days old. R21 says only "skipped". The out-of-scope list names R20's live case, not this one.
   - In the code, the same holds when p's `reply_count` or `latest_reply` does not decode (see below).
   - R21 should say a skipped parent's thread is read when its ts decodes, or the out-of-scope list should name the loss.
2. **R18 can leave a delivered message with no mark.**
   - "Adds the second, then removes the first", with each call "given up" after its tries. When the add of the done mark is given up, the removal of seen still runs, and the message shows nothing. That reads as "never reached the session".
   - The rule should say the first is removed only after the second was added.
3. **"A post of the own side appears in that message's thread" (R18) is ambiguous.**
   - Read literally, an own-side typed message is done the moment it is delivered, since it is itself an own post in its own thread. So is any later message in a thread the own side posted in earlier.
   - The model passes with "after the message". The rule should say "after it".
4. **R20's recovery path breaks R4.**
   - m1's envelope does not decode, so it is acked and dropped, and m2 is delivered. A reconnect within the margin finds m1 in history and delivers it after m2.
   - R4 exempts only Slack's reordering beyond 3 s.
   - Either R4 or the R20 out-of-scope note needs the sentence "a message recovered this way can arrive out of order".
5. **R21's skip plus Slack's resend gives disorder or loss, and the rules pick neither.**
   - m1 decodes live but not in history. Its envelope is in flight when the connection drops, and catch-up skips it.
   - Taking Slack's resend breaks R4 (the model's choice). Dropping live frames older than the catch-up start loses m1 (the code's choice), and only R21's "skips it again" covers that.
6. **Implied, not written.** Each was a counterexample to a first draft of this model:
   - after a disconnect, live messages wait for the next catch-up;
   - what a catch-up gathered survives a disconnect;
   - `done` is saved before it is answered;
   - the reaction queue is saved per call.

   The code does all four; only the third is written down, in a comment in `src/core.ts`.

## Model and code compared

The code was read after the findings were written: `src/core.ts`, `src/shell.ts` and `src/slack-api.ts`, as of the decoding step (4c), with R19–R22.

Where they agree:

- `pump` saves the inflight delivery before the write (R2's exception).
- Envelopes are saved, then acked once, and an undecodable payload is acked and dropped (R20).
- `connect` and `scheduleReconnect` clear `live`, and `release` runs only when live.
- Catch-up merges history with the ready held messages and sorts by ts.
- A skipped message with a decodable `ThreadStub` still has its thread read.
- R18:
  - `noteAnswer` uses "after the message";
  - `handle` queues add-done before remove-seen;
  - `pumpReactions` runs one call at a time and saves before each;
  - `marked_done` is saved before the answer;
  - `reactTo` gives done at once to a message handled before delivery.
- A history message with `edited` claims its edit key, so a held edit with the same text is dropped.

Where they differ:

1. **The cursor.** The code's is a time watermark (`caughtUpUntilMs`, set at a catch-up's start and on each live tick) with a 10-minute margin and the `claimed` map for dedup. The model's is the stricter "highest ts delivered" with margin 0, which is why it needed finding 6's first two obligations. The code's margin covers them, as `design-releaseMargin` shows.
2. **Finding 1 is in the code.** `slack-api.ts` makes no `ThreadStub` when the ts does not decode, nor when `reply_count` or `latest_reply` is missing or mistyped.
3. **Finding 2 is in the code.** On give-up, `shell.ts` logs the error and still dispatches `reaction_done`, so the queued `remove seen` runs.
4. **Finding 4 is in the code.** A history item found by a catch-up within the margin is enqueued after newer ones that were already delivered.
5. **Finding 5: the code chose loss.** `consider` drops a live message older than `liveFromTs`.
6. **Held live messages.** The code saves them before the ack. The model loses them on a crash and relies on catch-up.

## Replay: later

The hub's model feeds `sim:hub:replay`. A replay here is not worth building now, for three reasons:

- **Listener.tla does not map onto the code's state.** Its cursor is not the code's watermark plus `claimed`. An exported graph would need its abstract state (α) computed from a different cursor, so the watermark has to be modelled first. That is about an hour, and worth doing only when the catch-up code next changes.
- **Marks.tla maps closely, but the core cannot see finding 2.** `reactTo`, `handle`, `markDone` and `reaction_done` match `Deliver`, `Post`, `Done` and `Exec` one to one. The shell, though, sends the same `reaction_done` for a success and a give-up, so a replay would only encode today's gap. Build it with finding 2's fix, which adds the outcome to `reaction_done`; the replay then comes nearly free.
- **The findings are short, fixed scenarios.** They are cheaper as fixed cases in the existing simulator (`src/sim`) or in `core.spec.ts` than as a replay pipeline:
  - a parent whose ts does not decode, with a reply;
  - an R20 drop, then a reconnect within the margin;
  - an R21 skip, then a resend;
  - a done add given up three times.

Before any replay, the rules owner has to decide findings 1–5.
