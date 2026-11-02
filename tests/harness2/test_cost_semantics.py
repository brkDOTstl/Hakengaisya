"""Check unknown costs without requiring the optional upstream package."""

import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "packages/optimizer/harness2_bridge.py"
SPEC = importlib.util.spec_from_file_location("cost_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class CostSemanticsTests(unittest.TestCase):
    def test_unknown_cost_is_not_reported_as_zero_or_available_for_comparison(self):
        requests = [{"request_id": "one", "kind": "edit"}, {"request_id": "two", "kind": "execute"}]
        responses = [{"request_id": "one", "cost_usd": None}, {"request_id": "two", "cost_usd": 0.5}]
        summary = bridge.cost_summary(responses, requests)
        self.assertIsNone(summary["observed_cost_usd"])
        self.assertFalse(summary["cost_evidence_complete"])
        self.assertTrue(summary["upstream_cost_placeholder_used"])
        self.assertFalse(summary["cost_comparison_allowed"])

    def test_fully_observed_cost_does_not_by_itself_prove_a_comparable_saving(self):
        requests = [{"request_id": "one", "kind": "edit"}]
        responses = [{"request_id": "one", "cost_usd": 0.125}]
        summary = bridge.cost_summary(responses, requests)
        self.assertEqual(summary["observed_cost_usd"], 0.125)
        self.assertTrue(summary["cost_evidence_complete"])
        self.assertFalse(summary["upstream_cost_placeholder_used"])
        self.assertFalse(summary["cost_comparison_allowed"])

    def test_missing_response_does_not_count_as_complete_cost_evidence(self):
        requests = [{"request_id": "one", "kind": "edit"}, {"request_id": "two", "kind": "execute"}]
        responses = [{"request_id": "one", "cost_usd": 0.125}]
        summary = bridge.cost_summary(responses, requests)
        self.assertIsNone(summary["observed_cost_usd"])
        self.assertFalse(summary["cost_evidence_complete"])
        self.assertFalse(summary["cost_comparison_allowed"])

    def test_missing_upstream_is_unavailable_not_a_successful_probe(self):
        with self.assertRaises(bridge.Stop) as result:
            bridge.load_upstream(Path(__file__).parent / "missing-upstream-checkout")
        self.assertEqual(result.exception.status, "unavailable")


if __name__ == "__main__":
    unittest.main()
