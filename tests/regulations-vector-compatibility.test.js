const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('法规向量兼容迁移不会重写旧 text 列，并会重排当前版本索引', () => {
    const migration = read('server/db/migrations/regulations-vector-column-compatibility.js');
    const search = read('server/services/regulations/search.js');
    const config = read('server/services/rag-config.js');
    const index = read('server/db/migrations/index.js');

    assert.match(migration, /embedding_type/);
    assert.doesNotMatch(migration, /ALTER COLUMN embedding TYPE vector/);
    assert.match(migration, /不 ALTER COLUMN/);
    assert.match(migration, /index_status = 'retry_wait'/);
    assert.match(migration, /embedding = NULL/);
    assert.match(migration, /rag_rerank_candidate_limit/);
    assert.match(migration, /rag_rerank_timeout_ms/);
    assert.match(index, /regulations-vector-column-compatibility/);
    assert.match(search, /const vectorExpression = `a\.embedding::vector\(\$\{queryVector\.length\}\)`/);
    assert.match(search, /vector_dims\(\$\{vectorExpression\}\)/);
    assert.match(config, /RAG_CONFIG_KEYS\.rerankCandidateLimit[\s\S]*?\n\s*20,/);
    assert.match(config, /RAG_CONFIG_KEYS\.rerankTimeoutMs[\s\S]*?\n\s*5000,/);
});
