"""Build the EasyEDA Pro .eext without third-party dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

BASE = Path(__file__).resolve().parent
FILES = ("geometry.js", "pcb.js", "index.js")
EXPORTS = ("checkReturnPath", "checkMultiplePaths", "clearReturnPaths", "cancelPicking", "showRunLog")


def resource_path(value):
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value or ":" in value:
        raise ValueError("资源路径必须位于项目目录内。")
    return path.as_posix()


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


def verify_package(path):
    with ZipFile(path) as archive:
        if archive.testzip() is not None:
            raise ValueError("扩展包完整性校验失败。")
        manifest = json.loads(archive.read("extension.json"))
        for name in ("name", "uuid", "displayName", "description", "version", "license", "repository", "categories", "keywords"):
            if not manifest.get(name):
                raise ValueError(f"扩展清单缺少必填属性：{name}")
        if not isinstance(manifest["keywords"], list) or not all(
            isinstance(keyword, str) and keyword.strip() for keyword in manifest["keywords"]
        ):
            raise ValueError("扩展关键词 keywords 必须为非空字符串数组。")
        entry = manifest["entry"].removeprefix("./")
        if not entry.endswith(".js"):
            entry += ".js"
        logo = archive.read(resource_path(manifest["images"]["logo"]))
        if len(logo) < 24 or logo[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValueError("扩展图标必须是有效 PNG。")
        width, height = struct.unpack(">II", logo[16:24])
        if not width or width != height:
            raise ValueError("扩展图标必须为正方形。")
        banner = archive.read(resource_path(manifest["images"]["banner"]))
        if not banner.startswith(b"\xff\xd8\xff") or not banner.endswith(b"\xff\xd9"):
            raise ValueError("扩展横幅必须是有效 JPEG。")
        for name in ("README.md", "CHANGELOG.md", "LICENSE", "NOTICE"):
            if not archive.read(name).strip():
                raise ValueError(f"扩展包缺少说明内容：{name}")
        changelog = archive.read("CHANGELOG.md").decode("utf-8-sig")
        if not re.search(r"(?m)^## v" + re.escape(manifest["version"]) + r"\s*$", changelog):
            raise ValueError("更新记录缺少当前版本说明。")
        code = archive.read(entry).decode("utf-8")
        if "const EXTENSION_VERSION = " + json.dumps(manifest["version"]) + ";" not in code:
            raise ValueError("扩展入口与清单版本不一致。")
        for name in ("iframe/index.html", "iframe/hint.html"):
            html = archive.read(name).decode("utf-8")
            if "{{VERSION}}" in html or '<script src="./results.js">' in html:
                raise ValueError("界面资源尚未完成打包。")
    return manifest


def build(output_dir):
    manifest = json.loads((BASE / "extension.json").read_text(encoding="utf-8-sig"))
    version = manifest["version"]
    image_paths = [resource_path(manifest["images"][name]) for name in ("logo", "banner")]
    hint = (BASE / "iframe/hint.html").read_text(encoding="utf-8-sig").replace("{{VERSION}}", version)
    html = (BASE / "iframe/index.html").read_text(encoding="utf-8-sig").replace("{{VERSION}}", version)
    results = (BASE / "iframe/results.js").read_text(encoding="utf-8-sig")
    contents = {
        "extension.json": json.dumps(manifest, ensure_ascii=False, indent=2),
        **{name: (BASE / name).read_bytes() for name in image_paths},
        **{name: (BASE / name).read_bytes() for name in ("README.md", "CHANGELOG.md", "LICENSE", "NOTICE")},
        **{path.relative_to(BASE).as_posix(): path.read_bytes()
           for path in sorted((BASE / "docs").rglob("*")) if path.is_file()},
        "dist/index.js": bundle(version),
        "iframe/hint.html": hint,
        "iframe/index.html": html.replace('<script src="./results.js"></script>', f"<script>\n{results}\n</script>"),
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / f"{manifest['name']}_v{version}.eext"
    with tempfile.NamedTemporaryFile(dir=output_dir, suffix=".tmp", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with ZipFile(temporary_path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in contents.items():
                info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o644 << 16
                archive.writestr(info, data, compresslevel=9)
        verify_package(temporary_path)
        temporary_path.replace(archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    archive_path.with_suffix(".eext.sha256").write_text(f"{digest}  {archive_path.name}\n", encoding="utf-8")
    return archive_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=BASE / "build" / "dist")
    parser.add_argument("--verify", type=Path, help="Verify an existing .eext package.")
    args = parser.parse_args()
    if args.verify:
        manifest = verify_package(args.verify)
        print(f"Verified {manifest['name']} v{manifest['version']}")
    else:
        print(build(args.output))
