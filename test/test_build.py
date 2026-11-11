import hashlib
import json
from pathlib import Path
import shutil
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
            for name in ("src", "iframe", "images"):
                shutil.copytree(ROOT / name, workspace / name)
            shutil.copyfile(ROOT / "extension.json", workspace / "extension.json")
            with patch.object(build, "BASE", workspace):
                package = build.build(Path(directory) / "output")
                previous = package.read_bytes()
                (workspace / "images/logo.png").unlink()
                with self.assertRaises(FileNotFoundError):
                    build.build(package.parent)
                self.assertEqual(previous, package.read_bytes())
                self.assertEqual(list(package.parent.glob("*.tmp")), [])

    def test_verifier_rejects_missing_icon(self):
        with tempfile.TemporaryDirectory(dir=TEST_WORK) as directory:
            package = build.build(Path(directory))
            damaged = Path(directory) / "damaged.eext"
            with ZipFile(package) as source, ZipFile(damaged, "w") as target:
                for name in source.namelist():
                    if name != "images/logo.png":
                        target.writestr(name, source.read(name))
            with self.assertRaises(KeyError):
                build.verify_package(damaged)


if __name__ == "__main__":
    unittest.main()
