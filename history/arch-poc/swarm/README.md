# Swarm testing: measured and dropped

**What it is:** swarm testing switches a random part of the test generator off for a whole run. In our simulators, each kind of action and each kind of fault was on with probability ½, drawn from the run's seed. The idea ([Groce et al., ISSTA 2012](https://users.cs.utah.edu/~regehr/papers/swarm12.pdf)) is that without some features, the rest get used more deeply. The paper's example is a stack that rarely fills while tests keep popping items off it. [TigerBeetle's simulator](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/ARCHITECTURE.md) and [Hypothesis](https://hypothesis.works/articles/rule-based-stateful-testing/) both use it.

**Why we tried it:** to find out whether it finds our bugs in less time.

**The bar, written down before measuring:** keep it only if a planted bug declared in advance is caught more often in the same run time, without the simulators exercising less of the code. Otherwise drop the code and keep the numbers. [The experiment brief](brief.md).

## The result

**Dropped in both simulators.**

- With equal run time, swarm caught 18 of the 19 planted bugs less often than ordinary runs.
- It lowered most coverage counters, which count how often each behaviour happens: 16 of the listener's 28 and 11 of the hub's 16, per second of run time.
- The swarm code was built ([`ce030f8`](https://github.com/mimukodik/slack-listener/commit/ce030f8)), measured and removed again ([`81bf2fc`](https://github.com/mimukodik/slack-listener/commit/81bf2fc)). Ordinary runs were unchanged throughout: with swarm switched off, every seed's result matched main.

**Why it lost here:** our hard bugs need several behaviours in the same run. Take the 👀 mark that says a message arrived. When the session marks the message done, the listener adds ✅ and removes 👀. One planted bug removed 👀 even when adding ✅ kept failing. To expose it, a run needs both the session's `done` and Slack refusing the reaction. A swarm run that switches either one off can't find it:

- Ordinary runs caught this bug in 803 of 10,000 seeds.
- Swarm caught it in 540 of the same seeds, and was still behind after allowing for its cheaper runs.

Swarm pays off when one behaviour crowds another out, as popping keeps the stack from filling. Nothing in either of our simulated worlds does that.

**The one exception:** a session line that isn't JSON was caught about 28% more often per second. The gain came only from swarm runs being cheaper; per run, the two modes were even. In the same runs, coverage fell. For example, malformed Slack API answers occurred only 36% as often per second.

|                                                                 | Ordinary runs  | Swarm runs     |
| --------------------------------------------------------------- | -------------- | -------------- |
| Listener bugs caught more often per second                      | 11 of 12       | 1 of 12        |
| Hub bugs caught more often per second                           | 7 of 7         | 0 of 7         |
| The two hardest listener bugs (L5, L10), caught in 10,000 seeds | 12 and 10      | 5 and 1        |
| Average run time on the correct code, listener / hub            | 30 ms / 155 ms | 21 ms / 102 ms |

Each bug with its plant, the rule it breaks and its rate: [the planted bugs](mutants.md). The full tables with per-block spread and coverage: [the decision entry](entry.md).

## Two bugs no run reached

Two planted bugs were caught in 0 of 10,000 runs. Both plants took, but the simulated world never runs the code they changed:

- **L8, a stale live message not dropped.** Only a message that decodes live but not in catch-up history reaches this code. The fake Slack's unreadable messages are unreadable both ways.
- **L12, a shorter pruning horizon.** Pruning forgets entries older than 24 hours, and no sampled run lasts 24 simulated hours.

Swarm only switches behaviours off, so it couldn't reach them either. Both were replaced before any swarm code existed, and both are kept in the record with their zeros. They mark two gaps in the simulator, not in swarm testing.

## Check the numbers yourself

**What was run:**

- **Listener:** 10,000 seeds of 120 actions per bug and mode.
- **Hub:** 2,500 seeds of 80 calls.
- Each total ran in five blocks.
- The baseline was `3a36ac7`.

**The archive:** [measurements.zip](measurements.zip) holds every seed table, the campaign log, the coverage summary and the two reference tables. Its SHA-256 is `2cada7904fffdfbcdd38f4639dd5353bd170827c7db53383e70cebdf3e5e8942`. Each seed row has the seed, the outcome (0 means the planted bug was caught) and the run time in milliseconds.

**Rebuild the reported tables from the raw rows.** Run this from the repository root, with Python 3 and unzip; both diffs should be empty:

```sh
(
  set -eu
  study=$PWD/history/arch-poc/swarm
  scratch=$(mktemp -d)
  cp -R "$study/tools" "$scratch/tools"
  unzip -q "$study/measurements.zip" -d "$scratch"
  cd "$scratch"
  for arm in listener hub; do
    case "$arm" in listener) block=2000 ;; hub) block=500 ;; esac
    reference="raw/table-$arm.txt"
    sed 's/:.*//' "$reference" | xargs python3 -I tools/table.py "$block" > "$arm.txt"
    diff -u "$reference" "$arm.txt" && echo "$arm: identical"
  done
)
```

**Rerun the whole campaign:** use a throwaway checkout of `ce030f8` with its locked dependencies installed, and set `SWARM_CHECKOUT` to its path. Then run `sh tools/campaign.sh` from a scratch directory that holds a copy of `tools/` and an empty `raw/`. You need Bun, Python 3 and `timeout`. The script plants each bug in that checkout and restores the file afterwards. Run times will differ on another machine.
