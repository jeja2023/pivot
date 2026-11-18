"""从原生放映顺序提取页面及其可达的 Open Packaging Convention 部件。"""
import io
import posixpath
import zipfile

from lxml import etree as XML
from native_package import NS, Package, parse


def serialize(root):
    return XML.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def select_pages(data, pages):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return select_parts(archive, data, pages)


def select_parts(archive, data, pages):
    package = Package(data)
    package.archive.close()
    parts = package.parts
    presentation = "ppt/presentation.xml"
    root = parse(parts[presentation])
    page_list = root.find("p:sldIdLst", NS)
    if not pages or pages != sorted(set(pages)) or any(not 1 <= page <= len(package.slides) for page in pages):
        raise ValueError("无法按指定页码提取原生页面。")
    selected = {package.slides[page - 1] for page in pages}
    excluded = set(package.slides) - selected
    for index, node in enumerate(list(page_list), 1):
        if index not in pages:
            page_list.remove(node)
    for name in ("p:custShowLst", "p:extLst"):
        node = root.find(name, NS)
        if node is not None:
            root.remove(node)

    contents = {presentation: serialize(root)}
    queue, visited = [("", "_rels/.rels")], set()
    while queue:
        owner, rel_path = queue.pop()
        if owner in visited:
            continue
        visited.add(owner)
        if owner:
            contents.setdefault(owner, parts[owner])
        if rel_path not in parts:
            continue
        links = parse(parts[rel_path])
        dropped = set()
        for relation in list(links):
            target = relation.get("Target", "")
            if not owner and relation.get("Type") != NS["r"] + "/officeDocument":
                links.remove(relation)
                continue
            if relation.get("TargetMode") == "External":
                continue
            target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(owner), target))
            if target in excluded:
                dropped.add(relation.get("Id"))
                links.remove(relation)
                continue
            if target not in parts:
                raise ValueError("原生页面的内部资源缺失，无法提取。")
            queue.append((target, posixpath.join(posixpath.dirname(target), "_rels", posixpath.basename(target) + ".rels")))
        if dropped and owner:
            xml = parse(contents[owner])
            for node in list(xml.iter()):
                if not any(key.startswith("{" + NS["r"] + "}") and value in dropped for key, value in node.attrib.items()):
                    continue
                if XML.QName(node).localname not in {"hlinkClick", "hlinkHover"}:
                    raise ValueError("所选页面仍依赖被排除页面，无法安全提取。")
                node.getparent().remove(node)
            contents[owner] = serialize(xml)
        contents[rel_path] = serialize(links)

    types = parse(parts["[Content_Types].xml"])
    for item in list(types):
        name = item.get("PartName")
        if name and name.lstrip("/") not in contents:
            types.remove(item)
    contents["[Content_Types].xml"] = serialize(types)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as destination:
        for name, value in contents.items():
            destination.writestr(archive.getinfo(name).filename, value)
    result = output.getvalue()
    verified = Package(result)
    verified.archive.close()
    if verified.slides != [package.slides[page - 1] for page in pages] or excluded.intersection(verified.parts):
        raise ValueError("部分文稿的页序或资源核对失败。")
    return result
