'use strict';

const { getSkillVersion } = require('./agent-releases');
const { parseSkillManifest } = require('./agent-skills');
const { readInstalledSkillResources, metadataFiles } = require('./agent-skill-resources');
const { declarativeResourcePackage } = require('./agent-skill-resource-import');
const { sourceIsActive } = require('../repositories/agent-learning-evaluation');
const { verifyEnvelopeForVersion } = require('./agent-skill-signing');

function invalid(message, status = 409) {
    return Object.assign(new Error(message), { code: 'SKILL_REVISION_SOURCE_INVALID', status, expose: true });
}

async function resolveSkillRevision(user, input = {}) {
    if (input.sourceVersionId === undefined) return { resources: input.resources || [], sourceRunId: input.sourceRunId };
    const versionId = Number(input.sourceVersionId);
    if (!Number.isSafeInteger(versionId) || versionId <= 0 || typeof input.sourceDigest !== 'string') {
        throw invalid('来源技能版本引用无效，请重新打开治理界面。', 400);
    }
    const source = await getSkillVersion(versionId, user, { action: 'write' });
    if (!source) throw invalid('来源技能版本不存在或已无权编辑。', 403);
    if (source.digest !== input.sourceDigest) throw invalid('来源技能版本已变化，请重新打开后编辑。');
    if (!await sourceIsActive(source.id)) throw invalid('来源任务已撤回，不能继续复用此技能。', 403);

    let resources = input.resources, packageDigest = '';
    if (source.package_path) {
        const manifest = parseSkillManifest(source.manifest_json || source.manifest_yaml);
        const pack = await readInstalledSkillResources(source.package_path);
        const instructionsOnly = !manifest.resources?.length && !manifest.files?.length && !Object.keys(manifest.dependencies || {}).length
            && pack.entries.every(entry => metadataFiles.has(entry.name));
        if (!instructionsOnly && !declarativeResourcePackage(manifest)) throw invalid('此技能含完整包依赖，请重新导入完整包并验证签名后发布。');
        packageDigest = pack.digest;
        if (resources === undefined) {
            resources = (manifest.resources || []).map(item => {
                const entry = pack.entries.find(entry => entry.name === item.path);
                if (!entry) throw invalid('来源技能配套文件不完整，请重新导入。');
                return { path: item.path, encoding: 'base64', content: entry.data.toString('base64') };
            });
        }
    }
    // 文件读取后复核当前编辑权限与来源，不能用旧界面快照绕过撤权。
    const current = await getSkillVersion(versionId, user, { action: 'write' });
    if (!current || current.digest !== source.digest || current.content_digest !== source.content_digest
        || current.package_path !== source.package_path || current.signing_envelope_id !== source.signing_envelope_id || !await sourceIsActive(source.id)) {
        throw invalid('来源技能或授权在读取期间已变化，请重新打开后编辑。', 403);
    }
    if (current.signing_envelope_id) {
        const signature = await verifyEnvelopeForVersion(current, { requireFullContent: Boolean(current.package_path) });
        if (!signature.verified || signature.signatureForm === 'detached' && String(current.digest).replace(/^sha256:/, '') !== packageDigest) {
            throw invalid('来源技能签名已失效或与资源不一致，请重新签发。', 403);
        }
    }
    // 修订保留原任务来源；新版本重新验证和签名，不能继承原版本的信任状态。
    return { resources: resources || [], sourceRunId: source.source_run_id || null };
}

module.exports = { resolveSkillRevision };
