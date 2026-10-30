'use strict';

const sharp = require('sharp');
const { PDFArray, PDFName, PDFString, PDFDocument, rgb } = require('pdf-lib');

const { extractDocumentText, renderPdfPages } = require('../../../../document-text');
const { getKnowledgeLimits } = require('../../../resource-limits');
const { OUTPUT_TYPES } = require('../../constants');
const { createTextOutputs } = require('../../exporters');
const { getQpdfHealth, protectPdf } = require('../engines/qpdf');
const { validatePdfA } = require('../engines/verapdf');

function createAdvancedPdfOperations(helpers) {
    const {
        assertPdfPageCount,
        baseName,
        ensureNotCancelled,
        getCjkFont,
        loadPdf,
        pdfError,
        pdfLoadOptions,
        requirePdfFile,
        savePdfOutput,
        writeBinaryOutput
    } = helpers;

    async function protectPdfOutput({ job, file, config, onProgress, isCancelled }) {
        const sourcePath = await requirePdfFile(file);
        await ensureNotCancelled(isCancelled);
        const bytes = await protectPdf({
            sourcePath,
            userId: job.user_id,
            inputPassword: config.password,
            userPassword: config.outputPassword,
            ownerPassword: config.ownerPassword,
            permissions: config.outputPermissions
        });
        const source = await loadPdf(file, pdfLoadOptions(job, config));
        const output = await writeBinaryOutput({
            userId: job.user_id,
            fileId: file.id,
            jobId: job.id,
            sourceName: file.original_name,
            suffix: '受保护副本',
            outputType: 'protected_pdf',
            bytes,
            pageCount: source.getPageCount(),
            quality: { complete: true, engine: (await getQpdfHealth()).version, encryption: 'AES-256', permissions: config.outputPermissions || {} }
        });
        await onProgress?.(90, { processedPages: output.pageCount, requestedPages: output.pageCount });
        return { outputs: [output], processedFiles: 1, processedPages: output.pageCount, requestedPages: output.pageCount };
    }

    function normalizeRedactionRegions(regions, pageNumber) {
        return (Array.isArray(regions) ? regions : [])
            .filter(region => Number(region.page) === pageNumber)
            .map(region => ({
                x: Math.max(0, Math.min(Number(region.x || 0), 1)),
                y: Math.max(0, Math.min(Number(region.y || 0), 1)),
                width: Math.max(0, Math.min(Number(region.width || 0), 1)),
                height: Math.max(0, Math.min(Number(region.height || 0), 1))
            }))
            .filter(region => region.width > 0 && region.height > 0);
    }

    function redactionOverlaySvg(width, height, regions) {
        const rects = regions.map(region => `<rect x="${Math.round(region.x * width)}" y="${Math.round(region.y * height)}" width="${Math.ceil(region.width * width)}" height="${Math.ceil(region.height * height)}" fill="#000000"/>`).join('');
        return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${rects}</svg>`);
    }

    async function redactPdf({ job, file, config, onProgress, isCancelled }) {
        const sourcePath = await requirePdfFile(file);
        const source = await loadPdf(file, pdfLoadOptions(job, config));
        const pageCount = source.getPageCount();
        assertPdfPageCount(pageCount, config.maxToolPages);
        if (!Array.isArray(config.redactRegions) || !config.redactRegions.length) throw pdfError('请至少指定一个需要永久脱敏的区域。', 'REDACTION_REGIONS_REQUIRED');
        const rendered = await renderPdfPages(sourcePath, {
            password: config.password,
            first: 1,
            last: pageCount,
            maxPages: pageCount,
            desiredWidth: Math.min(Math.max(Number(config.redactionDpi || 180) * 8.3, 1000), 3500)
        });
        if (rendered.length !== pageCount) throw pdfError('无法完整渲染原始页面，未发布脱敏输出。', 'OUTPUT_INCOMPLETE');
        const target = await PDFDocument.create();
        let redactedPages = 0;
        for (let index = 0; index < rendered.length; index += 1) {
            await ensureNotCancelled(isCancelled);
            const image = await sharp(rendered[index].data).png().toBuffer();
            const metadata = await sharp(image).metadata();
            const regions = normalizeRedactionRegions(config.redactRegions, index + 1);
            const flattened = regions.length
                ? await sharp(image).composite([{ input: redactionOverlaySvg(metadata.width || 1, metadata.height || 1, regions), top: 0, left: 0 }]).png().toBuffer()
                : image;
            const embedded = await target.embedPng(flattened);
            const sourcePage = source.getPage(index);
            const page = target.addPage([sourcePage.getWidth(), sourcePage.getHeight()]);
            page.drawImage(embedded, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
            if (regions.length) redactedPages += 1;
            await onProgress?.(15 + Math.floor(((index + 1) / pageCount) * 75), { processedPages: index + 1, requestedPages: pageCount });
        }
        const output = await savePdfOutput({
            pdf: target,
            job,
            file,
            suffix: '永久脱敏结果',
            outputType: 'redacted_flattened_pdf',
            quality: {
                complete: true,
                redactionMode: 'rasterized',
                originalObjectsRemoved: true,
                redactedPages,
                limitations: ['输出为栅格化副本，不保留原始可搜索文本、标签、表单、链接、批注、附件或数字签名。']
            }
        });
        return { outputs: [output], processedFiles: 1, processedPages: pageCount, requestedPages: pageCount };
    }

    function addPageAnnotation(pdf, page, annotation) {
        const rect = [annotation.x, annotation.y, annotation.x + annotation.width, annotation.y + annotation.height];
        const type = annotation.type === 'note' ? 'Text' : 'Highlight';
        const values = {
            Type: PDFName.of('Annot'),
            Subtype: PDFName.of(type),
            Rect: rect,
            Contents: PDFString.of(String(annotation.content || '').slice(0, 2000)),
            C: type === 'Text' ? [1, 0.78, 0] : [1, 0.92, 0.2],
            F: 4
        };
        if (type === 'Highlight') values.QuadPoints = [rect[0], rect[3], rect[2], rect[3], rect[0], rect[1], rect[2], rect[1]];
        const ref = pdf.context.register(pdf.context.obj(values));
        let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        if (!annots) {
            annots = pdf.context.obj([]);
            page.node.set(PDFName.of('Annots'), annots);
        }
        annots.push(ref);
    }

    async function annotatePdf({ job, file, config, onProgress, isCancelled }) {
        const pdf = await loadPdf(file, pdfLoadOptions(job, config));
        const annotations = Array.isArray(config.annotations) ? config.annotations : [];
        if (!annotations.length) throw pdfError('请至少提供一条批注区域。', 'ANNOTATIONS_REQUIRED');
        let added = 0;
        for (const annotation of annotations) {
            await ensureNotCancelled(isCancelled);
            const pageIndex = Number(annotation.page || 0) - 1;
            if (pageIndex < 0 || pageIndex >= pdf.getPageCount()) throw pdfError(`批注页码 ${annotation.page} 超出文件范围。`, 'INVALID_PAGE_RANGE');
            const page = pdf.getPage(pageIndex);
            const box = {
                x: Number(annotation.x) * page.getWidth(),
                y: (1 - Number(annotation.y) - Number(annotation.height)) * page.getHeight(),
                width: Number(annotation.width) * page.getWidth(),
                height: Number(annotation.height) * page.getHeight()
            };
            page.drawRectangle({ x: box.x, y: box.y, width: box.width, height: box.height, color: annotation.type === 'note' ? rgb(1, 0.78, 0) : rgb(1, 0.92, 0.2), opacity: annotation.type === 'note' ? 0.25 : 0.35, borderOpacity: 0.7, borderWidth: 0.6 });
            addPageAnnotation(pdf, page, { ...annotation, ...box });
            added += 1;
        }
        await onProgress?.(90, { processedPages: pdf.getPageCount(), requestedPages: pdf.getPageCount() });
        return {
            outputs: [await savePdfOutput({ pdf, job, file, suffix: '批注结果', outputType: 'annotated_pdf', quality: { complete: true, annotations: added, preservesInteractiveAnnotations: true } })],
            processedFiles: 1,
            processedPages: pdf.getPageCount(),
            requestedPages: pdf.getPageCount()
        };
    }

    async function fillPdfForm({ job, file, config, onProgress, isCancelled }) {
        const pdf = await loadPdf(file, pdfLoadOptions(job, config));
        const values = config.formValues && typeof config.formValues === 'object' ? config.formValues : {};
        const form = pdf.getForm();
        const fields = form.getFields();
        const byName = new Map(fields.map(field => [field.getName(), field]));
        const unknown = Object.keys(values).filter(name => !byName.has(name));
        if (unknown.length) throw pdfError(`表单字段不存在：${unknown.slice(0, 5).join('、')}。`, 'FORM_FIELD_NOT_FOUND');
        let changed = 0;
        for (const [name, value] of Object.entries(values)) {
            await ensureNotCancelled(isCancelled);
            const field = byName.get(name);
            if (typeof field.setText === 'function') field.setText(String(value ?? ''));
            else if (typeof field.select === 'function') field.select(Array.isArray(value) ? value.map(item => String(item)) : [String(value)]);
            else if (typeof field.check === 'function' && typeof field.uncheck === 'function') {
                if ([true, 'true', '1', 'yes', 'on'].includes(value)) field.check(); else field.uncheck();
            } else throw pdfError(`字段“${name}”的类型当前不支持填写。`, 'FORM_FIELD_UNSUPPORTED');
            changed += 1;
        }
        if (!changed) throw pdfError('请提供至少一个表单字段值。', 'FORM_VALUES_REQUIRED');
        const font = await getCjkFont(pdf);
        form.updateFieldAppearances(font);
        await onProgress?.(90, { processedPages: pdf.getPageCount(), requestedPages: pdf.getPageCount() });
        return {
            outputs: [await savePdfOutput({ pdf, job, file, suffix: '表单填写结果', outputType: 'filled_form_pdf', quality: { complete: true, fieldsFilled: changed, flattened: false } })],
            processedFiles: 1,
            processedPages: pdf.getPageCount(),
            requestedPages: pdf.getPageCount()
        };
    }

    async function compareVisualPage(left, right) {
        const leftImage = await sharp(left).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const rightImage = await sharp(right).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (leftImage.info.width !== rightImage.info.width || leftImage.info.height !== rightImage.info.height) {
            return { different: true, ratio: 1, image: null, reason: '页面像素尺寸不同' };
        }
        const data = Buffer.from(leftImage.data);
        let different = 0;
        for (let index = 0; index < data.length; index += 4) {
            const delta = Math.max(Math.abs(leftImage.data[index] - rightImage.data[index]), Math.abs(leftImage.data[index + 1] - rightImage.data[index + 1]), Math.abs(leftImage.data[index + 2] - rightImage.data[index + 2]));
            if (delta > 28) {
                different += 1;
                data[index] = 220;
                data[index + 1] = 38;
                data[index + 2] = 38;
                data[index + 3] = 255;
            }
        }
        const pixels = leftImage.info.width * leftImage.info.height;
        return { different: different > 0, ratio: pixels ? different / pixels : 0, image: different ? await sharp(data, { raw: leftImage.info }).png().toBuffer() : null, reason: '' };
    }

    async function comparePdf({ job, files, config, onProgress, isCancelled }) {
        const [leftFile, rightFile] = files;
        const left = await loadPdf(leftFile, pdfLoadOptions(job, config));
        const right = await loadPdf(rightFile, pdfLoadOptions(job, config));
        const pageCount = Math.max(left.getPageCount(), right.getPageCount());
        assertPdfPageCount(pageCount, config.maxToolPages);
        const leftPath = await requirePdfFile(leftFile);
        const rightPath = await requirePdfFile(rightFile);
        const report = { version: 1, left: { fileId: leftFile.id, pages: left.getPageCount() }, right: { fileId: rightFile.id, pages: right.getPageCount() }, pages: [], textDifferent: false };
        const outputs = [];
        for (let index = 0; index < pageCount; index += 1) {
            await ensureNotCancelled(isCancelled);
            if (index >= left.getPageCount() || index >= right.getPageCount()) {
                report.pages.push({ page: index + 1, status: 'added_or_removed' });
                continue;
            }
            const options = { password: config.password, first: index + 1, last: index + 1, maxPages: 1, desiredWidth: Math.min(Math.max(config.compareDpi * 8.3, 800), 2200) };
            const [leftRender] = await renderPdfPages(leftPath, options);
            const [rightRender] = await renderPdfPages(rightPath, options);
            if (!leftRender?.data || !rightRender?.data) throw pdfError(`第 ${index + 1} 页无法渲染比较，未发布不完整比较结果。`, 'OUTPUT_INCOMPLETE');
            const visual = await compareVisualPage(leftRender.data, rightRender.data);
            const pageResult = { page: index + 1, status: visual.different ? 'different' : 'same', changedPixelRatio: Number(visual.ratio.toFixed(6)), reason: visual.reason };
            report.pages.push(pageResult);
            if (visual.image) {
                outputs.push(await writeBinaryOutput({ userId: job.user_id, fileId: leftFile.id, jobId: job.id, sourceName: `${baseName(leftFile.original_name)}与${baseName(rightFile.original_name)}`, suffix: `第${index + 1}页差异`, outputType: 'pdf_compare_image', bytes: visual.image, mimeType: 'image/png', extension: '.png', pageCount: 1, quality: pageResult }));
            }
            await onProgress?.(15 + Math.floor(((index + 1) / pageCount) * 75), { processedPages: index + 1, requestedPages: pageCount });
        }
        const [leftText, rightText] = await Promise.all([
            extractDocumentText(leftPath, '', leftFile.original_name, { password: config.password }),
            extractDocumentText(rightPath, '', rightFile.original_name, { password: config.password })
        ]);
        report.textDifferent = String(leftText || '').replace(/\s+/g, ' ').trim() !== String(rightText || '').replace(/\s+/g, ' ').trim();
        outputs.unshift(await writeBinaryOutput({ userId: job.user_id, fileId: leftFile.id, jobId: job.id, sourceName: `${baseName(leftFile.original_name)}与${baseName(rightFile.original_name)}`, suffix: '比较报告', outputType: 'pdf_compare_report', bytes: Buffer.from(JSON.stringify(report, null, 2), 'utf8'), mimeType: 'application/json; charset=utf-8', extension: '.json', pageCount, quality: { complete: true, visualDifferentPages: report.pages.filter(page => page.status !== 'same').length, textDifferent: report.textDifferent } }));
        return { outputs, processedFiles: 2, processedPages: pageCount, requestedPages: pageCount };
    }

    async function validatePdfAOutput({ job, file, config, onProgress }) {
        const sourcePath = await requirePdfFile(file);
        const result = await validatePdfA({ sourcePath, flavour: config.pdfaProfile });
        const output = await writeBinaryOutput({ userId: job.user_id, fileId: file.id, jobId: job.id, sourceName: file.original_name, suffix: 'PDF-A验证报告', outputType: 'pdfa_validation_report', bytes: Buffer.from(result.report, 'utf8'), mimeType: 'application/xml; charset=utf-8', extension: '.xml', pageCount: 0, quality: { complete: true, compliant: result.compliant, profile: result.flavour, engine: result.engine, diagnostics: result.diagnostics.slice(0, 500) } });
        await onProgress?.(90, { processedPages: 0, requestedPages: 0, pdfaCompliant: result.compliant });
        return { outputs: [output], processedFiles: 1, processedPages: 0, requestedPages: 0, qualityStatus: result.compliant ? 'passed' : 'failed' };
    }

    async function exportPdfDocx({ job, file, config, onProgress }) {
        const sourcePath = await requirePdfFile(file);
        const text = await extractDocumentText(sourcePath, '', file.original_name, { password: config.password, maxChars: getKnowledgeLimits().extractMaxChars });
        if (!String(text || '').trim()) throw pdfError('未提取到可导出 Word 的文本。扫描件请先完成 OCR 与人工复核。', 'TEXT_NOT_FOUND');
        const outputs = await createTextOutputs({ userId: job.user_id, file, job, text, pages: [], blocks: [], formats: [OUTPUT_TYPES.DOCX] });
        await onProgress?.(90, { processedPages: 0, requestedPages: 0, textLength: String(text).length });
        return { outputs, processedFiles: 1, processedPages: 0, requestedPages: 0, textLength: String(text).length };
    }

    async function exportPdfXlsx({ job, file, config, onProgress }) {
        const sourcePath = await requirePdfFile(file);
        const text = await extractDocumentText(sourcePath, '', file.original_name, { password: config.password, maxChars: getKnowledgeLimits().extractMaxChars });
        if (!String(text || '').trim()) throw pdfError('未提取到可导出 Excel 的文本。扫描件请先完成 OCR 与人工复核。', 'TEXT_NOT_FOUND');
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 9000);
        const { renderDocumentIr } = require('../../../document-rendering');
        const rendered = await renderDocumentIr({ ir_version: '1', doc_type: 'table', meta: { title: `${baseName(file.original_name)} 可复核文本` }, blocks: [{ type: 'table', header: ['序号', '提取文本'], widths_pct: [12, 88], rows: lines.map((line, index) => [String(index + 1), line]) }] }, 'xlsx');
        const output = await writeBinaryOutput({ userId: job.user_id, fileId: file.id, jobId: job.id, sourceName: file.original_name, suffix: '可复核Excel', outputType: OUTPUT_TYPES.XLSX, bytes: rendered.buffer, mimeType: rendered.mimeType, extension: '.xlsx', pageCount: 0, quality: { complete: true, renderer: rendered.rendererVersion, rows: lines.length, limitation: '此导出为可复核的逐行文本工作表；复杂版式、合并单元格和图形不保证还原。' } });
        await onProgress?.(90, { processedPages: 0, requestedPages: 0, textLength: String(text).length });
        return { outputs: [output], processedFiles: 1, processedPages: 0, requestedPages: 0, textLength: String(text).length };
    }

    return { annotatePdf, comparePdf, exportPdfDocx, exportPdfXlsx, fillPdfForm, protectPdfOutput, redactPdf, validatePdfAOutput };
}

module.exports = { createAdvancedPdfOperations };
