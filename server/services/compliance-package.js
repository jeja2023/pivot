const { Buffer } = require('node:buffer');
const { normalizePriceCurrency } = require('./model-costs');

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let j = 0; j < 8; j += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosDate, dosTime };
}

function buildZipArchive(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { dosDate, dosTime } = dosDateTime();

    entries.forEach(entry => {
        const name = Buffer.from(String(entry.name || '').replace(/\\/g, '/'), 'utf8');
        const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content || ''), 'utf8');
        const checksum = crc32(content);

        const local = Buffer.alloc(30 + name.length);
        let p = 0;
        local.writeUInt32LE(0x04034b50, p); p += 4;
        local.writeUInt16LE(20, p); p += 2;
        local.writeUInt16LE(0x0800, p); p += 2;
        local.writeUInt16LE(0, p); p += 2;
        local.writeUInt16LE(dosTime, p); p += 2;
        local.writeUInt16LE(dosDate, p); p += 2;
        local.writeUInt32LE(checksum, p); p += 4;
        local.writeUInt32LE(content.length, p); p += 4;
        local.writeUInt32LE(content.length, p); p += 4;
        local.writeUInt16LE(name.length, p); p += 2;
        local.writeUInt16LE(0, p); p += 2;
        name.copy(local, p);
        localParts.push(local, content);

        const central = Buffer.alloc(46 + name.length);
        p = 0;
        central.writeUInt32LE(0x02014b50, p); p += 4;
        central.writeUInt16LE(20, p); p += 2;
        central.writeUInt16LE(20, p); p += 2;
        central.writeUInt16LE(0x0800, p); p += 2;
        central.writeUInt16LE(0, p); p += 2;
        central.writeUInt16LE(dosTime, p); p += 2;
        central.writeUInt16LE(dosDate, p); p += 2;
        central.writeUInt32LE(checksum, p); p += 4;
        central.writeUInt32LE(content.length, p); p += 4;
        central.writeUInt32LE(content.length, p); p += 4;
        central.writeUInt16LE(name.length, p); p += 2;
        central.writeUInt16LE(0, p); p += 2;
        central.writeUInt16LE(0, p); p += 2;
        central.writeUInt16LE(0, p); p += 2;
        central.writeUInt16LE(0, p); p += 2;
        central.writeUInt32LE(0, p); p += 4;
        central.writeUInt32LE(offset, p); p += 4;
        name.copy(central, p);
        centralParts.push(central);

        offset += local.length + content.length;
    });

    const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
    const eocd = Buffer.alloc(22);
    let p = 0;
    eocd.writeUInt32LE(0x06054b50, p); p += 4;
    eocd.writeUInt16LE(0, p); p += 2;
    eocd.writeUInt16LE(0, p); p += 2;
    eocd.writeUInt16LE(entries.length, p); p += 2;
    eocd.writeUInt16LE(entries.length, p); p += 2;
    eocd.writeUInt32LE(centralSize, p); p += 4;
    eocd.writeUInt32LE(offset, p);

    return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function csvFromRows(headers, rows, escapeCsvCell) {
    const lines = ['\uFEFF' + headers.map(item => escapeCsvCell(item.label)).join(',')];
    rows.forEach(row => {
        lines.push(headers.map(item => escapeCsvCell(row[item.key] ?? '')).join(','));
    });
    return lines.join('\n') + '\n';
}

function buildDateConditions(alias, column, { start, end } = {}) {
    const conditions = [];
    const params = [];
    if (start) {
        conditions.push(`${alias}.${column} >= ?`);
        params.push(`${start} 00:00:00`);
    }
    if (end) {
        conditions.push(`${alias}.${column} <= ?`);
        params.push(`${end} 23:59:59`);
    }
    return { conditions, params };
}

function buildComplianceAuditPackage({ db, escapeCsvCell, generatedAt, filters = {} }) {
    const manifest = {
        generatedAt,
        filters: {
            start: filters.start || '',
            end: filters.end || '',
            includeDeleted: filters.includeDeleted === true
        },
        files: []
    };

    const includeDeleted = filters.includeDeleted === true;
    const sessionDate = buildDateConditions('s', 'created_at', filters);
    const auditDate = buildDateConditions('al', 'timestamp', filters);
    const usageDate = buildDateConditions('usage', 'created_at', filters);

    const sessionWhere = [
        ...sessionDate.conditions,
        includeDeleted ? '' : 's.deleted_at IS NULL'
    ].filter(Boolean);
    const auditWhere = auditDate.conditions;
    const usageWhere = usageDate.conditions;

    const sessions = db.prepare(`
        SELECT s.id, u.username, u.nickname, s.title, s.tags, s.is_pinned, s.is_archived,
               s.deleted_at, s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
               (SELECT COUNT(*) FROM attachments a WHERE a.session_id = s.id) AS attachment_count
        FROM sessions s
        LEFT JOIN users u ON u.id = s.user_id
        ${sessionWhere.length ? `WHERE ${sessionWhere.join(' AND ')}` : ''}
        ORDER BY COALESCE(s.updated_at, s.created_at) DESC
        LIMIT 50000
    `).all(...sessionDate.params);

    const audits = db.prepare(`
        SELECT al.id, al.timestamp, u.username, al.ip_address, al.action, al.details
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.user_id
        ${auditWhere.length ? `WHERE ${auditWhere.join(' AND ')}` : ''}
        ORDER BY al.timestamp DESC
        LIMIT 50000
    `).all(...auditDate.params);

    const usage = db.prepare(`
        SELECT usage.created_at, u.username, u.nickname, md.name AS model_name,
               usage.role, usage.token_count, usage.input_tokens, usage.output_tokens, usage.usage_source
        FROM (
            SELECT user_id, model_id, role, token_count,
                   CASE WHEN role = 'user' THEN token_count ELSE 0 END AS input_tokens,
                   CASE WHEN role != 'user' THEN token_count ELSE 0 END AS output_tokens,
                   created_at, 'message' AS usage_source
            FROM messages
            UNION ALL
            SELECT user_id, model_id, COALESCE(source, 'api') AS role, token_count,
                   COALESCE(input_tokens, 0) AS input_tokens,
                   COALESCE(output_tokens, 0) AS output_tokens,
                   created_at, 'api' AS usage_source
            FROM model_usage_events
        ) usage
        LEFT JOIN users u ON u.id = usage.user_id
        LEFT JOIN models md ON md.id = usage.model_id
        ${usageWhere.length ? `WHERE ${usageWhere.join(' AND ')}` : ''}
        ORDER BY usage.created_at DESC
        LIMIT 50000
    `).all(...usageDate.params);

    const modelCosts = db.prepare(`
        SELECT md.id, md.name, md.model_name, md.price_currency,
               COALESCE(md.input_price_per_million, 0) AS input_price_per_million,
               COALESCE(md.output_price_per_million, 0) AS output_price_per_million,
               COALESCE(SUM(usage.input_tokens), 0) AS input_tokens,
               COALESCE(SUM(usage.output_tokens), 0) AS output_tokens,
               COALESCE(SUM(usage.token_count), 0) AS total_tokens,
               ROUND(
                   (
                       COALESCE(SUM(usage.input_tokens), 0) * COALESCE(md.input_price_per_million, 0)
                       + COALESCE(SUM(usage.output_tokens), 0) * COALESCE(md.output_price_per_million, 0)
                   ) / 1000000.0,
                   6
               ) AS estimated_cost
        FROM models md
        LEFT JOIN (
            SELECT user_id, model_id, role, token_count,
                   CASE WHEN role = 'user' THEN token_count ELSE 0 END AS input_tokens,
                   CASE WHEN role != 'user' THEN token_count ELSE 0 END AS output_tokens,
                   created_at
            FROM messages
            UNION ALL
            SELECT user_id, model_id, COALESCE(source, 'api') AS role, token_count,
                   COALESCE(input_tokens, 0) AS input_tokens,
                   COALESCE(output_tokens, 0) AS output_tokens,
                   created_at
            FROM model_usage_events
        ) usage ON usage.model_id = md.id ${usageWhere.length ? `AND ${usageWhere.join(' AND ')}` : ''}
        GROUP BY md.id
        ORDER BY estimated_cost DESC, total_tokens DESC
    `).all(...usageDate.params);

    const files = [
        {
            name: 'manifest.json',
            content: JSON.stringify(manifest, null, 2)
        },
        {
            name: 'sessions.csv',
            content: csvFromRows([
                { key: 'id', label: 'Session ID' },
                { key: 'username', label: 'User' },
                { key: 'nickname', label: 'Nickname' },
                { key: 'title', label: 'Title' },
                { key: 'tags', label: 'Tags' },
                { key: 'message_count', label: 'Messages' },
                { key: 'attachment_count', label: 'Attachments' },
                { key: 'is_pinned', label: 'Pinned' },
                { key: 'is_archived', label: 'Archived' },
                { key: 'deleted_at', label: 'Deleted At' },
                { key: 'created_at', label: 'Created At' },
                { key: 'updated_at', label: 'Updated At' }
            ], sessions, escapeCsvCell)
        },
        {
            name: 'audit_logs.csv',
            content: csvFromRows([
                { key: 'id', label: 'ID' },
                { key: 'timestamp', label: 'Timestamp' },
                { key: 'username', label: 'User' },
                { key: 'ip_address', label: 'IP' },
                { key: 'action', label: 'Action' },
                { key: 'details', label: 'Details' }
            ], audits, escapeCsvCell)
        },
        {
            name: 'usage_details.csv',
            content: csvFromRows([
                { key: 'created_at', label: 'Time' },
                { key: 'username', label: 'User' },
                { key: 'nickname', label: 'Nickname' },
                { key: 'model_name', label: 'Model' },
                { key: 'role', label: 'Role' },
                { key: 'input_tokens', label: 'Input Tokens' },
                { key: 'output_tokens', label: 'Output Tokens' },
                { key: 'token_count', label: 'Total Tokens' },
                { key: 'usage_source', label: 'Source' }
            ], usage, escapeCsvCell)
        },
        {
            name: 'model_costs.csv',
            content: csvFromRows([
                { key: 'id', label: 'Model ID' },
                { key: 'name', label: 'Model Name' },
                { key: 'model_name', label: 'Upstream Model' },
                { key: 'price_currency', label: '计价币种' },
                { key: 'input_price_per_million', label: 'Input Price / 1M' },
                { key: 'output_price_per_million', label: 'Output Price / 1M' },
                { key: 'input_tokens', label: 'Input Tokens' },
                { key: 'output_tokens', label: 'Output Tokens' },
                { key: 'total_tokens', label: 'Total Tokens' },
                { key: 'estimated_cost', label: 'Estimated Cost' }
            ], modelCosts.map(row => ({
                ...row,
                price_currency: normalizePriceCurrency(row.price_currency)
            })), escapeCsvCell)
        }
    ];

    manifest.files = files.filter(file => file.name !== 'manifest.json').map(file => ({
        name: file.name,
        bytes: Buffer.byteLength(file.content),
        rows: file.content.split('\n').length - 2
    }));
    files[0].content = JSON.stringify(manifest, null, 2);

    return buildZipArchive(files);
}

module.exports = {
    buildComplianceAuditPackage,
    buildZipArchive,
    crc32
};
