"""原稿编辑与离线视频的固定执行动作；源路径均由宿主快照提供。"""
import hashlib
import json
from pathlib import Path
from native_package import Package
from native_objects import describe
from native_edit import apply
import native_media
from tool_catalog import relative_path


def execute(request, workspace, skill):
    action = request["action"]
    source = relative_path(request.get("source", "inputs/source.pptx"), workspace, must_exist=True)
    if source.suffix != ".pptx" or source.relative_to(workspace).parts[0] != "inputs":
        raise ValueError("原稿操作只接受当前任务的PPTX输入快照。")
    data = source.read_bytes()
    package = Package(data)
    delivery = workspace / "delivery"
    delivery.mkdir(exist_ok=True)
    if action in {"native_inspect", "native_patch"}:
        report = {"sourceDigest": hashlib.sha256(data).hexdigest(), "outputDigest": hashlib.sha256(data).hexdigest(), "changedParts": [], "preservedParts": len(package.parts)}
        if action == "native_patch":
            data, report = apply(package, request.get("patches"), skill)
            package = Package(data)
        output = delivery / "presentation.pptx"
        output.write_bytes(data)
        manifest = describe(package, skill)
        manifest["preservation"] = report
        manifest["packageDigest"] = hashlib.sha256(data).hexdigest()
        if len(json.dumps(manifest).encode()) > 6 * 1024 * 1024:
            raise ValueError("原稿对象数据超过6MiB，请拆分文稿后重试。")
        native_media.preview(output, workspace, len(package.slides))
        (delivery / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, allow_nan=False), encoding="utf-8")
        return {"status": "passed", "sha256": manifest["packageDigest"], "slideCount": len(package.slides), "preservation": report, "offlineProtocol": 1}
    if action == "native_video_prepare":
        native_media.preview(source, workspace, len(package.slides))
        return {"slideCount": len(package.slides), "sourceDigest": hashlib.sha256(data).hexdigest()}
    if action == "native_video_clip":
        index = request.get("slideIndex")
        if not isinstance(index, int) or not 0 <= index < len(package.slides):
            raise ValueError("视频页码无效。")
        audio = relative_path(request["audio"], workspace, must_exist=True) if request.get("audio") else None
        if audio is not None and (audio.relative_to(workspace).parts[0] != "inputs" or audio.suffix not in {".wav", ".mp3", ".ogg"}):
            raise ValueError("旁白必须来自已授权的音频输入快照。")
        return native_media.clip(workspace, index, request.get("options", {}), audio)
    if action == "native_video_finish":
        return native_media.combine(workspace, request.get("clips"), hashlib.sha256(data).hexdigest())
    raise ValueError("原稿执行动作未登记。")
