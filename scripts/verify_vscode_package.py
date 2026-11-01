import argparse
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VSIX = (
    ROOT
    / "connectors"
    / "vscode"
    / "qiling-spirit-vscode-0.1.1.vsix"
)


def verify_package(vsix_path: Path) -> None:
    with zipfile.ZipFile(vsix_path) as package:
        names = set(package.namelist())
        manifest = json.loads(package.read("extension/package.json"))

        if "extension/extension.cjs" not in names:
            raise ValueError("VSIX is missing its extension entrypoint")
        if "ws" not in manifest.get("dependencies", {}):
            raise ValueError("VS Code connector must declare its ws dependency")
        if "qilingSpirit.pair" not in {
            command["command"]
            for command in manifest.get("contributes", {}).get("commands", [])
        }:
            raise ValueError("VSIX is missing the qilingSpirit.pair command")

        with tempfile.TemporaryDirectory() as temp_dir:
            package.extractall(temp_dir)
            subprocess.run(
                [
                    "node",
                    str(ROOT / "scripts" / "verify_vscode_activation.cjs"),
                    str(Path(temp_dir) / "extension"),
                ],
                check=True,
            )

        if "extension/node_modules/ws/package.json" not in names:
            raise ValueError(
                "VSIX is missing ws runtime dependency; package without --no-dependencies"
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("vsix", nargs="?", type=Path, default=DEFAULT_VSIX)
    args = parser.parse_args()
    verify_package(args.vsix)
    print(f"Verified VS Code extension package: {args.vsix}")
