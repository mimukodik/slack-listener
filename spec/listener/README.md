# The listener's TLA+ model

`Listener.tla` and `Marks.tla` model the listener's protocol (`src/core.ts`, `src/shell.ts`, RULES.md's R rules): delivery, catch-up, Socket Mode and the state file in the first, R18's seen and done marks in the second. Both were written from RULES.md's R rules alone (the version with R19–R22), before the code was read; the comparison with the code came after. When they disagree, RULES.md is right, then the model, then `src/core.ts`. The spike's findings led to six rule sentences the owner approved on 2026-11-22 and to a fix of R18's give-up in the code (DECISIONS.md, 4c+); the models now follow those sentences. TLC runs locally only: CI has no Java and no TLC, and must not get them. Nothing in CI reads this folder yet (see "Replay: later"). The task hub's model is in `spec/tasks/`.

## Running TLC

`tlc.sh <cfg> [cap-seconds] [extra TLC args]` runs one configuration with a wall-clock cap (default 900 s). `Marks.cfg` and `marks-*.cfg` run `Marks.tla`, the rest `Listener.tla`. It needs two variables, with no default:

- `TLA2TOOLS_JAR`: the TLC 2026.11.02 `tla2tools.jar`, sha256 `c57d4d7bbee3ed2c89c32cb9c60cac728f751e80e2570bc4b7368ae39291fc21`. Each log's first line records the jar's sha256.
- `JAVA`: a Java 17 binary.

The log goes to `$TLC_OUT/<cfg>.log` (default `$TMPDIR/listener-tlc`).

`check.sh` runs every configuration below and checks each outcome: a pass, or the named property violated. It prints one line per configuration and exits non-zero on any surprise. It takes about 11 minutes on 4 workers; `Listener-2crash.cfg` is left out (about 5 minutes more).

For one log: `steps.sh <cfg>` prints a counterexample's actions, and `trace.sh <cfg>` its key variables per state. `mkcfg.sh` writes a Listener configuration from its constants. The constant `Excuses` names which of the rules' excuses the invariants allow: `"badTsParent"` (R21: replies under a parent whose thread fields do not decode) and `"r20Order"` (R4: a message recovered after an R20 drop may come late); every configuration has both, except the `noexcuse-*` ones, which show each excuse is needed.

## What is modelled

**Listener.tla.** Messages are posted with ts 1..N, top-level or as a reply in an earlier top-level message's thread, by the other side (heard, R10) or by an own-side agent (never delivered).

| Rules                   | Model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack                   | Slack pushes one envelope per post or edit while connected, FIFO, and may resend an unacked envelope (`MaxDup`). Top-level messages age: 0 (under 24 h), 1 (1 to 7 days), 2 (older). `Decodes`: a message reads as `ok`, `bad` or `badTs` in a history or replies page. `LiveBads`: its envelope payload does or does not decode                                                                                                                                                                                                                                 |
| R20                     | each frame is acked once (`AckOnce`). A payload that does not decode is acked and dropped                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R7, R21 catch-up        | on connect, history pages of `PS` top-level messages, newest first, back 7 days, then each scheduled thread. A thread is scheduled when it has a reply above the cursor, or when its parent was skipped but its ts decodes. A message that does not decode in a page is skipped. A failed whole-page read is a retry, which is a stutter, so it is not modelled                                                                                                                                                                                                  |
| live waits for catch-up | live messages are held. They are delivered only once the last catch-up's reads have ended, and none has started since; Connect, Disconnect and Crash clear that. What a catch-up gathered and did not deliver is kept across a disconnect and the next connect, whether it finished or was cut short. R7 asks this only of a finished catch-up and has the next one read again what one cut short had read, so the model keeps more than the rule asks. Delivery also waits until what Slack pushed has landed, which models the 3-second hold (R4 out of scope) |
| R21 resend              | a live envelope of a message posted before the last catch-up started (`liveFrom`) is acked and dropped: that catch-up read it, or skipped it. R21 also drops such a live event held across the reconnect; the model keeps held messages and delivers them, so it delivers more than the rule allows, which no invariant forbids                                                                                                                                                                                                                                  |
| R2                      | a delivery is three steps: save the intent, write to the session, save delivered plus cursor (`Margin` re-reads below the cursor). A crash restarts from the file, and a saved intent is delivered again, marked `possible_duplicate`                                                                                                                                                                                                                                                                                                                            |

Invariants:

- `R2`: every repeat in the session log is marked.
- `R2Edit`: an edit never comes before its message.
- `R5`: an edit never repeats the text the session has.
- `R4`: ts order within a thread and among top-level messages. R4 lets a message dropped live under R20 and found by a later catch-up arrive out of that order; the model's excuse is narrower and covers only that message coming after newer ones.
- `R10`: only allowed senders are delivered.
- `AckOnce`: each frame is acked once.
- `R7Safe`: an allowed, unexcused message not yet in the session can still reach it, both from memory and from the saved file after a crash.

The temporal property `R7`: every allowed message is eventually written, or excused because it aged out, was skipped under R21 (its live resend dropped too), was dropped live under R20, or is a reply under a parent whose ts does not decode (R21). The model keeps the spike's granularity for that last excuse: a parent reads as `badTs` or not, with no separate `reply_count` or `latest_reply`, and there is no reply also sent to the channel, which R21 would not excuse. `FairSpec` gives weak fairness to the listener's own steps and to Connect (R8), and none to Slack, time or faults.

**Marks.tla.** Messages are by `other`, `ownTyped` or `ownAgent`; the first two are delivered.

- Deliver adds the seen mark, or the done mark at once when the message is already handled.
- An own post later in the thread, or the session's `done`, replaces seen with done: add the done mark, then remove the seen one.
- Reaction calls run one at a time from a queue saved before each call, so a restart repeats at most one call (R18). A call is `ok`, fails, or applies with its reply lost (`already_reacted` and `no_reaction` count as success). After 3 tries it is given up. When adding done is given up, the queued removal of that message's seen mark is dropped, so seen stays (R18).
- `done` is saved before it is answered.
- A crash restores marks, queue, done requests and the delivered set from the file. A delivery that was not saved is delivered again, so it is marked again. A seen message whose thread got an own post since is made done.

Invariants:

- `NeverBare`: a message once marked never shows no own mark, give-ups included. Only a message whose first add was given up, and so never showed a mark, can be bare. R18 names one more bare case: a first reaction dropped because the reaction queue was full. The model's queue has no limit, so that case is not modelled.
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

These are the results on 2026-11-22 (4c+), exhaustive BFS on 4 workers, with nothing else running. The spike's numbers were smaller (`Listener.cfg`: 4,868,069 states): `liveFrom` and the gathered set kept across a connect add states.

| Configuration                 | What it checks                                                        | Result                                          |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `Listener.cfg`                | 3 msgs, 1 crash, 1 disconnect, 1 resend, ageing, other + own          | passes: 6,584,157 states, depth 38, 42 s        |
| `Listener-2crash.cfg`         | the same with 2 crashes and 2 disconnects                             | passes: 39,569,120 states, depth 47, 4 min 52 s |
| `edits.cfg`                   | 2 msgs and one edit                                                   | passes: 1,950,668 states, depth 38, 13 s        |
| `decodes.cfg`                 | R21 skips (`ok`, `bad`), no resends                                   | passes: 2,878,594 states, depth 40, 18 s        |
| `live.cfg`                    | R7 liveness, 2 msgs, other + own, crash, disconnect, resend, ageing   | passes: 153,207 states, depth 32, 10 s          |
| `live3.cfg`                   | R7 liveness, 3 msgs, R21 skips                                        | passes: 2,878,594 states, depth 40, 4 min 31 s  |
| `Marks.cfg`                   | R18, 3 msgs, 1 crash, 2 failures (no call is given up)                | passes: 4,398,346 states, depth 24, 24 s        |
| `marks-giveUp.cfg`            | R18, 3 msgs, 1 crash, 3 failures, so a call can be given up           | passes: 8,159,874 states, depth 26, 42 s        |
| `design-releaseMargin.cfg`    | the `releaseOnDisconnect` bug with a margin of one message            | passes: 158,208 states, depth 33, 2 s           |
| `design-dropGathered.cfg`     | what any catch-up gathered dropped at a disconnect (finding 6)        | passes: 5,744,469 states, depth 38, 36 s        |
| `design-badTsParent.cfg`      | finding 1, excused by R21                                             | passes: 754,464 states, depth 35, 6 s           |
| `design-live-badTsParent.cfg` | finding 1 as a lasso, excused by R21                                  | passes: 547 states, depth 16, 0 s               |
| `marks-design-giveUp.cfg`     | finding 2, fixed: the done add given up, 1 crash                      | passes: 71,262 states, depth 22, 1 s            |
| `marks-design-literal.cfg`    | finding 3's literal reading (`Handled = "literal"`), kept as a record | DoneMeansAnswered violated, 5 states            |
| `r20.cfg`                     | finding 4, allowed by R4                                              | passes: 6,666,255 states, depth 40, 44 s        |
| `design-r21resend.cfg`        | finding 5, the resend dropped (R21)                                   | passes: 12,337,906 states, depth 42, 1 min 23 s |

### Excuses removed: 3, each needed

Each runs a passing design configuration with one excuse taken out of `Excuses`, so the invariant is the rule without that sentence.

| Configuration               | Excuse removed                                     | Caught by | Trace |
| --------------------------- | -------------------------------------------------- | --------- | ----- |
| `noexcuse-badTsParent`      | `"badTsParent"` (R21's sentence on thread parents) | R7Safe    | 11    |
| `noexcuse-live-badTsParent` | the same, as a lasso                               | R7        | 8     |
| `noexcuse-r20`              | `"r20Order"` (R4's R20 exception)                  | R4        | 20    |

### Planted bugs: 16, each caught

Each is one guard, through the constant `Bug`. The trace column counts states, including the initial one. Every one is caught within 20 s (most in under 2 s).

| Configuration             | Bug                                                                                               | Caught by         | Trace |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ----------------- | ----- |
| `bug-saveBeforeWrite`     | the save that records a delivery is written before it                                             | R7Safe            | 9     |
| `bug-noIntent`            | no intent saved, so a redelivery after a crash is not marked                                      | R2                | 17    |
| `bug-ackTwice`            | a resent envelope is acked twice                                                                  | AckOnce           | 6     |
| `bug-skipDropsNext`       | a skipped message also skips the next one in its page                                             | R7Safe            | 12    |
| `bug-skipParentNoThread`  | catch-up never reads a skipped parent's thread                                                    | R7Safe            | 11    |
| `bug-window24h`           | threads are read only for parents under 24 h, not 7 days                                          | R7Safe            | 12    |
| `bug-noVersionCheck`      | an edit is delivered without comparing it with the text delivered                                 | R5                | 15    |
| `bug-releaseOnDisconnect` | after a disconnect, what catch-up gathered is delivered before the next catch-up                  | R7Safe            | 13    |
| `bug-takeResend`          | the live resend of a message the catch-up skipped is delivered (the spike's choice for finding 5) | R4                | 19    |
| `bug-liveFromAtEnd`       | live messages are cut from the catch-up's end, not its start                                      | R7Safe            | 11    |
| `marks-bug-removeFirst`   | remove seen before adding done                                                                    | NeverBare         | 8     |
| `marks-bug-unordered`     | reaction calls run out of order                                                                   | NeverBare         | 8     |
| `marks-bug-ignoreHandled` | a message handled before delivery still gets seen                                                 | DoneHolds         | 5     |
| `marks-bug-lazySave`      | the reaction queue is saved lazily, so a restart replays several calls                            | DoneSticks        | 9     |
| `marks-bug-doneNotSaved`  | `done` is answered before it is saved                                                             | DoneMeansAnswered | 10    |
| `marks-bug-giveUpRemoves` | the seen removal still runs when the done add is given up (finding 2 unfixed)                     | NeverBare         | 14    |

## Design findings

Each is a case the rules let go wrong, leave undefined, or contradict, as the spike found it, with how it was settled in 4c+.

1. **A reply under a parent whose ts does not decode is lost on catch-up, and R7 does not excuse it.**
   - The trace: while the listener is down, parent p fails to decode down to its ts, r is a fine reply to p, and m3 is a fine top-level message. Catch-up skips p (R21), cannot know its thread exists, and delivers m3. r is never read.
   - R7 promises replies in threads up to 7 days old. R21 says only "skipped". The out-of-scope list names R20's live case, not this one.
   - In the code, the same holds when p's `reply_count` or `latest_reply` does not decode (see below).
   - R21 should say a skipped parent's thread is read when its ts decodes, or the out-of-scope list should name the loss.
   - **Settled by R21** (the owner's sentence of 4c): such replies are not delivered unless also sent to the channel. `R7` and `R7Safe` excuse them (`"badTsParent"`); `design-badTsParent` and `design-live-badTsParent` pass, and `noexcuse-*` fail without the excuse.
2. **R18 can leave a delivered message with no mark.**
   - "Adds the second, then removes the first", with each call "given up" after its tries. When the add of the done mark is given up, the removal of seen still runs, and the message shows nothing. That reads as "never reached the session".
   - The rule should say the first is removed only after the second was added.
   - **Settled by R18 and fixed in the code**: when adding the second is given up, the first stays, and a delivered message carries neither only when its first reaction was given up or dropped from a full queue. `marks-design-giveUp` passes with `NeverBare` tightened; `marks-bug-giveUpRemoves` plants the old behaviour back and fails it.
3. **"A post of the own side appears in that message's thread" (R18) is ambiguous.**
   - Read literally, an own-side typed message is done the moment it is delivered, since it is itself an own post in its own thread. So is any later message in a thread the own side posted in earlier.
   - The model passes with "after the message". The rule should say "after it".
   - **Settled by R18**, which now says "after the message". `marks-design-literal` keeps the literal reading as a record, and it still fails `DoneMeansAnswered`.
4. **R20's recovery path breaks R4.**
   - m1's envelope does not decode, so it is acked and dropped, and m2 is delivered. A reconnect within the margin finds m1 in history and delivers it after m2.
   - R4 exempts only Slack's reordering beyond 3 s.
   - Either R4 or the R20 out-of-scope note needs the sentence "a message recovered this way can arrive out of order".
   - **Settled by R4**, which now lets such a message arrive out of order. `r20` passes with the excuse (`"r20Order"`) and `noexcuse-r20` fails without it.
5. **R21's skip plus Slack's resend gives disorder or loss, and the rules pick neither.**
   - m1 decodes live but not in history. Its envelope is in flight when the connection drops, and catch-up skips it.
   - Taking Slack's resend breaks R4 (the model's choice). Dropping live frames older than the catch-up start loses m1 (the code's choice), and only R21's "skips it again" covers that.
   - **Settled by R21, for the code's choice**: for a message posted before the catch-up started, its live event, resent or held across the reconnect, is dropped, so the message is not delivered. The model drops a resend of a message posted before the last catch-up started, and `design-r21resend` passes; it keeps a held one (see the R21 resend row above). `bug-takeResend` plants the spike's choice back and fails `R4`, with R4's R20 excuse on, so that excuse does not cover it; `bug-liveFromAtEnd` cuts from the catch-up's end instead of its start, too wide, and fails `R7Safe`.
6. **Implied, not written.** Each was a counterexample to a first draft of this model:
   - after a disconnect, live messages wait for the next catch-up;
   - what a catch-up gathered survives a disconnect;
   - `done` is saved before it is answered;
   - the reaction queue is saved before each call.

   The code does all four; only the third is written down, in a comment in `src/core.ts`.
   - **Settled by R7 and R18**, which now state all four: R7 that what a finished catch-up gathered survives, and what one cut short had read is read again; R18 that the queue is saved before each call, so a restart repeats at most one call. `bug-releaseOnDisconnect`, `marks-bug-doneNotSaved` and `marks-bug-lazySave` catch a break of the first, third and fourth. The second is now modelled (a connect keeps what was gathered), but `design-dropGathered`, which drops it at a disconnect, passes: in this model the next catch-up reads those messages again, since none is below the cursor, so R7 does not depend on it here.

## Model and code compared

The code was read after the findings were written: `src/core.ts`, `src/shell.ts` and `src/slack-api.ts`, as of the decoding step (4c), with R19–R22, and again in 4c+.

Where they agree:

- `pump` saves the inflight delivery before the write (R2's exception).
- Envelopes are saved, then acked once, and an undecodable payload is acked and dropped (R20).
- `connect` and `scheduleReconnect` clear `live`, and `release` runs only when live.
- Catch-up merges history with the ready held messages and sorts by ts.
- A skipped message with a decodable `ThreadStub` still has its thread read.
- `consider` drops a live message older than the catch-up's start (`liveFromTs`), as the model's `Stale` does (finding 5, R21).
- A history item found by a catch-up within the margin is enqueued after newer ones already delivered, which R4 now allows (finding 4).
- R18:
  - `noteAnswer` uses "after the message";
  - `handle` queues add-done before remove-seen;
  - `pumpReactions` runs one call at a time and saves before each, so each call's result is saved before the next starts;
  - `marked_done` is saved before the answer;
  - `reactTo` gives done at once to a message handled before delivery;
  - since 4c+, `reaction_done` carries the outcome, `ok` or `given_up`, and a given-up add of done drops the queued removal of seen (`afterReaction`), as `KeepEyes` does.
- A history message with `edited` claims its edit key, so a held edit with the same text is dropped.

Where they differ:

1. **The cursor.** The code's is a time watermark (`caughtUpUntilMs`, set at a catch-up's start and on each live tick) with a 10-minute margin and the `claimed` map for dedup. The model's is the stricter "highest ts delivered" with margin 0, which is why it needed finding 6's first two obligations. The code's margin covers them, as `design-releaseMargin` shows.
2. **What a catch-up gathered.** The code hands an ended catch-up's messages to its delivery queue, which is saved and survives a disconnect and a restart; a catch-up cut off by a disconnect drops what it had read, and the next one reads it again. R7 says the same. The model keeps both across a disconnect and drops both on a crash; keeping a cut-short catch-up's is more than R7 asks.
3. **Held live messages.** The code saves them before the ack, and drops at release any held across a reconnect that is older than the new catch-up's start; that catch-up's history delivers them, or skips them under R21, which says so. The model keeps them held across a disconnect, loses them on a crash, and relies on catch-up; it drops only a resend, so it may deliver a held message the catch-up skipped.
4. **The last call's save.** The code saves the reaction queue before each call, so the save after a call is the one before the next; after the last call the queue is saved at the next save (a tick, a delivery). The model's `Exec` needs a save before each try. A restart repeats at most one call in both, as R18 says, and both calls are safe to repeat.
5. **A done for a message not taken in.** The model's `Done` takes any posted message; the code answers `taken: false` for one it never took in (`markDone`), so such a done is not kept.
6. **Finding 1's granularity.** `slack-api.ts` makes no `ThreadStub` when the ts, `reply_count` or `latest_reply` does not decode; the model has only `badTs`.

## Replay: later

The hub's model feeds `sim:hub:replay`. Neither listener model does yet:

- **Listener.tla does not map onto the code's state.** Its cursor is not the code's watermark plus `claimed`, and it handles held messages and an interrupted catch-up differently (above). An exported graph would need its abstract state (α) computed from a different cursor, so the watermark has to be modelled first. That is about an hour, and worth doing only when the catch-up code next changes.
- **Marks.tla maps closely, and the core now sees the outcome.** `reactTo`, `handle`, `markDone` and `reaction_done` match `Deliver`, `Post`, `Done` and `Exec` one to one, and 4c+ gave `reaction_done` its outcome, so a give-up reaches the core as the model's does. A replay would still need:
  - α from the core's `State` (`reacted`, `handled`, `marked`, the reaction queue) and the fake's reactions to the model's `mark`, `q` and `rx`;
  - an export of `Marks.cfg`'s and `marks-giveUp.cfg`'s state graphs and a path cutter, as `spec/tasks/regenerate.sh` and `src/hub/sim/tla/export.ts` do;
  - a driver that turns `Exec(i, "fail")` three times into one `given_up`, `"lost"` into a call Slack applies but whose answer fails, `Crash` into a restart from the saved file, `Post` into an own-side envelope and `Done` into `marked_done`;
  - `Done` aligned with the code first: the model must not take a done for a message the listener never took in (difference 5).
- **The findings are short, fixed scenarios**, cheaper as fixed cases than a pipeline. Finding 2's counterexample is replayed through the core in `src/core.spec.ts` ("marks-design-giveUp: …"), and the simulator's R18 checker states the rule on every call and at the end of every run. The others stay as TLC configurations:
  - a parent whose ts does not decode, with a reply (`design-badTsParent`);
  - an R20 drop, then a reconnect within the margin (`r20`);
  - an R21 skip, then a resend (`design-r21resend`).
