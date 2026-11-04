'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const { extractDocumentText } = require('../document-text');

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const DATE_REGEX = /(?:19|20)\d{2}年\d{1,2}月\d{1,2}日|二〇[一二三四五六七八九〇]+年[一二三四五六七八九十]+月[一二三四五六七八九十]+日/;

/**
 * 将 run 节点渲染为带样式的 HTML span
 */
function renderRunNode(rNode) {
    const rPr = Array.from(rNode.childNodes).find(n => n.nodeName === 'w:rPr' || n.localName === 'rPr');
    let isBold = false;
    let isItalic = false;
    let isUnderline = false;
    let fontSizePt = null;
    let color = '';
    let fontName = '';

    if (rPr) {
        for (const prop of Array.from(rPr.childNodes)) {
            const name = prop.localName || prop.nodeName.replace(/^w:/, '');
            if (name === 'b') {
                const val = prop.getAttribute('w:val') ?? prop.getAttribute('val');
                isBold = val !== '0' && val !== 'false';
            } else if (name === 'i') {
                const val = prop.getAttribute('w:val') ?? prop.getAttribute('val');
                isItalic = val !== '0' && val !== 'false';
            } else if (name === 'u') {
                const val = prop.getAttribute('w:val') ?? prop.getAttribute('val');
                isUnderline = val !== 'none';
            } else if (name === 'sz') {
                const halfPts = parseInt(prop.getAttribute('w:val') ?? prop.getAttribute('val'), 10);
                if (Number.isFinite(halfPts) && halfPts > 0) fontSizePt = halfPts / 2;
            } else if (name === 'color') {
                const val = (prop.getAttribute('w:val') ?? prop.getAttribute('val') ?? '').trim();
                if (/^[0-9a-fA-F]{6}$/.test(val)) color = `#${val}`;
            } else if (name === 'rFonts') {
                fontName = prop.getAttribute('w:eastAsia') ?? prop.getAttribute('eastAsia')
                    ?? prop.getAttribute('w:ascii') ?? prop.getAttribute('ascii') ?? '';
            }
        }
    }

    let text = '';
    for (const child of Array.from(rNode.childNodes)) {
        const cName = child.localName || child.nodeName.replace(/^w:/, '');
        if (cName === 't') {
            text += escapeHtml(child.textContent || '');
        } else if (cName === 'br') {
            text += '<br>';
        } else if (cName === 'tab') {
            text += '&emsp;&emsp;';
        }
    }

    if (!text) return '';

    let out = text;
    if (isUnderline) out = `<u>${out}</u>`;
    if (isItalic) out = `<em>${out}</em>`;
    if (isBold) out = `<strong>${out}</strong>`;

    const spanStyles = [];
    if (fontSizePt) spanStyles.push(`font-size:${fontSizePt}pt`);
    if (color) spanStyles.push(`color:${color}`);
    if (fontName) spanStyles.push(`font-family:"${escapeHtml(fontName)}",serif`);

    if (spanStyles.length) {
        out = `<span style="${spanStyles.join(';')}">${out}</span>`;
    }

    return out;
}

/**
 * 将段落节点渲染为带样式的 HTML p / h1 / h2 元素
 */
function renderParagraphNode(pNode, index = 0, total = 1) {
    const pPr = Array.from(pNode.childNodes).find(n => n.nodeName === 'w:pPr' || n.localName === 'pPr');
    let jc = '';
    let pStyle = '';

    if (pPr) {
        const jcNode = Array.from(pPr.childNodes).find(n => n.nodeName === 'w:jc' || n.localName === 'jc');
        if (jcNode) jc = (jcNode.getAttribute('w:val') ?? jcNode.getAttribute('val') ?? '').toLowerCase();

        const pStyleNode = Array.from(pPr.childNodes).find(n => n.nodeName === 'w:pStyle' || n.localName === 'pStyle');
        if (pStyleNode) pStyle = (pStyleNode.getAttribute('w:val') ?? pStyleNode.getAttribute('val') ?? '').toLowerCase();
    }

    const runsHtml = [];
    for (const child of Array.from(pNode.childNodes)) {
        const cName = child.localName || child.nodeName.replace(/^w:/, '');
        if (cName === 'r') {
            runsHtml.push(renderRunNode(child));
        } else if (cName === 'hyperlink') {
            for (const hChild of Array.from(child.childNodes)) {
                if ((hChild.localName || hChild.nodeName.replace(/^w:/, '')) === 'r') {
                    runsHtml.push(renderRunNode(hChild));
                }
            }
        }
    }

    const content = runsHtml.join('');
    const plainText = (pNode.textContent || '').trim();

    if (!plainText) {
        return '<p class="doc-p doc-p-empty">&nbsp;</p>';
    }

    // 1. 明确居中对齐或样式为标题
    if (jc === 'center' || /title|标题/.test(pStyle)) {
        return `<h1 class="doc-title">${content}</h1>`;
    }

    // 2. 明确居右对齐或识别为末尾落款/日期
    const isNearEnd = index >= total - 3;
    const isSignoffDate = isNearEnd && DATE_REGEX.test(plainText);
    const isSignoffUnit = isNearEnd && plainText.length <= 30 && !/[。；！？]$/.test(plainText);

    if (jc === 'right' || isSignoffDate || (jc === '' && isSignoffUnit && index > 1)) {
        return `<p class="doc-p doc-align-right doc-signoff">${content}</p>`;
    }

    // 3. 样式为 Heading 1-4 或前缀特征标题
    if (/heading\s*1|^1$/.test(pStyle) || (/^[一二三四五六七八九十]+、/.test(plainText) && plainText.length <= 60)) {
        return `<h2 class="doc-heading doc-heading-1">${content}</h2>`;
    }
    if (/heading\s*2|^2$/.test(pStyle) || (/^（[一二三四五六七八九十]+）/.test(plainText) && plainText.length <= 60)) {
        return `<h3 class="doc-heading doc-heading-2">${content}</h3>`;
    }
    if (/heading\s*3|^3$/.test(pStyle) || (/^\d+[.、]/.test(plainText) && plainText.length <= 60)) {
        return `<h4 class="doc-heading doc-heading-3">${content}</h4>`;
    }

    // 4. 首段且短、无句号、未设对齐 -> 首行大标题
    if (index === 0 && plainText.length <= 50 && !/[。；！？]$/.test(plainText)) {
        return `<h1 class="doc-title">${content}</h1>`;
    }

    // 5. 默认普通正文段落：首行缩进 2em，两端对齐
    return `<p class="doc-p doc-paragraph">${content}</p>`;
}

/**
 * 将表格节点渲染为 HTML 表格
 */
function renderTableNode(tblNode) {
    const rows = [];
    const trNodes = Array.from(tblNode.childNodes).filter(n => (n.localName || n.nodeName.replace(/^w:/, '')) === 'tr');

    for (let rIdx = 0; rIdx < trNodes.length; rIdx++) {
        const trNode = trNodes[rIdx];
        const cells = [];
        const tcNodes = Array.from(trNode.childNodes).filter(n => (n.localName || n.nodeName.replace(/^w:/, '')) === 'tc');

        for (const tcNode of tcNodes) {
            let colSpan = 1;
            const tcPr = Array.from(tcNode.childNodes).find(n => (n.localName || n.nodeName.replace(/^w:/, '')) === 'tcPr');
            if (tcPr) {
                const gridSpan = Array.from(tcPr.childNodes).find(n => (n.localName || n.nodeName.replace(/^w:/, '')) === 'gridSpan');
                if (gridSpan) {
                    const spanVal = parseInt(gridSpan.getAttribute('w:val') ?? gridSpan.getAttribute('val'), 10);
                    if (Number.isFinite(spanVal) && spanVal > 1) colSpan = spanVal;
                }
            }

            const pNodes = Array.from(tcNode.childNodes).filter(n => (n.localName || n.nodeName.replace(/^w:/, '')) === 'p');
            const cellHtml = pNodes.map((p, idx) => renderParagraphNode(p, idx, pNodes.length)).join('') || '&nbsp;';
            const spanAttr = colSpan > 1 ? ` colspan="${colSpan}"` : '';
            cells.push(`<td${spanAttr}>${cellHtml}</td>`);
        }

        if (cells.length) {
            rows.push(`<tr>${cells.join('')}</tr>`);
        }
    }

    return `<table class="doc-tbl"><tbody>\n${rows.join('\n')}\n</tbody></table>`;
}

/**
 * 从 DOCX 的 word/document.xml 生成正文 HTML
 */
function parseDocxXml(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
    const body = doc.getElementsByTagName('w:body')[0] || doc.getElementsByTagNameNS('*', 'body')[0];
    if (!body) return '';

    const htmlParts = [];
    const children = Array.from(body.childNodes).filter(n => n.nodeType === 1);
    const pElements = children.filter(n => (n.localName || n.nodeName.replace(/^w:/, '')) === 'p');
    const totalP = pElements.length;

    let pCount = 0;
    for (const node of children) {
        const name = node.localName || node.nodeName.replace(/^w:/, '');
        if (name === 'p') {
            htmlParts.push(renderParagraphNode(node, pCount, totalP));
            pCount++;
        } else if (name === 'tbl') {
            htmlParts.push(renderTableNode(node));
        }
    }

    return htmlParts.filter(Boolean).join('\n');
}

/**
 * 将纯文本流转换为结构化段落 HTML（针对 .doc 二进制文件或纯文本回退）
 */
function parseTextToDocHtml(rawText) {
    const lines = String(rawText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) {
        return '<p class="doc-p doc-p-empty">&nbsp;</p>';
    }

    const htmlParts = [];
    let titleRendered = false;

    // 倒数 1-3 行寻找落款日期与单位
    let signoffDateIndex = -1;
    let signoffUnitIndex = -1;

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
        if (DATE_REGEX.test(lines[i])) {
            signoffDateIndex = i;
            if (i > 0 && lines[i - 1].length <= 30 && !/[。；！？]$/.test(lines[i - 1])) {
                signoffUnitIndex = i - 1;
            }
            break;
        }
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 标题识别：首行短且无句号
        if (!titleRendered && i === 0 && line.length <= 60 && !/[。；！？]$/.test(line)) {
            htmlParts.push(`<h1 class="doc-title">${escapeHtml(line)}</h1>`);
            titleRendered = true;
            continue;
        }

        // 落款识别
        if (i === signoffUnitIndex || i === signoffDateIndex) {
            htmlParts.push(`<p class="doc-p doc-align-right doc-signoff">${escapeHtml(line)}</p>`);
            continue;
        }

        // 一级标题：一、...
        if (/^[一二三四五六七八九十]+、/.test(line) && line.length <= 60) {
            htmlParts.push(`<h2 class="doc-heading doc-heading-1">${escapeHtml(line)}</h2>`);
            continue;
        }

        // 二级标题：（一）...
        if (/^（[一二三四五六七八九十]+）/.test(line) && line.length <= 60) {
            htmlParts.push(`<h3 class="doc-heading doc-heading-2">${escapeHtml(line)}</h3>`);
            continue;
        }

        // 三级标题：1. ...
        if (/^\d+[.、]/.test(line) && line.length <= 60) {
            htmlParts.push(`<h4 class="doc-heading doc-heading-3">${escapeHtml(line)}</h4>`);
            continue;
        }

        // 普通正文段落
        htmlParts.push(`<p class="doc-p doc-paragraph">${escapeHtml(line)}</p>`);
    }

    return htmlParts.join('\n');
}

/**
 * 包装为完整的纸张风格预览 HTML 页面
 */
function wrapDocumentPage(bodyHtml, title = '文档预览') {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --doc-font-fangsong: "FangSong_GB2312", "仿宋_GB2312", "FangSong", "仿宋", "Noto Serif CJK SC", serif;
      --doc-font-song: "SimSun", "宋体", "Songti SC", "Noto Serif CJK SC", serif;
      --doc-font-hei: "SimHei", "黑体", "Heiti SC", "Noto Sans CJK SC", sans-serif;
      --doc-font-kaiti: "KaiTi", "楷体", "STKaiti", serif;
      --doc-font-title: "FZXiaoBiaoSong-B05S", "方正小标宋简体", "STZhongsong", "SimSun", "宋体", serif;
    }
    * {
      box-sizing: border-box;
    }
    html {
      background: #eef2f6;
      min-height: 100%;
    }
    body {
      margin: 0;
      padding: 28px 16px 48px;
      color: #1e293b;
      font-family: var(--doc-font-fangsong);
      font-size: 15pt;
      line-height: 1.75;
      display: flex;
      flex-direction: column;
      align-items: center;
      background: transparent;
      -webkit-font-smoothing: antialiased;
    }
    .doc-page {
      box-sizing: border-box;
      width: 100%;
      max-width: 840px;
      min-height: 960px;
      padding: 54px 64px 64px;
      margin: 0 auto;
      background: #ffffff;
      box-shadow: 0 4px 24px -2px rgba(15, 23, 42, 0.08), 0 2px 8px -1px rgba(15, 23, 42, 0.04);
      border: 1px solid rgba(203, 213, 225, 0.7);
      border-radius: 4px;
      word-break: break-word;
    }
    .doc-p {
      margin: 0 0 10pt;
      line-height: 1.75;
      font-size: 15pt;
    }
    .doc-paragraph {
      text-indent: 2em;
      text-align: justify;
    }
    .doc-align-center {
      text-align: center !important;
      text-indent: 0 !important;
    }
    .doc-align-right {
      text-align: right !important;
      text-indent: 0 !important;
    }
    .doc-signoff {
      margin-top: 20pt;
      margin-bottom: 6pt;
    }
    .doc-title {
      font-family: var(--doc-font-title);
      font-size: 22pt;
      font-weight: bold;
      line-height: 1.4;
      text-align: center;
      margin: 0 0 20pt;
      text-indent: 0;
      color: #111827;
    }
    .doc-heading {
      font-family: var(--doc-font-hei);
      font-weight: 700;
      margin: 14pt 0 8pt;
      color: #111827;
    }
    .doc-heading-1 {
      font-size: 16pt;
      text-indent: 2em;
    }
    .doc-heading-2 {
      font-family: var(--doc-font-kaiti);
      font-size: 15pt;
      text-indent: 2em;
    }
    .doc-heading-3 {
      font-size: 14pt;
      text-indent: 2em;
    }
    .doc-p-empty {
      min-height: 1.5em;
      margin: 0 0 6pt;
    }
    .doc-tbl {
      width: 100%;
      margin: 12pt 0 16pt;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 11pt;
    }
    .doc-tbl th, .doc-tbl td {
      padding: 6pt 8pt;
      border: 1px solid #334155;
      vertical-align: middle;
      word-break: break-word;
    }
    .doc-tbl th {
      font-family: var(--doc-font-hei);
      font-weight: 700;
      text-align: center;
      background: #f8fafc;
    }
    @media (max-width: 680px) {
      body {
        padding: 12px 8px 32px;
      }
      .doc-page {
        padding: 24px 20px 32px;
        font-size: 13pt;
      }
      .doc-p {
        font-size: 13pt;
      }
      .doc-title {
        font-size: 17pt;
      }
    }
    @media print {
      html, body {
        background: #ffffff;
        padding: 0;
      }
      .doc-page {
        width: auto;
        min-height: 0;
        padding: 0;
        margin: 0;
        box-shadow: none;
        border: none;
      }
    }
  </style>
</head>
<body>
  <article class="doc-page">
    ${bodyHtml}
  </article>
</body>
</html>`;
}

/**
 * 提取 Word 文档预览
 * @param {string} filePath 文件绝对路径
 * @param {string} mimeType MIME 类型
 * @param {string} fileName 原始文件名
 * @returns {Promise<{ html: string, text: string }>}
 */
async function extractDocPreview(filePath, mimeType = '', fileName = '') {
    const ext = path.extname(fileName || filePath || '').toLowerCase();
    const docTitle = path.basename(fileName || filePath || '', ext);

    // 先抽取纯文本作为兜底
    let plainText = '';
    try {
        plainText = await extractDocumentText(filePath, mimeType, fileName, { maxChars: 15000 });
    } catch (_) {
        plainText = '';
    }

    if (ext === '.docx') {
        try {
            const buffer = await fs.promises.readFile(filePath);
            const zip = await JSZip.loadAsync(buffer);
            const docXmlFile = zip.file('word/document.xml') || zip.file(/word\/document\.xml$/i)[0];
            if (docXmlFile) {
                const xml = await docXmlFile.async('string');
                const bodyHtml = parseDocxXml(xml);
                if (bodyHtml && bodyHtml.trim()) {
                    return {
                        html: wrapDocumentPage(bodyHtml, docTitle),
                        text: plainText
                    };
                }
            }
        } catch (_) {
            // DOCX XML 解析遇到损坏时，平滑回退到基于提取文本的排版页面
        }
    }

    // .doc 或 DOCX 异常回退
    const fallbackBody = parseTextToDocHtml(plainText);
    return {
        html: wrapDocumentPage(fallbackBody, docTitle),
        text: plainText
    };
}

module.exports = {
    extractDocPreview,
    parseDocxXml,
    parseTextToDocHtml,
    wrapDocumentPage
};
