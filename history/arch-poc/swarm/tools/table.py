# Kill table from raw/*.tsv: per block of seeds (a seed offset), failing runs,
# summed run time, and runs to the first kill.
# usage: python3 -I table.py <block> tag...
import sys, os, statistics as st
S = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
block = int(sys.argv[1])
for tag in sys.argv[2:]:
  rows = []
  for line in open(os.path.join(S, "raw", tag + ".tsv")):
    p = line.rstrip("\n").split("\t")
    if p[0].isdigit(): rows.append((int(p[0]), p[1] == "1", float(p[2]), p[3] if len(p) > 3 else ""))
  rows.sort()
  blocks = [rows[i:i + block] for i in range(0, len(rows), block)]
  kills = [sum(1 for r in b if not r[1]) for b in blocks]
  secs = [sum(r[2] for r in b) / 1000 for b in blocks]
  first = []
  for b in blocks:
    idx = next((i + 1 for i, r in enumerate(b) if not r[1]), None)
    first.append(idx if idx is not None else f">{len(b)}")
  rate = [k / len(b) for k, b in zip(kills, blocks)]
  kps = [k / s for k, s in zip(kills, secs)]
  print(f"{tag}: kills/block {kills} mean {st.mean(kills):.1f} (min {min(kills)}, max {max(kills)}), rate {100*st.mean(rate):.2f}%, "
        f"run-s/block {st.mean(secs):.1f}, kills per run-s {st.mean(kps):.3f} ({min(kps):.3f}-{max(kps):.3f}), first kill at run {first}")
