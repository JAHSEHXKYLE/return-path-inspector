"""Build the EasyEDA Pro .eext without third-party dependencies."""
import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

BASE = Path(__file__).resolve().parent
FILES = ("geometry.js", "pcb.js", "index.js")
EXPORTS = ("checkReturnPath", "checkMultiplePaths", "clearReturnPaths", "cancelPicking", "showRunLog")


def bundle(version):
    sources = [(BASE / "src" / name).read_text(encoding="utf-8-sig") for name in FILES]
    return (
        "var edaEsbuildExportName = (() => {\n'use strict';\n"
        f"const EXTENSION_VERSION = {json.dumps(version)};\n"
        "const runtimeKey = 'returnPathInspectorRuntime:' + EXTENSION_VERSION;\n"
        "if (eda[runtimeKey]) return eda[runtimeKey];\n"
        + "\n".join(sources)
        + "\nreturn (eda[runtimeKey] = { " + ", ".join(EXPORTS) + " });\n})();\n"
    )


def build(output_dir):
    manifest = json.loads((BASE / "extension.json").read_text(encoding="utf-8-sig"))
    version = manifest["version"]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / f"{manifest['name']}_v{version}.eext"
    with ZipFile(archive_path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("extension.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("dist/", b"")
        archive.writestr("dist/index.js", bundle(version))
        archive.writestr("iframe/", b"")
        hint = (BASE / "iframe/hint.html").read_text(encoding="utf-8-sig").replace("{{VERSION}}", version)
        archive.writestr("iframe/hint.html", hint)
        html = (BASE / "iframe/index.html").read_text(encoding="utf-8-sig").replace("{{VERSION}}", version)
        results = (BASE / "iframe/results.js").read_text(encoding="utf-8-sig")
        html = html.replace('<script src="./results.js"></script>', f"<script>\n{results}\n</script>")
        archive.writestr("iframe/index.html", html)
    return archive_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=BASE / "build" / "dist")
    print(build(parser.parse_args().output))
