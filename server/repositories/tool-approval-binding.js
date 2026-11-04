'use strict';

const { queryOne } = require('../db/client');

async function readApprovalServer(serverId) {
    return queryOne('SELECT id,base_url,config,status,api_key FROM mcp_servers WHERE id = ?', [serverId]);
}

module.exports = { readApprovalServer };
