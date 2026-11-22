------------------------------- MODULE Tasks -------------------------------
(***************************************************************************)
(* The task hub's protocol (slack-listener slice B1, BER-2368), modelled   *)
(* from the brief and its addendum only, not from the code. Copied into    *)
(* the repository for B1c (2026-11-22) with three changes, each recorded   *)
(* in DECISIONS.md: claims go least recently claimed first (OldestFirst    *)
(* FALSE), a creator's command is checked for its state before its actor,  *)
(* as the code does, and a commit is split from the delivery of its reply  *)
(* (Commit, then Reply or LoseReply).                                      *)
(*                                                                         *)
(* Structure:                                                              *)
(*   - the "implementation" part: guards and new task records, as the hub *)
(*     would compute them inside one write transaction. Planted bugs hook  *)
(*     in here through the constant Bug.                                   *)
(*   - the "observer" part: each event records what was true when the      *)
(*     transaction read the store (liveBefore, holderBefore), computed     *)
(*     independently of the guards, plus ghost state for T6 and T7.        *)
(*   - the rules T1-T7 as invariants over the event log and the store.     *)
(*                                                                         *)
(* Time is a countdown per lease (left), so the state space stays finite   *)
(* without a clock bound. A write is two steps, Begin (reads the store,    *)
(* decides, holds the single-writer lock) and Commit; Crash drops a        *)
(* Begin that has not committed.                                           *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
    Principals,       \* people, lanes and runs sharing the hub
    Workers,          \* principals that poll for work (fairness, liveness configs)
    Mortal,           \* principals that may die (stop acting forever)
    NTasks,           \* task slots; a slot is "none" until created
    Keys,             \* request keys per principal
    Options,          \* the options a question offers
    BadOption,        \* an option not offered
    NoP, NoArg, Nil,  \* model values
    L,                \* lease length in ticks
    MaxEvents,        \* bound on committed events (safety configs)
    MaxCrash,         \* crash bound; 0 means unlimited
    LeaseRunsInInput, \* TRUE: the lease keeps counting down while input-required
    MemoRefusals,     \* TRUE: refusals and "none ready" are stored under their key too
    StrictT6,         \* TRUE: T6 compares with the first answer of any kind, refusals included
    WithLog,          \* FALSE: drop the log, keys and ghosts (liveness configs)
    OldestFirst,      \* TRUE: claims take the oldest ready task (the spike's first order,
                      \* which starves); FALSE: least recently claimed first, as the code
    Bug               \* "none" or the name of a planted bug

VARIABLES
    task,     \* Tasks -> [st, creator, holder, left, waitOn]
    log,      \* committed events; the cursor of event i is i
    memo,     \* request-key store: memo[p][k] = Nil or [inp, ans]
    pend,     \* the open write transaction, or Nil
    readLog,  \* what a reader following the cursor has read so far
    first,    \* ghost: first answer per key (committed only, or any if StrictT6)
    t6ok,     \* ghost: every repeated key got the first answer back
    acked,    \* ghost: keys whose success reached the client
    alive,    \* principals still acting
    crashes,
    order,    \* claim order over task slots: least recently claimed, or creation order
    out       \* a committed answer not yet delivered to its caller, or Nil

vars == <<task, log, memo, pend, readLog, first, t6ok, acked, alive, crashes, order, out>>

Tasks  == 1..NTasks
Final  == {"completed", "failed", "canceled"}
Open   == {"submitted", "working", "input-required"}
States == {"none"} \cup Open \cup Final
HolderOps == {"renew", "request", "complete", "fail"}
Max(S) == CHOOSE x \in S : \A y \in S : x >= y
Min(S) == CHOOSE x \in S : \A y \in S : x <= y

Inputs ==
    {[op |-> o, t |-> 0, arg |-> NoArg] : o \in {"create", "claim"}}
    \cup {[op |-> o, t |-> t, arg |-> NoArg] :
            o \in {"renew", "amend", "cancel", "complete", "fail"}, t \in Tasks}
    \cup {[op |-> "request", t |-> t, arg |-> w] : t \in Tasks, w \in Principals}
    \cup {[op |-> "answer", t |-> t, arg |-> a] : t \in Tasks, a \in Options \cup {BadOption}}

ClaimInput == [op |-> "claim", t |-> 0, arg |-> NoArg]

(* ------------------------- the implementation -------------------------- *)

Live(t) == task[t].st = "working" /\ task[t].left > 0

Ready(t) ==
    CASE Bug = "claimSkipsLease" -> task[t].st \in {"submitted", "working"}
      [] Bug = "noReclaim"       -> task[t].st = "submitted"
      [] Bug = "reopenCompleted" -> task[t].st \in {"submitted", "completed"}
                                    \/ (task[t].st = "working" /\ task[t].left = 0)
      [] OTHER                   -> task[t].st = "submitted"
                                    \/ (task[t].st = "working" /\ task[t].left = 0)

HolderLive(p, t, op) ==
    task[t].holder = p
    /\ (task[t].left > 0 \/ (Bug = "renewAfterLapse" /\ op = "renew"))

Refuse(c)   == [code |-> c, t |-> 0, new |-> Nil]
Ok(t, new)  == [code |-> "ok", t |-> t, new |-> new]
Ans(r)      == [code |-> r.code, t |-> r.t]

Fresh(p) == [st |-> "submitted", creator |-> p, holder |-> NoP, left |-> 0, waitOn |-> NoP]

DoCreate(p) ==
    LET free == {t \in Tasks : task[t].st = "none"}
    IN IF free = {} THEN Refuse("full") ELSE Ok(Min(free), Fresh(p))

Pos(t) == CHOOSE i \in 1..NTasks : order[i] = t
MoveLast(t) == Append(SelectSeq(order, LAMBDA x : x # t), t)

DoClaim(p) ==
    LET rd == {t \in Tasks : Ready(t)}
    IN IF rd = {} THEN Refuse("noneReady")
       ELSE LET t == CHOOSE x \in rd : \A y \in rd : Pos(x) <= Pos(y)
            IN Ok(t, [task[t] EXCEPT !.st = "working", !.holder = p, !.left = L, !.waitOn = NoP])

HolderStep(p, t, op, new) ==
    IF task[t].st # "working" THEN Refuse("wrongState")
    ELSE IF ~HolderLive(p, t, op) THEN Refuse("notHolder")
    ELSE Ok(t, new)

CreatorStep(p, t, new) ==
    IF task[t].st \in Final THEN Refuse("wrongState")
    ELSE IF task[t].creator # p THEN Refuse("notCreator")
    ELSE Ok(t, new)

DoOnTask(p, inp) ==
    LET t == inp.t IN
    IF task[t].st = "none" THEN Refuse("notFound") ELSE
    CASE inp.op = "renew" ->
            HolderStep(p, t, "renew", [task[t] EXCEPT !.left = L])
      [] inp.op = "request" ->
            HolderStep(p, t, "request",
                       [task[t] EXCEPT !.st = "input-required", !.waitOn = inp.arg])
      [] inp.op = "complete" ->
            HolderStep(p, t, "complete", [task[t] EXCEPT !.st = "completed", !.left = 0])
      [] inp.op = "fail" ->
            HolderStep(p, t, "fail", [task[t] EXCEPT !.st = "failed", !.left = 0])
      [] inp.op = "answer" ->
            IF task[t].st # "input-required" THEN Refuse("wrongState")
            ELSE IF task[t].waitOn # p /\ Bug # "answerAnyPrincipal" THEN Refuse("notWaitedOn")
            ELSE IF inp.arg \notin Options /\ Bug # "answerAnyOption" THEN Refuse("badOption")
            ELSE Ok(t, [task[t] EXCEPT !.st = "working", !.waitOn = NoP])
      [] inp.op = "amend" ->
            CreatorStep(p, t, task[t])
      [] inp.op = "cancel" ->
            CreatorStep(p, t, [task[t] EXCEPT !.st = "canceled", !.left = 0,
                               !.waitOn = IF Bug = "cancelKeepsWait" THEN @ ELSE NoP])

Outcome(p, inp) ==
    CASE inp.op = "create" -> DoCreate(p)
      [] inp.op = "claim"  -> DoClaim(p)
      [] OTHER             -> DoOnTask(p, inp)

(* ---------------------------- the observer ----------------------------- *)

MkEvent(p, k, inp, r) ==
    [t |-> r.t, kind |-> inp.op, actor |-> p, key |-> k, arg |-> inp.arg,
     from |-> task[r.t].st, to |-> r.new.st,
     liveBefore |-> Live(r.t), holderBefore |-> task[r.t].holder,
     leftAfter |-> r.new.left]

\* A response for (p, k, inp) reaches the client. committed: it came from a commit.
Deliver(p, k, inp, a, committed) ==
    IF ~WithLog THEN UNCHANGED <<first, t6ok, acked>>
    ELSE LET f == first[p][k] IN
         /\ t6ok' = (t6ok /\ (f = Nil \/ IF f.inp = inp THEN a = f.ans ELSE a.code = "conflict"))
         /\ first' = IF f = Nil /\ (committed \/ StrictT6)
                     THEN [first EXCEPT ![p][k] = [inp |-> inp, ans |-> a]] ELSE first
         /\ acked' = IF a.code = "ok" THEN acked \cup {<<p, k>>} ELSE acked

(* ------------------------------ the actions ---------------------------- *)

Init ==
    /\ task = [t \in Tasks |-> [st |-> "none", creator |-> NoP, holder |-> NoP,
                                left |-> 0, waitOn |-> NoP]]
    /\ log = <<>>
    /\ memo = [p \in Principals |-> [k \in Keys |-> Nil]]
    /\ pend = Nil
    /\ readLog = <<>>
    /\ first = [p \in Principals |-> [k \in Keys |-> Nil]]
    /\ t6ok = TRUE
    /\ acked = {}
    /\ alive = [p \in Principals |-> TRUE]
    /\ crashes = 0
    /\ order = [i \in 1..NTasks |-> i]
    /\ out = Nil

Begin(p, k, inp) ==
    /\ pend = Nil
    /\ out = Nil
    /\ alive[p]
    /\ LET m == IF WithLog THEN memo[p][k] ELSE Nil IN
       IF m # Nil /\ Bug # "ignoreMemo"
       THEN \* a repeated key: answer from the key store, write nothing
            /\ Deliver(p, k, inp,
                       IF m.inp = inp THEN m.ans ELSE [code |-> "conflict", t |-> 0], FALSE)
            /\ UNCHANGED <<task, log, memo, pend, readLog, alive, crashes, order, out>>
       ELSE
         LET r == Outcome(p, inp) IN
         IF r.code = "ok"
         THEN LET ev == MkEvent(p, k, inp, r) IN
              /\ WithLog => Len(log) < MaxEvents
              /\ pend' = [p |-> p, k |-> k, inp |-> inp, r |-> r, ev |-> ev,
                          ord |-> IF inp.op = "claim" /\ ~OldestFirst
                                  THEN MoveLast(r.t) ELSE order]
              /\ log' = IF WithLog /\ Bug \in {"eventOutsideTx", "dirtyRead"}
                        THEN Append(log, ev) ELSE log
              /\ memo' = IF Bug = "memoOutsideTx"
                         THEN [memo EXCEPT ![p][k] = [inp |-> inp, ans |-> Ans(r)]] ELSE memo
              /\ UNCHANGED <<task, readLog, first, t6ok, acked, alive, crashes, order, out>>
         ELSE \* a refusal or "none ready": no event; stored only if MemoRefusals
              /\ Deliver(p, k, inp, Ans(r), FALSE)
              /\ memo' = IF WithLog /\ MemoRefusals
                         THEN [memo EXCEPT ![p][k] = [inp |-> inp, ans |-> Ans(r)]] ELSE memo
              /\ UNCHANGED <<task, log, pend, readLog, alive, crashes, order, out>>

Commit ==
    /\ pend # Nil
    /\ task' = [task EXCEPT ![pend.r.t] = pend.r.new]
    /\ log' = IF WithLog /\ Bug \notin {"eventOutsideTx", "dirtyRead"}
              THEN Append(log, pend.ev) ELSE log
    /\ memo' = IF WithLog
               THEN [memo EXCEPT ![pend.p][pend.k] = [inp |-> pend.inp, ans |-> Ans(pend.r)]]
               ELSE memo
    \* The committed answer is the key's first answer, delivered or not.
    /\ first' = IF WithLog /\ first[pend.p][pend.k] = Nil
                THEN [first EXCEPT ![pend.p][pend.k] = [inp |-> pend.inp, ans |-> Ans(pend.r)]]
                ELSE first
    /\ out' = [p |-> pend.p, k |-> pend.k, inp |-> pend.inp, ans |-> Ans(pend.r)]
    /\ pend' = Nil
    /\ order' = pend.ord
    /\ UNCHANGED <<readLog, t6ok, acked, alive, crashes>>

\* The committed answer reaches its caller.
Reply ==
    /\ out # Nil
    /\ Deliver(out.p, out.k, out.inp, out.ans, TRUE)
    /\ out' = Nil
    /\ UNCHANGED <<task, log, memo, pend, readLog, alive, crashes, order>>

\* The process dies after the commit, before the reply: the caller never sees
\* it, and a retry under the same key gets the committed answer.
LoseReply ==
    /\ out # Nil
    /\ out' = Nil
    /\ UNCHANGED <<task, log, memo, pend, readLog, first, t6ok, acked, alive, crashes, order>>

\* The process dies with a transaction open: the store keeps the last commit.
Crash ==
    /\ pend # Nil
    /\ MaxCrash = 0 \/ crashes < MaxCrash
    /\ pend' = Nil
    /\ crashes' = IF MaxCrash = 0 THEN crashes ELSE crashes + 1
    /\ log' = IF Bug = "dirtyRead" THEN SubSeq(log, 1, Len(log) - 1) ELSE log
    /\ UNCHANGED <<task, memo, readLog, first, t6ok, acked, alive, order, out>>

Running(t) ==
    task[t].left > 0
    /\ (task[t].st = "working" \/ (LeaseRunsInInput /\ task[t].st = "input-required"))

Tick ==
    /\ pend = Nil
    /\ out = Nil
    /\ \E t \in Tasks : Running(t)
    /\ task' = [t \in Tasks |-> IF Running(t) THEN [task[t] EXCEPT !.left = @ - 1] ELSE task[t]]
    /\ UNCHANGED <<log, memo, pend, readLog, first, t6ok, acked, alive, crashes, order, out>>

ReadEvent ==
    /\ WithLog
    /\ Len(readLog) < Len(log)
    /\ readLog' = Append(readLog, log[Len(readLog) + 1])
    /\ UNCHANGED <<task, log, memo, pend, first, t6ok, acked, alive, crashes, order, out>>

Die(p) ==
    /\ p \in Mortal /\ alive[p]
    /\ alive' = [alive EXCEPT ![p] = FALSE]
    /\ UNCHANGED <<task, log, memo, pend, readLog, first, t6ok, acked, crashes, order, out>>

Next ==
    \/ \E p \in Principals, k \in Keys, inp \in Inputs : Begin(p, k, inp)
    \/ Commit
    \/ Reply
    \/ LoseReply
    \/ Crash
    \/ Tick
    \/ ReadEvent
    \/ \E p \in Principals : Die(p)

Spec == Init /\ [][Next]_vars

ClaimStep(p) == \E k \in Keys : Begin(p, k, ClaimInput)

FairSpec ==
    Spec
    /\ SF_vars(Tick)
    /\ WF_vars(Commit)
    /\ WF_vars(Reply \/ LoseReply)
    /\ \A p \in Workers : SF_vars(ClaimStep(p))

(* ------------------------------- the rules ----------------------------- *)

Idx == 1..Len(log)
AtRest == pend = Nil
PrevIdx(i) == {j \in 1..(i - 1) : log[j].t = log[i].t}
PrevTo(i) == IF PrevIdx(i) = {} THEN "none" ELSE log[Max(PrevIdx(i))].to
EvIdx(t) == {j \in Idx : log[j].t = t}
LastTo(t) == IF EvIdx(t) = {} THEN "none" ELSE log[Max(EvIdx(t))].to
LastKind(t) == IF EvIdx(t) = {} THEN "none" ELSE log[Max(EvIdx(t))].kind

\* The transition table the rules allow: <<from, action, to>>.
Table ==
    {<<"none", "create", "submitted">>,
     <<"submitted", "claim", "working">>,
     <<"working", "claim", "working">>,              \* re-claim after the lease lapsed
     <<"working", "renew", "working">>,
     <<"working", "request", "input-required">>,
     <<"input-required", "answer", "working">>,
     <<"working", "complete", "completed">>,
     <<"working", "fail", "failed">>}
    \cup {<<s, "amend", s>> : s \in Open}
    \cup {<<s, "cancel", "canceled">> : s \in Open}

\* T1. A task is in exactly one state and changes it only by the table.
T1 ==
    /\ \A t \in Tasks : task[t].st \in States
    /\ \A i \in Idx : <<log[i].from, log[i].kind, log[i].to>> \in Table

\* T2. A claim never takes a live lease; holder-only actions come from the
\* live holder.
T2 ==
    \A i \in Idx :
        /\ log[i].kind \in HolderOps =>
               log[i].holderBefore = log[i].actor /\ log[i].liveBefore
        /\ log[i].kind = "claim" => ~log[i].liveBefore

\* T3. Final at most once, never left.
T3 ==
    \A i, j \in Idx : (i < j /\ log[i].t = log[j].t) => log[i].to \notin Final

\* T4. Every change is one event with its actor; at rest the store is the
\* fold of the log; a reader following the cursor saw a prefix of the log.
T4 ==
    /\ \A i \in Idx : log[i].actor \in Principals /\ log[i].from = PrevTo(i)
    /\ AtRest => \A t \in Tasks : task[t].st = LastTo(t)
    /\ Len(readLog) <= Len(log)
    /\ readLog = SubSeq(log, 1, Len(readLog))

\* T5. Only the principal waited on answers, and only with an offered option.
T5 ==
    \A i \in Idx :
        log[i].kind = "answer" =>
            /\ log[i].arg \in Options
            /\ LET rq == {j \in PrevIdx(i) : log[j].kind = "request"}
               IN rq # {} /\ log[Max(rq)].arg = log[i].actor

\* T6. A repeated key returns the first answer and changes nothing.
T6 ==
    /\ t6ok
    /\ \A i, j \in Idx : i # j =>
           <<log[i].actor, log[i].key>> # <<log[j].actor, log[j].key>>

\* T7. At rest after any crash: every success a client saw, and every stored
\* success under a key, has its committed event.
HasEvent(p, k) == \E i \in Idx : log[i].actor = p /\ log[i].key = k
T7 ==
    AtRest =>
        /\ \A pk \in acked : HasEvent(pk[1], pk[2])
        /\ \A p \in Principals, k \in Keys :
               (memo[p][k] # Nil /\ memo[p][k].ans.code = "ok") => HasEvent(p, k)

\* The addendum's "tasks waiting on P" query reads waitOn: it must be set
\* exactly when the task is input-required.
WaitingQuery ==
    \A t \in Tasks : (task[t].waitOn # NoP) <=> (task[t].st = "input-required")

\* Design question: an answered task goes back to its asker with a live lease.
AnswerReturnsToAsker ==
    \A i \in Idx : log[i].kind = "answer" => log[i].leftAfter > 0

\* What the code can be compared with: the ghosts (first, t6ok, acked), the
\* reader (readLog), alive and crashes are observer state. b1-export.cfg
\* fingerprints states by this view, so the exported graph has one state per
\* code-visible state; its paths are still real behaviours of Spec.
ExportView == <<task, log, memo, pend, out, order>>

\* Principals, keys and options are interchangeable in the safety configs.
Sym == Permutations(Principals) \cup Permutations(Keys) \cup Permutations(Options)

Rules == T1 /\ T2 /\ T3 /\ T4 /\ T5 /\ T6 /\ T7 /\ WaitingQuery

(* ------------------------------ liveness ------------------------------- *)

Stale(t) == task[t].st = "working" /\ task[t].left > 0 /\ ~alive[task[t].holder]

\* A working task whose holder stopped (died) eventually becomes claimable.
StaleLeaseLapses == \A t \in Tasks : Stale(t) ~> ~Stale(t)

\* A lapsed working task is eventually re-claimed (or ended), given a live,
\* fairly polling worker.
LapsedIsReclaimed ==
    \A t \in Tasks :
        (task[t].st = "working" /\ task[t].left = 0)
            ~> (task[t].st # "working" \/ task[t].left > 0)

\* Design question: does a question always end? (Expected to fail.)
InputRequiredEnds ==
    \A t \in Tasks : (task[t].st = "input-required") ~> (task[t].st # "input-required")

=============================================================================
