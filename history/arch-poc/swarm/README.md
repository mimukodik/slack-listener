# Why we dropped swarm testing for the listener and task hub

**Ordinary simulation found 18 of 19 planted bugs more often per second.** Swarm testing gave each action or fault about a one-in-two chance of being available during a run. The idea was that removing a distracting action could make another behavior easier to reach. The team agreed in advance to keep the change if detection improved for a predeclared bug while baseline coverage held. [Original research](https://www.flux.utah.edu/paper/groce-issta12/) · [Experiment brief](brief.md)

Consider the 👀 reaction marking a delivered message. Once the session handles it, the listener adds ✅ and removes 👀. A planted bug removed 👀 even when adding ✅ repeatedly failed. To expose it, the simulator needed both the session marking the message done and Slack rejecting the reaction. If either behavior was disabled for a run, the bug could not surface. Ordinary runs exposed it 803 times in 10,000 seeds. Swarm exposed it 540 times on the same seeds, and remained worse after accounting for its cheaper runs.

Malformed session input was the exception. Swarm detected that bug about 28% more often per second. It also exercised fewer of the measured behaviors, so the gain fell short of the agreed criterion. This verdict covers the tested configuration on these two simulators. A workload where one kind of event routinely prevents another from happening would be a reason to revisit it. [Results by bug, coverage and decision](entry.md) · [Planted bugs and two scenarios neither simulator mode could reach](mutants.md)

## How to check the numbers

The listener used 10,000 seeds of 120 actions per bug and mode. The hub used 2,500 seeds of 80 calls. Each total was split into five blocks. Detection rates use detections per second of summed run time, so a faster run gets credit for fitting more attempts into the same budget. The baseline was `3a36ac7`. [Instrumentation commit](https://github.com/mimukodik/slack-listener/commit/ce030f8) · [Commit removing the unsuccessful approach](https://github.com/mimukodik/slack-listener/commit/81bf2fc)

[Download the measurement archive](measurements.zip) to inspect the 65 seed tables, original campaign log, coverage summary and two reference tables. Its SHA-256 is `2cada7904fffdfbcdd38f4639dd5353bd170827c7db53383e70cebdf3e5e8942`. Each seed row records the seed, outcome (0 means the check detected the planted bug) and elapsed milliseconds. The filenames beginning with `m-` identify the campaign and controls. The remaining seed tables cover screening and supplementary runs.

To reproduce all 38 reported rows, run this from the repository root with Python 3 and unzip. Each diff should be empty.

```sh
(
  set -eu
  study=history/arch-poc/swarm
  scratch=$(mktemp -d)
  cp -R "$study/tools" "$scratch/tools"
  unzip -q "$study/measurements.zip" -d "$scratch"
  cd "$scratch"
  for arm in listener hub; do
    case "$arm" in listener) block=2000 ;; hub) block=500 ;; esac
    reference="raw/table-$arm.txt"
    sed 's/:.*//' "$reference" | xargs python3 -I tools/table.py "$block" > "$arm.txt"
    diff -u "$reference" "$arm.txt"
  done
)
```

To rerun the mutation campaign, use a disposable checkout of `ce030f8`, install its locked dependencies and set `SWARM_CHECKOUT` to its absolute path. In a scratch directory containing copies of `tools/` and an empty `raw/`, run `sh tools/campaign.sh` with Bun, Python 3 and `timeout` available. It edits and restores the disposable checkout. Timing varies by host.
