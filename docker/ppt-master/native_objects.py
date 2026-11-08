"""将原生对象投影为可编辑字段，保留对象身份、组合和未支持内容。"""
from __future__ import annotations

import sys
import math
from pathlib import Path
from xml.etree import ElementTree as ET
from lxml import etree as XML
from native_package import NS, EMU, frame, parse


def rgb(node):
    if node is None:
        return None
    value = node.find("a:srgbClr", NS)
    return "#" + value.get("val") if value is not None else None


def paint(node):
    if node is None:
        return None
    solid = node.find("a:solidFill", NS)
    if solid is not None:
        alpha = solid.find("a:srgbClr/a:alpha", NS)
        return {"type": "solid", "color": rgb(solid), "opacity": int(alpha.get("val")) / 100000 if alpha is not None else 1}
    gradient = node.find("a:gradFill", NS)
    if gradient is not None:
        stops = []
        for stop in gradient.findall("a:gsLst/a:gs", NS):
            alpha = stop.find("a:srgbClr/a:alpha", NS)
            stops.append({"position": int(stop.get("pos", 0)) / 100000, "color": rgb(stop), "opacity": int(alpha.get("val")) / 100000 if alpha is not None else 1})
        line = gradient.find("a:lin", NS)
        return {"type": "gradient", "angle": int(line.get("ang", 0)) / 60000 if line is not None else 0, "stops": stops, "editable": line is not None and all(stop["color"] for stop in stops)}
    return {"type": "none"} if node.find("a:noFill", NS) is not None else {"type": "inherited"}


def runs(node):
    result = []
    for p_index, paragraph in enumerate(node.findall("p:txBody/a:p", NS)):
        for r_index, run in enumerate(paragraph.findall("a:r", NS)):
            prop = run.find("a:rPr", NS)
            font = prop.find("a:latin", NS) if prop is not None else None
            size = prop.get("sz") if prop is not None else None
            result.append({"paragraph": p_index, "run": r_index, "text": run.findtext("a:t", "", NS), "fontSize": int(size) / 100 if size else None, "fontFamily": font.get("typeface") if font is not None else "", "bold": prop.get("b") == "1" if prop is not None else False, "italic": prop.get("i") == "1" if prop is not None else False, "color": rgb(prop.find("a:solidFill", NS)) if prop is not None else None})
    return result


def formulas(node, skill):
    sys.path.insert(0, str(skill / "scripts/source_to_md"))
    sys.path.insert(0, str(skill / "scripts"))
    from pptx_to_svg.formula_import import _serialize_root
    from svg_to_pptx.native_objects.formula_compiler import compile_latex_to_inline_omml
    from svg_to_pptx.native_objects.formula_omml import validate_omml_fragment
    result = []
    for index, equation in enumerate(node.findall(".//m:oMath", NS)):
        try:
            math = ET.fromstring(XML.tostring(equation))
            # Office可省略默认横线分式属性，上游编译器要求显式表达；仅在读取投影中补齐。
            for fraction in math.findall(".//m:f", NS):
                if fraction.find("m:fPr", NS) is None:
                    properties = ET.Element("{" + NS["m"] + "}fPr")
                    ET.SubElement(properties, "{" + NS["m"] + "}type", {"{" + NS["m"] + "}val": "bar"})
                    fraction.insert(0, properties)
            validate_omml_fragment(ET.tostring(math, encoding="unicode"))
            latex = _serialize_root(math)
            compile_latex_to_inline_omml(latex)
        except (ValueError, TypeError, NotImplementedError, RecursionError):
            latex = ""
        result.append({"index": index, "latex": latex, "editable": bool(latex)})
    return result


def geometry(node):
    preset = node.find("p:spPr/a:prstGeom", NS)
    if preset is not None:
        return {"type": "preset", "preset": preset.get("prst"), "adjustments": [{"name": gd.get("name"), "formula": gd.get("fmla")} for gd in preset.findall("a:avLst/a:gd", NS)]}
    custom = node.find("p:spPr/a:custGeom", NS)
    if custom is None:
        return None
    paths = []
    for path in custom.findall("a:pathLst/a:path", NS):
        commands = []
        for command in path:
            commands.append({"type": XML.QName(command).localname, "attributes": dict(command.attrib), "points": [dict(point.attrib) for point in command]})
        paths.append({"attributes": dict(path.attrib), "commands": commands})
    return {"type": "custom", "paths": paths}


def table(node):
    source = node.find("a:graphic/a:graphicData/a:tbl", NS)
    if source is None:
        return None
    return {"rows": [[{"text": "\n".join("".join(row.itertext()) for row in cell.findall("a:txBody/a:p", NS)), "merged": cell.get("hMerge") == "1" or cell.get("vMerge") == "1"} for cell in row.findall("a:tc", NS)] for row in source.findall("a:tr", NS)]}


def chart(package, index, node):
    reference = node.find("a:graphic/a:graphicData/c:chart", NS)
    if reference is None:
        return None
    link = package.relationships(package.slides[index]).get(reference.get("{" + NS["r"] + "}id"))
    if not link or link["external"]:
        return {"editable": False, "reason": "外部图表保持原稿。"}
    root = parse(package.parts[link["target"]])
    series = root.findall(".//c:ser", NS)
    supported = bool(series) and not any(root.find(".//c:" + kind, NS) is not None for kind in ["scatterChart", "bubbleChart", "stockChart", "surfaceChart", "surface3DChart"])
    categories = [point.findtext("c:v", "", NS) for point in series[0].findall("c:cat/c:strRef/c:strCache/c:pt", NS)] if series else []
    if not categories and series:
        levels = series[0].findall("c:cat/c:multiLvlStrRef/c:multiLvlStrCache/c:lvl", NS)
        if len(levels) == 1:
            categories = [point.findtext("c:v", "", NS) for point in levels[0].findall("c:pt", NS)]
    if not categories and series:
        supported = False
        categories = [point.findtext("c:v", "", NS) for point in series[0].findall("c:cat/c:numRef/c:numCache/c:pt", NS)]
    values = []
    for item in series:
        points = item.findall("c:val/c:numRef/c:numCache/c:pt", NS)
        try:
            data = [float(point.findtext("c:v", "nan", NS)) for point in points]
            if any(not math.isfinite(value) for value in data):
                supported, data = False, [value if math.isfinite(value) else None for value in data]
        except ValueError:
            supported, data = False, []
        name = item.findtext("c:tx/c:strRef/c:strCache/c:pt/c:v", "", NS) or item.findtext("c:tx/c:v", "", NS)
        values.append({"name": name, "values": data})
    supported = supported and 0 < len(categories) <= 200 and len(values) <= 20 and all(len(item["values"]) == len(categories) for item in values) and package.chart_uses.get(link["target"]) == 1
    return {"editable": supported, "categories": categories, "series": values, "part": link["target"], "reason": "仅同结构分类图表可修改数据；其他图表保留原稿。" if not supported else ""}


def describe(package, skill):
    slides, count = [], 0
    for index in range(len(package.slides)):
        objects = []
        for identity, node, parent in package.objects(index):
            kind = XML.QName(node).localname
            name = node.find(".//p:cNvPr", NS).get("name", "原生对象")
            properties = node.find("p:spPr", NS)
            info = {"id": identity, "parentId": parent, "name": name, "kind": kind, "frame": frame(node), "runs": runs(node), "formulas": formulas(node, skill) if kind != "grpSp" else [], "fill": paint(properties), "geometry": geometry(node), "table": table(node), "chart": chart(package, index, node), "hidden": node.find(".//p:cNvPr", NS).get("hidden") == "1"}
            group = node.find("p:grpSpPr/a:xfrm", NS)
            if group is not None:
                offset, extent = group.find("a:chOff", NS), group.find("a:chExt", NS)
                if offset is not None and extent is not None:
                    info["childFrame"] = {"x": int(offset.get("x", 0)) / EMU, "y": int(offset.get("y", 0)) / EMU, "width": int(extent.get("cx", 0)) / EMU, "height": int(extent.get("cy", 0)) / EMU}
            data = node.find("a:graphic/a:graphicData", NS)
            if kind == "graphicFrame" and info["table"] is None and info["chart"] is None:
                info["contentReadOnly"] = True
                info["notice"] = "SmartArt、OLE或未映射图形保留原生内容，仅支持已有对象的位置和尺寸。"
            if node.find(".//p:oleObj", NS) is not None:
                info["notice"] = "嵌入对象保持原稿，不执行嵌入程序。"
            objects.append(info)
        count += len(objects)
        if count > 2500:
            raise ValueError("整稿对象超过2500个，请拆分后编辑。")
        media = any(rel["type"].endswith(("/video", "/audio", "/media")) for rel in package.relationships(package.slides[index]).values())
        slides.append({"index": index, "objects": objects, "hasNativeAnimations": package.slide(index).find("p:timing", NS) is not None, "hasEmbeddedMedia": media})
    return {"schemaVersion": 1, "width": package.width, "height": package.height, "slides": slides, "objectCount": count, "previewEngine": "LibreOffice", "previewNotice": "离线静态预览可能与PowerPoint存在字体及复杂效果差异。母版、兼容分支及未列出的对象保持原稿；不支持的内容不转换成图片替代。"}
