----------------------------- MODULE TraceTasks -----------------------------
(***************************************************************************)
(* Trace validation of the hub against Tasks.tla (B1c, after Cirstea,      *)
(* Kuppe, Loillier and Merz 2024). The hub simulator's bounded mode        *)
(* records one line per step: a call with its principal, key, input and    *)
(* answer, a call whose answer was lost to a crash after its commit, or a  *)
(* wait of whole ticks, each with alpha of the store after it              *)
(* (src/hub/sim/alpha.ts). validate.ts writes the lines into Tr below.     *)
(*                                                                         *)
(* Each line is one group of the spec's own steps: a call is Begin, then   *)
(* Commit and Reply when it commits; a lost answer is Begin, Commit and    *)
(* LoseReply (or Begin alone for a stored refusal); a wait is any number   *)
(* of Ticks. The group must end at rest with the spec's alpha equal to the *)
(* line's. A crash that left the store as it was is a stutter: no line.    *)
(* TLC searches for a behaviour that consumes every line; reaching the end *)
(* violates NotAccepted, which is the acceptance.                          *)
(***************************************************************************)
EXTENDS Tasks
CONSTANTS p1, p2, k1, k2, o1, o2, o3
VARIABLES i, ph

Tr == <<>> \* TRACE: validate.ts replaces this line

AlphaNow ==
    [task |-> task,
     log |-> [j \in 1..Len(log) |->
                [t |-> log[j].t, kind |-> log[j].kind, actor |-> log[j].actor,
                 key |-> log[j].key, arg |-> log[j].arg, to |-> log[j].to]],
     memo |-> memo]

Line == Tr[i]

\* The answer the line reports is the one the key now holds.
AnswerFits(l) ==
    /\ memo[l.p][l.k] # Nil
    /\ IF l.ans = "conflict"
       THEN memo[l.p][l.k].inp # l.inp
       ELSE memo[l.p][l.k].inp = l.inp /\ memo[l.p][l.k].ans.code = l.ans

TInit == Init /\ i = 1 /\ ph = "rest" /\ AlphaNow = Tr[1].alpha

Start ==
    /\ ph = "rest"
    /\ i < Len(Tr)
    /\ LET l == Tr[i + 1] IN
         IF l.kind = "tick" THEN UNCHANGED vars ELSE Begin(l.p, l.k, l.inp)
    /\ i' = i + 1
    /\ ph' = "busy"

Inside ==
    /\ ph = "busy"
    /\ UNCHANGED <<i, ph>>
    /\ \/ Line.kind \in {"call", "lost"} /\ Commit
       \/ Line.kind = "call" /\ Reply
       \/ Line.kind = "lost" /\ LoseReply
       \/ Line.kind = "tick" /\ Tick

Finish ==
    /\ ph = "busy"
    /\ pend = Nil
    /\ out = Nil
    /\ AlphaNow = Line.alpha
    /\ Line.kind = "call" => AnswerFits(Line)
    /\ ph' = "rest"
    /\ UNCHANGED <<vars, i>>

TNext == Start \/ Inside \/ Finish

\* Violated when the whole trace was consumed: the trace is accepted.
NotAccepted == ~(i = Len(Tr) /\ ph = "rest")

\* Violated when line Upto was reached at rest; validate.ts uses it to find
\* how far a rejected trace got.
Upto == 0 \* UPTO: validate.ts replaces this line
NotReached == ~(i >= Upto /\ ph = "rest")
=============================================================================
