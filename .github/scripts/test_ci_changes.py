import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("ci_changes", Path(__file__).with_name("ci-changes.py"))
changes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changes)


class ChangesTest(unittest.TestCase):
    def test_documentation_and_empty_diff(self):
        for paths in [[], ["README.md"], ["docs/guide.en.md", "specs/plan.md"]]:
            self.assertEqual(changes.classify(paths), {"code": False, "windows": False})

    def test_tui_does_not_require_windows_runtime(self):
        self.assertEqual(changes.classify(["packages/tui/src/config/keybind.ts"]), {"code": True, "windows": False})

    def test_runtime_resources_are_code(self):
        self.assertTrue(changes.classify(["packages/core/src/prompt/system.md"])["code"])

    def test_platform_and_shared_changes_require_windows(self):
        for path in ["packages/core/src/session.ts", "packages/miao/src/runtime/window.ts", "script/install-local.ps1", "bun.lock", ".github/actions/setup-bun/action.yml"]:
            self.assertEqual(changes.classify([path]), {"code": True, "windows": True})


if __name__ == "__main__":
    unittest.main()
