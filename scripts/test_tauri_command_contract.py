import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TauriCommandContractTests(unittest.TestCase):
    def test_voice_assistant_status_command_is_registered_and_allowed(self):
        pet = (ROOT / "src/pet/PetApp.tsx").read_text(encoding="utf-8")
        settings = (ROOT / "src/pet/SettingsApp.tsx").read_text(encoding="utf-8")
        rust = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
        permissions = (ROOT / "src-tauri/permissions/app.toml").read_text(
            encoding="utf-8"
        )
        command = "qiling_voice_assistant_status"

        self.assertIn(command, pet)
        self.assertIn(command, settings)
        self.assertRegex(rust, rf"fn {re.escape(command)}\s*\(")
        self.assertRegex(
            rust,
            rf"generate_handler!\s*\[[\s\S]*?\b{re.escape(command)}\b",
        )
        self.assertRegex(permissions, rf'"{re.escape(command)}"')

    def test_edge_voice_commands_are_registered_and_allowed(self):
        settings = (ROOT / "src/pet/SettingsApp.tsx").read_text(encoding="utf-8")
        speech = (ROOT / "src/lib/speech.ts").read_text(encoding="utf-8")
        rust = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
        permissions = (ROOT / "src-tauri/permissions/app.toml").read_text(
            encoding="utf-8"
        )

        for command, frontend in (
            ("qiling_edge_voice_list", settings),
            ("qiling_edge_voice_synthesize", speech),
            ("qiling_edge_voice_cancel", speech),
        ):
            with self.subTest(command=command):
                self.assertIn(command, frontend)
                self.assertRegex(rust, rf"fn {re.escape(command)}\s*\(")
                self.assertRegex(
                    rust,
                    rf"generate_handler!\s*\[[\s\S]*?\b{re.escape(command)}\b",
                )
                self.assertRegex(permissions, rf'"{re.escape(command)}"')

    def test_vscode_explain_command_is_registered_and_allowed(self):
        settings = (ROOT / "src/pet/SettingsApp.tsx").read_text(encoding="utf-8")
        rust = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
        permissions = (ROOT / "src-tauri/permissions/app.toml").read_text(
            encoding="utf-8"
        )

        match = re.search(
            r"invoke\(['\"](?P<command>spirit_invoke_vscode_explain\w*)['\"]\)",
            settings,
        )
        self.assertIsNotNone(match, "VS Code explanation invoke command not found")
        command = match.group("command")
        self.assertRegex(rust, rf"fn {re.escape(command)}\s*\(")
        self.assertRegex(
            rust,
            rf"generate_handler!\s*\[[\s\S]*?\b{re.escape(command)}\b",
        )
        self.assertRegex(permissions, rf'"{re.escape(command)}"')


if __name__ == "__main__":
    unittest.main()
