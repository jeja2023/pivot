'use strict';

const repository = require('../../../repositories/analysis-model-ownership');
const { requestKey } = require('./query-contract');
const { biError } = require('./errors');

function recipient(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw biError('ANALYSIS_MODEL_TRANSFER_INVALID', '请选择有效接收人。');
    return value;
}
function text(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw biError('ANALYSIS_MODEL_TRANSFER_INVALID', `请填写${label}，最多 ${max} 字。`);
    return value.trim();
}
function record(row) {
    return { id: row.id, modelId: row.model_id, ownerId: Number(row.owner_id), initiatorId: Number(row.initiator_id), recipientId: Number(row.recipient_id), expectedVersion: Number(row.expected_version),
        impactHash: row.impact_hash, impact: row.impact_json, businessOwner: row.business_owner, maintenanceContact: row.maintenance_contact, reason: row.reason, status: row.status,
        decisionComment: row.decision_comment, createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at };
}
async function previewTransfer({ user, modelId, body }) { return repository.preview({ userId: Number(user.id), modelId, recipientId: recipient(body.recipientId) }); }
async function requestTransfer({ user, modelId, body }) {
    if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1 || !/^[a-f0-9]{64}$/.test(body.impactHash || '')) throw biError('ANALYSIS_MODEL_TRANSFER_INVALID', '请先预览当前交接影响。');
    return record(await repository.create({ userId: Number(user.id), modelId, recipientId: recipient(body.recipientId), expectedVersion: body.expectedVersion, impactHash: body.impactHash,
        reason: text(body.reason, '交接原因', 2000), businessOwner: text(body.businessOwner, '新业务负责人', 120), maintenanceContact: text(body.maintenanceContact, '新维护联系人', 120), requestKey: requestKey(body.requestKey) }));
}
async function transferInbox(user) { return (await repository.inbox(Number(user.id))).map(record); }
async function getTransfer(user, id) {
    const result = await repository.detail(Number(user.id), id);
    return { ...record(result.row), currentImpact: result.currentImpact, unchanged: result.unchanged };
}
async function decideTransfer({ user, id, body }) {
    if (!['accepted', 'rejected', 'cancelled'].includes(body.action)) throw biError('ANALYSIS_MODEL_TRANSFER_INVALID', '请选择接受、拒绝或撤回交接。');
    if (body.action === 'accepted' && (!Array.isArray(body.confirmations) || ['sources', 'personalScope', 'credentials', 'pausedPlans', 'contacts'].some(key => !body.confirmations.includes(key)))) throw biError('ANALYSIS_MODEL_TRANSFER_INVALID', '请逐项确认来源权限、个人范围、凭据、暂停计划和新维护责任。');
    return record(await repository.decide({ userId: Number(user.id), id, action: body.action, comment: text(body.comment, '处理说明', 2000) }));
}

module.exports = { previewTransfer, requestTransfer, transferInbox, getTransfer, decideTransfer };
