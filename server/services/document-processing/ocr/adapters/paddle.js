const { buildRecognitionResult, normalizeConfidence, runCommand, splitEnvArgs } = require('./shared');

function appendOptionalArg(args, flag, value) {
    const normalized = String(value || '').trim();
    if (normalized) args.push(flag, normalized);
}

function getCliVersion() {
    const value = String(process.env.PADDLEOCR_CLI_VERSION || '3').trim().toLowerCase();
    return ['2', 'v2', 'legacy'].includes(value) ? 'legacy' : '3';
}

function stripAnsi(value) {
    return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function isPaddleInformationalLine(line) {
    const normalized = stripAnsi(line).trim();
    if (!normalized) return true;
    return /Using the local font file/i.test(normalized)
        || /LOCAL_FONT_FILE_PATH/i.test(normalized);
}

function normalizePaddleDiagnostic(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(line => stripAnsi(line).trim())
        .filter(line => !isPaddleInformationalLine(line))
        .join('\n')
        .trim();
}

function parseQuotedList(value) {
    const matches = [];
    const pattern = /(['"])((?:\\.|(?!\1).)*?)\1/g;
    let match;
    while ((match = pattern.exec(String(value || ''))) !== null) {
        matches.push(match[2]
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n'));
    }
    return matches;
}

function parseNumberList(value) {
    return String(value || '')
        .match(/-?\d+(?:\.\d+)?/g)
        ?.map(item => normalizeConfidence(item, 0.8)) || [];
}

function extractBracketContent(source, key, fromIndex = 0) {
    const keyPattern = new RegExp(`["']?${key}["']?\\s*:`,'g');
    keyPattern.lastIndex = fromIndex;
    const keyMatch = keyPattern.exec(source);
    if (!keyMatch) return null;
    const openIndex = source.indexOf('[', keyPattern.lastIndex);
    if (openIndex < 0) return null;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = openIndex; i < source.length; i += 1) {
        const char = source[i];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = '';
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '[') depth += 1;
        if (char === ']') depth -= 1;
        if (depth === 0) {
            return { content: source.slice(openIndex + 1, i), endIndex: i + 1 };
        }
    }
    return null;
}

function parseOcrV3Output(stdout) {
    const source = String(stdout || '');
    const blocks = [];
    let searchIndex = 0;
    while (searchIndex < source.length) {
        const textsResult = extractBracketContent(source, 'rec_texts', searchIndex);
        if (!textsResult) break;
        const texts = parseQuotedList(textsResult.content);
        const scoresResult = extractBracketContent(source, 'rec_scores', textsResult.endIndex);
        const scores = scoresResult ? parseNumberList(scoresResult.content) : [];
        texts.forEach((text, index) => {
            if (text) {
                blocks.push({
                    text,
                    confidence: scores[index] ?? 0.8,
                    bbox: [],
                    sortOrder: blocks.length
                });
            }
        });
        searchIndex = textsResult.endIndex;
    }
    return blocks;
}

function parseJsonLine(line) {
    try {
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object') return null;
        if (Array.isArray(value.rec_texts)) {
            return value.rec_texts.map((text, index) => ({
                text,
                confidence: value.rec_scores?.[index] ?? 0.8,
                bbox: value.rec_polys?.[index] || value.dt_polys?.[index] || []
            })).filter(block => block.text);
        }
        const text = value.text || value.transcription || value.label || '';
        if (!text) return null;
        return {
            text,
            confidence: value.confidence ?? value.score ?? value.probability ?? 0.8,
            bbox: value.bbox || value.box || value.points || []
        };
    } catch (_err) {
        return null;
    }
}

function parseTupleLine(line) {
    const textMatch = line.match(/['"]([^'"]{1,1000})['"]\s*,\s*([0-9]+(?:\.[0-9]+)?)/);
    if (!textMatch) return null;
    const bboxMatch = line.match(/\[\s*\[\s*[-0-9.]+\s*,\s*[-0-9.]+\s*\][\s\S]*?\]/);
    return {
        text: textMatch[1],
        confidence: normalizeConfidence(textMatch[2], 0.8),
        bbox: bboxMatch ? bboxMatch[0] : []
    };
}

function parsePaddleOutput(stdout) {
    const source = normalizePaddleDiagnostic(stdout);
    const v3Blocks = parseOcrV3Output(source);
    if (v3Blocks.length > 0) return v3Blocks;

    const blocks = [];
    source.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || /^(Namespace|download|loading|success)/i.test(trimmed)) return;
        const parsed = parseJsonLine(trimmed);
        if (Array.isArray(parsed)) {
            blocks.push(...parsed);
            return;
        }
        const tuple = parsed || parseTupleLine(trimmed);
        if (tuple?.text) blocks.push(tuple);
    });
    if (blocks.length > 0) return blocks;
    const fallbackText = source
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !/^\[/.test(line))
        .join('\n')
        .trim();
    return fallbackText ? [{ text: fallbackText, confidence: 0.6, bbox: [] }] : [];
}

function buildPaddleArgs(imagePath, language) {
    const extraArgs = splitEnvArgs(process.env.PADDLEOCR_ARGS || '');
    if (getCliVersion() === 'legacy') {
        const args = [
            ...extraArgs,
            '--image_dir', imagePath,
            '--lang', language,
            '--show_log', 'False'
        ];
        appendOptionalArg(args, '--det_model_dir', process.env.PADDLEOCR_DET_MODEL_DIR);
        appendOptionalArg(args, '--rec_model_dir', process.env.PADDLEOCR_REC_MODEL_DIR);
        appendOptionalArg(args, '--cls_model_dir', process.env.PADDLEOCR_CLS_MODEL_DIR);
        return args;
    }

    const args = [
        'ocr',
        '-i', imagePath,
        '--lang', language,
        '--ocr_version', 'PP-OCRv6',
        '--use_doc_orientation_classify', 'False',
        '--use_doc_unwarping', 'False'
    ];
    appendOptionalArg(args, '--text_detection_model_dir', process.env.PADDLEOCR_DET_MODEL_DIR);
    appendOptionalArg(args, '--text_recognition_model_dir', process.env.PADDLEOCR_REC_MODEL_DIR);
    if (String(process.env.PADDLEOCR_CLS_MODEL_DIR || '').trim()) {
        args.push('--use_textline_orientation', 'True');
        appendOptionalArg(args, '--textline_orientation_model_dir', process.env.PADDLEOCR_CLS_MODEL_DIR);
    }
    args.push(...extraArgs);
    return args;
}

async function recognizePage(imagePath, options = {}) {
    const command = process.env.PADDLEOCR_CMD || 'paddleocr';
    const language = options.language || process.env.PADDLEOCR_LANG || 'ch';
    const result = await runCommand(command, buildPaddleArgs(imagePath, language), {
        timeoutMs: options.timeoutMs,
        env: {
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1'
        }
    });
    return buildRecognitionResult({
        blocks: parsePaddleOutput(String(result.stdout || '') + '\n' + String(result.stderr || '')),
        engine: 'paddle',
        language
    });
}

async function checkAvailability() {
    const command = process.env.PADDLEOCR_CMD || 'paddleocr';
    try {
        await runCommand(command, ['--help'], {
            timeoutMs: 5000,
            maxBuffer: 512 * 1024,
            env: {
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1'
            }
        });
        return { available: true, command, cliVersion: getCliVersion() };
    } catch (err) {
        const diagnostic = normalizePaddleDiagnostic([err.stderr, err.message].filter(Boolean).join('\n'));
        if (!diagnostic) return { available: true, command, cliVersion: getCliVersion() };
        return { available: false, command, cliVersion: getCliVersion(), error: diagnostic };
    }
}

module.exports = {
    buildPaddleArgs,
    checkAvailability,
    normalizePaddleDiagnostic,
    parsePaddleOutput,
    recognizePage,
    stripAnsi
};
