'use strict';

module.exports = [{
    id: '202610130001_regulations_categories',
    description: 'Add custom regulation categories catalog table.',
    async upPg(client) {
        await client.query(`
            CREATE TABLE IF NOT EXISTS regulation_categories (
                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                sort_order INT NOT NULL DEFAULT 0,
                created_by_user BIGINT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai'),
                updated_at TIMESTAMPTZ DEFAULT (NOW() AT TIME ZONE 'Asia/Shanghai')
            );
            CREATE INDEX IF NOT EXISTS idx_regulation_categories_sort
                ON regulation_categories(sort_order ASC, name ASC);
        `);
    }
}];
