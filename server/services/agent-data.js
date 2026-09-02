const { transaction } = require('../db/client');
const { exportMemories } = require('./long-term-memory');
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
    await transaction(async trx => {
        const memory = await trx.execute("UPDATE memories SET status = 'deleted', updated_at = ? WHERE user_id = ? AND status != 'deleted'", [now, user.id]);
        result.memories = memory;
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
    });
    return { deletedAt: now, ...result };
}

module.exports = { deleteAgentPersonalData, exportAgentPersonalData };
