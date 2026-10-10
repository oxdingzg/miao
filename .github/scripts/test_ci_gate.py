import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("ci-gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTest(unittest.TestCase):
    def test_documentation_skips_specialist_checks(self):
        self.assertFalse(any(gate.classify(["README.md", "docs/guide.md"]).values()))

    def test_workflow_and_setup_changes_require_checks(self):
        for path in [".github/workflows/ci.yml", ".github/ci-checks.json", ".github/actions/setup-bun/action.yml"]:
            self.assertTrue(all(gate.classify([path]).values()), path)

    def test_runtime_dependencies_require_browser_and_replay_checks(self):
        flags = gate.classify(["packages/core/src/session/runner/turn.ts"])
        for name in ["blackbox", "e2e", "remote"]:
            self.assertTrue(flags[name], name)
        self.assertTrue(gate.classify(["packages/remote-control/src/browser.ts"])["e2e"])

    def test_successful_and_intentionally_skipped_results_pass(self):
        flags = {name: "false" for name in gate.CHECKS}
        needs = {name: {"result": "skipped"} for name in gate.CHECKS}
        needs.update({name: {"result": "success"} for name in ["policy", "unit", "typecheck"]})
        gate.enforce(needs, flags)
        flags["engine"] = "true"
        needs["engine"]["result"] = "success"
        gate.enforce(needs, flags)

    def test_failed_cancelled_or_missing_required_checks_fail_closed(self):
        flags = {name: "true" for name in gate.CHECKS}
        for job in [*gate.CHECKS, "policy", "unit", "typecheck"]:
            for result in ["failure", "cancelled", "abandoned", "skipped"]:
                needs = {name: {"result": "success"} for name in [*gate.CHECKS, "policy", "unit", "typecheck"]}
                needs[job]["result"] = result
                with self.assertRaises(ValueError, msg=f"{job}: {result}"):
                    gate.enforce(needs, flags)
            del needs[job]
            with self.assertRaises(ValueError):
                gate.enforce(needs, flags)


if __name__ == "__main__":
    unittest.main()
