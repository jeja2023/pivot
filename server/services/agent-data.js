const { transaction } = require('../db/client');
const { exportMemories, cancelMemoryExtractionJobs, setLongTermMemoryEnabled } = require('./long-term-memory');
const { getAgentProfile } = require('./agent-profile');
const { listAgentFeedback } = require('./agent-feedback');
const { listEvolutionProposals } = require('./agent-evolution');
const { listAgentGoals } = require('./agent-goals');
const { listAgentChannels } = require('./agent-channels');
const { getBeijingTimestamp } = require('../time');
const { getPrimaryTenantId } = require('./enterprise-access');

async function exportAgentPersonalData(user) {
    const tenantId = user.tenant_id || await getPrimaryTenantId(user.id);
    const [profile, memories, feedback, proposals, goals, channels] = await Promise.all([
        getAgentProfile(user.id),
        exportMemories(user.id, { status: 'all', type: '', search: '' }),
        listAgentFeedback(user, { limit: 200 }),
        listEvolutionProposals(user, { limit: 200 }),
        listAgentGoals(user, { limit: 200 }),
        listAgentChannels(user)
    ]);
    return { exportedAt: getBeijingTimestamp(), userId: Number(user.id), tenantId, profile, memories, feedback, proposals, goals, channels };
}

async function deleteAgentPersonalData(user, _options = {}) {
    const now = getBeijingTimestamp();
    const result = {};
    // 删除前递增记忆修订号，避免已运行的抽取任务在事务提交后重新写回记录。
    await setLongTermMemoryEnabled(user.id, false);
    result.memoryJobsCancelled = await cancelMemoryExtractionJobs(user.id, { reason: 'PERSONAL_DATA_DELETED' });
    await transaction(async trx => {
        // 此接口是明确的个人数据擦除请求。它不同于普通“忘记”操作，会移除
        // 私有正文、来源、抑制项、使用事件和评测数据，而不是仅保留软删除标记。
        result.memoryUsageEvents = await trx.execute('DELETE FROM memory_usage_events WHERE user_id = ?', [user.id]);
        result.memoryEvidence = await trx.execute('DELETE FROM memory_source_evidence WHERE user_id = ?', [user.id]);
        result.memorySuppressions = await trx.execute('DELETE FROM memory_suppressions WHERE user_id = ?', [user.id]);
        result.memoryEvaluationRuns = await trx.execute('DELETE FROM memory_evaluation_runs WHERE user_id = ?', [user.id]);
        result.memoryEvaluationCases = await trx.execute('DELETE FROM memory_evaluation_cases WHERE user_id = ?', [user.id]);
        result.memories = await trx.execute('DELETE FROM memories WHERE user_id = ?', [user.id]);
        result.memoryJobsDeleted = await trx.execute('DELETE FROM memory_extraction_jobs WHERE user_id = ?', [user.id]);
        for (const [name, sql] of Object.entries({
            feedback: 'DELETE FROM agent_feedback WHERE user_id = ?',
            learningJobs: 'DELETE FROM agent_learning_jobs WHERE user_id = ?',
            proposals: 'DELETE FROM agent_evolution_proposals WHERE user_id = ?',
            goals: "UPDATE agent_goals SET status = 'deleted', ended_at = ?, updated_at = ? WHERE user_id = ? AND status != 'deleted'",
            channels: "UPDATE agent_channel_bindings SET status = 'deleted', credential_ref = '', config = '{}'::jsonb, updated_at = ? WHERE user_id = ? AND status != 'deleted'",
            profileVersions: 'DELETE FROM agent_profile_versions WHERE user_id = ?',
            profile: 'DELETE FROM agent_profiles WHERE user_id = ?'
        })) {
            if (name === 'goals') result[name] = await trx.execute(sql, [now, now, user.id]);
            else if (name === 'channels') result[name] = await trx.execute(sql, [now, user.id]);
            else result[name] = await trx.execute(sql, [user.id]);
        }
        result.memorySettings = await trx.execute(`
            DELETE FROM user_settings
            WHERE user_id = ? AND key IN ('long_term_memory_enabled', 'long_term_memory_revision', 'agent_memory_policy')
        `, [user.id]);
    });
    return { deletedAt: now, ...result };
}

module.exports = { deleteAgentPersonalData, exportAgentPersonalData };
