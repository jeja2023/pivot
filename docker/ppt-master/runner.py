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
from delivery_checklist import ChecklistMismatch, read_slide_order, verify_checklist, verify_preserved_pages

ENGINE = Path(os.environ.get("PIVOT_MASTER_ENGINE_ROOT", "/engine"))
WORKSPACE = Path(os.environ.get("PIVOT_MASTER_WORKSPACE", "/workspace"))
SKILL = ENGINE / "skill"
LOCK_PATH = Path("/runner/engine-lock.json") if Path("/runner/engine-lock.json").is_file() else Path(__file__).resolve().parents[2] / "config/ppt-master-engine.json"
REVISION = json.loads(LOCK_PATH.read_text(encoding="utf-8"))["revision"]
TEXT_EXTENSIONS = {".md", ".json", ".yaml", ".yml", ".txt", ".svg", ".csv", ".xml"}
MAX_TEXT = 180_000
MAX_WORKSPACE = 250 * 1024 * 1024
REVIEW_DRAFT = ".pivot/review-draft.pptx"
PREVIOUS_REVIEW_DRAFT = ".pivot/previous-review-draft.pptx"
REVIEW_PREVIEW = ".pivot/review-preview"
PROGRESS_DIRECTORY = (".pivot", "progress")


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
    environment.update({"HOME": tempfile.gettempdir(), "USERPROFILE": tempfile.gettempdir(), "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PIVOT_MASTER_WORKSPACE": str(WORKSPACE), "PPT_MASTER_PROJECT_PATH": str(WORKSPACE), "PPT_MASTER_DISABLE_AUTO_UPDATE": "1"})
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
            # 由宿主单独限额并转存的快照中转文件不计入源工作区配额。
            if file.relative_to(WORKSPACE).parts[:2] == PROGRESS_DIRECTORY:
                continue
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


def package_report(data: bytes, checklist=None, preservation=None) -> dict:
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
        report = {"status": "passed", "slideCount": len(slide_names), "charts": len([name for name in names if re.fullmatch(r"ppt/charts/chart\d+\.xml", name)]), "officeVisual": "not_checked"}
        if preservation is not None:
            baseline, selected = preservation
            with zipfile.ZipFile(io.BytesIO(baseline)) as previous:
                verify_preserved_pages(previous, archive, read_slide_order(archive, slide_names), selected)
        if checklist is not None:
            report.update(verify_checklist(archive, slide_names, checklist))
        return report


def page_sources(file, receipt, checklist):
    export = receipt.get("pageSources", {}).get(file.relative_to(WORKSPACE).as_posix(), [])
    if len(export) != len(checklist or []) or len(set(export)) != len(export):
        return []
    return export


def installed_template_digest(project, template_source):
    source = relative_path(template_source, SKILL, must_exist=True)
    if source.relative_to(SKILL).parts[0] != "templates":
        raise ValueError("交付模板须来自固定运行包。")
    if str(SKILL / "scripts") not in sys.path:
        sys.path.insert(0, str(SKILL / "scripts"))
    from apply_template import apply_templates, snapshot_template_roots, read_template_install
    # 上游预检逐文件比对已安装的规范、版式与资源，回执还须对应所选发行包的原始内容。
    selected = WORKSPACE / "selected-template"
    plan = apply_templates(project, [str(selected)], dry_run=True, validate=False)
    canonical = snapshot_template_roots(project, [str(source)])[0]
    if plan.root_snapshots[0]["files"] != canonical["files"] or plan.root_snapshots[0]["specs"] != canonical["specs"]:
        raise ValueError("任务模板副本与所选发行包模板不一致，请重新载入。")
    read_template_install(project, plan.root_snapshots, plan.selection_sha256)
    spec = source / "templates" / "design_spec.md"
    return hashlib.sha256(spec.read_text(encoding="utf-8").encode("utf-8")).hexdigest()


def registered_export(path, *, current=False):
    file = relative_path(path, WORKSPACE, must_exist=True)
    if not file.is_file() or file.suffix != ".pptx" or "exports" not in file.parts or file.stat().st_size > 60 * 1024 * 1024:
        raise ValueError("只能交付 exports 目录中的最终 PPTX。")
    data = file.read_bytes()
    content_hash = hashlib.sha256(data).hexdigest()
    receipt = json.loads((WORKSPACE / ".pivot/export.json").read_text(encoding="utf-8"))
    key = "currentExports" if current else "exports"
    if receipt.get(key, {}).get(file.relative_to(WORKSPACE).as_posix()) != content_hash:
        raise ValueError("文件与上游导出回执的摘要不一致。")
    return file, data, content_hash, receipt


def inspect_export(request):
    """对已登记的导出快照重新核验和渲染，避免运行或改写原制作任务。"""
    file, data, digest, _ = registered_export(request.get("path"))
    checklist = request.get("checklist")
    if not isinstance(checklist, list) or not 1 <= len(checklist) <= 100:
        raise ValueError("此任务缺少可核对的已确认清单。")
    try:
        package_report(data, checklist)
        report = {"passedPages": list(range(1, len(checklist) + 1)), "failedPages": []}
    except ChecklistMismatch as error:
        if error.report is None:
            raise
        report = error.report
    passed = report["passedPages"]
    if not passed:
        return {"pageReview": report, "pages": []}

    # 导出快照及清单共同决定哪些页可读，缓存只保存一份通过页预览。
    revision = hashlib.sha256((digest + json.dumps(checklist, ensure_ascii=False, separators=(",", ":"))).encode()).hexdigest()
    destination = WORKSPACE / REVIEW_PREVIEW
    names = [f"review-{revision}-{page}.png" for page in passed]
    if not all((destination / name).is_file() for name in names):
        from native_media import preview
        with tempfile.TemporaryDirectory(prefix="review-preview-", dir=WORKSPACE / ".pivot") as temporary:
            staging = Path(temporary)
            preview(file, staging, len(checklist))
            images = [staging / "native-preview" / f"slide-{page}.png" for page in passed]
            if sum(image.stat().st_size for image in images) > 32 * 1024 * 1024:
                raise ValueError("通过页预览超过文件上限，请下载草稿查看。")
            if destination.exists():
                shutil.rmtree(destination)
            destination.mkdir()
            for image, name in zip(images, names):
                image.replace(destination / name)
    return {"pageReview": report, "pages": [{"page": page, "file": name} for page, name in zip(passed, names)]}


def capture_progress(request):
    project = relative_path(request.get("project"), WORKSPACE, must_exist=True)
    if not project.is_dir():
        raise ValueError("制作项目目录无效。")
    destination = WORKSPACE.joinpath(*PROGRESS_DIRECTORY)
    if destination.is_symlink() or destination.parent.is_symlink():
        raise ValueError("制作快照目录已重定向。")
    destination.mkdir(parents=True, exist_ok=True)

    def describe(name, data):
        if not 0 < len(data) <= 60 * 1024 * 1024:
            raise ValueError("制作快照超过保存上限。")
        with tempfile.NamedTemporaryFile(dir=destination, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        try:
            temporary.replace(destination / name)
        finally:
            temporary.unlink(missing_ok=True)
        return {"file": name, "sha256": hashlib.sha256(data).hexdigest(), "byteSize": len(data)}

    path = request.get("export")
    if not path:
        files = [entry for entry in inventory() if entry.is_relative_to(project)
                 and not any(part.startswith(".") or part in {"exports", "validation", "delivery"}
                             for part in entry.relative_to(project).parts)]
        pages = [file.stem for file in files if file.parent in {project / "svg_output", project / "authoring-svg-flat"}
                 and file.suffix.lower() == ".svg"]
        if not files or not pages and request.get("template") is not True:
            return {}
        if sum(file.stat().st_size for file in files) > 60 * 1024 * 1024:
            raise ValueError("当前项目源稿超过快照保存上限。")
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
            for file in sorted(files):
                archive.write(file, file.relative_to(WORKSPACE).as_posix())
        return {"source": {**describe("progress-sources.zip", data.getvalue()), "files": sorted(pages)}}

    file, data, original_digest, receipt = registered_export(path, current=True)
    if not file.is_relative_to(project / "exports") or receipt.get("sourceFingerprint") != source_fingerprint():
        raise ValueError("快照与本次导出或项目源稿不一致。")
    checklist = request.get("checklist")
    if not isinstance(checklist, list) or not 1 <= len(checklist) <= 100:
        raise ValueError("快照缺少已确认的页面清单。")
    try:
        package_report(data, checklist)
        report = {"passedPages": list(range(1, len(checklist) + 1)), "failedPages": []}
    except ChecklistMismatch as error:
        report = error.report or {"passedPages": [], "failedPages": [{"page": index} for index in range(1, len(checklist) + 1)]}
    passed = sorted(report["passedPages"])
    result = {"export": {**describe("progress-review.pptx", data), "passedPages": passed,
                         "pendingPages": [item["page"] for item in report["failedPages"]]},
              "originalDigest": original_digest}
    if passed:
        from native_subset import select_pages
        try:
            subset = select_pages(data, passed)
            package_report(subset, [checklist[page - 1] for page in passed])
            result["passed"] = describe("progress-passed.pptx", subset)
        except (ValueError, zipfile.BadZipFile) as error:
            result["subsetUnavailable"] = clean(str(error))[:500]
    return result


def deliver_presentation(request: dict) -> dict:
    try:
        file, data, content_hash, receipt = registered_export(request.get("path"), current=True)
    except ValueError as error:
        raise ValueError("最终文件与最近成功的上游导出或当前源稿不一致，请重新校验并导出。") from error
    if receipt.get("sourceFingerprint") != source_fingerprint():
        raise ValueError("最终文件与最近成功的上游导出或当前源稿不一致，请重新校验并导出。")
    preservation = None
    repair = request.get("repair")
    draft = WORKSPACE / REVIEW_DRAFT
    prior = WORKSPACE / PREVIOUS_REVIEW_DRAFT
    if repair is not None:
        if not isinstance(repair, dict):
            raise ValueError("按页修复参数无效。")
        baseline_digest = repair.get("sha256")
        pages = repair.get("pages")
        if not isinstance(baseline_digest, str) or not re.fullmatch(r"[a-f0-9]{64}", baseline_digest) or not isinstance(pages, list) or not pages or any(type(page) is not int or not 1 <= page <= 100 for page in pages):
            raise ValueError("按页修复的草稿摘要或页码无效。")
        if draft.is_symlink() or not draft.is_file() or draft.stat().st_size > 60 * 1024 * 1024:
            raise ValueError("原待核验草稿已不可用。")
        baseline = draft.read_bytes()
        current_digest = hashlib.sha256(baseline).hexdigest()
        if current_digest != baseline_digest:
            # 引擎已保留修复稿、宿主尚未写入检查点时，可重放同一导出与原基准的核验。
            if repair.get("automatic") is not True or current_digest != content_hash or not prior.is_file() or prior.is_symlink():
                raise ValueError("待核验草稿已变化，请刷新任务后重试。")
            baseline = prior.read_bytes()
            if hashlib.sha256(baseline).hexdigest() != baseline_digest:
                raise ValueError("待核验草稿已变化，请刷新任务后重试。")
        preservation = (baseline, set(pages))
    try:
        report = package_report(data, request.get("checklist"), preservation)
    except ChecklistMismatch as error:
        if request.get("retainReviewDraft") is not True:
            raise
        # 仅保留与本次成功导出回执一致且结构可读的草稿，正式交付仍须通过清单核验。
        result = {"reviewFailure": str(error)}
        if error.report is not None:
            result["pageReview"] = {**error.report, "pageSources": page_sources(file, receipt, request.get("checklist"))}
        files = inventory()
        keep_prior = bool(repair and repair.get("automatic") is True and current_digest == baseline_digest and current_digest != content_hash)
        replaced = {draft, prior} if keep_prior else {draft}
        if (sum(entry.stat().st_size for entry in files if entry not in replaced) + len(data)
                + (len(baseline) if keep_prior else 0) > MAX_WORKSPACE
                or len(files) + int(draft not in files) + int(keep_prior and prior not in files) > 16_000):
            return result
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=draft.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
            if keep_prior:
                prior.unlink(missing_ok=True)
                os.link(draft, prior)
            temporary.replace(draft)
            result["reviewDraft"] = {"sha256": content_hash, "byteSize": len(data)}
        except OSError:
            pass
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
        return result
    if request.get("templateSource"):
        report["templateSpecDigest"] = installed_template_digest(file.parent.parent, request["templateSource"])
    report["currentExportSha256"] = content_hash
    delivery = WORKSPACE / "delivery"
    delivery.mkdir(exist_ok=True)
    (delivery / "presentation.pptx").write_bytes(data)
    with zipfile.ZipFile(delivery / "project.zip", "w", zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
        for entry in inventory():
            relative = entry.relative_to(WORKSPACE)
            if relative.parts[0] != "delivery" and relative.as_posix() not in {REVIEW_DRAFT, PREVIOUS_REVIEW_DRAFT}:
                archive.write(entry, relative.as_posix())
    with (delivery / "project.zip").open("rb") as project_file:
        project_digest = hashlib.file_digest(project_file, "sha256").hexdigest()
    if preservation is not None:
        report["preservation"] = {"sha256": repair["sha256"], "pages": sorted(preservation[1])}
    return {"path": "delivery/presentation.pptx", "projectPath": "delivery/project.zip", "sha256": content_hash, "projectSha256": project_digest, "byteSize": len(data), "packageCheck": report}


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
        return {"status": "ready", "revision": REVISION, "contentDigest": manifest["contentDigest"], "fileCount": len(actual), "tools": list(TOOLS), "deliveryChecklist": 1, "currentExport": 1, "pageRepair": 1, "progressSnapshots": 1, "network": "disabled", "license": "MIT", "pdfSourceBackend": "pivot", "offlineNativeProtocol": 1 if shutil.which("soffice") and shutil.which("pdftoppm") and shutil.which("ffmpeg") else 0}
    inventory()
    if action == "inspect_export":
        return inspect_export(request)
    if action == "capture_progress":
        return capture_progress(request)
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
        length = max(1, min(int(request.get("length", 32_000)), 60_000))
        return {"path": request["path"], "text": source[offset:offset + length], "offset": offset, "nextOffset": offset + length if offset + length < len(source) else None, "totalChars": len(source)}
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
        previous_exports = {}
        if request.get("tool") == "export":
            previous_exports = {file: file.stat().st_mtime_ns for file in inventory() if file.suffix == ".pptx" and "exports" in file.parts}
        result = run(args)
        files = inventory()
        if request.get("tool") == "apply_template" and result["exitCode"] == 0 and request.get("templateSource"):
            project = relative_path(request["args"][0], WORKSPACE, must_exist=True)
            result["templateSpecDigest"] = installed_template_digest(project, request["templateSource"])
        if request.get("tool") == "export" and result["exitCode"] == 0:
            metadata = WORKSPACE / ".pivot"
            metadata.mkdir(exist_ok=True)
            args = request["args"]
            project = relative_path(args[0], WORKSPACE, must_exist=True)
            current_exports = [file for file in files if file.suffix == ".pptx" and file.is_relative_to(project / "exports")
                               and file.stat().st_mtime_ns != previous_exports.get(file)]
            current_hashes = {file.relative_to(WORKSPACE).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest() for file in current_exports}
            receipt_file = metadata / "export.json"
            exports = json.loads(receipt_file.read_text(encoding="utf-8")).get("exports", {}) if receipt_file.exists() else {}
            exports.update(current_hashes)
            page_sources_by_export = {}
            if project.is_dir() and "--roundtrip" not in args and not any(arg in {"-s", "--source"} or arg.startswith("--source=") for arg in args):
                sys.path.insert(0, str(SKILL / "scripts"))
                from slide_roster import discover_slide_svgs
                sources = [page.relative_to(WORKSPACE).as_posix() for page in discover_slide_svgs(project / "svg_output")]
                page_sources_by_export = dict.fromkeys(current_hashes, sources)
            with tempfile.NamedTemporaryFile(dir=metadata, mode="w", encoding="utf-8", delete=False) as stream:
                json.dump({"sourceFingerprint": source_fingerprint(), "exports": exports, "currentExports": current_hashes,
                           "pageSources": page_sources_by_export}, stream)
            Path(stream.name).replace(receipt_file)
            if len(current_exports) == 1:
                result["progressExport"] = current_exports[0].relative_to(WORKSPACE).as_posix()
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
        return deliver_presentation(request)
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
