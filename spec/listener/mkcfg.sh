#!/bin/sh
# Writes one Listener configuration next to this script.
# Usage: mkcfg.sh name comment N MaxCrash MaxDisc MaxDup MaxAge MaxEdits Senders Decodes LiveBads Margin Excuses [spec] [bug] [checks]
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
name=$1; shift
cat > "$here/$name.cfg" <<CFG
\\* $1
SPECIFICATION ${13:-Spec}
CONSTANTS
    N = $2
    PS = 2
    Margin = ${11}
    MaxCrash = $3
    MaxDisc = $4
    MaxDup = $5
    MaxAge = $6
    MaxEdits = $7
    Senders = $8
    Decodes = $9
    LiveBads = ${10}
    Excuses = ${12}
    Bug = ${14:-"none"}
    Nil = Nil
${15:-INVARIANTS R2 R2Edit R5 R4 R10 AckOnce R7Safe}
CHECK_DEADLOCK FALSE
CFG
