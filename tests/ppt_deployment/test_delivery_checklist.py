"""核对最终 OOXML 的物理页序、正文、备注隔离和图表关键数据。"""
import io
import hashlib
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "docker" / "ppt-master"))
from delivery_checklist import A, C, P, R, REL, verify_checklist  # noqa: E402
import runner  # noqa: E402


def deck(back_value="成本1200", front_value="成本1200", chart_value="120.00"):
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
                            f'<a:p><a:r><a:t>{front_value if index == 2 else back_value}</a:t></a:r></a:p></p:txBody></p:sp>'
                            '<p:sp><p:nvSpPr><p:cNvPr hidden="1"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>隐藏数据30</a:t></a:r></a:p></p:txBody></p:sp>'
                            f'{chart}</p:spTree></p:cSld></p:sld>')
        archive.writestr("ppt/slides/_rels/slide2.xml.rels", f'<Relationships xmlns="{REL}"><Relationship Id="c1" Type="{R}/chart" Target="../charts/chart1.xml"/></Relationships>')
        archive.writestr("ppt/charts/chart1.xml", f'<c:chartSpace xmlns:c="{C}"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>实际</c:v></c:tx>'
                        '<c:cat><c:strLit><c:pt idx="0"><c:v>一季度</c:v></c:pt></c:strLit></c:cat>'
                        f'<c:val><c:numLit><c:pt idx="0"><c:v>{chart_value}</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>')
        archive.writestr("ppt/notesSlides/notesSlide2.xml", "<note>只写在备注的数据30</note>")
    return buffer


class DeliveryChecklistTests(unittest.TestCase):
    def test_partial_snapshot_keeps_native_chart_and_excludes_failed_slide(self):
        from native_subset import select_pages
        source = io.BytesIO()
        with zipfile.ZipFile(deck()) as baseline, zipfile.ZipFile(source, "w") as archive:
            for name in baseline.namelist():
                data = baseline.read(name)
                if name == "ppt/presentation.xml":
                    data = data.replace(b"</p:presentation>", b'<p:sldSz cx="12192000" cy="6858000"/></p:presentation>')
                archive.writestr(name, data)
            archive.writestr("_rels/.rels", f'<Relationships xmlns="{REL}"><Relationship Id="rId1" Type="{R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
            archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        result = select_pages(source.getvalue(), [1])
        with zipfile.ZipFile(io.BytesIO(result)) as archive:
            self.assertEqual(verify_checklist(archive, ["ppt/slides/slide2.xml"],
                             [["首页", [["实际一季度120", "实际", "一季度", "120"]]]])["checkedPages"], 1)
            self.assertIn("ppt/charts/chart1.xml", archive.namelist())
            self.assertNotIn("ppt/slides/slide1.xml", archive.namelist())
            self.assertNotIn("ppt/notesSlides/notesSlide2.xml", archive.namelist())

    def test_review_preview_recovers_registered_export_without_draft_or_delivery(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, "WORKSPACE", Path(directory)):
            root = Path(directory)
            export = root / "project/exports/report.pptx"
            export.parent.mkdir(parents=True)
            data = deck().getvalue()
            export.write_bytes(data)
            metadata = root / ".pivot"
            metadata.mkdir()
            path = "project/exports/report.pptx"
            (metadata / "export.json").write_text(json.dumps({"exports": {path: hashlib.sha256(data).hexdigest()}}), encoding="utf-8")

            def render(source, staging, count):
                self.assertEqual(source, export)
                images = staging / "native-preview"
                images.mkdir()
                for index in range(1, count + 1):
                    (images / f"slide-{index}.png").write_bytes(b"preview")

            with patch("native_media.preview", side_effect=render) as renderer:
                request = {"path": path, "checklist": [["首页", []], ["后页", ["成本1000"]]]}
                result = runner.inspect_export(request)
                self.assertEqual(runner.inspect_export(request), result)
                self.assertEqual(renderer.call_count, 1)
                self.assertEqual(result["pageReview"]["passedPages"], [1])
                previews = root / runner.REVIEW_PREVIEW
                self.assertEqual([file.name for file in previews.iterdir()], [result["pages"][0]["file"]])
                self.assertFalse((root / runner.REVIEW_DRAFT).exists())
                self.assertFalse((root / "delivery").exists())
            export.write_bytes(b"unregistered bytes")
            with self.assertRaisesRegex(ValueError, "摘要不一致"):
                runner.inspect_export(request)

    def test_full_review_lists_all_pages_and_checks(self):
        with self.assertRaises(runner.ChecklistMismatch) as failure:
            runner.package_report(deck().getvalue(), [["首页", []], ["另一个标题", ["成本1000", "成本2000"]]])
        self.assertEqual(failure.exception.report, {"passedPages": [1], "failedPages": [
            {"page": 2, "missingTitle": True, "missingValues": [1, 2]}
        ]})

    def test_selected_page_can_be_corrected_but_other_content_and_chart_are_locked(self):
        baseline = deck().getvalue()
        checklist = [["首页", []], ["后页", ["成本1500"]]]
        repaired = deck(back_value="成本1500").getvalue()
        report = runner.package_report(repaired, checklist, (baseline, {2}))
        self.assertEqual(report["checkedPages"], 2)
        for modified in [deck(back_value="成本1500", front_value="成本1400"), deck(back_value="成本1500", chart_value="138")]:
            with self.assertRaisesRegex(ValueError, "改变了第 1 页"):
                runner.package_report(modified.getvalue(), checklist, (baseline, {2}))

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

    def test_only_an_intact_registered_export_can_be_retained_as_unverified_draft(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, "WORKSPACE", Path(directory)):
            root = Path(directory)
            export = root / "project/exports/report.pptx"
            export.parent.mkdir(parents=True)
            data = deck().getvalue()
            export.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            draft = root / runner.REVIEW_DRAFT
            draft.parent.mkdir()
            receipt = draft.parent / "export.json"
            request = {"path": "project/exports/report.pptx", "checklist": [["误写首页", []], ["后页", []]]}
            receipt.write_text(json.dumps({"sourceFingerprint": runner.source_fingerprint(), "exports": {request["path"]: digest}}), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "缺少已确认的可见标题"):
                runner.deliver_presentation(request)
            self.assertFalse(draft.exists())
            result = runner.deliver_presentation({**request, "retainReviewDraft": True})
            self.assertEqual(draft.read_bytes(), data)
            self.assertEqual(result["reviewDraft"], {"sha256": digest, "byteSize": len(data)})
            self.assertIn("交付第 1 页", result["reviewFailure"])
            self.assertFalse((root / "delivery").exists())

            export.write_bytes(b"unregistered bytes")
            with self.assertRaisesRegex(ValueError, "与最近成功的上游导出"):
                runner.deliver_presentation({**request, "retainReviewDraft": True})
            self.assertEqual(draft.read_bytes(), data)

            export.write_bytes(data)
            delivered = runner.deliver_presentation({**request, "checklist": [["首页", []], ["后页", []]], "retainReviewDraft": True})
            self.assertEqual(delivered["packageCheck"]["status"], "passed")
            with zipfile.ZipFile(root / delivered["projectPath"]) as project:
                self.assertNotIn(runner.REVIEW_DRAFT, project.namelist())
