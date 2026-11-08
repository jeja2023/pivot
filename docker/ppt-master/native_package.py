"""原生PPTX包读取与定点写回；未修改条目保持原字节，不重建整份文稿。"""
from __future__ import annotations

import hashlib
import io
import posixpath
from pathlib import PurePosixPath
import zipfile
from lxml import etree as XML

NS = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", "a": "http://schemas.openxmlformats.org/drawingml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "c": "http://schemas.openxmlformats.org/drawingml/2006/chart", "m": "http://schemas.openxmlformats.org/officeDocument/2006/math", "rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
EMU = 9525


def parse(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("PPTX包含不支持的外部XML声明。")
    return XML.fromstring(data, XML.XMLParser(resolve_entities=False, no_network=True, huge_tree=False))


def element(name, **attributes):
    prefix, local = name.split(":")
    return XML.Element("{" + NS[prefix] + "}" + local, {key: str(value) for key, value in attributes.items()})


def child(parent, name):
    result = parent.find(name, NS)
    if result is None:
        result = element(name)
        parent.append(result)
    return result


class Package:
    def __init__(self, data):
        if len(data) > 60 * 1024 * 1024:
            raise ValueError("原稿超过60MiB上限。")
        self.original = data
        self.archive = zipfile.ZipFile(io.BytesIO(data))
        entries = self.archive.infolist()
        if len(entries) > 16000 or sum(entry.file_size for entry in entries) > 250 * 1024 * 1024:
            raise ValueError("原稿解压体积或文件数量超过上限。")
        names = [entry.filename for entry in entries]
        if not {"ppt/presentation.xml", "[Content_Types].xml"}.issubset(names):
            raise ValueError("原稿不是完整PPTX，请在演示软件中重新另存后上传。")
        if len(names) != len(set(names)) or any(name.startswith("/") or ".." in PurePosixPath(name).parts or "\\" in name for name in names):
            raise ValueError("原稿包含不安全或重复包条目。")
        if any("vbaproject" in name.lower() or name.lower().endswith(".bin") and "activex" in name.lower() for name in names):
            raise ValueError("请先移除原稿中的宏或ActiveX后再进行离线编辑。")
        self.parts = {entry.filename: self.archive.read(entry) for entry in entries}
        for name, content in self.parts.items():
            if name.endswith((".xml", ".rels")):
                parse(content)
        self.changed = {}
        presentation = parse(self.parts["ppt/presentation.xml"])
        size = presentation.find("p:sldSz", NS)
        if size is None:
            raise ValueError("原稿缺少页面尺寸。")
        self.width, self.height = int(size.get("cx")) / EMU, int(size.get("cy")) / EMU
        if not 10 <= self.width <= 20000 or not 10 <= self.height <= 20000:
            raise ValueError("原稿页面尺寸超出支持范围。")
        links = self.relationships("ppt/presentation.xml")
        self.slides = [links[node.get("{" + NS["r"] + "}id")]["target"] for node in presentation.findall("p:sldIdLst/p:sldId", NS)]
        if not 1 <= len(self.slides) <= 40:
            raise ValueError("离线原稿工作台支持1至40页。")
        if len(self.slides) != len(set(self.slides)):
            raise ValueError("多个页面共享同一个原生页，请先在演示软件中另存为独立页面。")
        self.roots = {}
        self.chart_uses = {}
        for index, file in enumerate(self.slides):
            links = self.relationships(file)
            for node in self.slide(index).findall(".//c:chart", NS):
                target = links.get(node.get("{" + NS["r"] + "}id"), {}).get("target")
                self.chart_uses[target] = self.chart_uses.get(target, 0) + 1

    def relationships(self, name):
        file = posixpath.join(posixpath.dirname(name), "_rels", posixpath.basename(name) + ".rels")
        if file not in self.parts:
            return {}
        result = {}
        for rel in parse(self.parts[file]):
            target = rel.get("Target", "")
            external = rel.get("TargetMode") == "External"
            resolved = target if external else posixpath.normpath(posixpath.join(posixpath.dirname(name), target)) if not target.startswith("/") else target[1:]
            if not external and (resolved.startswith("../") or resolved not in self.parts):
                raise ValueError("PPTX关系指向不存在或越界的文件。")
            result[rel.get("Id")] = {"target": resolved, "type": rel.get("Type", ""), "external": external}
        return result

    def slide(self, index):
        if not isinstance(index, int) or not 0 <= index < len(self.slides):
            raise ValueError("原稿页码不存在。")
        file = self.slides[index]
        if file not in self.roots:
            self.roots[file] = parse(self.parts[file])
        return self.roots[file]

    def objects(self, index):
        tree = self.slide(index).find("p:cSld/p:spTree", NS)
        result = []

        def visit(parent, parent_id="", depth=0):
            if depth > 20:
                raise ValueError("原稿组合层级过深。")
            for node in parent:
                kind = XML.QName(node).localname
                if kind not in {"sp", "pic", "graphicFrame", "cxnSp", "grpSp"}:
                    continue
                identity = node.find(".//p:cNvPr", NS)
                if identity is None:
                    continue
                result.append((identity.get("id"), node, parent_id))
                if kind == "grpSp":
                    visit(node, identity.get("id"), depth + 1)

        visit(tree)
        ids = [item[0] for item in result]
        if len(ids) != len(set(ids)) or len(result) > 1000:
            raise ValueError("原稿对象标识重复或单页对象数量过多。")
        return result

    def object(self, index, identity):
        for key, node, parent in self.objects(index):
            if key == str(identity):
                return node
        raise ValueError("所选原生对象不存在，请刷新后重试。")

    def save_slide(self, index):
        self.changed[self.slides[index]] = XML.tostring(self.slide(index), xml_declaration=True, encoding="UTF-8", standalone=True)

    def output(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
            for entry in self.archive.infolist():
                archive.writestr(entry, self.changed.get(entry.filename, self.parts[entry.filename]))
        result = stream.getvalue()
        verification = Package(result)
        for name, data in self.parts.items():
            if name not in self.changed and verification.parts[name] != data:
                raise ValueError("未修改的原稿条目发生变化，已停止交付。")
        return result, {"changedParts": sorted(self.changed), "preservedParts": len(self.parts) - len(self.changed), "sourceDigest": hashlib.sha256(self.original).hexdigest(), "outputDigest": hashlib.sha256(result).hexdigest()}


def transform(node):
    for name in ["p:spPr/a:xfrm", "p:grpSpPr/a:xfrm", "p:xfrm"]:
        found = node.find(name, NS)
        if found is not None:
            return found
    return None


def frame(node):
    xfrm = transform(node)
    if xfrm is None:
        return None
    off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
    if off is None or ext is None:
        return None
    return {"x": int(off.get("x", 0)) / EMU, "y": int(off.get("y", 0)) / EMU, "width": int(ext.get("cx", 0)) / EMU, "height": int(ext.get("cy", 0)) / EMU, "rotation": int(xfrm.get("rot", 0)) / 60000, "flipH": xfrm.get("flipH") == "1", "flipV": xfrm.get("flipV") == "1"}
