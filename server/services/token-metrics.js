'use strict';

// 以同一数据库快照计算累计值和当天值；保留原始记录作为唯一事实来源，
// 使删除、修正和其他节点写入在下一次刷新时都能反映出来。
async function readTokenMetrics(query, start, nextStart) {
    const rows = await query(`
        SELECT COALESCE(usage.model_id, 0) AS model_id,
               COALESCE(md.name, 'unknown') AS model_name,
               usage.role,
               SUM(COALESCE(usage.token_count, 0)) AS tokens,
               SUM(COALESCE(usage.token_count, 0)) FILTER
                   (WHERE usage.created_at >= ? AND usage.created_at < ?) AS today_tokens
        FROM (
            SELECT model_id, COALESCE(role, 'unknown') AS role, token_count, created_at FROM messages
            UNION ALL
            SELECT model_id, COALESCE(source, 'api') AS role, token_count, created_at FROM model_usage_events
        ) AS usage
        LEFT JOIN models md ON md.id = usage.model_id
        GROUP BY COALESCE(usage.model_id, 0), COALESCE(md.name, 'unknown'), usage.role
    `, [start, nextStart]);
    const all = [];
    const today = [];
    for (const row of rows || []) {
        const { model_id, model_name, role, tokens, today_tokens } = row;
        all.push({ model_id, model_name, role, tokens });
        if (today_tokens !== null && today_tokens !== undefined) today.push({ model_id, model_name, role, tokens: today_tokens });
    }
    return { all, today };
}

async function readSnapshot(queryOne, start, nextStart) {
    const row = await queryOne(`
        SELECT all_rows, today_rows,
               day_start = ?::timestamptz AND day_end = ?::timestamptz AS same_day,
               (EXTRACT(EPOCH FROM (clock_timestamp() - computed_at)) * 1000)::double precision AS age_ms
        FROM token_metrics_snapshot WHERE id = 1
    `, [start, nextStart]);
    if (!row || row.same_day !== true || !Array.isArray(row.all_rows) || !Array.isArray(row.today_rows)
        || !Number.isFinite(Number(row.age_ms)) || Number(row.age_ms) < 0) return null;
    return { all: row.all_rows, today: row.today_rows, ageMs: Number(row.age_ms) };
}

// 数据库锁仅在缓存过期时取得；锁后重新检查，确保多个节点只需一次全量聚合。
// 快照始终可从原表重新生成，因此修正、删除和进程重启不改变统计口径。
async function readSharedTokenMetrics({ queryOne, transaction, start, nextStart, ttlMs }) {
    const fresh = snapshot => snapshot && snapshot.ageMs < ttlMs;
    const initial = await readSnapshot(queryOne, start, nextStart);
    if (fresh(initial)) return initial;
    return await transaction(async trx => {
        await trx.query("SELECT pg_advisory_xact_lock(hashtext('pivot:token-metrics'), hashtext(current_schema()))");
        const latest = await readSnapshot(trx.queryOne, start, nextStart);
        if (fresh(latest)) return latest;
        const result = await readTokenMetrics(trx.query, start, nextStart);
        await trx.execute(`
            INSERT INTO token_metrics_snapshot (id, day_start, day_end, all_rows, today_rows, computed_at)
            VALUES (1, ?::timestamptz, ?::timestamptz, ?::jsonb, ?::jsonb, clock_timestamp())
            ON CONFLICT (id) DO UPDATE SET day_start = EXCLUDED.day_start, day_end = EXCLUDED.day_end,
                all_rows = EXCLUDED.all_rows, today_rows = EXCLUDED.today_rows, computed_at = EXCLUDED.computed_at
        `, [start, nextStart, JSON.stringify(result.all), JSON.stringify(result.today)]);
        return { ...result, ageMs: 0 };
    });
}

module.exports = { readTokenMetrics, readSharedTokenMetrics };
