"""上游工具白名单；调用参数只允许固定选项和任务目录内路径。"""
from pathlib import Path, PurePosixPath
import re


TOOLS = {
    "analyze_images": ("analyze_images.py", set()),
    "text_measure": ("text_measure.py", {"--outline"}),
    "icon_sync": ("icon_sync.py", set()),
    "project": ("project_manager.py", {"--format", "--dir", "--quick-generate", "--copy", "--no-image-propagation", "--json", "--pretty", "--bundle", "--record-usage"}),
    "check_svg": ("svg_quality_checker.py", {"--quick-generate", "--canonical-authoring", "--stage", "--page", "--roundtrip", "--json", "--template-mode", "--template-kind"}),
    "finalize": ("finalize_svg.py", {"--json"}),
    "export": ("svg_to_pptx.py", {"--quick-generate", "--roundtrip", "--native-charts-and-tables", "--native-objects", "--quiet", "-q", "-o", "--output", "-s", "--source", "--format", "-f", "--transition", "--transition-duration", "--animation", "--animation-duration", "--animation-trigger", "--animation-stagger", "--animation-config", "--no-animations", "--auto-advance", "--kiosk", "--narration-audio-dir", "--use-narration-timings", "--recorded-narration", "--narration-padding", "--narration-start-floor", "--no-image-optimize", "--primary-language", "--reflow-text", "--merge-paragraphs", "--no-merge", "--with-notes", "--no-notes", "--image-max-dimension", "--image-sizing", "--image-scale", "--image-quality", "--inherit-motion-from"}),
    "import_native": ("pptx_to_svg.py", {"-o", "--output", "--roundtrip", "--inheritance-mode", "--json", "--overwrite"}),
    "import_template": ("pptx_template_import.py", {"-o", "--output", "--json", "--overwrite"}),
    "template_preview": ("template_preview_pptx.py", {"-o", "--output", "--json"}),
    "apply_template": ("apply_template.py", {"--root", "--dry-run"}),
    "split_notes": ("total_md_split.py", {"--json"}),
    "preset_shape": ("preset_shape_svg.py", {"--grouped", "--search", "--compact", "--id", "--frame", "--fill", "--stroke", "--stroke-width", "--adjust", "--input"}),
    "chart_recall": ("chart_recall.py", {"--json", "--pretty"}),
    "visualization_recall": ("visualization_recall.py", {"--json", "--pretty"}),
    "chart_calculator": ("svg_position_calculator.py", {"--data", "--area", "--bar-width", "--gap-width", "--value-range", "--x-range", "--y-range", "--horizontal", "--center", "--radius", "--inner-radius", "--start-angle", "--max-value", "--slot-midpoints", "--json"}),
    "workspace": ("pptx_workspace.py", {"--json"}),
}

ROLE = re.compile(r"\w[\w-]{0,39}:[\w .,'\x22&-]{1,120}:(\d{1,4}(?:\.\d{1,4})?)(?::(?:bold|normal))?")
BUILTIN_ICON = re.compile(r"(?:chunk-filled|phosphor-duotone|tabler-filled|tabler-outline|simple-icons)/[a-z0-9][a-z0-9_-]{0,120}")


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


def writable_project(value: str, workspace: Path) -> Path:
    project = relative_path(value, workspace, must_exist=True)
    parts = project.relative_to(workspace).parts
    if value.startswith("-") or not project.is_dir() or not parts or parts[0] in {"inputs", "delivery"}:
        raise ValueError("该工具需要可写的任务项目目录。")
    return project


def calibration_arguments(args: list, workspace: Path) -> list[str]:
    if len(args) < 3 or args[0] != "calibrate":
        raise ValueError("文字校准仅支持项目目录以及 --outline、--role、--sample。")
    project = writable_project(args[1], workspace)
    relative_path((project.relative_to(workspace) / "validation/text_calibration.json").as_posix(), workspace)
    cleaned = args[:2]
    has_basis = False
    options = iter(args[2:])
    for option in options:
        flag, separator, inline = option.partition("=")
        if option == "--outline":
            cleaned.append(option)
            has_basis = True
            continue
        if flag not in {"--role", "--sample"}:
            raise ValueError("文字校准选项未登记。")
        value = inline if separator else next(options, "")
        if not value.strip() or not separator and value.startswith("--"):
            raise ValueError("文字校准选项缺少有效内容。")
        if flag == "--role":
            role = ROLE.fullmatch(value)
            if not role or not 0 < float(role[1]) <= 1000:
                raise ValueError("文字角色须使用 名称:字体:字号[:bold] 格式和有效字号。")
            has_basis = True
        cleaned.append(f"{flag}={value}")
    if not has_basis:
        raise ValueError("文字校准须提供 --outline 或至少一个 --role。")
    return cleaned


def icon_arguments(args: list, workspace: Path) -> list[str]:
    if len(args) < 2 or any(not BUILTIN_ICON.fullmatch(icon) for icon in args[1:]):
        raise ValueError("图标同步仅支持项目目录及内置的 library/name 标识。")
    project = writable_project(args[0], workspace).relative_to(workspace).as_posix()
    for icon in args[1:]:
        relative_path(f"{project}/icons/{icon}.svg", workspace)
    return args


def command(tool: str, args: list, skill: Path, workspace: Path) -> list[str]:
    if tool not in TOOLS or not isinstance(args, list) or len(args) > 48:
        raise ValueError("工具或参数数量不受支持。")
    if any(not isinstance(arg, str) or not arg or len(arg) > 500 or any(ord(char) < 32 for char in arg) for arg in args):
        raise ValueError("工具参数必须是受限文本。")
    script, flags = TOOLS[tool]
    script_path = skill / "scripts" / script
    if not script_path.is_file():
        raise ValueError("此固定版本尚未提供所选工具。")
    if tool == "text_measure":
        return [str(script_path), *calibration_arguments(args, workspace)]
    if tool == "icon_sync":
        return [str(script_path), *icon_arguments(args, workspace)]
    if tool == "analyze_images":
        if len(args) != 1:
            raise ValueError("图片盘点只接受当前项目的 images 目录。")
        directory = relative_path(args[0], workspace, must_exist=True)
        parts = directory.relative_to(workspace).parts
        if len(parts) < 2 or parts[-1] != "images" or parts[0] in {"inputs", "delivery"} or not directory.is_dir():
            raise ValueError("图片盘点只接受当前项目的 images 目录。")
        for child in directory.rglob("*"):
            if child.is_symlink():
                raise ValueError("图片盘点不接受符号链接。")
    cleaned = []
    output_value = False
    expanded = []
    for argument in args:
        if argument.startswith("--") and "=" in argument:
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
    if tool == "check_svg" and "--page" in cleaned:
        project = relative_path(cleaned[0], workspace, must_exist=True)
        parent = project if project.name == "svg_output" else project / "svg_output"
        index = cleaned.index("--page") + 1
        if index >= len(cleaned) or cleaned.count("--page") != 1 or not cleaned[index].endswith(".svg"):
            raise ValueError("单页检查须指定一张当前项目的 SVG。")
        value = cleaned[index]
        if value.startswith("svg_output/"):
            value = (parent.parent.relative_to(workspace) / value).as_posix()
        elif "/" not in value:
            value = (parent.relative_to(workspace) / value).as_posix()
        page = relative_path(value, workspace)
        if not page.is_file() or not page.resolve().is_relative_to(parent.resolve()):
            raise ValueError("单页检查只允许当前项目 svg_output 下的现有 SVG。")
        cleaned[index] = page.relative_to(workspace).as_posix()
    if tool == "import_native" and "--inheritance-mode" in cleaned:
        index = cleaned.index("--inheritance-mode") + 1
        if index >= len(cleaned) or cleaned.count("--inheritance-mode") != 1 or cleaned[index] not in {"both", "layered", "flat"}:
            raise ValueError("原稿继承模式无效。")
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
