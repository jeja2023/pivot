"""核对最终 OOXML 的物理页序、正文、备注隔离和图表关键数据。"""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "docker" / "ppt-master"))
from delivery_checklist import A, C, P, R, REL, verify_checklist  # noqa: E402


def deck():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst>'
                        '<p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>')
        archive.writestr("ppt/_rels/presentation.xml.rels", f'<Relationships xmlns="{REL}">'
                        f'<Relationship Id="rId1" Type="{R}/slide" Target="slides/slide1.xml"/>'
                        f'<Relationship Id="rId2" Type="{R}/slide" Target="slides/slide2.xml"/></Relationships>')
        for index, title in enumerate(["后页", "首页"], 1):
            chart = f'<p:graphicFrame><a:graphic><a:graphicData><c:chart xmlns:c="{C}" r:id="c1"/></a:graphicData></a:graphic></p:graphicFrame>' if index == 2 else ''
            archive.writestr(f"ppt/slides/slide{index}.xml", f'<p:sld xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}">'
                            f'<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{title}</a:t></a:r></a:p>'
                            '<a:p><a:r><a:t>成本1200</a:t></a:r></a:p></p:txBody></p:sp>'
                            '<p:sp><p:nvSpPr><p:cNvPr hidden="1"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>隐藏数据30</a:t></a:r></a:p></p:txBody></p:sp>'
                            f'{chart}</p:spTree></p:cSld></p:sld>')
        archive.writestr("ppt/slides/_rels/slide2.xml.rels", f'<Relationships xmlns="{REL}"><Relationship Id="c1" Type="{R}/chart" Target="../charts/chart1.xml"/></Relationships>')
        archive.writestr("ppt/charts/chart1.xml", f'<c:chartSpace xmlns:c="{C}"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>实际</c:v></c:tx>'
                        '<c:cat><c:strLit><c:pt idx="0"><c:v>一季度</c:v></c:pt></c:strLit></c:cat>'
                        '<c:val><c:numLit><c:pt idx="0"><c:v>120.00</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>')
        archive.writestr("ppt/notesSlides/notesSlide2.xml", "只写在备注的数据30")
    return buffer


class DeliveryChecklistTests(unittest.TestCase):
    def test_actual_order_and_native_chart_value_are_verified(self):
        with zipfile.ZipFile(deck()) as archive:
            result = verify_checklist(archive, ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"],
                                      [["首页", [["实际一季度120", "实际", "一季度", "120"]]], ["后页", ["成本1200"]]])
        self.assertEqual(result["checkedPages"], 2)
        self.assertEqual(result["checkedValues"], 2)
        self.assertEqual(len(result["checklistDigest"]), 64)

    def test_wrong_count_title_value_and_hidden_notes_are_blocked(self):
        invalid = [([["首页", []]], "页数不符"),
                   ([["后页", []], ["首页", []]], "缺少已确认的可见标题"),
                   ([["首页", ["成本120"]], ["后页", []]], "关键数据"),
                   ([["首页", ["隐藏数据30"]], ["后页", []]], "关键数据"),
                   ([["首页", ["备注的数据30"]], ["后页", []]], "关键数据"),
                   ([["首页", [["实际一季度121", "实际", "一季度", "121"]]], ["后页", []]], "关键数据")]
        with zipfile.ZipFile(deck()) as archive:
            for checklist, message in invalid:
                with self.subTest(checklist=checklist), self.assertRaisesRegex(ValueError, message):
                    verify_checklist(archive, ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"], checklist)
