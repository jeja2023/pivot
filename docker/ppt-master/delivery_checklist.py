"""从最终 PPTX 的实际放映顺序回读已确认的页面标题和关键数据。"""
import hashlib
import json
import posixpath
import re
import unicodedata
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"


class ChecklistMismatch(ValueError):
    """文件可读，但放映页与已确认内容不符。"""

    def __init__(self, message, report=None):
        super().__init__(message)
        self.report = report


def compact(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).split())


def contains(text: str, expected: str, numeric: bool = False) -> bool:
    def numeric_text(value):
        return re.sub(r"−|负(?=\d)", "-", compact(value))
    needle = numeric_text(expected) if numeric else compact(expected)
    if not needle:
        return False
    prefix = r"(?<![\d.+±-])(?<!\d,)" if numeric and re.match(r"[+-]?\d", needle) else ""
    if prefix and needle[0].isdigit():
        prefix += r"\+?"
    suffix = r"(?!\d|\.\d|,\d{3})" if numeric and needle[-1].isdigit() else ""
    return bool(re.search(prefix + re.escape(needle) + suffix, numeric_text(text) if numeric else compact(text)))


def read_slide_order(archive, slide_names: list[str]) -> list[str]:
    presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
    relationships = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
    targets = {}
    for relation in relationships.findall(f"{{{REL}}}Relationship"):
        if relation.get("TargetMode") == "External" or relation.get("Type") != f"{R}/slide":
            continue
        target = relation.get("Target", "")
        targets[relation.get("Id")] = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("ppt", target))
    ordered = [targets.get(node.get(f"{{{R}}}id")) for node in presentation.findall(f"{{{P}}}sldIdLst/{{{P}}}sldId")]
    if len(ordered) != len(slide_names) or set(ordered) != set(slide_names):
        raise ValueError("PPTX 的实际放映页序与页面文件无法一致核对。")
    return ordered


def visible_fragments(slide) -> list[str]:
    # 仅核验页面中的可见文字对象及表格内容，演讲备注不计入。
    fragments = []
    tree = slide.find(f"{{{P}}}cSld/{{{P}}}spTree")
    if tree is None:
        return fragments
    def visit(element):
        if element.tag not in {f"{{{P}}}sp", f"{{{P}}}grpSp", f"{{{P}}}graphicFrame", f"{{{P}}}cxnSp"}:
            return
        if any(node.get("hidden") in {"1", "true"} for node in element.findall(f"./*/{{{P}}}cNvPr")):
            return
        if element.tag == f"{{{P}}}grpSp":
            for child in element:
                visit(child)
            return
        for body in element.iter(f"{{{P}}}txBody"):
            paragraphs = ["".join(node.text or "" for node in paragraph.iter(f"{{{A}}}t")) for paragraph in body.findall(f"{{{A}}}p")]
            fragments.extend(paragraphs)
            fragments.append(" ".join(paragraphs))
        for row in element.iter(f"{{{A}}}tr"):
            cells = [" ".join(node.text or "" for node in cell.iter(f"{{{A}}}t")) for cell in row.findall(f"{{{A}}}tc")]
            fragments.extend(cells)
            fragments.append(" ".join(cells))
    for child in tree:
        visit(child)
    return fragments


def chart_points(archive, slide, slide_path):
    root, file_name = posixpath.split(slide_path)
    relationships_path = posixpath.join(root, "_rels", f"{file_name}.rels")
    if relationships_path not in archive.namelist():
        return []
    visible_ids = set()
    for frame in slide.iter(f"{{{P}}}graphicFrame"):
        if any(node.get("hidden") in {"1", "true"} for node in frame.findall(f"./*/{{{P}}}cNvPr")):
            continue
        visible_ids.update(chart.get(f"{{{R}}}id") for chart in frame.iter(f"{{{C}}}chart"))
    relationships = ET.fromstring(archive.read(relationships_path))
    found = []
    for rel in relationships.findall(f"{{{REL}}}Relationship"):
        if rel.get("Id") not in visible_ids or rel.get("TargetMode") == "External" or rel.get("Type") != f"{R}/chart":
            continue
        target = rel.get("Target", "")
        chart_path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(root, target))
        if not re.fullmatch(r"ppt/charts/chart\d+\.xml", chart_path) or chart_path not in archive.namelist():
            continue
        chart = ET.fromstring(archive.read(chart_path))
        for series in chart.iter(f"{{{C}}}ser"):
            title = series.find(f"{{{C}}}tx")
            label = next((item.text or "" for item in title.iter(f"{{{C}}}v")), "") if title is not None else ""
            cats, values = series.find(f"{{{C}}}cat"), series.find(f"{{{C}}}val")
            if cats is None or values is None:
                continue
            matched = {point.get("idx"): point.findtext(f"{{{C}}}v", "") for point in values.iter(f"{{{C}}}pt")}
            for point in cats.iter(f"{{{C}}}pt"):
                number = matched.get(point.get("idx"), "")
                try:
                    n = Decimal(number)
                    if n.is_finite():
                        found.append((compact(label), compact(point.findtext(f"{{{C}}}v", "")), n))
                except InvalidOperation:
                    continue
    return found


def valid_value(value):
    if isinstance(value, str):
        return 0 < len(value) <= 120
    return (isinstance(value, list) and len(value) == 4 and all(isinstance(item, str) and 0 < len(item) <= 120 for item in value)
            and len(value[3]) <= 48 and re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?", value[3]))


def slide_identity(archive, slide_path, parts, part_hashes):
    # 比较页面及其依赖部件，包括图表工作簿、图片、备注、版式和主题。
    pending = [slide_path]
    visited = {}
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        if path not in parts:
            raise ValueError("页面引用的文件缺失，无法核对保留页。")
        if path not in part_hashes:
            payload = archive.read(path)
            if path.endswith(".xml"):
                root = ET.fromstring(payload)
                # 导出器会重新分配 Office 的创建标识和日期、页码域的内部标识。
                for element in root.iter():
                    if element.tag == "{http://schemas.microsoft.com/office/powerpoint/2010/main}creationId":
                        element.attrib.pop("val", None)
                    elif element.tag == f"{{{A}}}fld" and element.get("type", "").startswith(("slidenum", "datetime")):
                        element.attrib.pop("id", None)
                payload = ET.tostring(root)
            part_hashes[path] = hashlib.sha256(payload).hexdigest()
        visited[path] = part_hashes[path]
        parent, name = posixpath.split(path)
        relationships = posixpath.join(parent, "_rels", name + ".rels")
        if relationships not in parts:
            continue
        pending.append(relationships)
        for relation in ET.fromstring(archive.read(relationships)).findall(f"{{{REL}}}Relationship"):
            if relation.get("TargetMode") == "External":
                continue
            # 备注及版式的反向引用会回到页面，母版引用的其他版式与当前页无关。
            relation_type = relation.get("Type", "").rsplit("/", 1)[-1]
            if relation_type == "slide" or relation_type == "slideLayout" and "/slideMasters/" in path:
                continue
            target = relation.get("Target", "").split("#", 1)[0]
            if target:
                pending.append(posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(parent, target)))
    return hashlib.sha256(json.dumps(sorted(visited.items())).encode()).hexdigest()


def verify_preserved_pages(baseline, archive, ordered, selected):
    previous_names = baseline.namelist()
    previous = read_slide_order(baseline, [name for name in previous_names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)])
    if len(ordered) != len(previous) or any(page > len(previous) for page in selected):
        raise ValueError("按页修复须保留原页数，请按指定页面修正后重新导出。")
    before_parts, after_parts = set(previous_names), set(archive.namelist())
    before_hashes, after_hashes = {}, {}
    for index, (old_path, new_path) in enumerate(zip(previous, ordered), 1):
        if index not in selected and slide_identity(baseline, old_path, before_parts, before_hashes) != slide_identity(archive, new_path, after_parts, after_hashes):
            raise ValueError(f"按页修复改变了第 {index} 页或它使用的资源。已保留原草稿，请仅修改选中的页面。")


def verify_checklist(archive, slide_names: list[str], checklist) -> dict:
    if not isinstance(checklist, list) or not 1 <= len(checklist) <= 100:
        raise ValueError("交付缺少有效的已确认页面清单。")
    ordered = read_slide_order(archive, slide_names)
    if len(checklist) != len(slide_names):
        raise ChecklistMismatch(f"交付页数不符：已确认 {len(checklist)} 页，实际导出 {len(slide_names)} 页。")
    checked, passed, failed = 0, [], []
    first_message = ""
    for index, (item, path) in enumerate(zip(checklist, ordered), 1):
        if not isinstance(item, list) or len(item) != 2 or not isinstance(item[0], str) or not 0 < len(item[0]) <= 180:
            raise ValueError("已确认的页面标题无效。")
        title, values = item
        if not isinstance(values, list) or len(values) > 8 or not all(valid_value(value) for value in values):
            raise ValueError("已确认的关键数据清单无效。")
        checked += len(values)
        if checked > 120:
            raise ValueError("已确认的关键数据超过核验范围。")
        slide = ET.fromstring(archive.read(path))
        fragments = visible_fragments(slide)
        missing_title = not any(contains(text, title) for text in fragments)
        if missing_title and not first_message:
            first_message = f"交付第 {index} 页缺少已确认的可见标题，请修正后重新导出。"
        points = chart_points(archive, slide, path) if any(isinstance(value, list) for value in values) else []
        missing_values = []
        for item_number, value in enumerate(values, 1):
            if isinstance(value, list):
                candidates = [number for series, category, number in points if (series, category) == (compact(value[1]), compact(value[2]))]
                matched = bool(candidates) and all(number == Decimal(value[3]) for number in candidates)
            else:
                matched = any(contains(text, value, numeric=True) for text in fragments)
            if not matched:
                missing_values.append(item_number)
                if not first_message:
                    first_message = f"交付第 {index} 页第 {item_number} 项关键数据无法在页面回读中核对，请修正后重新导出。"
        if missing_title or missing_values:
            failed.append({"page": index, "missingTitle": missing_title, "missingValues": missing_values})
        else:
            passed.append(index)
    if failed:
        raise ChecklistMismatch(first_message, {"passedPages": passed, "failedPages": failed})
    payload = json.dumps(checklist, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return {"checklistDigest": hashlib.sha256(payload).hexdigest(), "checkedPages": len(checklist), "checkedValues": checked}
