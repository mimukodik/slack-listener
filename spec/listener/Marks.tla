------------------------------ MODULE Marks ------------------------------
(***************************************************************************)
(* R18's seen and done marks, modelled from RULES.md only.                 *)
(*                                                                         *)
(* Messages 1..N in ts order; each is top-level or a reply in the thread   *)
(* of an earlier top-level one, posted by the other side, an own-side     *)
(* person (typed) or an own-side agent. The listener delivers the first   *)
(* two kinds (R10), marks them seen (:eyes:), and done (:check:) when a   *)
(* post of the own side appears in the thread or the session marks done.  *)
(* Reaction calls run from a queue saved with the marks; each call can    *)
(* fail or lose its reply, is tried at most 3 times, then given up. When  *)
(* adding done is given up, seen stays: its queued removal is dropped.    *)
(* A crash restores the marks and the queue from the last save.           *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS N, MaxCrash, MaxFail, Handled, Bug, Nil

VARIABLES posted, snd, th,          \* Slack: author kind and thread per ts
          rx,                       \* Slack: own reactions per message
          dlv, mark, q, doneReq,    \* listener memory
          smark, sq, sDoneReq, sdlv, \* saved state file
          dirty,                    \* memory differs from the file
          gaveUp, shown, eyesAfterCheck, fails, crashes

vars == <<posted, snd, th, rx, dlv, mark, q, doneReq, smark, sq, sDoneReq, sdlv, dirty,
          gaveUp, shown, eyesAfterCheck, fails, crashes>>

M == 1..N
Posted == 1..posted
Own(m) == snd[m] \in {"ownTyped", "ownAgent"}
Deliverable(m) == snd[m] \in {"other", "ownTyped"}     \* R10

\* R18: "a post of the own side appears in that message's thread".
\*   "ordered": a later own post in the thread, or the session marked it done.
\*   "literal": any own post in the thread, the message itself included.
IsHandled(m) ==
    \/ m \in doneReq
    \/ \E o \in Posted : Own(o) /\ th[o] = th[m]
                         /\ (IF Handled = "ordered" THEN o > m ELSE TRUE)

Call(op, e, m) == [op |-> op, e |-> e, m |-> m, tries |-> 0]
\* The calls that replace eyes by check: add the second, then remove the first.
Replace(m) == IF Bug = "removeFirst" THEN << Call("rm", "eyes", m), Call("add", "check", m) >>
              ELSE << Call("add", "check", m), Call("rm", "eyes", m) >>

RECURSIVE ReplaceAll(_)
ReplaceAll(S) == IF S = {} THEN << >>
                 ELSE LET x == CHOOSE y \in S : \A z \in S : y <= z
                      IN Replace(x) \o ReplaceAll(S \ {x})

Post(s, t) ==
    /\ posted < N
    /\ LET m == posted + 1 IN
       /\ posted' = m
       /\ snd' = [snd EXCEPT ![m] = s]
       /\ th' = [th EXCEPT ![m] = IF t = 0 THEN m ELSE t]
       \* An own post marks every delivered, seen message of its thread done.
       /\ LET hit == {x \in dlv : mark[x] = "seen" /\ th[x] = (IF t = 0 THEN m ELSE t)
                                   /\ s \in {"ownTyped", "ownAgent"}
                                   /\ (Handled = "literal" \/ m > x)}
          IN /\ mark' = [x \in M |-> IF x \in hit THEN "done" ELSE mark[x]]
             /\ q' = q \o ReplaceAll(hit)
             /\ dirty' = (dirty \/ hit # {})
    /\ UNCHANGED <<rx, dlv, doneReq, smark, sq, sDoneReq, sdlv, gaveUp, shown, eyesAfterCheck, fails, crashes>>

PostAny == \E s \in {"other", "ownTyped", "ownAgent"},
              t \in {0} \cup {x \in Posted : th[x] = x} : Post(s, t)

Deliver(m) ==
    /\ m \in Posted /\ Deliverable(m) /\ m \notin dlv
    /\ dlv' = dlv \cup {m}
    /\ IF IsHandled(m) /\ Bug # "ignoreHandled"
         THEN /\ mark' = [mark EXCEPT ![m] = "done"] /\ q' = Append(q, Call("add", "check", m))
         ELSE /\ mark' = [mark EXCEPT ![m] = "seen"] /\ q' = Append(q, Call("add", "eyes", m))
    /\ dirty' = TRUE
    /\ UNCHANGED <<posted, snd, th, rx, doneReq, smark, sq, sDoneReq, sdlv, gaveUp, shown, eyesAfterCheck, fails, crashes>>

\* The session marks a message done (only its ts).
Done(m) ==
    /\ m \in Posted /\ m \notin doneReq
    /\ doneReq' = doneReq \cup {m}
    /\ IF m \in dlv /\ mark[m] = "seen"
         THEN /\ mark' = [mark EXCEPT ![m] = "done"] /\ q' = q \o Replace(m)
         ELSE UNCHANGED <<mark, q>>
    \* The done request is saved before the session gets its answer.
    /\ IF Bug = "doneNotSaved" THEN /\ dirty' = TRUE /\ UNCHANGED <<smark, sq, sDoneReq, sdlv>>
       ELSE /\ sDoneReq' = doneReq' /\ smark' = mark' /\ sq' = q' /\ sdlv' = dlv /\ dirty' = FALSE
    /\ UNCHANGED <<posted, snd, th, rx, dlv, gaveUp, shown, eyesAfterCheck, fails, crashes>>

Save ==
    /\ dirty
    /\ smark' = mark /\ sq' = q /\ sDoneReq' = doneReq /\ sdlv' = dlv /\ dirty' = FALSE
    /\ UNCHANGED <<posted, snd, th, rx, dlv, mark, q, doneReq, gaveUp, shown, eyesAfterCheck, fails, crashes>>

Apply(c) ==
    LET r == rx[c.m] IN
    IF c.op = "add" THEN r \cup {c.e} ELSE r \ {c.e}

\* One try of a queued call: ok, failed (not applied), or applied with the reply lost.
\* already_reacted / no_reaction count as success.
\* R18: when adding the check is given up, the eyes stay, so the queued
\* removal of that message's eyes is dropped (planted back by "giveUpRemoves").
KeepEyes(c, rest) ==
    IF c.op = "add" /\ c.e = "check" /\ Bug # "giveUpRemoves"
      THEN SelectSeq(rest, LAMBDA x : ~(x.op = "rm" /\ x.e = "eyes" /\ x.m = c.m))
      ELSE rest

Exec(i, outcome) ==
    /\ i \in 1..Len(q) /\ (i = 1 \/ Bug = "unordered")
    \* The queue is saved before each call (R18), so a restart repeats at most one call.
    /\ (~dirty \/ Bug = "lazySave")
    /\ outcome \in {"ok", "fail", "lost"}
    /\ outcome # "ok" => fails < MaxFail
    /\ LET c == q[i]
           applied == outcome \in {"ok", "lost"}
           rest == SubSeq(q, 1, i - 1) \o SubSeq(q, i + 1, Len(q))
           again == [c EXCEPT !.tries = @ + 1]
       IN /\ rx' = IF applied THEN [rx EXCEPT ![c.m] = Apply(c)] ELSE rx
          /\ shown' = IF applied /\ Apply(c) # {} THEN shown \cup {c.m} ELSE shown
          /\ eyesAfterCheck' = IF applied /\ c.op = "add" /\ c.e = "eyes" /\ "check" \in rx[c.m]
                               THEN eyesAfterCheck \cup {c.m} ELSE eyesAfterCheck
          /\ IF outcome = "ok" THEN /\ q' = rest /\ UNCHANGED gaveUp
             ELSE IF again.tries >= 3
               THEN /\ q' = KeepEyes(c, rest) /\ gaveUp' = gaveUp \cup {[e |-> c.e, op |-> c.op, m |-> c.m]}
               ELSE /\ q' = [q EXCEPT ![i] = again] /\ UNCHANGED gaveUp
          /\ fails' = IF outcome = "ok" THEN fails ELSE fails + 1
    /\ dirty' = TRUE
    /\ UNCHANGED <<posted, snd, th, dlv, mark, doneReq, smark, sq, sDoneReq, sdlv, crashes>>

\* Restart from the file. A delivery not yet saved is delivered again
\* (R2's possible_duplicate, Listener.tla), so it is marked again.
Crash ==
    /\ crashes < MaxCrash
    /\ crashes' = crashes + 1
    /\ doneReq' = sDoneReq /\ dlv' = sdlv /\ dirty' = FALSE
    \* On restart, a seen message whose thread got an own post since is done.
    /\ LET hit == {x \in sdlv : smark[x] = "seen" /\ IsHandled(x)}
       IN /\ mark' = [x \in M |-> IF x \in hit /\ Bug # "noReconcile" THEN "done" ELSE smark[x]]
          /\ q' = sq \o (IF Bug = "noReconcile" THEN << >> ELSE ReplaceAll(hit))
    /\ UNCHANGED <<posted, snd, th, rx, smark, sq, sDoneReq, sdlv, gaveUp, shown, eyesAfterCheck, fails>>

Init ==
    /\ posted = 0 /\ snd = [m \in M |-> "none"] /\ th = [m \in M |-> 0]
    /\ rx = [m \in M |-> {}]
    /\ dlv = {} /\ mark = [m \in M |-> "none"] /\ q = << >> /\ doneReq = {}
    /\ smark = mark /\ sq = << >> /\ sDoneReq = {} /\ sdlv = {} /\ dirty = FALSE
    /\ gaveUp = {} /\ shown = {} /\ eyesAfterCheck = {} /\ fails = 0 /\ crashes = 0

Next ==
    \/ PostAny \/ \E m \in M : Deliver(m) \/ Done(m)
    \/ Save \/ Crash
    \/ \E i \in 1..Len(q), o \in {"ok", "fail", "lost"} : Exec(i, o)

Spec == Init /\ [][Next]_vars

(* ------------------------------ the rules ----------------------------- *)

GaveUp(m) == \E g \in gaveUp : g.m = m

\* R18: when adding the second is given up, the first stays. Once a mark
\* showed on a message, it never shows none, give-ups included; only a
\* message whose first add was given up, and so never showed a mark, can be
\* bare. The queue has no limit here, so R18's other bare case, a first
\* reaction dropped because the queue was full, is not modelled.
NeverBare == \A m \in shown : rx[m] # {}

\* R18: done is final; eyes never come back after check.
DoneSticks == eyesAfterCheck = {}

\* R18: the two must differ, and at rest the mark shows exactly.
AtRest == (q = << >> /\ ~dirty) =>
            \A m \in dlv : ~GaveUp(m) =>
              rx[m] = (IF mark[m] = "done" THEN {"check"} ELSE {"eyes"})

\* Done means handled in the ordered sense: the session said so, or the own
\* side posted in the thread after the message.
DoneMeansAnswered == \A m \in dlv : "check" \in rx[m] =>
    \/ m \in doneReq
    \/ \E o \in Posted : Own(o) /\ th[o] = th[m] /\ o > m

\* A done the session made, once saved, shows on a delivered message.
DoneHolds == \A m \in M : (m \in dlv /\ m \in sDoneReq) => mark[m] = "done" \/ m \notin dlv

=============================================================================
