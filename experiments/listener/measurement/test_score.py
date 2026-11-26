import itertools
import unittest
from fractions import Fraction

from score import ARMS, TASKS, score


class ScoreTest(unittest.TestCase):
    def test_inclusive_threshold_uses_exact_elapsed_seconds(self):
        rows = [
            dict(arm=arm, task=task, rep=rep, outcome="pass", elapsed_seconds=1200,
                 receipt_sha256="a" * 64, critical_failure=False)
            for arm, task, rep in itertools.product(ARMS, TASKS, (1, 2))
        ]
        rust = [row for row in rows if row["arm"] == "rust"]
        zig = [row for row in rows if row["arm"] == "zig"]
        for row in rust:
            row["elapsed_seconds"] = 1800
        rust[-1]["elapsed_seconds"] += 10
        zig[-1]["elapsed_seconds"] += 367
        self.assertTrue(score(rows)["pilot_bar_met"])  # 7567 / 10810 = 0.70
        zig[-1]["elapsed_seconds"] += Fraction(1, 1000)
        self.assertFalse(score(rows)["pilot_bar_met"])
