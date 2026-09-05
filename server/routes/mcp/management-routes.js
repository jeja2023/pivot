function mountMcpManagementRoutes(deps = {}) {
    const {
        router,
        authMiddleware,
        adminMiddleware,
        logAction,
        asyncHandler,
        query,
        queryOne,
        nowOffsetExpr,
        isSuperAdmin,
        listMcpServers,
        getMcpServerShareOptions,
        updateMcpServerSharing,
        normalizeServerRowAsync,
        buildCapabilityHealth,
        getBuiltInToolDefinitions,
        getCapabilityToolGovernanceFromPackage,
        listCachedMcpTools,
        MCP_CHAT_TOOL_TITLES,
        listGlobalCapabilityPackages,
        getGlobalCapabilityPackage,
        setGlobalCapabilityPackageStatus,
        setGlobalCapabilityToolGovernance,
        parseBoolean
    } = deps;

    router.get('/mcp/servers', authMiddleware, asyncHandler(async (req, res) => {
        res.json({ data: await listMcpServers(req.user) });
    }));

    router.get('/mcp/servers/:id/share-options', authMiddleware, asyncHandler(async (req, res) => {
        const options = await getMcpServerShareOptions(req.params.id, req.user);
        if (!options) return res.status(404).json({ error: '工具服务不存在或无权管理共享设置' });
        return res.json({ data: options });
    }));

    router.patch('/mcp/servers/:id/sharing', authMiddleware, asyncHandler(async (req, res) => {
        try {
            const server = await updateMcpServerSharing(req.params.id, req.user, req.body || {});
            if (!server) return res.status(404).json({ error: '工具服务不存在或无权管理共享设置' });
            logAction(req, '更新工具服务共享设置', `${server.name}: ${server.scope}`);
            return res.json({ success: true, server: await normalizeServerRowAsync(server) });
        } catch (error) {
            return res.status(error.status || 400).json({ error: error.message });
        }
    }));

    router.get('/mcp/governance', authMiddleware, asyncHandler(async (req, res) => {
        const superAdmin = isSuperAdmin(req.user);
        const serverScope = superAdmin ? "s.status != 'deleted'" : "s.status != 'deleted' AND (s.user_id IS NULL OR s.user_id = ?)";
        const scopeParams = superAdmin ? [] : [req.user.id];
        const summary = await queryOne(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN s.last_error IS NOT NULL AND s.last_error != '' THEN 1 ELSE 0 END) AS error,
                SUM(CASE WHEN s.last_checked_at IS NULL THEN 1 ELSE 0 END) AS unchecked,
                SUM(CASE WHEN s.base_url LIKE 'pivot-db://%' THEN 1 ELSE 0 END) AS databaseServers,
                SUM(CASE WHEN s.base_url LIKE 'pivot-reports://%' THEN 1 ELSE 0 END) AS reportServers,
                SUM(CASE WHEN s.base_url LIKE 'pivot-visualization://%' THEN 1 ELSE 0 END) AS visualizationServers,
                SUM(CASE WHEN s.base_url LIKE 'pivot-report://%' THEN 1 ELSE 0 END) AS reportComposerServers,
                SUM(CASE WHEN s.base_url LIKE 'pivot-im://%' THEN 1 ELSE 0 END) AS imServers
            FROM mcp_servers s
            WHERE ${serverScope}
        `, scopeParams);
        const recentWindow = nowOffsetExpr('-7 days');
        const callScope = superAdmin
            ? `l.created_at >= ${recentWindow}`
            : `(l.user_id = ? OR (l.server_id IS NOT NULL AND (s.user_id IS NULL OR s.user_id = ?))) AND l.created_at >= ${recentWindow}`;
        const callParams = superAdmin ? [] : [req.user.id, req.user.id];
        const roundAvgExpr = 'ROUND(AVG(l.duration_ms)::numeric, 0)';
        const callSummary = await queryOne(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END) AS errors,
                ${roundAvgExpr} AS avgDurationMs
            FROM mcp_call_logs l
            LEFT JOIN mcp_servers s ON s.id = l.server_id
            WHERE ${callScope}
        `, callParams);
        const topTools = await query(`
            SELECT l.tool_name, COALESCE(s.name, '我的电脑') AS server_name, COUNT(*) AS count,
                   SUM(CASE WHEN l.status = 'error' THEN 1 ELSE 0 END) AS errors,
                   ${roundAvgExpr} AS avgDurationMs
            FROM mcp_call_logs l
            LEFT JOIN mcp_servers s ON s.id = l.server_id
            WHERE ${callScope}
            GROUP BY l.server_id, s.name, l.tool_name
            ORDER BY count DESC
            LIMIT 8
        `, callParams);
        const health = buildCapabilityHealth(summary || {}, callSummary || {});
        res.json({
            summary: {
                total: Number(summary?.total || 0),
                active: Number(summary?.active || 0),
                error: Number(summary?.error || 0),
                unchecked: Number(summary?.unchecked || 0),
                databaseServers: Number(summary?.databaseServers || 0),
                reportServers: Number(summary?.reportServers || 0),
                visualizationServers: Number(summary?.visualizationServers || 0),
                reportComposerServers: Number(summary?.reportComposerServers || 0),
                imServers: Number(summary?.imServers || 0),
                calls7d: Number(callSummary?.total || 0),
                callErrors7d: Number(callSummary?.errors || 0),
                avgDurationMs: Number(callSummary?.avgDurationMs || 0),
                healthScore: health.score,
                healthLevel: health.level,
                activeRate: health.activeRate,
                callErrorRate: health.callErrorRate
            },
            health,
            topTools: topTools || []
        });
    }));

    router.get('/mcp/call-logs', authMiddleware, asyncHandler(async (req, res) => {
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
        const superAdmin = isSuperAdmin(req.user);
        const where = superAdmin ? "(l.server_id IS NULL OR s.status != 'deleted')" : "(l.user_id = ? OR (l.server_id IS NOT NULL AND (s.user_id IS NULL OR s.user_id = ?)))";
        const params = superAdmin ? [limit] : [req.user.id, req.user.id, limit];
        const rows = await query(`
            SELECT l.id, l.user_id, COALESCE(NULLIF(u.deleted_username, ''), u.username) AS username, u.nickname, l.server_id, COALESCE(s.name, '我的电脑') AS server_name,
                   l.tool_name, l.source, l.status, l.duration_ms, l.input_preview,
                   l.output_preview, l.error_message, l.created_at
            FROM mcp_call_logs l
            LEFT JOIN mcp_servers s ON s.id = l.server_id
            LEFT JOIN users u ON u.id = l.user_id
            WHERE ${where}
            ORDER BY l.created_at DESC, l.id DESC
            LIMIT ?
        `, params);
        res.json({ data: rows });
    }));

    async function resolvePackageTools(item, user) {
        if (!item) return [];
        const config = item.config || {};
        const storedTools = config.tools && typeof config.tools === 'object' ? config.tools : {};
        let tools = [];
        if (item.type === 'builtin_tool') {
            const definition = getBuiltInToolDefinitions(user).find(tool => tool.name === item.source_ref);
            if (definition) {
                tools = [{
                    name: definition.name,
                    fullName: definition.name,
                    title: definition.title || definition.name,
                    description: definition.description || '',
                    governance: getCapabilityToolGovernanceFromPackage(item, definition.name, user)
                }];
            }
        } else {
            const cachedList = await listCachedMcpTools(item.source_ref, user);
            tools = [];
            for (const tool of cachedList) {
                if (item.type === 'database_connection' ? tool.serverType !== 'database' : tool.serverType === 'database') {
                    continue;
                }
                const gov = getCapabilityToolGovernanceFromPackage(item, tool.name, user);
                const shortName = String(tool.name || '').replace(/^mcp\.\d+\./, '');
                const title = tool.title && tool.title !== tool.name ? tool.title : (MCP_CHAT_TOOL_TITLES[shortName] || tool.title || tool.name);
                tools.push({
                    name: tool.name,
                    fullName: tool.fullName,
                    title,
                    description: tool.description || '',
                    governance: gov
                });
            }
        }
        const known = new Set(tools.map(tool => tool.name));
        for (const name of Object.keys(storedTools)) {
            if (known.has(name)) continue;
            const gov = getCapabilityToolGovernanceFromPackage(item, name, user);
            const shortName = String(name || '').replace(/^mcp\.\d+\./, '');
            const title = MCP_CHAT_TOOL_TITLES[shortName] || name;
            tools.push({
                name,
                fullName: name,
                title,
                description: '已保存策略，当前工具缓存中未找到该工具。',
                stale: true,
                governance: gov
            });
        }
        return tools;
    }

    router.get('/capabilities/packages', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const packages = await listGlobalCapabilityPackages(req.user);
        if (req.query?.include_tools === 'true' || req.query?.includeTools === 'true') {
            const enriched = await Promise.all(packages.map(async item => {
                const tools = await resolvePackageTools(item, req.user);
                return { ...item, tools };
            }));
            return res.json({ data: enriched, scope: 'global' });
        }
        res.json({ data: packages, scope: 'global' });
    }));

    router.get('/capabilities/packages/:key/tools', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const item = await getGlobalCapabilityPackage(req.params.key, req.user);
        if (!item) return res.status(404).json({ error: '工具包不存在。' });
        const tools = await resolvePackageTools(item, req.user);
        res.json({ item, tools });
    }));

    router.put('/capabilities/packages/:key', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const item = await setGlobalCapabilityPackageStatus(req.params.key, req.user, req.body?.status || (req.body?.enabled === false ? 'disabled' : 'enabled'));
        if (!item) return res.status(404).json({ error: '工具包不存在。' });
        logAction(req, '更新工具包状态', `${item.package_key}: ${item.status}`);
        res.json({ success: true, item });
    }));

    router.put('/capabilities/packages/:key/tools/:tool', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
        const item = await setGlobalCapabilityToolGovernance(req.params.key, req.user, req.params.tool, {
            enabled: parseBoolean(req.body?.enabled, true),
            riskLevel: req.body?.riskLevel || req.body?.risk_level,
            approvalRequired: req.body?.approvalRequired !== undefined
                ? req.body.approvalRequired
                : req.body?.approval_required,
            usage: req.body?.usage || req.body?.applicability
        });
        if (!item) return res.status(404).json({ error: '工具包不存在。' });
        logAction(req, '更新工具治理', `${item.packageKey}: ${item.toolName}`);
        res.json({ success: true, item });
    }));
}

module.exports = { mountMcpManagementRoutes };
