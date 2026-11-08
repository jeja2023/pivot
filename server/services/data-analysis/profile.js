'use strict';

const { MAX_PROFILE_DISTINCT, createDuckConnection, withDuckTimeout } = require('./shared');
const { profileWithConnection } = require('./profile-sql');

async function profileViaSql(parquetPath, columns, totalRows) {
    const { instance, connection } = await createDuckConnection();
    try {
        return await profileWithConnection(connection, parquetPath, columns, totalRows, {
            run: sql => withDuckTimeout(connection, () => connection.runAndReadAll(sql)), maxDistinct: MAX_PROFILE_DISTINCT
        });
    } finally { connection.closeSync(); instance.closeSync(); }
}

module.exports = { profileViaSql };
