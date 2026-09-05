function mountMcpConfigurationRoutes(deps = {}) {
    const {
        router,
        authMiddleware,
        asyncHandler,
        getBeijingTimestamp,
        query,
        queryOne,
        execute,
        transaction,
        decryptSecret,
        encryptSecret,
        assertSafeMcpOutboundUrl,
        getAccessibleMcpServer,
        normalizeServerRowAsync,
        refreshMcpTools,
        listCachedMcpTools,
        filterMcpToolsByCapability,
        DEFAULT_PORTS,
        normalizeDatabaseConnectionError,
        testDatabaseConnection,
        validateDatabaseConnectionPayload,
        BUILTIN_MCP_PREFIXES,
        executeBuiltinMcpTool,
        getBuiltinServiceTypeFromUrl,
        getBuiltinConfigForServerAsync,
        normalizeBuiltinPayload,
        isSuperAdmin,
        SYSTEM_MCP_SERVICES,
        getDatabaseTestErrorStatus,
        sanitizeDatabaseConnectionForLog,
        parseServerConfig,
        normalizeExternalServerConfig,
        findAccessibleBuiltinService,
        safeJsonGet,
        logAction,
        createSystemBuiltinService,
        decryptExistingDatabasePassword
    } = deps;

        router.get('/mcp/database-types', authMiddleware, asyncHandler(async (_req, res) => {
            res.json({
                data: [
                    { id: 'postgres', name: 'PostgreSQL', defaultPort: DEFAULT_PORTS.postgres, driver: 'pg' },
                    { id: 'mysql', name: 'MySQL / MariaDB', defaultPort: DEFAULT_PORTS.mysql, driver: 'mysql2' },
                    { id: 'sqlserver', name: 'SQL Server', defaultPort: DEFAULT_PORTS.sqlserver, driver: 'mssql' },
                    { id: 'sqlite', name: 'SQLite', defaultPort: DEFAULT_PORTS.sqlite, driver: 'better-sqlite3' },
                    { id: 'mongodb', name: 'MongoDB', defaultPort: DEFAULT_PORTS.mongodb, driver: 'mongodb' }
                ]
            });
        }));

        router.post('/mcp/database-connections/test', authMiddleware, asyncHandler(async (req, res) => {
            const serverId = req.body?.id || req.body?.mcp_server_id || req.body?.mcpServerId;
            let password = req.body?.password;

            if (serverId) {
                const existing = await getAccessibleMcpServer(serverId, req.user);
                if (!existing) return res.status(404).json({ error: '工具服务不存在。' });
                if (!String(existing.base_url || '').startsWith('pivot-db://')) {
                    return res.status(400).json({ error: '该工具服务不是服务器可访问数据库。' });
                }
                const dbConnectionRow = await queryOne('SELECT * FROM mcp_database_connections WHERE mcp_server_id = ?', [existing.id]);
                if (!dbConnectionRow) return res.status(404).json({ error: '服务器可访问数据库配置不存在。' });
                if (password === undefined || password === '********') {
                    password = decryptExistingDatabasePassword(dbConnectionRow);
                }
            }

            let connection;
            try {
                connection = validateDatabaseConnectionPayload({ ...req.body, password }, req.user);
                const result = await testDatabaseConnection(connection);
                logAction(req, '测试数据库能力连接', `${connection.database_type}: ${connection.host || connection.database_name}`);
                res.json({ success: true, result });
            } catch (err) {
                const failure = normalizeDatabaseConnectionError(err, connection || req.body);
                const status = failure.status || getDatabaseTestErrorStatus(err);
                (req.log || console).warn({
                    status,
                    code: failure.code || err?.code,
                    message: failure.detail || failure.message || err?.message,
                    hint: failure.hint,
                    connection: sanitizeDatabaseConnectionForLog(connection, req.body)
                }, 'MCP 服务器可访问数据库测试失败');
                res.status(status).json({
                    success: false,
                    error: failure.message || err?.message || '服务器可访问数据库测试失败。',
                    code: failure.code || err?.code || 'MCP_DATABASE_CONNECTION_TEST_FAILED',
                    detail: failure.detail || '',
                    hint: failure.hint || '',
                    diagnostics: failure.diagnostics || sanitizeDatabaseConnectionForLog(connection, req.body)
                });
            }
        }));

        router.post('/mcp/servers', authMiddleware, asyncHandler(async (req, res) => {
            const name = String(req.body?.name || '').trim();
            const baseUrl = String(req.body?.base_url || req.body?.baseUrl || '').trim();
            const apiKey = String(req.body?.api_key || req.body?.apiKey || '').trim();
            const description = String(req.body?.description || '').trim();
            const config = normalizeExternalServerConfig(req.body || {});
            const shared = isSuperAdmin(req.user) && (req.body?.shared === true || req.body?.user_id === null);
            if (!name || !baseUrl) return res.status(400).json({ error: '服务名称和基础 URL 为必填项。' });
            await assertSafeMcpOutboundUrl(baseUrl, req.user);
            if (config.healthCheckUrl) await assertSafeMcpOutboundUrl(config.healthCheckUrl, req.user);
            const now = getBeijingTimestamp();
            const row = await queryOne(`
                INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, config, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
                RETURNING id
            `, [shared ? null : req.user.id, name, baseUrl, encryptSecret(apiKey), description, JSON.stringify(config), now, now]);
            logAction(req, '新增工具服务', `${name}: ${baseUrl}`);
            const created = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [row?.id]);
            res.status(201).json({ success: true, server: await normalizeServerRowAsync(created) });
        }));

        router.post('/mcp/database-connections', authMiddleware, asyncHandler(async (req, res) => {
            const name = String(req.body?.name || '').trim();
            const description = String(req.body?.description || '').trim();
            const shared = isSuperAdmin(req.user) && (req.body?.shared === true || req.body?.user_id === null);
            if (!name) return res.status(400).json({ error: '请填写连接名称。' });

            const connection = validateDatabaseConnectionPayload(req.body, req.user);
            const now = getBeijingTimestamp();
            const userId = shared ? null : req.user.id;
            let serverId = 0;
            await transaction(async trx => {
                const info = await trx.queryOne(`
                    INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
                    VALUES (?, ?, ?, '', ?, 'active', ?, ?)
                    RETURNING id
                `, [userId, name, 'pivot-db://pending', description, now, now]);
                serverId = info?.id;
                await trx.execute('UPDATE mcp_servers SET base_url = ? WHERE id = ?', [
                    `pivot-db://connection/${serverId}`, serverId
                ]);
                await trx.execute(`
                    INSERT INTO mcp_database_connections (
                        mcp_server_id, user_id, database_type, host, port, database_name, username, password, options, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                `, [
                    serverId,
                    userId,
                    connection.database_type,
                    connection.host,
                    connection.port,
                    connection.database_name,
                    connection.username,
                    encryptSecret(connection.password),
                    JSON.stringify(connection.options),
                    now,
                    now
                ]);
            });
            logAction(req, '新增数据库工具服务', `${name}: ${connection.database_type}`);
            const created = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [serverId]);
            res.status(201).json({ success: true, server: await normalizeServerRowAsync(created) });
        }));

        router.post('/mcp/builtin-services', authMiddleware, asyncHandler(async (req, res) => {
            const name = String(req.body?.name || '').trim();
            const description = String(req.body?.description || '').trim();
            const shared = isSuperAdmin(req.user) && (req.body?.shared === true || req.body?.user_id === null);
            if (!name) return res.status(400).json({ error: '请填写工具名称。' });

            const service = normalizeBuiltinPayload(req.body?.service_type || req.body?.serviceType, req.body);
            if (service.serviceType === 'im') {
                await assertSafeMcpOutboundUrl(service.config.endpointUrl, req.user);
            }
            const now = getBeijingTimestamp();
            const userId = shared ? null : req.user.id;
            let serverId = 0;
            await transaction(async trx => {
                const info = await trx.queryOne(`
                    INSERT INTO mcp_servers (user_id, name, base_url, api_key, description, status, created_at, updated_at)
                    VALUES (?, ?, ?, '', ?, 'active', ?, ?)
                    RETURNING id
                `, [userId, name, `${BUILTIN_MCP_PREFIXES[service.serviceType]}pending`, description, now, now]);
                serverId = info?.id;
                await trx.execute('UPDATE mcp_servers SET base_url = ? WHERE id = ?', [
                    `${BUILTIN_MCP_PREFIXES[service.serviceType]}connection/${serverId}`, serverId
                ]);
                await trx.execute(`
                    INSERT INTO mcp_builtin_configs (
                        mcp_server_id, user_id, service_type, config, secret, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
                `, [
                    serverId,
                    userId,
                    service.serviceType,
                    JSON.stringify(service.config),
                    encryptSecret(service.secret),
                    now,
                    now
                ]);
            });
            logAction(req, '新增系统工具服务', `${name}: ${service.serviceType}`);
            const created = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [serverId]);
            res.status(201).json({ success: true, server: await normalizeServerRowAsync(created) });
        }));

        router.post('/mcp/system-services/:type/ensure', authMiddleware, asyncHandler(async (req, res) => {
            const serviceType = String(req.params.type || '').trim().toLowerCase();
            if (!SYSTEM_MCP_SERVICES[serviceType]) {
                return res.status(400).json({ error: '不支持的系统工具。' });
            }
            const existing = await findAccessibleBuiltinService(serviceType, req.user);
            const serverId = existing?.id || (await createSystemBuiltinService(serviceType, req.user));
            const server = await getAccessibleMcpServer(serverId, req.user);
            const tools = await refreshMcpTools(server, req.user);
            logAction(req, existing ? '启用系统工具服务' : '新增系统工具服务', `${SYSTEM_MCP_SERVICES[serviceType].name}: ${tools.length}`);
            const created = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [serverId]);
            res.status(existing ? 200 : 201).json({
                success: true,
                server: await normalizeServerRowAsync(created),
                tools
            });
        }));

        router.put('/mcp/builtin-services/:id', authMiddleware, asyncHandler(async (req, res) => {
            const existing = await getAccessibleMcpServer(req.params.id, req.user);
            if (!existing) return res.status(404).json({ error: '工具服务不存在。' });
            const serviceType = getBuiltinServiceTypeFromUrl(existing.base_url);
            if (!serviceType) return res.status(400).json({ error: '该工具服务不是系统预设。' });
            if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以编辑全局工具服务。' });
            if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权编辑该工具服务。' });

            const configRow = await queryOne('SELECT * FROM mcp_builtin_configs WHERE mcp_server_id = ?', [existing.id]);
            if (!configRow) return res.status(404).json({ error: '系统工具配置不存在。' });

            const name = String(req.body?.name || existing.name).trim();
            const description = String(req.body?.description ?? existing.description ?? '').trim();
            const status = ['active', 'paused'].includes(req.body?.status) ? req.body.status : existing.status;
            const service = normalizeBuiltinPayload(serviceType, {
                ...req.body,
                service_type: serviceType,
                secret: req.body?.secret === undefined || req.body?.secret === '********'
                    ? decryptSecret(configRow.secret || '')
                    : req.body?.secret
            });
            if (service.serviceType === 'im') {
                await assertSafeMcpOutboundUrl(service.config.endpointUrl, req.user);
            }
            const now = getBeijingTimestamp();
            await transaction(async trx => {
                await trx.execute(`
                    UPDATE mcp_servers
                    SET name = ?, description = ?, status = ?, updated_at = ?
                    WHERE id = ?
                `, [name, description, status, now, existing.id]);
                await trx.execute(`
                    UPDATE mcp_builtin_configs
                    SET service_type = ?, config = ?, secret = ?, status = ?, updated_at = ?
                    WHERE mcp_server_id = ?
                `, [
                    service.serviceType,
                    JSON.stringify(service.config),
                    encryptSecret(service.secret),
                    status,
                    now,
                    existing.id
                ]);
            });
            logAction(req, '修改系统工具服务', `${name}: ${service.serviceType}`);
            const updated = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [existing.id]);
            res.json({ success: true, server: await normalizeServerRowAsync(updated) });
        }));

        router.put('/mcp/database-connections/:id', authMiddleware, asyncHandler(async (req, res) => {
            const existing = await getAccessibleMcpServer(req.params.id, req.user);
            if (!existing) return res.status(404).json({ error: '工具服务不存在。' });
            if (!String(existing.base_url || '').startsWith('pivot-db://')) return res.status(400).json({ error: '该工具服务不是服务器可访问数据库。' });
            if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以编辑全局工具服务。' });
            if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权编辑该工具服务。' });

            const dbConnectionRow = await queryOne('SELECT * FROM mcp_database_connections WHERE mcp_server_id = ?', [existing.id]);
            if (!dbConnectionRow) return res.status(404).json({ error: '服务器可访问数据库配置不存在。' });

            const name = String(req.body?.name || existing.name).trim();
            const description = String(req.body?.description ?? existing.description ?? '').trim();
            const status = ['active', 'paused'].includes(req.body?.status) ? req.body.status : existing.status;
            const connection = validateDatabaseConnectionPayload({
                ...req.body,
                password: req.body?.password === undefined || req.body?.password === '********'
                    ? decryptExistingDatabasePassword(dbConnectionRow)
                    : req.body?.password
            }, req.user);
            const now = getBeijingTimestamp();
            await transaction(async trx => {
                await trx.execute(`
                    UPDATE mcp_servers
                    SET name = ?, description = ?, status = ?, updated_at = ?
                    WHERE id = ?
                `, [name, description, status, now, existing.id]);
                await trx.execute(`
                    UPDATE mcp_database_connections
                    SET database_type = ?, host = ?, port = ?, database_name = ?, username = ?, password = ?, options = ?, status = ?, updated_at = ?
                    WHERE mcp_server_id = ?
                `, [
                    connection.database_type,
                    connection.host,
                    connection.port,
                    connection.database_name,
                    connection.username,
                    encryptSecret(connection.password),
                    JSON.stringify(connection.options),
                    status,
                    now,
                    existing.id
                ]);
            });
            logAction(req, '修改数据库工具服务', `${name}: ${connection.database_type}`);
            const updated = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [existing.id]);
            res.json({ success: true, server: await normalizeServerRowAsync(updated) });
        }));

        router.put('/mcp/servers/:id', authMiddleware, asyncHandler(async (req, res) => {
            const existing = await getAccessibleMcpServer(req.params.id, req.user);
            if (existing && existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '当前用户对该公共 MCP 服务仅具有只读权限。' });
            if (existing && existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '当前用户对该 MCP 服务仅具有只读权限。' });
            if (!existing) return res.status(404).json({ error: '工具服务不存在。' });
            if (String(existing.base_url || '').startsWith('pivot-db://')) return res.status(400).json({ error: '服务器可访问数据库请使用对应表单编辑。' });
            if (getBuiltinServiceTypeFromUrl(existing.base_url)) return res.status(400).json({ error: '系统工具预设请使用对应的系统服务表单编辑。' });
            if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以编辑全局工具服务。' });
            if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权编辑该工具服务。' });

            const name = String(req.body?.name || existing.name).trim();
            const baseUrl = String(req.body?.base_url || req.body?.baseUrl || existing.base_url).trim();
            const description = String(req.body?.description ?? existing.description ?? '').trim();
            const status = ['active', 'paused'].includes(req.body?.status) ? req.body.status : existing.status;
            const config = normalizeExternalServerConfig({ ...parseServerConfig(existing.config), ...(req.body || {}) });
            const apiKeyInput = req.body?.api_key ?? req.body?.apiKey;
            const nextApiKey = apiKeyInput === undefined || apiKeyInput === '********'
                ? encryptSecret(existing.api_key || '')
                : encryptSecret(String(apiKeyInput || '').trim());
            await assertSafeMcpOutboundUrl(baseUrl, req.user);
            if (config.healthCheckUrl) await assertSafeMcpOutboundUrl(config.healthCheckUrl, req.user);
            await execute(`
                UPDATE mcp_servers
                SET name = ?, base_url = ?, api_key = ?, description = ?, config = ?, status = ?, updated_at = ?
                WHERE id = ?
            `, [name, baseUrl, nextApiKey, description, JSON.stringify(config), status, getBeijingTimestamp(), existing.id]);
            logAction(req, '修改工具服务', `${name}: ${baseUrl}`);
            const updated = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [existing.id]);
            res.json({ success: true, server: await normalizeServerRowAsync(updated) });
        }));

        router.patch('/mcp/servers/:id/status', authMiddleware, asyncHandler(async (req, res) => {
            const existing = await getAccessibleMcpServer(req.params.id, req.user);
            if (!existing) return res.status(404).json({ error: '工具服务不存在。' });
            if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以管理全局工具服务。' });
            if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权管理该工具服务。' });
            const status = req.body?.status === 'paused' ? 'paused' : 'active';
            const now = getBeijingTimestamp();
            await execute('UPDATE mcp_servers SET status = ?, updated_at = ? WHERE id = ?', [status, now, existing.id]);
            if (String(existing.base_url || '').startsWith('pivot-db://')) {
                await execute('UPDATE mcp_database_connections SET status = ?, updated_at = ? WHERE mcp_server_id = ?', [status, now, existing.id]);
            } else if (getBuiltinServiceTypeFromUrl(existing.base_url)) {
                await execute('UPDATE mcp_builtin_configs SET status = ?, updated_at = ? WHERE mcp_server_id = ?', [status, now, existing.id]);
            }
            logAction(req, status === 'paused' ? '停用工具服务' : '启用工具服务', existing.name);
            const updated = await queryOne('SELECT * FROM mcp_servers WHERE id = ?', [existing.id]);
            res.json({ success: true, server: await normalizeServerRowAsync(updated) });
        }));

        router.delete('/mcp/servers/:id', authMiddleware, asyncHandler(async (req, res) => {
            const existing = await getAccessibleMcpServer(req.params.id, req.user);
            if (!existing) return res.status(404).json({ error: '工具服务不存在。' });
            if (existing.user_id === null && !isSuperAdmin(req.user)) return res.status(403).json({ error: '只有 admin 权限层级可以删除全局工具服务。' });
            if (existing.user_id !== null && existing.user_id !== req.user.id && !isSuperAdmin(req.user)) return res.status(403).json({ error: '无权删除该工具服务。' });
            const now = getBeijingTimestamp();
            await execute("UPDATE mcp_servers SET status = 'deleted', updated_at = ? WHERE id = ?", [now, existing.id]);
            await execute("UPDATE mcp_database_connections SET status = 'deleted', updated_at = ? WHERE mcp_server_id = ?", [now, existing.id]);
            await execute("UPDATE mcp_builtin_configs SET status = 'deleted', updated_at = ? WHERE mcp_server_id = ?", [now, existing.id]);

            // 删除工具服务时，同步删除对应的工具包记录
            const isDatabase = String(existing.base_url || '').startsWith('pivot-db://');
            const packageType = isDatabase ? 'database_connection' : 'mcp_server';
            const packageKey = `${packageType}:${existing.id}`;
            await execute("DELETE FROM capability_packages WHERE package_key = ?", [packageKey]);

            logAction(req, '删除工具服务', existing.name);
            res.json({ success: true });
        }));

        router.post('/mcp/servers/:id/refresh', authMiddleware, asyncHandler(async (req, res) => {
            const refreshTarget = String(req.params.id) === '0' ? null : (await getAccessibleMcpServer(req.params.id, req.user));
            if (refreshTarget?.user_id !== null && refreshTarget && Number(refreshTarget.user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: '共享工具仅允许使用，不允许刷新工具缓存。' });
            }
            if (String(req.params.id) === '0') {
                const tools = await filterMcpToolsByCapability(await listCachedMcpTools(0, req.user), req.user);
                logAction(req, '刷新本机虚拟工具', `mcp.0: ${tools.length}`);
                return res.json({ success: true, tools });
            }
            const server = await getAccessibleMcpServer(req.params.id, req.user);
            if (!server) return res.status(404).json({ error: '工具服务不存在。' });
            const tools = await refreshMcpTools(server, req.user);
            logAction(req, '刷新工具库工具', `${server.name}: ${tools.length}`);
            res.json({ success: true, tools });
        }));

        router.post('/mcp/servers/:id/diagnose', authMiddleware, asyncHandler(async (req, res) => {
            const diagnoseTarget = await getAccessibleMcpServer(req.params.id, req.user);
            if (diagnoseTarget?.user_id !== null && diagnoseTarget && Number(diagnoseTarget.user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: '共享工具仅允许使用，不允许执行配置诊断。' });
            }
            const server = await getAccessibleMcpServer(req.params.id, req.user);
            if (!server) return res.status(404).json({ error: '工具服务不存在。' });
            const baseUrl = String(server.base_url || '');
            const builtinType = getBuiltinServiceTypeFromUrl(baseUrl);
            if (baseUrl.startsWith('pivot-db://')) {
                const row = await queryOne('SELECT * FROM mcp_database_connections WHERE mcp_server_id = ?', [server.id]);
                if (!row) return res.status(404).json({ error: '服务器可访问数据库配置不存在。' });
                let connection = null;
                try {
                    connection = validateDatabaseConnectionPayload({
                        database_type: row.database_type,
                        host: row.host,
                        port: row.port,
                        database_name: row.database_name,
                        username: row.username,
                        password: decryptExistingDatabasePassword(row),
                        ...(parseServerConfig(row.options))
                    }, req.user);
                    const result = await testDatabaseConnection(connection);
                    return res.json({
                        success: true,
                        type: 'database',
                        result,
                        governance: {
                            tableAllowlist: connection.options.tableAllowlist || [],
                            fieldAllowlist: connection.options.fieldAllowlist || {},
                            sensitiveFields: connection.options.sensitiveFields || [],
                            rowPolicyHint: connection.options.rowPolicyHint || '',
                            queryTimeoutMs: connection.options.queryTimeoutMs || 20000,
                            sqlCostEstimate: connection.options.sqlCostEstimate !== false
                        }
                    });
                } catch (err) {
                    const fallbackConnection = connection || {
                        database_type: row.database_type,
                        host: row.host,
                        port: row.port,
                        database_name: row.database_name,
                        ...(parseServerConfig(row.options))
                    };
                    const failure = normalizeDatabaseConnectionError(err, fallbackConnection);
                    const status = failure.status || getDatabaseTestErrorStatus(err);
                    return res.status(status).json({
                        success: false,
                        type: 'database',
                        error: failure.message || 'Pivot 服务器无法访问该数据库地址。',
                        code: failure.code || err?.code || 'MCP_DATABASE_DIAGNOSE_FAILED',
                        detail: failure.detail || '',
                        hint: failure.hint || '请确认这是由 Pivot 服务器发起连接；localhost / 127.0.0.1 指 Pivot 服务器。',
                        diagnostics: failure.diagnostics || sanitizeDatabaseConnectionForLog(fallbackConnection)
                    });
                }
            }
            if (builtinType === 'reports') {
                const builtinConfig = await getBuiltinConfigForServerAsync(server.id);
                try {
                    const result = await executeBuiltinMcpTool(server, 'reports.list_files', {
                        limit: Math.min(Math.max(Number(req.body?.limit || 8), 1), 20)
                    }, req.user);
                    return res.json({
                        success: true,
                        type: 'reports',
                        readableFiles: Array.isArray(result.files) ? result.files.length : Number(result.count || 0),
                        previewFiles: result.files || result.rows || [],
                        diagnostics: {
                            roots: builtinConfig?.config?.roots || [],
                            hint: '如果预览为空，请确认 Pivot 服务进程对目录有读取权限。'
                        }
                    });
                } catch (err) {
                    const config = builtinConfig?.config || {};
                    const roots = Array.isArray(config.roots) ? config.roots : [];
                    const status = Number(err?.status || err?.statusCode || 0) || 400;
                    return res.status(status).json({
                        success: false,
                        type: 'reports',
                        error: 'Pivot 服务器无法读取该报表目录。',
                        code: err?.code || 'MCP_REPORTS_DIAGNOSE_FAILED',
                        detail: String(err?.message || '').slice(0, 500),
                        diagnostics: {
                            roots,
                            hint: '这里填写的是服务器路径或服务器可访问的共享目录；请确认 Pivot 服务进程有读取权限。'
                        }
                    });
                }
            }
            if (builtinType === 'im') {
                const action = String(req.body?.action || '').trim();
                let testResult = null;
                if (action === 'test') {
                    const target = String(req.body?.target || '').trim();
                    const message = String(req.body?.message || 'Pivot 工具库 IM 通知测试').slice(0, 1000);
                    testResult = await executeBuiltinMcpTool(server, 'im.send_markdown', {
                        target,
                        markdown: message
                    }, req.user);
                }
                const targets = await executeBuiltinMcpTool(server, 'im.list_allowed_targets', {}, req.user);
                const recent = await query(`
                    SELECT tool_name, status, duration_ms, error_message, created_at
                    FROM mcp_call_logs
                    WHERE server_id = ?
                    ORDER BY created_at DESC, id DESC
                    LIMIT 8
                `, [server.id]);
                return res.json({
                    success: true,
                    type: 'im',
                    targets,
                    testResult,
                    recentDeliveries: recent,
                    retryHint: '发送失败时可检查目标白名单、Webhook 地址和认证密钥；修正后可再次测试发送。'
                });
            }
            const config = parseServerConfig(server.config);
            const healthUrl = String(config.healthCheckUrl || '').trim();
            if (!healthUrl) {
                return res.json({
                    success: true,
                    type: builtinType || 'external',
                    status: 'not_configured',
                    message: '未配置健康检查 URL。'
                });
            }
            const startedAt = Date.now();
            const response = await safeJsonGet(healthUrl, {
                user: req.user,
                assertUrl: (targetUrl, targetUser) => assertSafeMcpOutboundUrl(targetUrl, targetUser),
                timeout: Math.max(1000, Math.min(Number(config.timeoutMs || 20000) || 20000, 120000)),
                agentOptions: {
                    allowPrivateEnv: 'ALLOW_PRIVATE_MCP_URLS',
                    allowExplicitLoopbackForAdmin: true
                },
                validateStatus: () => true
            });
            res.json({
                success: response.status >= 200 && response.status < 400,
                type: 'external',
                statusCode: response.status,
                durationMs: Date.now() - startedAt,
                healthCheckUrl: healthUrl
            });
        }));
}

module.exports = { mountMcpConfigurationRoutes };
