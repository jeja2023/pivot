'use strict';

// 外部消息平台的目标 ID 是个人数据，不应以明文保存在会话映射表中。仅持久化
// 使用 binding 作为 AAD 的密文；投递适配器在真正发送前才可解封。
module.exports = [{
    id: '202609200002_agent_channel_gateway_target',
    description: 'Store encrypted outbound target reference for paired channel sessions.',
    async upPg(client) {
        await client.query(`
            ALTER TABLE agent_channel_sessions
            ADD COLUMN IF NOT EXISTS outbound_target_encrypted TEXT NOT NULL DEFAULT '';
        `);
    }
}];
