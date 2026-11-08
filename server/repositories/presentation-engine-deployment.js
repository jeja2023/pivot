'use strict';
async function lock(client) { await client.queryOne("SELECT pg_advisory_xact_lock(hashtext('ppt:deployment'))"); }
async function active(client) { return client.queryOne("SELECT COUNT(*)::int AS total FROM tool_tasks WHERE tool_name IN ('presentation.master','presentation.native') AND status IN ('working','input_required') AND expires_at>NOW()"); }
module.exports = { lock, active };
