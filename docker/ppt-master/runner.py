"""PPT Master 隔离执行协议：固定工具、只读运行包、任务专属文件与原生交付。"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from xml.etree import ElementTree as ET
from urllib.parse import urlparse

from tool_catalog import TOOLS, command, relative_path

ENGINE = Path(os.environ.get("PIVOT_MASTER_ENGINE_ROOT", "/engine"))
WORKSPACE = Path(os.environ.get("PIVOT_MASTER_WORKSPACE", "/workspace"))
SKILL = ENGINE / "skill"
LOCK_PATH = Path("/runner/engine-lock.json") if Path("/runner/engine-lock.json").is_file() else Path(__file__).resolve().parents[2] / "config/ppt-master-engine.json"
REVISION = json.loads(LOCK_PATH.read_text(encoding="utf-8"))["revision"]
TEXT_EXTENSIONS = {".md", ".json", ".yaml", ".yml", ".txt", ".svg", ".csv", ".xml"}
MAX_TEXT = 180_000
MAX_WORKSPACE = 250 * 1024 * 1024


def source_fingerprint() -> str:
    records = []
    for file in inventory():
        parts = file.relative_to(WORKSPACE).parts
        if parts[0].startswith(".") or "exports" in parts or "validation" in parts or parts[0] == "delivery":
            continue
        records.append((file.relative_to(WORKSPACE).as_posix(), hashlib.sha256(file.read_bytes()).hexdigest()))
    return hashlib.sha256(json.dumps(sorted(records)).encode()).hexdigest()


def clean(value: str) -> str:
    return value.replace(str(ENGINE), "[运行包]").replace(str(WORKSPACE), "[任务目录]").replace("/engine", "[运行包]").replace("/workspace", "[任务目录]")


def run(args: list[str], timeout: int = 100) -> dict:
    environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL", "TMPDIR", "FONTCONFIG_PATH"}}
    environment.update({"HOME": tempfile.gettempdir(), "USERPROFILE": tempfile.gettempdir(), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PPT_MASTER_PROJECT_PATH": str(WORKSPACE), "PPT_MASTER_DISABLE_AUTO_UPDATE": "1"})
    result = subprocess.run([sys.executable, *args], cwd=WORKSPACE, env=environment, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if len(result.stdout) + len(result.stderr) > 300_000:
        raise ValueError("上游工具输出过大，已拒绝登记。")
    return {"exitCode": result.returncode, "stdout": clean(result.stdout), "stderr": clean(result.stderr)}


def inventory() -> list[Path]:
    files, size = [], 0
    for file in WORKSPACE.rglob("*"):
        if file.is_symlink():
            raise ValueError("任务目录包含符号链接。")
        if file.is_file():
            files.append(file)
            size += file.stat().st_size
            if len(files) > 16_000 or size > MAX_WORKSPACE:
                raise ValueError("任务目录文件或总大小超过限制。")
    return files


def validate_svg(source: str, target: Path) -> None:
    if re.search(r"<!DOCTYPE|<!ENTITY|<\s*script\b|<\s*foreignObject\b|\bon[a-z]+\s*=|@import", source, re.I):
        raise ValueError("SVG 包含不支持的动态或外部声明。")
    tree = ET.fromstring(source)
    for match in re.finditer(r"url\(([^)]+)\)", source, re.I):
        if not match.group(1).strip().strip("'\"").startswith("#"):
            raise ValueError("SVG 填充和滤镜只能引用当前文档定义。")
    references = [(element.tag.rsplit("}", 1)[-1], value) for element in tree.iter() for attribute, value in element.attrib.items() if attribute.rsplit("}", 1)[-1] == "href"]
    for kind, value in references:
        if value.startswith("#"):
            continue
        if kind == "a":
            link = urlparse(value)
            if link.scheme in {"http", "https", "mailto"} and not link.username and not link.password:
                continue
            raise ValueError("超链接仅支持明确的网页、邮件或文档内目标。")
        if value.startswith("data:image/"):
            if not value.startswith(("data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,")):
                raise ValueError("SVG 内嵌图片类型不受支持。")
            continue
        candidate = target.parent / value
        if re.match(r"[a-z]+:|/|\\", value, re.I) or not candidate.resolve().is_relative_to(WORKSPACE.resolve()):
            raise ValueError("SVG 资源必须位于当前任务目录。")
        if any(parent.is_symlink() for parent in [candidate, *candidate.parents] if parent != WORKSPACE.parent):
            raise ValueError("SVG 资源不能经过符号链接。")
        relative_path(candidate.resolve().relative_to(WORKSPACE.resolve()).as_posix(), WORKSPACE, must_exist=True)


def package_report(data: bytes) -> dict:
    if len(data) > 60 * 1024 * 1024:
        raise ValueError("PPTX 超过输出上限。")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or any(name.startswith("/") or ".." in Path(name).parts for name in names):
            raise ValueError("PPTX 包路径或条目无效。")
        if sum(item.file_size for item in archive.infolist()) > 200 * 1024 * 1024:
            raise ValueError("PPTX 解压大小超出限制。")
        if archive.testzip() is not None or "ppt/presentation.xml" not in names:
            raise ValueError("最终文件不是完整的 PPTX。")
        slide_names = [name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
        if not 1 <= len(slide_names) <= 100:
            raise ValueError("最终文件页数不在支持范围。")
        for name in names:
            if name.endswith((".xml", ".rels")):
                text = archive.read(name)
                if b"<!DOCTYPE" in text or b"<!ENTITY" in text:
                    raise ValueError("最终文件含不支持的 XML 声明。")
                ET.fromstring(text)
        return {"status": "passed", "slideCount": len(slide_names), "charts": len([name for name in names if re.fullmatch(r"ppt/charts/chart\d+\.xml", name)]), "officeVisual": "not_checked"}


def main(request: dict) -> dict:
    manifest = json.loads((ENGINE / "manifest.json").read_text(encoding="utf-8"))
    lock = json.loads(Path("/runner/engine-lock.json").read_text(encoding="utf-8")) if Path("/runner/engine-lock.json").is_file() else json.loads((Path(__file__).resolve().parents[2] / "config/ppt-master-engine.json").read_text(encoding="utf-8"))
    computed = hashlib.sha256(json.dumps(manifest["files"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if manifest["revision"] != REVISION or manifest["tree"] != lock["tree"] or computed != lock["contentDigest"] or manifest["contentDigest"] != computed:
        raise ValueError("运行包版本不匹配。")
    integrity = run([str(SKILL / "scripts/attribution_guard.py")])
    if integrity["exitCode"]:
        raise ValueError("上游完整性门禁失败，请重新准备完整官方发行包。")
    action = request.get("action")
    if action == "health":
        expected = {entry["path"]: entry for entry in manifest["files"]}
        actual = {file.relative_to(SKILL).as_posix(): file for file in SKILL.rglob("*") if file.is_file()}
        if set(actual) != set(expected):
            raise ValueError("完整发行包文件清单不一致。")
        for name, file in actual.items():
            if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != expected[name]["sha256"]:
                raise ValueError("完整发行包内容摘要不一致。")
        return {"status": "ready", "revision": REVISION, "contentDigest": manifest["contentDigest"], "fileCount": len(actual), "tools": list(TOOLS), "network": "disabled", "license": "MIT", "pdfSourceBackend": "pivot", "offlineNativeProtocol": 1 if shutil.which("soffice") and shutil.which("pdftoppm") and shutil.which("ffmpeg") else 0}
    inventory()
    if action in {"native_inspect", "native_patch", "native_video_prepare", "native_video_clip", "native_video_finish"}:
        from native_adapter import execute
        result = execute(request, WORKSPACE, SKILL)
        inventory()
        return result
    if action == "read_runtime":
        file = relative_path(request.get("path"), SKILL, must_exist=True)
        if file.suffix not in TEXT_EXTENSIONS or file.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("运行包资源不是可读取的指引文本。")
        source = file.read_text(encoding="utf-8")
        offset = max(0, min(int(request.get("offset", 0)), len(source)))
        length = max(1, min(int(request.get("length", 32_000)), 60_000))
        return {"path": request["path"], "text": source[offset:offset + length], "offset": offset, "nextOffset": offset + length if offset + length < len(source) else None, "totalChars": len(source)}
    if action == "list":
        return {"files": [{"path": file.relative_to(WORKSPACE).as_posix(), "bytes": file.stat().st_size} for file in inventory() if not file.relative_to(WORKSPACE).parts[0].startswith(".")][:2000]}
    if action == "copy":
        source = relative_path(request.get("source"), WORKSPACE, must_exist=True)
        target = relative_path(request.get("path"), WORKSPACE)
        if not source.is_file() or target.suffix != source.suffix or source.suffix.lower() not in TEXT_EXTENSIONS | {".png", ".jpg", ".jpeg", ".webp", ".wav", ".mp3", ".ogg", ".mp4", ".ttf", ".otf", ".pptx"}:
            raise ValueError("只能复制任务内受控文稿或媒体文件。")
        if target.relative_to(WORKSPACE).parts[0] in {"inputs", "delivery"} or target.exists():
            raise ValueError("复制不能覆盖输入、交付或已有文件。")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        inventory()
        return {"path": request["path"], "bytes": target.stat().st_size}
    if action == "copy_template":
        source = relative_path(request.get("source"), SKILL, must_exist=True)
        target = relative_path(request.get("path"), WORKSPACE)
        if not source.is_dir() or source.relative_to(SKILL).parts[0] != "templates" or target.exists() or target.relative_to(WORKSPACE).parts[0] in {"inputs", "delivery"}:
            raise ValueError("仅能复制正式模板工作区到新的任务目录。")
        entries = [file for file in source.rglob("*") if file.is_file()]
        if len(entries) > 2000 or sum(file.stat().st_size for file in entries) > 50 * 1024 * 1024 or any(file.is_symlink() for file in entries):
            raise ValueError("模板工作区超过单次复制范围。")
        shutil.copytree(source, target)
        inventory()
        return {"path": request["path"], "files": len(entries)}
    if action == "read":
        file = relative_path(request.get("path"), WORKSPACE, must_exist=True)
        if file.suffix not in TEXT_EXTENSIONS or file.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("只允许读取任务内的受限文本文件。")
        source = file.read_text(encoding="utf-8")
        offset = max(0, min(int(request.get("offset", 0)), len(source)))
        return {"path": request["path"], "text": source[offset:offset + 60_000], "nextOffset": offset + 60_000 if offset + 60_000 < len(source) else None, "totalChars": len(source)}
    if action == "write":
        file = relative_path(request.get("path"), WORKSPACE)
        source = request.get("text")
        if file.suffix not in TEXT_EXTENSIONS or not isinstance(source, str) or len(source.encode()) > MAX_TEXT or "\x00" in source:
            raise ValueError("只能写入受限文稿文本，不能创建脚本或安装程序。")
        if file.parts[len(WORKSPACE.parts)] in {"inputs", "delivery"}:
            raise ValueError("输入快照与交付目录不能由模型覆盖。")
        if file.suffix == ".svg":
            validate_svg(source, file)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(source, encoding="utf-8")
        inventory()
        return {"path": request["path"], "bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    if action == "run":
        args = command(request.get("tool"), request.get("args"), SKILL, WORKSPACE)
        result = run(args)
        inventory()
        if request.get("tool") == "export" and result["exitCode"] == 0:
            metadata = WORKSPACE / ".pivot"
            metadata.mkdir(exist_ok=True)
            exports = {file.relative_to(WORKSPACE).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in inventory() if file.suffix == ".pptx" and "exports" in file.parts}
            (metadata / "export.json").write_text(json.dumps({"sourceFingerprint": source_fingerprint(), "exports": exports}), encoding="utf-8")
        return result
    if action == "validate_template":
        root = relative_path(request.get("path"), WORKSPACE, must_exist=True)
        kind = request.get("kind")
        if kind not in {"brand", "style", "layout", "deck"}:
            raise ValueError("模板类型无效。")
        result = run(["/runner/template_adapter.py", kind, str(root)])
        if result["exitCode"]:
            return result
        return {"exitCode": 0, "stdout": result["stdout"]}
    if action == "deliver_template":
        root = relative_path(request.get("path"), WORKSPACE, must_exist=True)
        kind = request.get("kind")
        if kind not in {"brand", "style", "layout", "deck"}:
            raise ValueError("模板类型无效。")
        check = run(["/runner/template_adapter.py", kind, str(root)])
        if check["exitCode"]:
            raise ValueError("上游模板校验未通过：" + check["stderr"][:1500])
        delivery = WORKSPACE / "delivery"
        delivery.mkdir(exist_ok=True)
        with zipfile.ZipFile(delivery / "project.zip", "w", zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
            for entry in inventory():
                relative = entry.relative_to(WORKSPACE)
                if relative.parts[0] not in {"delivery", ".pivot"}:
                    archive.write(entry, relative.as_posix())
        data = (delivery / "project.zip").read_bytes()
        return {"projectPath": "delivery/project.zip", "sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data), "packageCheck": {"status": "passed", "kind": kind, "upstreamValidation": check["stdout"], "officeVisual": "not_checked"}, "templateOnly": True}
    if action == "deliver":
        file = relative_path(request.get("path"), WORKSPACE, must_exist=True)
        if file.suffix != ".pptx" or "exports" not in file.parts or file.stat().st_size > 60 * 1024 * 1024:
            raise ValueError("只能交付 exports 目录中的最终 PPTX。")
        data = file.read_bytes()
        receipt = json.loads((WORKSPACE / ".pivot/export.json").read_text(encoding="utf-8"))
        if receipt.get("sourceFingerprint") != source_fingerprint() or receipt.get("exports", {}).get(file.relative_to(WORKSPACE).as_posix()) != hashlib.sha256(data).hexdigest():
            raise ValueError("最终文件与最近成功的上游导出或当前源稿不一致，请重新校验并导出。")
        report = package_report(data)
        delivery = WORKSPACE / "delivery"
        delivery.mkdir(exist_ok=True)
        (delivery / "presentation.pptx").write_bytes(data)
        with zipfile.ZipFile(delivery / "project.zip", "w", zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
            for entry in inventory():
                relative = entry.relative_to(WORKSPACE)
                if relative.parts[0] != "delivery":
                    archive.write(entry, relative.as_posix())
        return {"path": "delivery/presentation.pptx", "projectPath": "delivery/project.zip", "sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data), "packageCheck": report}
    raise ValueError("执行动作未登记。")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("执行输入超过上限。")
        response = {"ok": True, "revision": REVISION, "result": main(json.loads(raw))}
    except Exception as error:
        response = {"ok": False, "revision": REVISION, "error": clean(str(error))[:2000]}
    print(json.dumps(response, ensure_ascii=False))
