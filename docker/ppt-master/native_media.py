"""禁网运行的原稿预览与页面视频；只消费本地文件，不播放原生对象动画。"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
from PIL import Image, ImageChops, ImageStat


def process(args, timeout=90):
    try:
        completed = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise ValueError("离线渲染超过单步时间上限，请拆分页数或减少单页时长后重试。") from error
    if completed.returncode:
        raise ValueError("离线渲染工具执行失败，请检查原稿、字体或媒体格式。" + completed.stderr.decode("utf-8", "replace")[-1000:])
    return completed.stdout


def preview(source, workspace, count):
    if not shutil.which("soffice") or not shutil.which("pdftoppm"):
        raise ValueError("当前镜像尚未包含离线原稿渲染器，请重新构建已登记镜像。")
    destination = workspace / "native-preview"
    destination.mkdir(exist_ok=True)
    fingerprint = hashlib.sha256(source.read_bytes()).hexdigest()
    marker = destination / "source.json"
    if marker.is_file() and json.loads(marker.read_text())["digest"] == fingerprint and all((destination / f"slide-{page + 1}.png").is_file() for page in range(count)):
        return
    with tempfile.TemporaryDirectory(prefix=".native-render-", dir=workspace) as temporary:
        root = Path(temporary)
        from native_formula_preview import prepare
        rendered_source = prepare(source, root / "preview.pptx", Path("/engine/skill"))
        process(["soffice", "-env:UserInstallation=" + (root / "profile").as_uri(), "--headless", "--nologo", "--nodefault", "--norestore", "--nolockcheck", "--convert-to", "pdf:impress_pdf_Export", "--outdir", str(root), str(rendered_source)])
        pdf = root / (rendered_source.stem + ".pdf")
        if not pdf.is_file() or pdf.stat().st_size > 100 * 1024 * 1024:
            raise ValueError("离线原稿预览未产生有效PDF。")
        process(["pdftoppm", "-scale-to", "1280", "-png", str(pdf), str(root / "page")])
        pages = sorted(root.glob("page-*.png"), key=lambda file: int(file.stem.split("-")[-1]))
        if len(pages) != count:
            raise ValueError("离线预览页数与源稿不一致，已停止登记。")
        for page, file in enumerate(pages):
            if file.stat().st_size > 8 * 1024 * 1024:
                raise ValueError("单页预览图片超过8MiB。")
            shutil.copyfile(file, destination / f"slide-{page + 1}.png")
    marker.write_text(json.dumps({"digest": fingerprint}), encoding="utf-8")


def finite(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("视频时长、尺寸或帧率超出支持范围。")
    return value


def clip(workspace, index, options, audio=None):
    if set(options) - {"duration", "transition", "resolution", "fps"}:
        raise ValueError("视频参数包含未支持字段。")
    duration = finite(options.get("duration", 5), 0.5, 60)
    resolution = options.get("resolution", "720p")
    fps = options.get("fps", 24)
    transition = options.get("transition", "fade")
    if resolution not in {"720p", "1080p"} or fps not in {24, 30} or transition not in {"none", "fade"}:
        raise ValueError("请选择支持的视频清晰度、帧率和转场。")
    image = workspace / "native-preview" / f"slide-{index + 1}.png"
    with Image.open(image) as source:
        width, height = source.size
    output_height = 720 if resolution == "720p" else 1080
    output_width = max(2, round(width / height * output_height / 2) * 2)
    if output_width > 3840:
        raise ValueError("原稿页面比例超出视频导出范围。")
    directory = workspace / "video-clips"
    directory.mkdir(exist_ok=True)
    target = directory / f"slide-{index + 1}.mp4"
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-filter_threads", "1", "-loop", "1", "-framerate", str(fps), "-i", str(image)]
    if audio is not None:
        metadata = json.loads(process(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(audio)]))
        audio_duration = finite(float(metadata.get("format", {}).get("duration", 0)), 0.1, 60)
        duration = max(duration, audio_duration + 0.3)
        if duration > 60:
            raise ValueError("单页旁白含尾部留白后不得超过60秒。")
        args += ["-i", str(audio)]
    else:
        args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    filters = f"scale={output_width}:{output_height},setsar=1,format=yuv420p"
    if transition == "fade":
        fade = min(0.3, duration / 4)
        filters += f",fade=t=in:st=0:d={fade},fade=t=out:st={duration - fade}:d={fade}"
    args += ["-vf", filters, "-af", "apad", "-t", str(duration), "-r", str(fps), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-threads", "1", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-movflags", "+faststart", str(target)]
    process(args)
    return {"slideIndex": index, "duration": duration, "narrated": audio is not None, "bytes": target.stat().st_size}


def combine(workspace, clips, source_digest):
    if not isinstance(clips, list) or not 1 <= len(clips) <= 40 or sum(item["duration"] for item in clips) > 600:
        raise ValueError("页面视频最多40页、总时长10分钟。")
    directory = workspace / "video-clips"
    files = [directory / f"slide-{index + 1}.mp4" for index in range(len(clips))]
    if any(not file.is_file() for file in files):
        raise ValueError("视频分段未全部完成，不能登记最终文件。")
    listing = directory / "concat.txt"
    listing.write_text("\n".join(f"file '{file.name}'" for file in files), encoding="utf-8")
    target = workspace / "delivery/video.mp4"
    target.parent.mkdir(exist_ok=True)
    process(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", str(listing), "-c", "copy", "-movflags", "+faststart", str(target)])
    metadata = json.loads(process(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", str(target)]))
    actual = float(metadata.get("format", {}).get("duration", 0))
    video = next((item for item in metadata.get("streams", []) if item.get("codec_type") == "video"), {})
    if video.get("codec_name") != "h264" or abs(actual - sum(item["duration"] for item in clips)) > len(clips) * 0.15 + 0.2 or target.stat().st_size > 120 * 1024 * 1024:
        raise ValueError("MP4编码、时长或大小校验未通过。")
    decoded = workspace / "delivery/video-first.png"
    process(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-ss", str(min(0.4, clips[0]["duration"] / 2)), "-i", str(target), "-frames:v", "1", str(decoded)])
    with Image.open(decoded) as frame, Image.open(workspace / "native-preview/slide-1.png") as source:
        difference = ImageStat.Stat(ImageChops.difference(frame.convert("RGB"), source.convert("RGB").resize(frame.size))).mean
    if max(difference) > 30:
        raise ValueError("视频抽帧与原稿页面差异过大，已停止交付。")
    return {"status": "passed", "mode": "page_video", "sourceDigest": source_digest, "outputDigest": hashlib.sha256(target.read_bytes()).hexdigest(), "byteSize": target.stat().st_size, "duration": actual, "width": video["width"], "height": video["height"], "frameMeanAbsoluteError": difference, "narratedSlides": sum(item["narrated"] for item in clips), "slideCount": len(clips), "animationPlayback": "not_included", "embeddedVideoPlayback": "not_included", "network": "disabled", "previewEngine": "LibreOffice"}
