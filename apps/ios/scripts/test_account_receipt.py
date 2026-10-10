from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest


class ReceiptTest(unittest.TestCase):
    def invoke(self, receipt, *args):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            if receipt is not None:
                path.write_text(json.dumps(receipt))
            return subprocess.run([sys.executable, str(Path(__file__).with_name("account-receipt.py")), str(path), *args], capture_output=True, text=True)

    def test_launch_without_receipt_is_not_success(self):
        result = self.invoke(None)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_progress_waits_for_an_explicit_completion(self):
        result = self.invoke({"stage": "rpc", "finished": False, "nativeAccount": False})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")

    def test_completed_assertions_emit_the_required_marker(self):
        result = self.invoke({"stage": "cleared", "finished": True, "nativeAccount": True})
        self.assertEqual(result.returncode, 0)
        self.assertIn('{"nativeAccount":true}', result.stdout)

    def test_failed_probe_preserves_only_its_stage(self):
        result = self.invoke({"stage": "keychain", "finished": True, "nativeAccount": False})
        self.assertEqual(result.returncode, 1)
        self.assertIn("NativeAccountStage:keychain", result.stdout)
        self.assertNotIn('{"nativeAccount":true}', result.stdout)

    def test_timeout_retains_the_last_known_stage(self):
        for receipt, stage in [(None, "notStarted"), ({"stage": "login", "finished": False, "nativeAccount": False}, "login")]:
            result = self.invoke(receipt, "--timeout")
            self.assertEqual(result.returncode, 1)
            self.assertIn("NativeAccountStage:" + stage, result.stdout)

    def test_malformed_or_premature_success_cannot_pass(self):
        for receipt in [[], {"stage": "cleared", "finished": "true", "nativeAccount": True}, {"stage": "fixture", "finished": True, "nativeAccount": True}, {"stage": "secret-value", "finished": True, "nativeAccount": True}]:
            result = self.invoke(receipt)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("secret-value", result.stdout + result.stderr)
            self.assertNotIn('{"nativeAccount":true}', result.stdout)


if __name__ == "__main__":
    unittest.main()
