#!/usr/bin/env python3
"""Unit tests for the F24 go/no-go evaluator in reference-validation-matrix.py.

Run: python3 scripts/reference-validation-matrix.test.py
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "refmatrix", Path(__file__).with_name("reference-validation-matrix.py")
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
evaluate_go_no_go = _mod.evaluate_go_no_go
trade_fingerprint = _mod.trade_fingerprint


def leg(reset_ok=True, closed=6, pnl=100.0, fingerprint=None):
    return {
        "reset_ok": reset_ok,
        "summary": {
            "trade_count_total": closed,
            "trade_count_closed": closed,
            "win_rate_closed": 0.5,
            "realized_pnl": pnl,
        },
        "trade_fingerprint": fingerprint or [f"t{i}" for i in range(closed)],
    }


GOOD_DELTA = {"closed_trade_delta": 0, "win_rate_delta": 0.0, "realized_pnl_delta": 0.0}
CIO_OK = {"decision_rows": 12, "rows_with_outcome": 9}


class TestEvaluateGoNoGo(unittest.TestCase):
    def test_healthy_run_passes(self):
        out = evaluate_go_no_go(
            leg(fingerprint=["a1", "a2", "a3", "a4", "a5", "a6"]),
            leg(fingerprint=["b1", "b2", "b3", "b4", "b5", "b6"]),
            GOOD_DELTA,
            CIO_OK,
        )
        self.assertEqual(out["verdict"], "PASS")
        self.assertTrue(out["overall_pass"])
        self.assertEqual(out["invalid_reasons"], [])

    def test_reset_failure_invalidates_even_with_green_deltas(self):
        out = evaluate_go_no_go(
            leg(reset_ok=False, fingerprint=["a"] * 6),
            leg(reset_ok=False, fingerprint=["b"] * 6),
            GOOD_DELTA,
            CIO_OK,
        )
        self.assertEqual(out["verdict"], "INVALID")
        self.assertFalse(out["overall_pass"])
        self.assertIn("control_reset_failed", out["invalid_reasons"])
        self.assertIn("candidate_reset_failed", out["invalid_reasons"])

    def test_identical_trade_sets_invalidate(self):
        same = ["CSX|1|−58.4", "CSX|2|−58.4"]
        out = evaluate_go_no_go(
            leg(closed=6, fingerprint=same),
            leg(closed=6, fingerprint=same),
            GOOD_DELTA,
            CIO_OK,
        )
        self.assertEqual(out["verdict"], "INVALID")
        self.assertIn("legs_observed_identical_trade_set", out["invalid_reasons"])

    def test_thin_evidence_invalidates(self):
        out = evaluate_go_no_go(
            leg(closed=2, fingerprint=["a", "b"]),
            leg(closed=2, fingerprint=["c", "d"]),
            GOOD_DELTA,
            CIO_OK,
            min_closed_trades=5,
        )
        self.assertEqual(out["verdict"], "INVALID")
        self.assertTrue(any("below_min_5" in r for r in out["invalid_reasons"]))

    def test_zero_decision_rows_invalidates(self):
        out = evaluate_go_no_go(
            leg(fingerprint=["a"] * 6),
            leg(fingerprint=["b"] * 6),
            GOOD_DELTA,
            {"decision_rows": 0},
        )
        self.assertEqual(out["verdict"], "INVALID")
        self.assertIn("cio_eval_zero_decision_rows", out["invalid_reasons"])

    def test_material_regression_fails_not_invalid(self):
        bad_delta = {"closed_trade_delta": 0, "win_rate_delta": -0.30, "realized_pnl_delta": -500.0}
        out = evaluate_go_no_go(
            leg(fingerprint=["a"] * 6),
            leg(fingerprint=["b"] * 6),
            bad_delta,
            CIO_OK,
        )
        self.assertEqual(out["verdict"], "FAIL")
        self.assertFalse(out["overall_pass"])
        self.assertEqual(out["invalid_reasons"], [])

    def test_committed_f24_artifact_shape_is_invalid(self):
        """The exact degenerate shape shipped in validation-matrix-v1.json:
        reset_ok false on both legs, two identical closed losers, zero delta,
        zero CIO decision rows. The old gates PASSed this; it must be INVALID."""
        same = ["CSX|1753968600000|-58.44", "CSX|1753968700000|-58.44"]
        out = evaluate_go_no_go(
            leg(reset_ok=False, closed=2, pnl=-116.8895, fingerprint=same),
            leg(reset_ok=False, closed=2, pnl=-116.8895, fingerprint=same),
            GOOD_DELTA,
            {"decision_rows": 0, "rows_with_outcome": 0},
        )
        self.assertEqual(out["verdict"], "INVALID")
        self.assertFalse(out["overall_pass"])
        self.assertGreaterEqual(len(out["invalid_reasons"]), 4)


class TestTradeFingerprint(unittest.TestCase):
    def test_prefers_trade_id_and_sorts(self):
        rows = [
            {"ticker": "CSX", "trade_id": "z9"},
            {"ticker": "CSX", "trade_id": "a1"},
            {"ticker": "IGNORED", "trade_id": "x"},
        ]
        self.assertEqual(trade_fingerprint(rows, ["CSX"]), ["a1", "z9"])

    def test_falls_back_to_ticker_ts_pnl(self):
        rows = [{"ticker": "CSX", "entry_ts": 123, "pnl": -58.44}]
        self.assertEqual(trade_fingerprint(rows, ["CSX"]), ["CSX|123|-58.44"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
