'use strict';

const { isAdmin } = require('../permissions');
const { assertSafeMcpOutboundUrl, assertSafeOutboundHost, createSafeHttpAgents, createSafeHttpAgentsForUser } = require('../security');
const { assertNetworkPolicyUrl } = require('./agent-network-policy');

/** 只有数据库中由超级管理员创建的全局连接可以委托普通用户访问固定内网端点。 */
async function mcpOutboundOptions(server, user, options = {}, getAccessibleServer) {
    let managed = false;
    if (!isAdmin(user) && /^\d+$/.test(String(server.id)) && Number(server.id) > 0) {
        const authoritative = await getAccessibleServer(Number(server.id), user);
        managed = Boolean(authoritative && authoritative.user_id === null && authoritative.status === 'active'
            && authoritative.base_url === server.base_url && process.env.ALLOW_PRIVATE_MCP_URLS !== 'false');
    }
    const endpoint = new URL(String(server.base_url).trim().replace(/\/+$/, ''));
    let policy = options.networkPolicy;
    if (typeof policy === 'string') policy = JSON.parse(policy);
    if (options.requireNetworkPolicy === true && (!policy || typeof policy !== 'object')) throw new Error('自主任务必须配置工具连接的网络白名单。');
    const assertUrl = async target => {
        const parsed = new URL(target);
        if (parsed.href !== endpoint.href || parsed.username || parsed.password) throw new Error('工具连接禁止访问登记端点以外的地址。');
        if (policy) await assertNetworkPolicyUrl(target, policy, { requireAllowlist: true });
        if (managed) {
            // 保留敏感地址和 DNS 复核；不以管理员身份发起请求，也不允许本机或元数据地址。
            await assertSafeOutboundHost(parsed.hostname, { blockPrivate: false, failClosedDns: true });
        } else await assertSafeMcpOutboundUrl(target, user);
    };
    return {
        assertUrl,
        createAgents: () => managed
            ? createSafeHttpAgents({ blockPrivate: false, failClosedDns: true })
            : createSafeHttpAgentsForUser(user, { allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS', allowExplicitLoopbackForAdmin: true })
    };
}

module.exports = { mcpOutboundOptions };
