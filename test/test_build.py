import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
TEST_WORK = ROOT / "build"
TEST_WORK.mkdir(exist_ok=True)
sys.path.insert(0, str(ROOT))
import build


class PackageTests(unittest.TestCase):
    def test_package_resources_version_and_checksum(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            package = build.build(Path(directory))
            manifest = build.verify_package(package)
            with ZipFile(package) as archive:
                self.assertEqual(archive.read("images/logo.png"), (ROOT / "images/logo.png").read_bytes())
                for name in ("images/banner.jpg", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE",
                             "docs/guide.md", "docs/images/01-route-overview.png"):
                    self.assertEqual(archive.read(name), (ROOT / name).read_bytes())
                self.assertEqual(manifest, json.loads((ROOT / "extension.json").read_text(encoding="utf-8-sig")))
                code = archive.read("dist/index.js").decode()
                for function in build.EXPORTS:
                    self.assertIn(function, code)
                self.assertIn("id=\"tutorialDialog\"", archive.read("iframe/index.html").decode())
            checksum = package.with_suffix(".eext.sha256").read_text().split()[0]
            self.assertEqual(hashlib.sha256(package.read_bytes()).hexdigest(), checksum)

    def test_rebuild_is_reproducible(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            package = build.build(Path(directory))
            original = package.read_bytes()
            build.build(Path(directory))
            self.assertEqual(original, package.read_bytes())

    def test_missing_resource_keeps_previous_package(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            workspace = Path(directory) / "source"
            workspace.mkdir()
            for name in ("src", "iframe", "images", "docs"):
                shutil.copytree(ROOT / name, workspace / name)
            for name in ("extension.json", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"):
                shutil.copyfile(ROOT / name, workspace / name)
            with patch.object(build, "BASE", workspace):
                package = build.build(Path(directory) / "output")
                previous = package.read_bytes()
                (workspace / "images/logo.png").unlink()
                with self.assertRaises(FileNotFoundError):
                    build.build(package.parent)
                self.assertEqual(previous, package.read_bytes())
                self.assertEqual(list(package.parent.glob("*.tmp")), [])

    def test_verifier_rejects_missing_marketplace_resources(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            package = build.build(Path(directory))
            damaged = Path(directory) / "damaged.eext"
            for missing in ("images/logo.png", "images/banner.jpg", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"):
                with self.subTest(missing=missing):
                    with ZipFile(package) as source, ZipFile(damaged, "w") as target:
                        for name in source.namelist():
                            if name != missing:
                                target.writestr(name, source.read(name))
                    with self.assertRaises(KeyError):
                        build.verify_package(damaged)

    def test_verifier_rejects_invalid_marketplace_metadata_and_stale_changelog(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            package = build.build(Path(directory))
            damaged = Path(directory) / "damaged.eext"
            for mutation in ("license", "keywords_missing", "keywords_empty", "keywords_string",
                             "keywords_blank", "keywords_number", "changelog"):
                with self.subTest(mutation=mutation):
                    with ZipFile(package) as source, ZipFile(damaged, "w") as target:
                        for name in source.namelist():
                            data = source.read(name)
                            if name == "extension.json" and mutation != "changelog":
                                manifest = json.loads(data)
                                if mutation == "license":
                                    manifest.pop("license")
                                elif mutation == "keywords_missing":
                                    manifest.pop("keywords")
                                else:
                                    manifest["keywords"] = {
                                        "keywords_empty": [], "keywords_string": "PCB",
                                        "keywords_blank": ["PCB", "  "], "keywords_number": ["PCB", 42],
                                    }[mutation]
                                data = json.dumps(manifest).encode()
                            if mutation == "changelog" and name == "CHANGELOG.md":
                                data = b"# Changelog\n\n## v0.0.0\nOld entry\n"
                            target.writestr(name, data)
                    with self.assertRaises(ValueError):
                        build.verify_package(damaged)

    def test_verification_cli_works_with_windows_legacy_encoding(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            package = build.build(Path(directory))
            result = subprocess.run(
                [sys.executable, str(ROOT / "build.py"), "--verify", str(package)],
                env=dict(os.environ, PYTHONIOENCODING="cp1252"), capture_output=True, timeout=20,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode("cp1252"))
            self.assertIn(b"Verified return-path-inspector", result.stdout)


if __name__ == "__main__":
    unittest.main()
