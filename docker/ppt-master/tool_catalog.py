"""上游工具白名单；调用参数只允许固定选项和任务目录内路径。"""
from pathlib import Path, PurePosixPath
import re


TOOLS = {
    "project": ("project_manager.py", {"--format", "--dir", "--quick-generate", "--copy", "--no-image-propagation", "--json", "--pretty", "--bundle", "--record-usage"}),
    "check_svg": ("svg_quality_checker.py", {"--quick-generate", "--canonical-authoring", "--stage", "--json", "--template-mode", "--template-kind"}),
    "finalize": ("finalize_svg.py", {"--json"}),
    "export": ("svg_to_pptx.py", {"--quick-generate", "--roundtrip", "--native-charts-and-tables", "--native-objects", "--quiet", "-q", "-o", "--output", "-s", "--source", "--format", "-f", "--transition", "--transition-duration", "--animation", "--animation-duration", "--animation-trigger", "--animation-stagger", "--animation-config", "--no-animations", "--auto-advance", "--kiosk", "--narration-audio-dir", "--use-narration-timings", "--recorded-narration", "--narration-padding", "--narration-start-floor", "--no-image-optimize", "--primary-language", "--reflow-text", "--merge-paragraphs", "--no-merge", "--with-notes", "--no-notes", "--image-max-dimension", "--image-sizing", "--image-scale", "--image-quality", "--inherit-motion-from"}),
    "import_native": ("pptx_to_svg.py", {"-o", "--output", "--roundtrip", "--json", "--overwrite"}),
    "import_template": ("pptx_template_import.py", {"-o", "--output", "--json", "--overwrite"}),
    "template_preview": ("template_preview_pptx.py", {"-o", "--output", "--json"}),
    "apply_template": ("apply_template.py", {"--root", "--dry-run"}),
    "split_notes": ("total_md_split.py", {"--json"}),
    "preset_shape": ("preset_shape_svg.py", {"--grouped", "--search", "--compact", "--id", "--frame", "--fill", "--stroke", "--stroke-width", "--adjust", "--input"}),
    "chart_recall": ("chart_recall.py", {"--json", "--pretty"}),
    "visualization_recall": ("visualization_recall.py", {"--json", "--pretty"}),
    "chart_calculator": ("svg_position_calculator.py", {"--data", "--area", "--bar-width", "--gap-width", "--value-range", "--y-range", "--center", "--radius", "--inner-radius", "--start-angle", "--max-value", "--slot-midpoints", "--json"}),
    "workspace": ("pptx_workspace.py", {"--json"}),
}


def relative_path(value: str, root: Path, must_exist: bool = False) -> Path:
    if not isinstance(value, str) or not value or len(value) > 300 or "\\" in value or ":" in value or "\x00" in value:
        raise ValueError("任务文件路径无效。")
    parts = PurePosixPath(value)
    if parts.is_absolute() or ".." in parts.parts or any(part.startswith(".") and part not in {"."} for part in parts.parts):
        raise ValueError("文件路径必须位于当前任务目录。")
    target = root.joinpath(*parts.parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("任务文件路径越界。")
    current = target
    while current != root:
        if current.is_symlink():
            raise ValueError("任务目录不接受符号链接。")
        current = current.parent
    if must_exist and not target.exists():
        raise ValueError("任务文件不存在。")
    return target


def command(tool: str, args: list, skill: Path, workspace: Path) -> list[str]:
    if tool not in TOOLS or not isinstance(args, list) or len(args) > 48:
        raise ValueError("工具或参数数量不受支持。")
    script, flags = TOOLS[tool]
    script_path = skill / "scripts" / script
    if not script_path.is_file():
        raise ValueError("此固定版本尚未提供所选工具。")
    cleaned = []
    output_value = False
    expanded = []
    for argument in args:
        if isinstance(argument, str) and argument.startswith("--") and "=" in argument:
            expanded.extend(argument.split("=", 1))
        else:
            expanded.append(argument)
    previous = ""
    for argument in expanded:
        if not isinstance(argument, str) or not argument or len(argument) > 500 or any(ord(char) < 32 for char in argument):
            raise ValueError("工具参数必须是受限文本。")
        if argument.startswith("-") and not re.fullmatch(r"-\d+(?:\.\d+)?", argument):
            if argument not in flags:
                raise ValueError("工具选项尚未登记：" + argument)
        else:
            numeric_chart_data = tool == "chart_calculator" and previous == "--data" and re.fullmatch(r"[\w\s,.:+%-]+", argument)
            if (any(char in argument for char in ["\\", "\x00"]) or ":" in argument and not numeric_chart_data) or argument.startswith("/") or ".." in PurePosixPath(argument).parts:
                raise ValueError("工具参数不能引用任务目录之外的路径或网络地址。")
            if "/" in argument:
                relative_path(argument, workspace)
            if output_value and PurePosixPath(argument).parts and PurePosixPath(argument).parts[0] in {"inputs", "delivery"}:
                raise ValueError("工具不能覆盖输入快照或交付目录。")
        cleaned.append(argument)
        output_value = argument in {"-o", "--output", "--dir", "--template-dir"}
        previous = argument
    if tool == "project" and (not cleaned or cleaned[0] not in {"init", "import-sources", "validate", "info", "page-context", "page-context-report", "scaffold-spec", "scaffold-lock"}):
        raise ValueError("项目操作未登记。")
    if tool == "apply_template":
        if not cleaned or cleaned[0].startswith("-"):
            raise ValueError("应用模板需要明确的项目目录。")
        project = relative_path(cleaned[0], workspace, must_exist=True)
        if project.relative_to(workspace).parts and project.relative_to(workspace).parts[0] in {"inputs", "delivery"}:
            raise ValueError("不能向输入快照或交付目录安装模板。")
        for index, argument in enumerate(cleaned):
            if argument == "--root":
                if index + 1 >= len(cleaned):
                    raise ValueError("模板工作区参数不完整。")
                relative_path(cleaned[index + 1], workspace, must_exist=True)
    return [str(script_path), *cleaned]
