"""独立公式仅在预览副本中离线排版；交付PPTX始终保留原生Office Math。"""
import copy
import io
import math
import posixpath
import zipfile
from lxml import etree as XML
from PIL import Image
from native_package import Package, NS, EMU, frame, element, parse
from native_objects import formulas


def prepare(source, target, skill):
    package = Package(source.read_bytes())
    replacements = 0
    for index, file in enumerate(package.slides):
        relationships_file = posixpath.join(posixpath.dirname(file), "_rels", posixpath.basename(file) + ".rels")
        relationships = parse(package.parts[relationships_file])
        for identity, node, parent in package.objects(index):
            equations = node.findall(".//m:oMath", NS)
            if not equations or node.findall("p:txBody/a:p/a:r", NS):
                continue
            if len(equations) != 1 or XML.QName(node).localname != "sp":
                continue
            projected = formulas(node, skill)
            if not projected or not projected[0]["editable"]:
                continue
            geometry = frame(node)
            if not geometry:
                continue
            import matplotlib
            matplotlib.use("Agg")
            from matplotlib.mathtext import math_to_image
            from matplotlib.font_manager import FontProperties
            properties = equations[0].find(".//a:rPr", NS)
            size = max(1, min(200, int(properties.get("sz", 1800)) / 100)) if properties is not None else 18
            color = properties.find("a:solidFill/a:srgbClr", NS) if properties is not None else None
            ink = "#" + color.get("val") if color is not None else "#000000"
            output = io.BytesIO()
            try:
                with matplotlib.rc_context({"mathtext.fontset": "stix", "savefig.transparent": True}):
                    math_to_image("$" + projected[0]["latex"] + "$", output, prop=FontProperties(size=size), dpi=192, format="png", color=ink)
            except (ValueError, RuntimeError) as error:
                raise ValueError("当前公式可保留原稿，但离线预览排版器不支持此公式，请在目标Office软件中处理后重试。") from error
            content = output.getvalue()
            with Image.open(io.BytesIO(content)) as image:
                width, height = image.width / 2, image.height / 2
            width, height = max(1, width), max(1, height)
            ratio = min(1, geometry["width"] / width, geometry["height"] / height)
            width, height = width * ratio, height * ratio
            align = node.find("p:txBody/a:p/a:pPr", NS)
            alignment = align.get("algn") if align is not None else "ctr"
            x = geometry["x"] + (0 if alignment == "l" else geometry["width"] - width if alignment == "r" else (geometry["width"] - width) / 2)
            body = node.find("p:txBody/a:bodyPr", NS)
            anchor = body.get("anchor", "t") if body is not None else "t"
            y = geometry["y"] + ((geometry["height"] - height) / 2 if anchor == "ctr" else geometry["height"] - height if anchor == "b" else int(body.get("tIns", 0)) / EMU if body is not None else 0)
            if geometry["rotation"]:
                angle = math.radians(geometry["rotation"])
                center_x, center_y = geometry["x"] + geometry["width"] / 2, geometry["y"] + geometry["height"] / 2
                dx, dy = x + width / 2 - center_x, y + height / 2 - center_y
                x, y = center_x + dx * math.cos(angle) - dy * math.sin(angle) - width / 2, center_y + dx * math.sin(angle) + dy * math.cos(angle) - height / 2
            replacements += 1
            media = f"ppt/media/offline_math_{index}_{identity}.png"
            package.changed[media] = content
            relation_id = "rIdOfflineMath" + str(replacements)
            relationships.append(XML.Element("{" + NS["rel"] + "}Relationship", Id=relation_id, Type=NS["r"] + "/image", Target=posixpath.relpath(media, posixpath.dirname(file))))
            pic = element("p:pic")
            nv = element("p:nvPicPr"); nv.append(copy.deepcopy(node.find(".//p:cNvPr", NS))); nv.append(element("p:cNvPicPr")); nv.append(element("p:nvPr")); pic.append(nv)
            fill = element("p:blipFill")
            blip = element("a:blip"); blip.set("{" + NS["r"] + "}embed", relation_id); fill.append(blip)
            stretch = element("a:stretch"); stretch.append(element("a:fillRect")); fill.append(stretch); pic.append(fill)
            properties = element("p:spPr"); transform = element("a:xfrm", rot=round(geometry["rotation"] * 60000)); transform.append(element("a:off", x=round(x * EMU), y=round(y * EMU))); transform.append(element("a:ext", cx=round(width * EMU), cy=round(height * EMU))); properties.append(transform)
            preset = element("a:prstGeom", prst="rect"); preset.append(element("a:avLst")); properties.append(preset); pic.append(properties)
            node.getparent().replace(node, pic)
        if any(name.startswith(f"ppt/media/offline_math_{index}_") for name in package.changed):
            package.save_slide(index)
            package.changed[relationships_file] = XML.tostring(relationships, xml_declaration=True, encoding="UTF-8", standalone=True)
    if replacements:
        types = parse(package.parts["[Content_Types].xml"])
        if not any(item.get("Extension") == "png" for item in types):
            types.append(XML.Element("{http://schemas.openxmlformats.org/package/2006/content-types}Default", Extension="png", ContentType="image/png"))
            package.changed["[Content_Types].xml"] = XML.tostring(types, xml_declaration=True, encoding="UTF-8", standalone=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in package.parts:
                archive.writestr(name, package.changed.get(name, package.parts[name]))
            for name in package.changed.keys() - package.parts.keys():
                archive.writestr(name, package.changed[name])
        return target
    return source
