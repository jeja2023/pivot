module.exports = [{
    id: '202610200002_chat_task_feed_index',
    description: '为对话任务的公开事件分页和历史兼容检查补充组合索引。',
    async upPg(client) {
        await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_events_run_type_seq
            ON agent_events(run_id, event_type, event_seq DESC)`);
    }
}];
