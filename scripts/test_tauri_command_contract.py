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

    def test_barge_in_command_is_registered_and_allowed(self):
        pet = (ROOT / "src/pet/PetApp.tsx").read_text(encoding="utf-8")
        rust = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
        permissions = (ROOT / "src-tauri/permissions/app.toml").read_text(
            encoding="utf-8"
        )
        command = "qiling_voice_barge_in"

        self.assertIn(command, pet)
        self.assertRegex(rust, rf"fn {re.escape(command)}\s*\(")
        self.assertRegex(
            rust,
            rf"generate_handler!\s*\[[\s\S]*?\b{re.escape(command)}\b",
        )
        self.assertRegex(permissions, rf'"{re.escape(command)}"')
        # The barge-in path must cancel the model and both synthesis engines,
        # not just the audio the page already knows about.
        definition = re.search(
            rf"fn {re.escape(command)}\s*\([\s\S]*?\n\}}", rust
        )
        self.assertIsNotNone(definition)
        body = definition.group(0)
        for cancel in ("local_llm.cancel()", "voice.cancel()", "edge_voice.cancel_all()"):
            self.assertIn(cancel, body)

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

    def test_pet_pack_commands_are_registered_and_allowed(self):
        packs = (ROOT / "src/pet/packs.ts").read_text(encoding="utf-8")
        page = (ROOT / "src/pet/PacksApp.tsx").read_text(encoding="utf-8")
        settings = (ROOT / "src/pet/SettingsApp.tsx").read_text(encoding="utf-8")
        rust = (ROOT / "src-tauri/src/main.rs").read_text(encoding="utf-8")
        permissions = (ROOT / "src-tauri/permissions/app.toml").read_text(
            encoding="utf-8"
        )
        capability = (ROOT / "src-tauri/capabilities/packs.json").read_text(
            encoding="utf-8"
        )

        frontend = {
            "pet_packs_list": packs,
            "pet_character_current": packs,
            "pet_pack_load": packs,
            "pet_pack_install": page,
            "pet_pack_uninstall": page,
            "pet_pack_set_active": page,
            "pet_pack_pick_archive": page,
            "pet_packs_open": settings,
        }
        for command, source in frontend.items():
            with self.subTest(command=command):
                self.assertIn(command, source)
                self.assertRegex(rust, rf"fn {re.escape(command)}\s*\(")
                self.assertRegex(
                    rust,
                    rf"generate_handler!\s*\[[\s\S]*?\b{re.escape(command)}\b",
                )
                self.assertRegex(permissions, rf'"{re.escape(command)}"')
        self.assertIn("allow-pet-pack-commands", capability)
        self.assertRegex(capability, r'"windows"\s*:\s*\["packs"\]')


if __name__ == "__main__":
    unittest.main()
