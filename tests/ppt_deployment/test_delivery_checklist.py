"""核对最终 OOXML 的物理页序、正文、备注隔离和图表关键数据。"""
import io
import errno
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


def deck(back_value="成本1200", front_value="成本1200", chart_value="120.00", front_extra=""):
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
                            f'{chart}{front_extra if index == 2 else ""}</p:spTree></p:cSld></p:sld>')
        archive.writestr("ppt/slides/_rels/slide2.xml.rels", f'<Relationships xmlns="{REL}"><Relationship Id="c1" Type="{R}/chart" Target="../charts/chart1.xml"/></Relationships>')
        archive.writestr("ppt/charts/chart1.xml", f'<c:chartSpace xmlns:c="{C}"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>实际</c:v></c:tx>'
                        '<c:cat><c:strLit><c:pt idx="0"><c:v>一季度</c:v></c:pt></c:strLit></c:cat>'
                        f'<c:val><c:numLit><c:pt idx="0"><c:v>{chart_value}</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>')
        archive.writestr("ppt/notesSlides/notesSlide2.xml", "<note>只写在备注的数据30</note>")
    return buffer


class DeliveryChecklistTests(unittest.TestCase):
    def test_expanded_checklist_checks_every_value_and_keeps_a_hard_bound(self):
        values = [f"指标{i}项" for i in range(1, 25)]
        data = deck(front_value="，".join(values)).getvalue()
        result = runner.package_report(data, [["首页", values], ["后页", []]])
        self.assertEqual(result["checkedValues"], 24)
        with self.assertRaises(runner.ChecklistMismatch):
            runner.package_report(deck(front_value="，".join(values[:-1])).getvalue(), [["首页", values], ["后页", []]])
        with self.assertRaisesRegex(ValueError, "关键数据清单无效"):
            runner.package_report(data, [["首页", [*values, "指标25项"]], ["后页", []]])

    def test_grouped_values_cannot_use_hidden_unrelated_or_split_digits(self):
        def shape(text, properties=''):
            return f'<p:sp>{properties}<p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'

        def grouped(*items):
            return '<p:grpSp>' + ''.join(items) + '</p:grpSp>'

        label = shape('累计交付')
        amount = shape('120台')
        checklist = [['首页', ['累计交付120台']], ['后页', []]]
        valid = runner.package_report(deck(front_extra=grouped(label, amount)).getvalue(), checklist)
        self.assertEqual(valid['checkedValues'], 1)
        for example in [grouped(label) + grouped(amount), grouped(label, shape('120台', '<p:nvSpPr><p:cNvPr hidden="1"/></p:nvSpPr>')),
                        grouped(shape('累计交付12'), shape('0台')), grouped(label, shape('1120台'))]:
            with self.subTest(example=example), self.assertRaises(runner.ChecklistMismatch):
                runner.package_report(deck(front_extra=example).getvalue(), checklist)

    def test_optional_project_archive_io_failure_preserves_verified_pptx(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'WORKSPACE', Path(directory)):
            root = Path(directory)
            path = 'project/exports/result.pptx'
            export = root / path
            export.parent.mkdir(parents=True)
            data = deck().getvalue()
            export.write_bytes(data)
            expected = hashlib.sha256(data).hexdigest()
            metadata = root / '.pivot'
            metadata.mkdir()
            (metadata / 'export.json').write_text(json.dumps({'sourceFingerprint': runner.source_fingerprint(),
                'currentExports': {path: expected}}), encoding='utf-8')
            request = {'path': path, 'checklist': [['首页', []], ['后页', ['成本1200']]]}
            with patch.object(runner, 'build_project_archive', side_effect=OSError(errno.ENOSPC, 'ZIP 空间不足')):
                result = runner.deliver_presentation(request)
            self.assertEqual(result['sha256'], expected)
            self.assertEqual(result['packageCheck']['status'], 'passed')
            self.assertTrue(result['sourcePackageUnavailable'])
            self.assertEqual(result['sourcePackageUnavailableReason'], 'storage')
            self.assertEqual((root / 'delivery/presentation.pptx').read_bytes(), data)
            self.assertFalse((root / 'delivery/project.zip').exists())
            with patch.object(runner, 'build_project_archive') as zip_bundle:
                recovered = runner.deliver_presentation({**request, 'skipSourcePackage': True})
            zip_bundle.assert_not_called()
            self.assertEqual(recovered['sourcePackageUnavailableReason'], 'timeout')
            self.assertEqual(recovered['packageCheck'], result['packageCheck'])

    def test_title_parts_and_exact_display_values_in_delivered_file(self):
        def box(text, hidden=False):
            properties = '<p:nvSpPr><p:cNvPr hidden="1"/></p:nvSpPr>' if hidden else ''
            return f'<p:sp>{properties}<p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'

        parts = box("2026经营") + box("复盘")
        grouped = f'<p:grpSp>{parts}</p:grpSp>'
        expected = [["2026经营复盘", ["收入80万元", "增长5.00%"]], ["后页", []]]
        report = runner.package_report(deck(front_value="收入800,000元，增长5%", front_extra=grouped).getvalue(), expected)
        self.assertEqual(report["checkedValues"], 2)
        for extra in [parts, f'<p:grpSp>{box("2026经营")}{box("复盘", hidden=True)}</p:grpSp>',
                      f'<p:grpSp>{box("20")}{box("26经营复盘")}</p:grpSp>']:
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, "可见标题"):
                runner.package_report(deck(front_extra=extra).getvalue(), expected)
        for actual in ["收入800,001元，增长5%", "收入负800,000元，增长5%", "收入800,000美元，增长5%", "收入800,000元，增长5个百分点"]:
            with self.subTest(value=actual), self.assertRaisesRegex(ValueError, "关键数据"):
                runner.package_report(deck(front_value=actual, front_extra=grouped).getvalue(), expected)

    def test_revised_export_is_current_and_failed_repair_is_replayable(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, "WORKSPACE", Path(directory)):
            root = Path(directory)
            draft = root / runner.REVIEW_DRAFT
            draft.parent.mkdir()
            old, new = "project/exports/initial.pptx", "project/exports/revised.pptx"
            (root / old).parent.mkdir(parents=True)
            initial, revised = deck(back_value="成本100").getvalue(), deck(back_value="成本150").getvalue()
            (root / old).write_bytes(initial)
            (root / new).write_bytes(revised)
            draft.write_bytes(initial)
            hashes = {old: hashlib.sha256(initial).hexdigest(), new: hashlib.sha256(revised).hexdigest()}
            (draft.parent / "export.json").write_text(json.dumps({"sourceFingerprint": runner.source_fingerprint(),
                "exports": hashes, "currentExports": {new: hashes[new]}}), encoding="utf-8")
            request = {"path": new, "checklist": [["首页", []], ["后页", ["成本160"]]], "retainReviewDraft": True,
                       "repair": {"automatic": True, "pages": [2], "sha256": hashes[old]}}
            first = runner.deliver_presentation(request)
            self.assertEqual(first["reviewDraft"]["sha256"], hashes[new])
            self.assertEqual(runner.deliver_presentation(request), first)
            self.assertEqual(runner.registered_export(old)[2], hashes[old])
            with self.assertRaisesRegex(ValueError, "与最近成功的上游导出"):
                runner.deliver_presentation({**request, "path": old})
            with self.assertRaisesRegex(ValueError, "草稿已变化"):
                runner.deliver_presentation({**request, "repair": {**request["repair"], "automatic": False}})

    def test_signed_text_value_must_match_the_approved_amount(self):
        for actual in ["净利润-100万元", "净利润−100万元", "净利润－１００万元", "净利润1100万元"]:
            with self.subTest(actual=actual), self.assertRaises(runner.ChecklistMismatch):
                runner.package_report(deck(back_value=actual).getvalue(), [["首页", []], ["后页", ["100万元"]]])
        report = runner.package_report(deck(back_value="净利润−100万元").getvalue(), [["首页", []], ["后页", ["-100万元"]]])
        self.assertEqual(report["checkedValues"], 1)

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
            self.assertEqual(runner.registered_export(request["path"])[2], digest)
            with self.assertRaisesRegex(ValueError, "与最近成功的上游导出"):
                runner.deliver_presentation(request)
            record = json.loads(receipt.read_text(encoding="utf-8"))
            record["currentExports"] = {request["path"]: digest}
            receipt.write_text(json.dumps(record), encoding="utf-8")

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
