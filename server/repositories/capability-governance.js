'use strict';

const { query } = require('../db/client');

async function loadCapabilityPackagesByKeys(keys) {
    if (!keys.length) return [];
    return await query(
        'SELECT package_key, status, scope, user_id, config FROM capability_packages WHERE package_key = ANY(?::text[])',
        [keys]
    );
}

module.exports = { loadCapabilityPackagesByKeys };
