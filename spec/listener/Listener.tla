----------------------------- MODULE Listener -----------------------------
(***************************************************************************)
(* The slack-listener's delivery protocol, modelled from RULES.md (the 4c  *)
(* version, R1-R22) only, not from the code.                               *)
(*                                                                         *)
(* Slack's side: messages posted in ts order (ts = index), top-level or a  *)
(* reply to a top-level message, by the other side or by an own-side      *)
(* agent; one edit; parents that age past 24 h and 7 days; for each       *)
(* message, whether it decodes in a history/replies page (R21) and in its *)
(* Socket Mode envelope (R20). Slack pushes an envelope per post and per  *)
(* edit while a connection is open, FIFO, and may resend an unacked one.  *)
(*                                                                         *)
(* The listener's side: receive + ack, hold, catch-up (history pages      *)
(* newest first, then each scheduled thread), delivery to the session as  *)
(* three steps (save intent, write, save delivered + cursor), and the     *)
(* saved state file. Crash restarts from the file; a saved intent is      *)
(* delivered again, marked possible_duplicate (R2's exception).           *)
(*                                                                         *)
(* R18's marks live in Marks.tla.                                          *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    N,          \* messages Slack posts (ts 1..N)
    PS,         \* history page size
    Margin,     \* catch-up re-reads ts > cursor - Margin (ts units)
    MaxCrash, MaxDisc, MaxDup, MaxAge, MaxEdits,
    Senders,    \* subset of {"other", "own"}; "own" = an own-side agent post
    Decodes,    \* subset of {"ok", "bad", "badTs"}: how a message reads in a page (R21)
    LiveBads,   \* subset of BOOLEAN: TRUE = its envelope payload does not decode (R20)
    Excuses,    \* the rules' excuses checked: "badTsParent" (R21), "r20Order" (R4)
    Bug,
    Nil

VARIABLES
    posted, msg, age, edits, ages,          \* Slack
    unacked, pipe, rcvd, acks, dups, r20drop, \* Socket Mode
    conn, hcur, todo, gath, held, wip, redo, \* listener memory
    caught,                                 \* the last catch-up ended and none has started since
    liveFrom,                               \* the newest ts posted when the last catch-up started
    cursor, dv,                             \* listener memory: cursor, delivered versions
    sCursor, sdv, sInflight,                \* the saved state file
    slog,                                   \* ghost: what the session received
    crashes, discs

slackV  == <<posted, msg, age, edits, ages>>
sockV   == <<unacked, pipe, rcvd, acks, dups, r20drop>>
memV    == <<conn, hcur, todo, gath, held, wip, redo, cursor, dv, caught, liveFrom>>
fileV   == <<sCursor, sdv, sInflight>>
vars == <<slackV, sockV, memV, fileV, slog, crashes, discs>>

M == 1..N
Max(S) == CHOOSE x \in S : \A y \in S : x >= y
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Envs == [k : {"msg", "edit"}, m : M]
Env(k, m) == [k |-> k, m |-> m]
Item(k, m, v, d) == [k |-> k, m |-> m, v |-> v, dup |-> d]

Top(m)      == msg[m].par = 0
Allowed(m)  == msg[m].snd = "other"           \* R10, step 1: the other side is heard
Posted      == 1..posted
Tops        == {t \in Posted : Top(t)}
Replies(p)  == {r \in Posted : msg[r].par = p}

(* ----------------------------- Slack ---------------------------------- *)

Connected == conn # "down"

Push(e) == /\ pipe' = Append(pipe, e)
           /\ unacked' = unacked \cup {e}

Post(s, p, d, b) ==
    /\ posted < N
    /\ LET m == posted + 1 IN
       /\ posted' = m
       /\ msg' = [msg EXCEPT ![m] = [snd |-> s, par |-> p, dec |-> d, lbad |-> b, ver |-> 0]]
       /\ IF Connected THEN Push(Env("msg", m)) ELSE UNCHANGED <<pipe, unacked>>
    /\ UNCHANGED <<age, edits, ages, rcvd, acks, dups, r20drop, memV, fileV, slog, crashes, discs>>

PostAny ==
    \E s \in Senders, p \in {0} \cup Tops, d \in Decodes, b \in LiveBads : Post(s, p, d, b)

Edit(m) ==
    /\ edits < MaxEdits /\ m \in Posted /\ msg[m].ver = 0
    /\ edits' = edits + 1
    /\ msg' = [msg EXCEPT ![m].ver = 1]
    /\ IF Connected THEN Push(Env("edit", m)) ELSE UNCHANGED <<pipe, unacked>>
    /\ UNCHANGED <<posted, age, ages, rcvd, acks, dups, r20drop, memV, fileV, slog, crashes, discs>>

\* Time passes for a top-level message: 0 = within 24 h, 1 = 1-7 days, 2 = older.
Age(m) ==
    /\ ages < MaxAge /\ m \in Tops /\ age[m] < 2 /\ pipe = << >>
    /\ age' = [age EXCEPT ![m] = @ + 1] /\ ages' = ages + 1
    \* Slack's retries of an unacked envelope end long before a day passes.
    /\ unacked' = {}
    /\ UNCHANGED <<posted, msg, edits, pipe, rcvd, acks, dups, r20drop, memV, fileV, slog, crashes, discs>>

\* Slack resends an envelope it has not seen acknowledged.
Resend(e) ==
    /\ Connected /\ e \in unacked /\ dups < MaxDup
    /\ pipe' = Append(pipe, e) /\ dups' = dups + 1
    /\ UNCHANGED <<slackV, unacked, rcvd, acks, r20drop, memV, fileV, slog, crashes, discs>>

(* ---------------------------- the listener ---------------------------- *)

Items == gath \cup held
Delivered(m) == dv[m] # -1

\* R21: a live message posted before the last catch-up started is that
\* catch-up's to read (or to skip), so its resend is dropped. "takeResend"
\* plants the spike's first choice back: the resend is delivered.
Stale(m) == m <= liveFrom /\ Bug # "takeResend"

\* R20: ack every frame that has an envelope id; drop what does not decode.
Receive ==
    /\ Connected /\ pipe # << >>
    /\ LET e == Head(pipe)
           m == e.m
           dupFrame == rcvd[e] > 0
       IN /\ pipe' = Tail(pipe)
          /\ rcvd' = [rcvd EXCEPT ![e] = @ + 1]
          /\ acks' = [acks EXCEPT ![e] = @ + IF Bug = "ackTwice" /\ dupFrame THEN 2 ELSE 1]
          /\ unacked' = unacked \ {e}
          /\ IF msg[m].lbad
               THEN /\ r20drop' = IF e.k = "msg" THEN r20drop \cup {m} ELSE r20drop
                    /\ UNCHANGED held
               ELSE /\ held' = IF ~Allowed(m) \/ (e.k = "msg" /\ Stale(m)) THEN held
                               ELSE IF e.k = "msg"
                                 THEN IF Delivered(m) THEN held
                                      ELSE held \cup {Item("msg", m, 0, FALSE)}
                                 ELSE held \cup {Item("edit", m, 1, FALSE)}
                    /\ UNCHANGED r20drop
    /\ UNCHANGED <<slackV, dups, conn, hcur, todo, gath, wip, redo, cursor, dv, caught, liveFrom, fileV, slog, crashes, discs>>

\* R8: connect (again). Catch-up starts: history pages from the newest down.
\* What an earlier catch-up gathered and did not yet deliver is kept (R7).
\* "liveFromAtEnd" plants a resend cut that is too wide: taken when the
\* catch-up ends, it drops live messages posted while it read.
Connect ==
    /\ conn = "down" /\ redo = Nil
    /\ conn' = "reading" /\ hcur' = N + 1 /\ todo' = {}
    /\ caught' = FALSE
    /\ liveFrom' = IF Bug = "liveFromAtEnd" THEN liveFrom ELSE posted
    /\ UNCHANGED <<slackV, sockV, gath, held, wip, redo, cursor, dv, fileV, slog, crashes, discs>>

Disconnect ==
    /\ Connected /\ discs < MaxDisc
    /\ conn' = "down" /\ pipe' = << >> /\ todo' = {} /\ hcur' = N + 1
    /\ discs' = discs + 1
    /\ gath' = IF Bug = "dropGathered" THEN {} ELSE gath
    \* Frames in flight are lost: nothing more is delivered until a new catch-up ends.
    /\ caught' = (caught /\ Bug = "releaseOnDisconnect")
    /\ UNCHANGED <<slackV, unacked, rcvd, acks, dups, r20drop, held, wip, redo, cursor, dv, liveFrom, fileV, slog, crashes>>

\* A message catch-up would read again from cursor c (R7, R21).
Fresh(m, c) == m + Margin > c

\* History lists top-level messages within 7 days (24 h under the bug).
InHistory(t) == IF Bug = "window24h" THEN age[t] = 0 ELSE age[t] < 2

\* The next page: the PS newest top-level messages below hcur.
PageOf(h) ==
    LET below == {t \in Tops : t < h /\ InHistory(t)}
    IN IF Cardinality(below) <= PS THEN below
       ELSE CHOOSE S \in SUBSET below :
              Cardinality(S) = PS /\ \A x \in S, y \in below \ S : x > y

\* Planted: a skipped message also skips the next (older) one in its page.
DroppedBySkip(S) ==
    IF Bug # "skipDropsNext" THEN {}
    ELSE {t \in S : \E b \in S : msg[b].dec # "ok" /\ t < b
                                 /\ \A x \in S : x < b => x <= t}

ReadPage ==
    /\ conn = "reading" /\ hcur > 0
    /\ LET S == PageOf(hcur)
           D == DroppedBySkip(S)
           ok == {t \in S \ D : msg[t].dec = "ok"}
           newMsgs == {Item("msg", t, msg[t].ver, FALSE) :
                         t \in {x \in ok : Allowed(x) /\ age[x] = 0 /\ Fresh(x, cursor) /\ ~Delivered(x)}}
           newEdits == {Item("edit", t, msg[t].ver, FALSE) :
                         t \in {x \in ok : Allowed(x) /\ age[x] = 0 /\ Delivered(x) /\ msg[x].ver > dv[x]}}
           threads == {t \in S \ D :
                         \/ (msg[t].dec = "ok" /\ \E r \in Replies(t) : Fresh(r, cursor))
                         \/ (msg[t].dec = "bad" /\ Bug # "skipParentNoThread")}
       IN IF S = {} THEN /\ hcur' = 0 /\ UNCHANGED <<gath, todo>>
          ELSE /\ hcur' = Min(S)
               /\ gath' = gath \cup newMsgs \cup newEdits
               /\ todo' = todo \cup threads
    /\ UNCHANGED <<slackV, sockV, conn, held, wip, redo, cursor, dv, caught, liveFrom, fileV, slog, crashes, discs>>

ReadReplies(p) ==
    /\ conn = "reading" /\ p \in todo
    /\ LET rs == {r \in Replies(p) : msg[r].dec = "ok" /\ Allowed(r) /\ Fresh(r, cursor) /\ ~Delivered(r)}
       IN gath' = gath \cup {Item("msg", r, msg[r].ver, FALSE) : r \in rs}
    /\ todo' = todo \ {p}
    /\ UNCHANGED <<slackV, sockV, conn, hcur, held, wip, redo, cursor, dv, caught, liveFrom, fileV, slog, crashes, discs>>

ReadsDone ==
    /\ conn = "reading" /\ hcur = 0 /\ todo = {}
    /\ conn' = "live" /\ caught' = TRUE
    /\ liveFrom' = IF Bug = "liveFromAtEnd" THEN posted ELSE liveFrom
    /\ UNCHANGED <<slackV, sockV, hcur, todo, gath, held, wip, redo, cursor, dv, fileV, slog, crashes, discs>>

(* Delivery: the oldest item first (R4), messages before edits of one ts. *)
Key(i) == 2 * i.m + (IF i.k = "edit" THEN 1 ELSE 0)
Wanted(i) == IF i.k = "msg" THEN ~Delivered(i.m)
             ELSE /\ Delivered(i.m)
                  /\ (Bug = "noVersionCheck" \/ i.v > dv[i.m])

Begin ==
    /\ wip = Nil /\ caught /\ redo = Nil /\ Items # {}
    \* The 3-second hold: what Slack pushed before has landed (out of scope otherwise).
    /\ (pipe = << >> \/ Bug = "noHold")
    /\ LET i == CHOOSE x \in Items : \A y \in Items : Key(x) <= Key(y)
       IN /\ gath' = gath \ {x \in gath : x.k = i.k /\ x.m = i.m}
          /\ held' = held \ {x \in held : x.k = i.k /\ x.m = i.m}
          /\ wip' = IF Wanted(i) THEN [k |-> i.k, m |-> i.m, v |-> i.v, dup |-> i.dup, step |-> "new"]
                    ELSE Nil
    /\ UNCHANGED <<slackV, sockV, conn, hcur, todo, redo, cursor, dv, caught, liveFrom, fileV, slog, crashes, discs>>

\* After a restart: the saved intent is delivered again, marked possible_duplicate.
Redo ==
    /\ wip = Nil /\ redo # Nil
    /\ wip' = [k |-> redo.k, m |-> redo.m, v |-> redo.v, dup |-> TRUE, step |-> "intent"]
    /\ redo' = Nil
    /\ UNCHANGED <<slackV, sockV, conn, hcur, todo, gath, held, cursor, dv, caught, liveFrom, fileV, slog, crashes, discs>>

NewCursor(w) == IF w.k = "msg" THEN Max({cursor, w.m}) ELSE cursor

SaveIntent ==
    /\ wip # Nil /\ wip.step = "new"
    /\ wip' = [wip EXCEPT !.step = "intent"]
    /\ IF Bug = "noIntent" THEN UNCHANGED sInflight
       ELSE sInflight' = [k |-> wip.k, m |-> wip.m, v |-> wip.v]
    /\ IF Bug = "saveBeforeWrite"
         THEN /\ sdv' = [sdv EXCEPT ![wip.m] = wip.v] /\ sCursor' = NewCursor(wip)
         ELSE UNCHANGED <<sdv, sCursor>>
    /\ UNCHANGED <<slackV, sockV, conn, hcur, todo, gath, held, redo, cursor, dv, caught, liveFrom, slog, crashes, discs>>

Write ==
    /\ wip # Nil /\ wip.step = "intent"
    /\ slog' = Append(slog, [k |-> wip.k, m |-> wip.m, v |-> wip.v, dup |-> wip.dup])
    /\ dv' = [dv EXCEPT ![wip.m] = Max({@, wip.v})]
    /\ cursor' = NewCursor(wip)
    /\ wip' = [wip EXCEPT !.step = "written"]
    /\ UNCHANGED <<slackV, sockV, conn, hcur, todo, gath, held, redo, caught, liveFrom, fileV, crashes, discs>>

SaveDone ==
    /\ wip # Nil /\ wip.step = "written"
    /\ sdv' = dv /\ sCursor' = cursor /\ sInflight' = Nil
    /\ wip' = Nil
    /\ UNCHANGED <<slackV, sockV, conn, hcur, todo, gath, held, redo, cursor, dv, caught, liveFrom, slog, crashes, discs>>

\* A crash at any point: memory is lost, the file is read back (R19: it decodes).
Crash ==
    /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ conn' = "down" /\ pipe' = << >> /\ hcur' = N + 1 /\ todo' = {} /\ gath' = {}
    /\ held' = {} /\ wip' = Nil /\ caught' = FALSE
    /\ redo' = sInflight
    /\ cursor' = sCursor /\ dv' = sdv
    /\ UNCHANGED <<slackV, unacked, rcvd, acks, dups, r20drop, liveFrom, fileV, slog, discs>>

Init ==
    /\ posted = 0
    /\ msg = [m \in M |-> [snd |-> "none", par |-> 0, dec |-> "ok", lbad |-> FALSE, ver |-> 0]]
    /\ age = [m \in M |-> 0] /\ edits = 0 /\ ages = 0
    /\ unacked = {} /\ pipe = << >> /\ rcvd = [e \in Envs |-> 0] /\ acks = [e \in Envs |-> 0]
    /\ dups = 0 /\ r20drop = {}
    /\ conn = "down" /\ hcur = N + 1 /\ todo = {} /\ gath = {} /\ held = {}
    /\ wip = Nil /\ redo = Nil /\ caught = FALSE /\ liveFrom = 0 /\ cursor = 0 /\ dv = [m \in M |-> -1]
    /\ sCursor = 0 /\ sdv = [m \in M |-> -1] /\ sInflight = Nil
    /\ slog = << >> /\ crashes = 0 /\ discs = 0

Listen ==
    \/ Receive \/ Connect \/ ReadPage \/ (\E p \in M : ReadReplies(p)) \/ ReadsDone
    \/ Begin \/ Redo \/ SaveIntent \/ Write \/ SaveDone

Next ==
    \/ PostAny \/ (\E m \in M : Edit(m) \/ Age(m)) \/ (\E e \in Envs : Resend(e))
    \/ Listen \/ Disconnect \/ Crash

Spec == Init /\ [][Next]_vars

\* R8 and the listener's own steps are fair; Slack, faults and time are not.
FairSpec ==
    /\ Spec
    /\ WF_vars(Receive) /\ WF_vars(Connect) /\ WF_vars(ReadPage)
    /\ \A p \in M : WF_vars(ReadReplies(p))
    /\ WF_vars(ReadsDone) /\ WF_vars(Begin) /\ WF_vars(Redo)
    /\ WF_vars(SaveIntent) /\ WF_vars(Write) /\ WF_vars(SaveDone)

(* ------------------------------ the rules ----------------------------- *)

SIdx == 1..Len(slog)
Written(m) == \E i \in SIdx : slog[i].k = "msg" /\ slog[i].m = m

\* R2: a message (and an edit) reaches the session at most once; every
\* repeat is marked possible_duplicate.
R2 == \A i, j \in SIdx :
        (i < j /\ slog[i].k = slog[j].k /\ slog[i].m = slog[j].m
         /\ (slog[i].k = "msg" \/ slog[i].v = slog[j].v)) => slog[j].dup

\* R2 (edits): never before or instead of the original.
R2Edit == \A j \in SIdx : slog[j].k = "edit" =>
            \E i \in 1..(j - 1) : slog[i].k = "msg" /\ slog[i].m = slog[j].m

\* R5: an edit that leaves the text as the session last saw it is noise.
R5 == \A j \in SIdx : (slog[j].k = "edit" /\ ~slog[j].dup) =>
        \A i \in 1..(j - 1) : slog[i].m = slog[j].m => slog[i].v < slog[j].v

\* R4: within a thread, and among top-level messages, in ts order. A message
\* whose live event did not decode (R20) and that a later catch-up finds may
\* arrive after newer messages of its thread.
R4 == \A i, j \in SIdx :
        (i < j /\ slog[i].k = "msg" /\ slog[j].k = "msg" /\ ~slog[j].dup
         /\ msg[slog[i].m].par = msg[slog[j].m].par
         /\ ~("r20Order" \in Excuses /\ slog[j].m \in r20drop)) => slog[i].m < slog[j].m

R10 == \A i \in SIdx : Allowed(slog[i].m)

\* R20: each frame is acknowledged once.
AckOnce == \A e \in Envs : acks[e] <= rcvd[e]

\* R7's excuses, from the rules: aged out (24 h / 7 days), skipped by
\* catch-up (R21, its live resend dropped as well), dropped live as not
\* decoding (R20, out of scope), or a reply under a parent whose thread
\* fields do not decode (R21). The model knows only the parent's ts ("badTs"),
\* not reply_count or latest_reply, and has no reply also sent to the
\* channel, which R21 does not excuse.
Excused(m) ==
    \/ msg[m].dec # "ok"
    \/ m \in r20drop
    \/ (Top(m) /\ age[m] >= 1)
    \/ (~Top(m) /\ age[msg[m].par] = 2)
    \/ ("badTsParent" \in Excuses /\ ~Top(m) /\ msg[msg[m].par].dec = "badTs")

\* Would a catch-up from cursor c read m?
Readable(m, c) ==
    /\ Fresh(m, c) /\ msg[m].dec = "ok"
    /\ IF Top(m) THEN age[m] = 0 ELSE age[msg[m].par] < 2

\* An envelope in flight that Receive will hold, not drop as stale.
InPipe(m) == (\E i \in 1..Len(pipe) : pipe[i] = Env("msg", m)) /\ ~Stale(m)
MemRec(m) ==
    /\ ~Delivered(m)
    /\ \/ \E x \in Items : x.k = "msg" /\ x.m = m
       \/ (wip # Nil /\ wip.k = "msg" /\ wip.m = m)
       \/ (redo # Nil /\ redo.k = "msg" /\ redo.m = m)
       \/ InPipe(m)
       \/ Readable(m, cursor)
SavedRec(m) ==
    \/ (sInflight # Nil /\ sInflight.k = "msg" /\ sInflight.m = m)
    \/ (sdv[m] = -1 /\ Readable(m, sCursor))

\* R7 as a safety net: a message not yet in the session can still get
\* there both from memory and from the saved file after a crash.
R7Safe == \A m \in Posted :
            (Allowed(m) /\ ~Excused(m) /\ ~Written(m)) => (MemRec(m) /\ SavedRec(m))

Rules == R2 /\ R2Edit /\ R5 /\ R4 /\ R10 /\ AckOnce /\ R7Safe

\* R7 itself: every allowed message arrives, unless excused.
R7 == \A m \in M : []((m <= posted /\ Allowed(m)) => <>(Written(m) \/ Excused(m)))

=============================================================================
