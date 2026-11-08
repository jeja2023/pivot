"""原生对象字段补丁：拒绝任意XML，按对象身份更新被选中的包内容。"""
from __future__ import annotations

import io
import math
import re
import sys
from lxml import etree as XML
from native_package import NS, EMU, child, element, transform, parse


def number(value, minimum=-1000000, maximum=1000000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("原生对象数值超出允许范围。")
    return value


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise ValueError("请选择有效的六位颜色。")
    return value[1:].upper()


def keys(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError("对象补丁包含未支持字段。")


def set_fill(properties, value):
    keys(value, {"type", "color", "angle", "stops", "opacity"})
    kind = value.get("type")
    if kind not in {"solid", "gradient", "none"}:
        raise ValueError("填充仅支持纯色、线性渐变或无填充。")
    for item in list(properties):
        if XML.QName(item).localname in {"solidFill", "gradFill", "noFill", "pattFill", "blipFill", "grpFill"}:
            properties.remove(item)
    if kind == "none":
        fill = element("a:noFill")
    elif kind == "solid":
        fill = element("a:solidFill")
        paint = element("a:srgbClr", val=color(value.get("color")))
        if "opacity" in value:
            paint.append(element("a:alpha", val=round(number(value["opacity"], 0, 1) * 100000)))
        fill.append(paint)
    else:
        stops = value.get("stops")
        if not isinstance(stops, list) or not 2 <= len(stops) <= 12:
            raise ValueError("线性渐变需要2至12个色标。")
        fill, roster = element("a:gradFill", rotWithShape="1"), element("a:gsLst")
        previous = -1
        for stop in stops:
            keys(stop, {"position", "color", "opacity"})
            position = number(stop.get("position"), 0, 1)
            if position < previous:
                raise ValueError("渐变色标必须按位置递增排列。")
            item = element("a:gs", pos=round(position * 100000))
            paint = element("a:srgbClr", val=color(stop.get("color")))
            if "opacity" in stop:
                paint.append(element("a:alpha", val=round(number(stop["opacity"], 0, 1) * 100000)))
            item.append(paint)
            roster.append(item)
            previous = position
        fill.append(roster)
        fill.append(element("a:lin", ang=round(number(value.get("angle", 0), 0, 360) * 60000), scaled="1"))
    # OOXML对填充、线条、效果和字体的顺序有约束，不能简单追加在节点末尾。
    parent = XML.QName(properties).localname
    later = {"ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst"}
    if parent == "ln":
        later = {"prstDash", "custDash", "round", "bevel", "miter", "headEnd", "tailEnd", "extLst"}
    elif parent in {"rPr", "defRPr", "endParaRPr"}:
        later = {"effectLst", "effectDag", "highlight", "uLnTx", "uLn", "uFillTx", "uFill", "latin", "ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"}
    insertion = next((index for index, item in enumerate(properties) if XML.QName(item).localname in later), len(properties))
    properties.insert(insertion, fill)


def update_frame(node, value):
    keys(value, {"x", "y", "width", "height", "rotation", "flipH", "flipV"})
    xfrm = transform(node)
    if xfrm is None:
        raise ValueError("当前对象没有可直接编辑的位置尺寸，请保留原稿。")
    for key, tag, attr in [("x", "a:off", "x"), ("y", "a:off", "y"), ("width", "a:ext", "cx"), ("height", "a:ext", "cy")]:
        if key in value:
            child(xfrm, tag).set(attr, str(round(number(value[key], 0.1 if key in {"width", "height"} else -100000, 100000) * EMU)))
    if "rotation" in value:
        xfrm.set("rot", str(round(number(value["rotation"], -360, 360) * 60000)))
    for key in ["flipH", "flipV"]:
        if key in value:
            if not isinstance(value[key], bool):
                raise ValueError("翻转开关必须是布尔值。")
            xfrm.set(key, "1" if value[key] else "0")


def update_runs(node, edits):
    if not isinstance(edits, list) or len(edits) > 500:
        raise ValueError("富文本分段数量无效。")
    paragraphs = node.findall("p:txBody/a:p", NS)
    for edit in edits:
        keys(edit, {"paragraph", "run", "text", "fontSize", "fontFamily", "bold", "italic", "color"})
        p, r = edit.get("paragraph"), edit.get("run")
        if not isinstance(p, int) or not isinstance(r, int) or not 0 <= p < len(paragraphs):
            raise ValueError("富文本段落已变化，请刷新后重试。")
        spans = paragraphs[p].findall("a:r", NS)
        if not 0 <= r < len(spans):
            raise ValueError("富文本分段已变化，请刷新后重试。")
        run = spans[r]
        if "text" in edit:
            if not isinstance(edit["text"], str) or len(edit["text"]) > 12000 or "\x00" in edit["text"]:
                raise ValueError("富文本文字为空、过长或包含无效字符。")
            child(run, "a:t").text = edit["text"]
        if any(key in edit for key in ["fontSize", "fontFamily", "bold", "italic", "color"]):
            prop = run.find("a:rPr", NS)
            if prop is None:
                prop = element("a:rPr")
                run.insert(0, prop)
            if "fontSize" in edit:
                prop.set("sz", str(round(number(edit["fontSize"], 1, 400) * 100)))
            if "fontFamily" in edit:
                font = edit["fontFamily"]
                if not isinstance(font, str) or not 1 <= len(font) <= 120 or any(ord(char) < 32 for char in font):
                    raise ValueError("字体名称无效。")
                for name, later in [("latin", {"ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"}), ("ea", {"cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"})]:
                    entry = prop.find("a:" + name, NS)
                    if entry is None:
                        entry = element("a:" + name)
                        insertion = next((index for index, item in enumerate(prop) if XML.QName(item).localname in later), len(prop))
                        prop.insert(insertion, entry)
                    entry.set("typeface", font)
            for key, attr in [("bold", "b"), ("italic", "i")]:
                if key in edit:
                    if not isinstance(edit[key], bool):
                        raise ValueError("字体样式必须为布尔值。")
                    prop.set(attr, "1" if edit[key] else "0")
            if "color" in edit:
                set_fill(prop, {"type": "solid", "color": edit["color"]})


def update_formula(node, edits, skill):
    if not isinstance(edits, list) or len(edits) > 50:
        raise ValueError("公式数量无效。")
    sys.path.insert(0, str(skill / "scripts"))
    from svg_to_pptx.native_objects.formula_compiler import compile_latex_to_inline_omml
    from svg_to_pptx.native_objects.formula_run_properties import merge_formula_run_properties, merge_formula_control_properties
    from xml.etree import ElementTree as ET
    equations = node.findall(".//m:oMath", NS)
    for edit in edits:
        keys(edit, {"index", "latex"})
        index, latex = edit.get("index"), edit.get("latex")
        if not isinstance(index, int) or not 0 <= index < len(equations) or not isinstance(latex, str) or not 1 <= len(latex) <= 4000:
            raise ValueError("公式内容或对象标识无效。")
        compiled = parse(compile_latex_to_inline_omml(latex).encode())
        equation = equations[index]
        original_style = equation.find(".//a:rPr", NS)
        if original_style is None:
            original_style = node.find("p:txBody/a:p/a:pPr/a:defRPr", NS)
        if original_style is not None:
            style = ET.fromstring(XML.tostring(original_style))
            style.tag = "{" + NS["a"] + "}rPr"
            tree = ET.fromstring(XML.tostring(compiled))
            for run in tree.iter("{" + NS["m"] + "}r"):
                merge_formula_run_properties(run, style)
            merge_formula_control_properties(tree, style)
            compiled = parse(ET.tostring(tree))
        compiled.tail = equation.tail
        equation.getparent().replace(equation, compiled)


def update_table(node, cells):
    table = node.find("a:graphic/a:graphicData/a:tbl", NS)
    if table is None or not isinstance(cells, list) or len(cells) > 2000:
        raise ValueError("当前对象不是支持的原生表格。")
    rows = table.findall("a:tr", NS)
    for edit in cells:
        keys(edit, {"row", "column", "text"})
        row, column, text = edit.get("row"), edit.get("column"), edit.get("text")
        if not isinstance(row, int) or not isinstance(column, int) or not 0 <= row < len(rows) or not 0 <= column < len(rows[row].findall("a:tc", NS)) or not isinstance(text, str) or len(text) > 12000:
            raise ValueError("表格单元格标识或文字无效。")
        cell = rows[row].findall("a:tc", NS)[column]
        if cell.get("hMerge") == "1" or cell.get("vMerge") == "1":
            raise ValueError("请在合并单元格的起始单元格修改内容。")
        body = cell.find("a:txBody", NS)
        paragraph = body.find("a:p", NS)
        original_style = paragraph.find("a:r/a:rPr", NS) if paragraph is not None else None
        for item in list(body):
            if XML.QName(item).localname == "p":
                body.remove(item)
        for line in text.split("\n"):
            p, run = element("a:p"), element("a:r")
            if original_style is not None:
                run.append(parse(XML.tostring(original_style)))
            child(run, "a:t").text = line
            p.append(run)
            body.append(p)


def update_geometry(node, value):
    properties = node.find("p:spPr", NS)
    if properties is None:
        raise ValueError("当前对象不支持几何路径编辑。")
    keys(value, {"adjustments", "paths"})
    if "adjustments" in value:
        geom = properties.find("a:prstGeom", NS)
        edits = value["adjustments"]
        if geom is None or not isinstance(edits, list) or len(edits) > 30:
            raise ValueError("当前对象不支持预设调整参数。")
        existing = {gd.get("name"): gd for gd in geom.findall("a:avLst/a:gd", NS)}
        for edit in edits:
            keys(edit, {"name", "formula"})
            formula = edit.get("formula", "")
            if edit.get("name") not in existing or not re.fullmatch(r"val -?\d{1,10}", formula):
                raise ValueError("仅支持原有几何参数的明确数值调整。")
            existing[edit["name"]].set("fmla", formula)
    if "paths" in value:
        custom = properties.find("a:custGeom", NS)
        paths = value["paths"]
        if custom is None or not isinstance(paths, list) or not 1 <= len(paths) <= 40:
            raise ValueError("当前对象不支持自定义路径编辑。")
        path_list = child(custom, "a:pathLst")
        for item in list(path_list):
            path_list.remove(item)
        count = 0
        for path in paths:
            keys(path, {"attributes", "commands"})
            attributes = path.get("attributes", {})
            keys(attributes, {"w", "h", "fill", "stroke", "extrusionOk"})
            new_path = element("a:path")
            for key, value in attributes.items():
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,30}", str(value)):
                    raise ValueError("路径尺寸或绘制属性无效。")
                new_path.set(key, str(value))
            for command in path.get("commands", []):
                count += 1
                keys(command, {"type", "attributes", "points"})
                kind = command.get("type")
                if kind not in {"moveTo", "lnTo", "cubicBezTo", "quadBezTo", "arcTo", "close"} or count > 4000:
                    raise ValueError("路径指令不受支持或过多。")
                item = element("a:" + kind)
                attrs = command.get("attributes", {})
                keys(attrs, {"wR", "hR", "stAng", "swAng"})
                points = command.get("points", [])
                expected = {"moveTo": 1, "lnTo": 1, "cubicBezTo": 3, "quadBezTo": 2, "arcTo": 0, "close": 0}[kind]
                if len(points) != expected:
                    raise ValueError("路径控制点数量无效。")
                for key, value in attrs.items():
                    if not re.fullmatch(r"-?[A-Za-z0-9_.]{1,50}", str(value)):
                        raise ValueError("路径圆弧参数无效。")
                    item.set(key, str(value))
                for point in points:
                    keys(point, {"x", "y"})
                    if set(point) != {"x", "y"} or any(not re.fullmatch(r"(?:-?\d{1,12}|[A-Za-z_][A-Za-z0-9_.]{0,49})", str(value)) for value in point.values()):
                        raise ValueError("路径控制点坐标无效。")
                    item.append(element("a:pt", **point))
                new_path.append(item)
            path_list.append(new_path)


def update_chart(package, slide_index, node, value):
    keys(value, {"categories", "series"})
    from native_objects import chart
    original = chart(package, slide_index, node)
    categories, series = value.get("categories"), value.get("series")
    if not original or not original["editable"] or not isinstance(categories, list) or not isinstance(series, list) or len(categories) != len(original["categories"]) or len(series) != len(original["series"]) or len(categories) > 200:
        raise ValueError("仅支持原有分类和序列数量保持一致的图表数据编辑。")
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    presentation = Presentation(io.BytesIO(package.original))

    def find(shapes):
        for shape in shapes:
            if str(shape.shape_id) == node.find(".//p:cNvPr", NS).get("id"):
                return shape
            if shape.shape_type == 6:
                found = find(shape.shapes)
                if found is not None:
                    return found
        return None

    shape = find(presentation.slides[slide_index].shapes)
    data = CategoryChartData()
    if any(not isinstance(item, str) or len(item) > 500 for item in categories):
        raise ValueError("图表分类名称无效。")
    data.categories = categories
    for item in series:
        keys(item, {"name", "values"})
        if not isinstance(item.get("name"), str) or len(item["name"]) > 500 or not isinstance(item.get("values"), list) or len(item["values"]) != len(categories):
            raise ValueError("图表序列名称或数据数量无效。")
        data.add_series(item["name"], [number(value, -1e14, 1e14) for value in item["values"]])
    chart_root = parse(package.parts[original["part"]])
    if any(chart_root.find(".//c:" + kind, NS) is not None for kind in ["pieChart", "doughnutChart", "pie3DChart"]):
        if len(series) != 1 or any(value < 0 for value in series[0]["values"]) or sum(series[0]["values"]) <= 0:
            raise ValueError("饼图和环形图需要单序列非负数且总和大于零。")
    shape.chart.replace_data(data)
    chart_file = original["part"]
    workbook = shape.chart.part.chart_workbook.xlsx_part
    if workbook is None:
        raise ValueError("当前图表没有可编辑的嵌入工作簿。")
    workbook_file = str(workbook.partname).lstrip("/")
    references = sum(1 for file in package.parts if re.fullmatch(r"ppt/charts/chart\d+\.xml", file) for rel in package.relationships(file).values() if not rel["external"] and rel["target"] == workbook_file)
    if references != 1:
        raise ValueError("多个图表共享工作簿，当前数据保持只读以避免连带修改。")
    package.changed[chart_file] = XML.tostring(shape.chart._chartSpace, xml_declaration=True, encoding="UTF-8", standalone=True)
    package.changed[workbook_file] = workbook.blob


def apply(package, patches, skill):
    if not isinstance(patches, list) or not 1 <= len(patches) <= 200:
        raise ValueError("请提交1至200个对象补丁。")
    touched = set()
    chart_parts = set()
    for patch in patches:
        keys(patch, {"slideIndex", "objectId", "frame", "fill", "line", "runs", "formulas", "cells", "chart", "geometry", "hidden"})
        index = patch.get("slideIndex")
        node = package.object(index, patch.get("objectId"))
        if "frame" in patch:
            update_frame(node, patch["frame"])
        if "fill" in patch or "line" in patch:
            properties = node.find("p:spPr", NS)
            if properties is None:
                raise ValueError("此对象的填充或边框保持原稿。")
            if "fill" in patch:
                set_fill(properties, patch["fill"])
            if "line" in patch:
                keys(patch["line"], {"color", "width"})
                line = child(properties, "a:ln")
                line.set("w", str(round(number(patch["line"].get("width", 1), 0, 100) * EMU)))
                set_fill(line, {"type": "solid", "color": patch["line"]["color"]})
        if "runs" in patch:
            update_runs(node, patch["runs"])
        if "formulas" in patch:
            update_formula(node, patch["formulas"], skill)
        if "cells" in patch:
            update_table(node, patch["cells"])
        if "geometry" in patch:
            update_geometry(node, patch["geometry"])
        if "chart" in patch:
            from native_objects import chart
            chart_part = chart(package, index, node)["part"]
            if chart_part in chart_parts:
                raise ValueError("同轮不能重复修改共享图表，请分次保存。")
            chart_parts.add(chart_part)
            update_chart(package, index, node, patch["chart"])
        if "hidden" in patch:
            if not isinstance(patch["hidden"], bool):
                raise ValueError("隐藏状态必须为布尔值。")
            node.find(".//p:cNvPr", NS).set("hidden", "1" if patch["hidden"] else "0")
        touched.add(index)
    for index in touched:
        package.save_slide(index)
    return package.output()
