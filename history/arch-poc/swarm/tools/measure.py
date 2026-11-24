# Plants a mutant (or none), runs seeds first..last of one simulator on 8
# processes, plain or swarm, keeps the raw output, restores with cp and cmp.
# usage: python3 -I measure.py listener|hub <mutant|none> 0|1 first last length tag
import subprocess, sys, os, shutil, time, json, filecmp
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutants import LISTENER, HUB
ROOT = os.environ["SWARM_CHECKOUT"]
S = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
kind, name, swarm, first, last, length, tag = sys.argv[1:8]
first, last = int(first), int(last)
procs = 8
plants = [] if name == "none" else (LISTENER if kind == "listener" else HUB)[name]
aside = os.path.join(S, "aside"); os.makedirs(aside, exist_ok=True)
files = sorted({f for f, _, _ in plants})
for f in files: shutil.copyfile(os.path.join(ROOT, f), os.path.join(aside, os.path.basename(f)))
try:
  for f, old, new in plants:
    p = os.path.join(ROOT, f); s = open(p).read()
    assert s.count(old) == 1, f"{name}: found {s.count(old)}"
    open(p, "w").write(s.replace(old, new))
  n = last - first + 1; size = (n + procs - 1) // procs
  t0 = time.time(); running = []
  for i in range(procs):
    a = first + i * size; b = min(last, a + size - 1)
    if a > b: break
    running.append(subprocess.Popen(["timeout", "1800", "bun", os.path.join(S, "tools/range.ts"), ROOT, kind, swarm, str(a), str(b), length], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True))
  outs = []
  for p in running:
    o, e = p.communicate()
    if p.returncode != 0: print("process failed", p.returncode, e[-2000:]); sys.exit(1)
    outs.append(o)
  wall = time.time() - t0
finally:
  for f in files:
    shutil.copyfile(os.path.join(aside, os.path.basename(f)), os.path.join(ROOT, f))
    r = subprocess.run(["cmp", os.path.join(aside, os.path.basename(f)), os.path.join(ROOT, f)])
    assert r.returncode == 0, f"restore of {f} differs"
rows = []; cov = {}
for o in outs:
  for line in o.split("\n"):
    if line.startswith("COV\t"):
      for k, v in json.loads(line[4:]).items(): cov[k] = cov.get(k, 0) + v
    elif line.strip(): rows.append(line)
out = os.path.join(S, "raw", f"{tag}.tsv")
with open(out, "w") as fh:
  fh.write("\n".join(rows) + "\n"); fh.write("COV\t" + json.dumps(cov) + "\n"); fh.write(f"WALL\t{wall:.1f}\n")
fails = sum(1 for r in rows if r.split("\t")[1] == "0")
ms = sum(float(r.split("\t")[2]) for r in rows)
print(f"{tag}: {fails}/{len(rows)} fail, run-ms total {ms:.0f} (mean {ms/len(rows):.2f}), wall {wall:.1f}s, restored cmp ok")
