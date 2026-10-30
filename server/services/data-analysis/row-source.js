'use strict';
const shared = require('./shared');
// 只加载已授权字段到受限连接；调用方只能运行内部生成的固定查询。
async function withDatasetColumns(user, datasetId, keys, operation) {
    const dataset = await shared.getDatasetForUser(user, datasetId);
    const columns = [...new Set(keys)].map(key => shared.getColumn(dataset, key));
    await require('./governance').assertDatasetFieldsAccessible(user, dataset, columns.map(column => column.key));
    return shared.withAnalysisSlot(async () => {
        const { instance, connection } = await shared.createDuckConnection();
        try {
            await shared.withDuckTimeout(connection, () => connection.run(`CREATE TABLE source AS SELECT ${columns.map(column => shared.sqlIdent(column.key)).join(',')} FROM read_parquet(${shared.sqlLiteral(shared.getDatasetPaths(dataset).parquetPath)})`));
            await require('./duckdb-sandbox').lockDuckExternalAccess(connection);
            return await shared.withDuckTimeout(connection, () => operation({ dataset, columns, connection }));
        } finally { connection.closeSync(); instance.closeSync(); }
    });
}
module.exports = { withDatasetColumns };
