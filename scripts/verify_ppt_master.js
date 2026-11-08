'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Zip = require('jszip');
const { canonicalJson } = require('../server/services/canonical-json');

async function main() {
    const imageIndex = process.argv.indexOf('--image');
    const imageName = imageIndex >= 0 ? process.argv[imageIndex + 1] : 'ppt-master:6.8.0';
    const inspected = JSON.parse(execFileSync('docker', ['image', 'inspect', imageName], { encoding: 'utf8', windowsHide: true }))[0];
    const image = inspected.Id;
    assert.match(image || '', /^sha256:[a-f0-9]{64}$/, '所选镜像缺少完整不可变镜像ID。');
    const output = path.resolve('artifacts/ppt-master-acceptance', new Date().toISOString().replace(/[:.]/g, '-'));
    await fs.mkdir(output, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const manifest = { version: 1, images: [{ image, commands: ['python,/runner/runner.py'] }] };
    const signer = crypto.createSign('RSA-SHA256'); signer.update(canonicalJson(manifest)); signer.end();
    manifest.signature = signer.sign(privateKey).toString('base64'); manifest.signatureAlgorithm = 'RSA-SHA256';
    const trustFile = path.join(output, 'worker-trust.json'); await fs.writeFile(trustFile, JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(output, 'public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }).toString());
    Object.assign(process.env, { DATA_DIR: path.join(output, 'data'), NODE_ENV: 'production', PIVOT_PPT_MASTER_ENABLED: 'true', PIVOT_PPT_MASTER_IMAGE: image,
        PIVOT_CAPABILITY_WORKER_ENABLED: 'true', PIVOT_CAPABILITY_WORKER_TRUSTED_MANIFEST: trustFile,
        PIVOT_CAPABILITY_WORKER_SIGNING_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString() });
    const runtime = require('../server/services/presentations/master/runtime');
    const user = { id: 1 }, id = 'tooltask_' + crypto.randomBytes(24).toString('base64url');
    const actions = [];
    const run = async action => {
        const start = Date.now(); const result = await runtime.execute(user, id, action);
        actions.push({ action: action.action, tool: action.tool, exitCode: result.exitCode, durationMs: Date.now() - start });
        if (result.exitCode !== undefined) assert.equal(result.exitCode, 0, result.stderr + '\n' + result.stdout);
        await fs.writeFile(path.join(output, `step-${actions.length}.json`), JSON.stringify(result, null, 2));
        return result;
    };
    const health = await run({ action: 'health' }); assert.equal(health.fileCount, 13089); assert.equal(health.network, 'disabled');
    await assert.rejects(() => run({ action: 'read_runtime', path: '../../etc/passwd' }), /路径|目录/);
    await assert.rejects(() => run({ action: 'write', path: 'scripts/arbitrary.py', text: 'print(1)' }), /脚本|受限文稿/);
    await assert.rejects(() => run({ action: 'run', tool: 'export', args: ['project', '--enable-dangerous-nonconforming-svg-export'] }), /选项/);
    await run({ action: 'run', tool: 'project', args: ['init', 'pivot_acceptance', '--dir', '.', '--quick-generate'] });
    const files = await run({ action: 'list' }), project = files.files[0].path.split('/')[0];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" lang="zh-CN" data-pptx-page-role="content"><rect id="background" x="0" y="0" width="1280" height="720" fill="#F7F9FC"/><g id="heading" data-pptx-bounds="88 60 1104 100"><text x="88" y="128" font-family="Noto Sans CJK SC" font-size="44" font-weight="700" fill="#17324D">完整制作引擎验收</text></g><g id="evidence" data-pptx-bounds="88 200 1104 340"><rect x="88" y="220" width="1104" height="300" rx="12" fill="#E4EFFA"/><text x="128" y="310" font-family="Noto Sans CJK SC" font-size="32" fill="#17324D">收入120万元，成本80万元。</text><text x="128" y="390" font-family="Noto Sans CJK SC" font-size="28" fill="#17324D">由固定版本上游检查器和原生导出器生成。</text></g></svg>`;
    await run({ action: 'write', path: project + '/svg_output/slide_01.svg', text: svg });
    const preset = await run({ action: 'run', tool: 'preset_shape', args: ['render', 'rightArrow', '--id', 'native-arrow', '--frame', '120', '440', '800', '100', '--fill', '#1769AA', '--stroke', '#1769AA'] });
    const formulaSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720" lang="zh-CN" data-pptx-page-role="content"><rect id="background" x="0" y="0" width="1280" height="720" fill="#F7F9FC"/><g id="heading" data-pptx-bounds="88 60 1104 120"><text x="88" y="128" font-family="Noto Sans CJK SC" font-size="44" fill="#17324D">原生形状与可编辑公式</text></g><g id="formula-prose" data-pptx-bounds="88 210 1104 180"><text x="120" y="300" font-family="Noto Sans CJK SC" font-size="36" fill="#17324D">示例比例 <tspan data-pptx-inline-formula="\\frac{a}{b}">a/b</tspan> 保留为原生公式。</text></g>${preset.stdout}</svg>`;
    await run({ action: 'write', path: project + '/svg_output/slide_02.svg', text: formulaSvg });
    await run({ action: 'run', tool: 'check_svg', args: [project, '--quick-generate', '--stage', 'final', '--json'] });
    await run({ action: 'run', tool: 'export', args: [project, '--quick-generate', '-o', project + '/exports/Pivot-Master.pptx'] });
    const receipt = await run({ action: 'deliver', path: project + '/exports/Pivot-Master.pptx' });
    const native = await runtime.readOutput(user, id, 'presentation.pptx');
    await fs.writeFile(path.join(output, 'native.pptx'), native);
    const zip = await Zip.loadAsync(native), slide = await zip.file('ppt/slides/slide1.xml').async('string');
    assert.match(slide, /收入120万元/); assert.ok(!slide.includes('<p:pic>'), '正文不应被展平成整页图片');
    const secondSlide = await zip.file('ppt/slides/slide2.xml').async('string');
    assert.match(secondSlide, /prst="rightArrow"/); assert.match(secondSlide, /m:oMath/);
    await run({ action: 'write', path: project + '/svg_output/slide_01.svg', text: svg.replace('收入120万元', '收入121万元') });
    await assert.rejects(() => run({ action: 'deliver', path: project + '/exports/Pivot-Master.pptx' }), /不一致|重新校验/);
    const sourcePath = await runtime.inputFile(user, id, 'source.pptx', native);
    await run({ action: 'run', tool: 'import_native', args: [sourcePath, '-o', 'roundtrip', '--roundtrip'] });
    await run({ action: 'run', tool: 'export', args: ['roundtrip', '--roundtrip', '-o', 'roundtrip/exports/roundtrip.pptx'] });
    await run({ action: 'deliver', path: 'roundtrip/exports/roundtrip.pptx' });
    const roundtrip = await runtime.readOutput(user, id, 'presentation.pptx'), roundtripZip = await Zip.loadAsync(roundtrip);
    assert.equal(await roundtripZip.file('ppt/slides/slide1.xml').async('string'), slide, '未修改原稿页面须保持原始XML字节内容');
    assert.equal(await roundtripZip.file('ppt/slides/slide2.xml').async('string'), secondSlide, '公式及形状的未修改源页须保持原始XML');
    await fs.writeFile(path.join(output, 'roundtrip.pptx'), roundtrip);
    await run({ action: 'copy_template', source: 'templates/styles/consulting-decision', path: 'reusable' });
    await run({ action: 'run', tool: 'apply_template', args: [project, '--root', 'reusable'] });
    await assert.rejects(() => run({ action: 'run', tool: 'apply_template', args: ['inputs', '--root', 'reusable'] }), /输入|交付/);
    await assert.rejects(() => run({ action: 'run', tool: 'apply_template', args: [project, '--root', 'reusable', '--skip-validation'] }), /选项/);
    const template = await run({ action: 'deliver_template', path: 'reusable', kind: 'style' });
    assert.equal(template.packageCheck.status, 'passed'); await fs.writeFile(path.join(output, 'reusable-template.zip'), await runtime.readOutput(user, id, 'project.zip'));
    const report = { checkedAt: new Date().toISOString(), image, revision: health.revision, fileCount: health.fileCount, signature: 'verified_ephemeral_test_key',
        generate: receipt.packageCheck, untouchedSlideBytesPreserved: true, nativeShape: 'passed', nativeOfficeMath: 'passed', templateValidation: 'passed', templateApply: 'passed', sourceChangeInvalidatesDelivery: true,
        deniedTraversal: true, deniedArbitraryScript: true, deniedDangerousExport: true, actions, officeVisual: 'not_checked',
        modelQuality: 'not_tested', scope: '实际隔离容器执行上游工具；模型编排另以测试模型验证，不代表真实模型成稿盲评或生产认证。' };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, image, revision: report.revision, steps: actions.length, generate: 'passed', roundtrip: 'passed', template: 'passed', signature: 'verified' }));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
