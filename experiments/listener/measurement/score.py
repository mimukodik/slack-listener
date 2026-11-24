"""Score one complete three-language maintenance cohort from evaluator receipts."""
import argparse
import itertools
import json
import math
from pathlib import Path
import re

ARMS = ("effect", "rust", "zig")
TASKS = ("decision", "recovery", "deferred-io")
BUDGET = 2700


def score(rows):
    expected = set(itertools.product(ARMS, TASKS, (1, 2)))
    results = {arm: {"accepted": 0, "critical": 0, "charged_seconds": 0} for arm in ARMS}
    for row in rows:
        arm = row["arm"]
        key = (arm, row["task"], row["rep"])
        if type(row["rep"]) is not int or key not in expected:
            raise ValueError(f"duplicate or unscheduled attempt {key}")
        expected.remove(key)
        status = row["outcome"]
        elapsed = row["elapsed_seconds"]
        if type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0:
            raise ValueError(f"invalid elapsed time for {key}")
        if status not in ("pass", "fail", "timeout", "abandoned", "missing"):
            raise ValueError(f"invalid outcome for {key}")
        if not re.fullmatch(r"[0-9a-f]{64}", row["receipt_sha256"]):
            raise ValueError(f"missing receipt digest for {key}")
        if type(row["critical_failure"]) is not bool:
            raise ValueError(f"invalid critical failure flag for {key}")
        accepted = status == "pass"
        if accepted and (row["critical_failure"] or not 0 < elapsed <= BUDGET):
            raise ValueError(f"inconsistent accepted attempt {key}")
        r = results[arm]
        r["accepted"] += int(accepted)
        r["critical"] += int(row["critical_failure"])
        r["charged_seconds"] += elapsed if accepted else BUDGET
    if expected:
        raise ValueError(f"incomplete cohort: {sorted(expected)}")
    for r in results.values():
        r["accepted_per_hour"] = 3600 * r["accepted"] / r["charged_seconds"]
    rust, zig = results["rust"], results["zig"]
    ratio = None
    if rust["accepted"] and zig["accepted"]:
        ratio = (zig["charged_seconds"] / zig["accepted"]) / (rust["charged_seconds"] / rust["accepted"])
    return {"arms": results, "zig_rust_time_ratio": ratio, "pilot_bar_met":
            ratio is not None and ratio <= 0.70 and zig["accepted"] >= rust["accepted"] and zig["critical"] == 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path, help="one final JSON object per scheduled attempt per line")
    args = parser.parse_args()
    try:
        print(json.dumps(score([json.loads(s) for s in args.ledger.read_text().splitlines() if s.strip()]), indent=2))
    except (ValueError, KeyError, TypeError) as exc:
        parser.exit(1, f"unscorable cohort: {exc}\n")
