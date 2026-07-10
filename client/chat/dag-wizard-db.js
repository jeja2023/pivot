/* DAG 输入向导数据库辅助函数（拆自 dag-wizard-input.js） */


        const normalizeWizardTools = (toolsOrResolver = []) => {
            if (Array.isArray(toolsOrResolver)) return toolsOrResolver;
            if (typeof toolsOrResolver === 'function') return toolsOrResolver() || [];
            return [];
        };

        const databaseWizardConnections = (toolsOrResolver = []) => {
            const tools = normalizeWizardTools(toolsOrResolver);
            const entries = new Map();
            tools.forEach(tool => {
                const shortName = toolShortName(tool);
                if (!shortName.startsWith('db.')) return;
                databaseConnectionsFromTool(tool).forEach(connection => {
                    const serverId = String(connection.connectionId ?? connection.serverId ?? '').trim();
                    if (!serverId) return;
                    const entry = entries.get(serverId) || {
                        serverId,
                        serverName: connection.serverName || tool.serverName || `数据库 ${serverId}`,
                        databaseType: connection.databaseType || '',
                        tools: {}
                    };
                    entry.tools[shortName] = {
                        ...tool,
                        fullName: connection.fullName || toolValue(tool),
                        serverId,
                        connectionId: serverId,
                        serverName: connection.serverName || tool.serverName || entry.serverName,
                        databaseType: connection.databaseType || tool.databaseType || ''
                    };
                    entries.set(serverId, entry);
                });
            });
            return [...entries.values()]
                .filter(entry => Object.keys(entry.tools || {}).length)
                .sort((a, b) => a.serverName.localeCompare(b.serverName, 'zh-Hans-CN'));
        };

        const databaseToolConnectionOptions = (tool, toolsOrResolver = []) => {
            const direct = databaseConnectionsFromTool(tool);
            if (direct.length) return direct;
            const serverId = mcpServerIdFromTool(tool);
            if (!serverId) return [];
            const entry = databaseWizardConnections(toolsOrResolver).find(item => item.serverId === serverId);
            return entry ? [{
                serverId: entry.serverId,
                connectionId: entry.serverId,
                serverName: entry.serverName,
                databaseType: entry.databaseType || '',
                fullName: entry.tools?.[toolShortName(tool)]?.fullName || toolValue(tool)
            }] : [];
        };

        const databaseConnectionInputValue = (input = {}) => String(
            input?.connectionId
            ?? input?.connection_id
            ?? input?.databaseConnectionId
            ?? input?.database_connection_id
            ?? input?.mcpServerId
            ?? input?.mcp_server_id
            ?? ''
        ).trim();

        const selectedDatabaseConnectionId = (tool, input = {}, toolsOrResolver = []) => {
            const options = databaseToolConnectionOptions(tool, toolsOrResolver);
            const explicit = databaseConnectionInputValue(input);
            if (explicit && options.some(item => String(item.connectionId ?? item.serverId ?? '') === explicit)) return explicit;
            return String(options[0]?.connectionId ?? options[0]?.serverId ?? explicit ?? '');
        };

        const databaseConnectionLabel = (tool, serverId, toolsOrResolver = []) => {
            const option = databaseToolConnectionOptions(tool, toolsOrResolver).find(item => String(item.connectionId ?? item.serverId ?? '') === String(serverId ?? ''));
            if (!option) return String(serverId ?? '') || '未选择';
            return [option.serverName || `数据库 ${option.serverId}`, option.databaseType].filter(Boolean).join(' · ');
        };

        const callWizardTool = async (tool, input = {}) => {
            if (!tool) throw new Error('工具不可用。');
            const res = await apiFetch(`${API_BASE}/mcp/tools/call`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: toolValue(tool), input })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || '工具调用失败。');
            return data.result?.structuredContent ?? data.result;
        };
