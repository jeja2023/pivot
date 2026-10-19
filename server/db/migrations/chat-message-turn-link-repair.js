'use strict';

const [foundation] = require('./chat-conversation-turns');

async function checkPg(client) {
    const result = await client.query(`
        SELECT EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = to_regclass('messages')
              AND a.attname = 'conversation_turn_id' AND a.attnum > 0 AND NOT a.attisdropped
              AND EXISTS (
                  SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = to_regclass('idx_messages_conversation_turn_assistant')
                    AND i.indrelid = a.attrelid AND i.indisunique AND i.indisvalid
                    AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
                    AND regexp_replace(lower(pg_get_expr(i.indpred, i.indrelid)), '[[:space:]()]|::text', '', 'g')
                        = 'conversation_turn_idisnotnullandrole=''assistant'''
              )
              AND EXISTS (
                  SELECT 1 FROM pg_constraint c
                  WHERE c.conrelid = a.attrelid AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
                    AND c.confrelid = to_regclass('chat_conversation_turns') AND c.confdeltype = 'n' AND c.convalidated
              )
        ) AS ready
    `);
    return result.rows[0]?.ready === true;
}

module.exports = [{
    id: '202610190004_chat_message_turn_link_repair',
    description: '修复旧迁移已登记但聊天消息缺少轮次关联字段、外键或唯一索引的历史库。',
    checkPg,
    async upPg(client) {
        // 独立新版本修复历史结构，不能修改已登记迁移后期待旧库重新执行。
        await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('pivot:chat-turn-schema'))");
        await foundation.upPg(client);
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint c JOIN pg_attribute a
                      ON a.attrelid = c.conrelid AND c.conkey = ARRAY[a.attnum]::smallint[]
                    WHERE c.conrelid = to_regclass('messages') AND c.contype = 'f'
                      AND a.attname = 'conversation_turn_id' AND c.confrelid = to_regclass('chat_conversation_turns')
                      AND c.confdeltype = 'n'
                ) THEN
                    ALTER TABLE messages ADD CONSTRAINT messages_conversation_turn_id_fkey
                        FOREIGN KEY (conversation_turn_id) REFERENCES chat_conversation_turns(id) ON DELETE SET NULL;
                END IF;
            END $$;
        `);
    }
}];
