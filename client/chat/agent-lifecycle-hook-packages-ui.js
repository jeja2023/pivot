/* 生命周期 Hook 治理面板：包导入在服务端验签，网页只呈现已授权的元数据与审计。 */
(function () {
    function create({ state, escape, escapeAttr, setMarkup, setNotice, formatDate, apiJson, canManage } = {}) {
        const statusLabel = value => ({ active: '已生效', enabled: '已启用', disabled: '已停用', revoked: '已吊销', succeeded: '成功', failed: '失败', observe: '观察', deny: '拒绝', error_open: '开放失败', skipped_scope: '范围不足' })[String(value || '')] || String(value || '-');
        const packagesAllowed = () => typeof canManage === 'function' && canManage();

        function renderHooks() {
            const target = document.getElementById('agent-lifecycle-hooks-list');
            if (!target) return;
            const hooks = Array.isArray(state.lifecycleHooks) ? state.lifecycleHooks : [];
            setMarkup(target, hooks.length ? `<div class="aht-wrap"><table class="aht data-table"><thead><tr><th>名称</th><th>事件</th><th>阶段</th><th class="tc">顺序</th><th>失败策略</th><th>签名</th><th>状态</th></tr></thead><tbody>${hooks.map(hook => `<tr><td><strong>${escape(hook.hookName || '-')}</strong><small>${escape(`${hook.packageId || 'platform'}@${hook.packageVersion || '1'}`)}</small></td><td>${escape(hook.eventType || '-')}</td><td>${escape(hook.phase || '-')}</td><td class="tc">${Number(hook.priority || 0)}</td><td>${escape(hook.failurePolicy || '-')}</td><td>${hook.signatureVerified ? '<span class="agent-inbox-type-badge badge-run">已验证</span>' : '<span class="agent-inbox-type-badge badge-approval">未验证</span>'}</td><td>${hook.status === 'enabled' ? '<span class="agent-inbox-type-badge badge-run">已启用</span>' : '<span class="agent-inbox-type-badge badge-event">已停用</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="agent-harness-empty-card"><strong>暂无已登记的生命周期 Hook</strong><span>Hook 必须以已验证的签名清单发布后才能启用。</span></div>');
        }

        function renderPackages() {
            const target = document.getElementById('agent-lifecycle-hook-packages');
            const importer = document.getElementById('agent-lifecycle-hook-package-import');
            if (importer) { importer.hidden = !packagesAllowed(); if (!packagesAllowed()) importer.open = false; }
            if (!target) return;
            const packages = Array.isArray(state.lifecycleHookPackages) ? state.lifecycleHookPackages : [];
            setMarkup(target, packagesAllowed()
                ? (packages.length ? `<div class="aht-wrap"><table class="aht data-table"><thead><tr><th>包</th><th>签名密钥</th><th>清单摘要</th><th>状态</th><th>导入时间</th><th>操作</th></tr></thead><tbody>${packages.map(item => { const next = item.status === 'active' ? 'disabled' : item.status === 'disabled' ? 'active' : ''; return `<tr><td><strong>${escape(item.packageId || '-')}</strong><small>${escape(item.packageVersion || '-')}</small></td><td>${escape(item.signatureKeyId || '-')}</td><td><code>${escape(String(item.manifestDigest || '-').slice(0, 16))}</code></td><td>${escape(statusLabel(item.status))}</td><td>${escape(formatDate(item.importedAt))}</td><td>${next ? `<button class="btn-secondary btn-xs" type="button" data-agent-hook-package-status="${escapeAttr(next)}" data-agent-hook-package-id="${escapeAttr(item.packageId)}" data-agent-hook-package-version="${escapeAttr(item.packageVersion)}">${next === 'disabled' ? '停用' : '恢复'}</button>` : '<span>已吊销</span>'}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="agent-harness-empty-card"><strong>暂无受管 Hook 包</strong><span>可通过受保护的导入 API 登记经组织签名验证的声明式包。</span></div>')
                : '<div class="agent-harness-empty-card"><strong>受管 Hook 包仅对系统管理员可见</strong><span>当前用户仍可查看自己有权使用的 Hook 与脱敏调用审计。</span></div>');
        }

        function renderAudits() {
            const target = document.getElementById('agent-lifecycle-hook-audits');
            if (!target) return;
            const audits = Array.isArray(state.lifecycleHookAudits) ? state.lifecycleHookAudits : [];
            setMarkup(target, audits.length ? `<div class="aht-wrap"><table class="aht data-table"><thead><tr><th>时间</th><th>事件</th><th>阶段</th><th>决策</th><th>结果</th><th>耗时</th><th>运行 / 摘要</th></tr></thead><tbody>${audits.slice(0, 50).map(item => `<tr><td>${escape(formatDate(item.createdAt))}</td><td>${escape(item.eventType || '-')}</td><td>${escape(item.phase || '-')}</td><td>${escape(statusLabel(item.decision))}</td><td>${escape(statusLabel(item.outcome))}</td><td>${Number(item.durationMs || 0)} ms</td><td>${escape(String(item.runId || '-').slice(0, 12))} · ${escape(String(item.payloadFingerprint || '-').slice(0, 12))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="agent-harness-empty-card"><strong>暂无 Hook 调用审计</strong><span>启用的 Hook 在对应生命周期事件发生后会记录脱敏审计。</span></div>');
        }

        function render() { renderHooks(); renderPackages(); renderAudits(); }

        async function load() {
            const [hooks, audits, packages] = await Promise.all([
                apiJson(`${API_BASE}/agents/lifecycle-hooks`, { cache: 'no-store' }),
                apiJson(`${API_BASE}/agents/lifecycle-hooks/audits?limit=50`, { cache: 'no-store' }),
                packagesAllowed() ? apiJson(`${API_BASE}/agents/lifecycle-hook-packages?limit=100`, { cache: 'no-store' }).catch(() => ({ data: [] })) : Promise.resolve({ data: [] })
            ]);
            state.lifecycleHooks = Array.isArray(hooks.data) ? hooks.data : [];
            state.lifecycleHookPackages = Array.isArray(packages.data) ? packages.data : [];
            state.lifecycleHookAudits = Array.isArray(audits.data) ? audits.data : [];
            render();
            return { hooks: state.lifecycleHooks, packages: state.lifecycleHookPackages, audits: state.lifecycleHookAudits };
        }

        async function setPackageStatus(button) {
            const packageId = String(button?.dataset.agentHookPackageId || '');
            const packageVersion = String(button?.dataset.agentHookPackageVersion || '');
            const status = String(button?.dataset.agentHookPackageStatus || '');
            if (!packageId || !packageVersion || !['active', 'disabled'].includes(status)) return;
            button.disabled = true;
            try {
                await apiJson(`${API_BASE}/agents/lifecycle-hook-packages/${encodeURIComponent(packageId)}/${encodeURIComponent(packageVersion)}/status`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
                });
                await load();
                setNotice?.(status === 'disabled' ? '受管 Hook 包已停用。' : '受管 Hook 包已恢复。', 'success');
            } catch (error) { setNotice?.(error.message || '更新 Hook 包状态失败。', 'error'); }
            finally { button.disabled = false; }
        }

        async function importPackage(button) {
            const manifestText = String(document.getElementById('agent-lifecycle-hook-package-manifest')?.value || '').trim();
            const signature = String(document.getElementById('agent-lifecycle-hook-package-signature')?.value || '').trim();
            const keyId = String(document.getElementById('agent-lifecycle-hook-package-key-id')?.value || '').trim();
            if (!manifestText || !signature) return setNotice?.('请填写规范化包清单和组织签名。', 'error');
            let manifest;
            try { manifest = JSON.parse(manifestText); } catch (_) { return setNotice?.('Hook 包清单必须是有效 JSON。', 'error'); }
            button.disabled = true;
            try {
                await apiJson(`${API_BASE}/agents/lifecycle-hook-packages/import`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest, signature: { keyId, signature } })
                });
                document.getElementById('agent-lifecycle-hook-package-manifest').value = '';
                document.getElementById('agent-lifecycle-hook-package-signature').value = '';
                document.getElementById('agent-lifecycle-hook-package-import').open = false;
                await load();
                setNotice?.('受管 Hook 包已通过签名验证并导入。', 'success');
            } catch (error) { setNotice?.(error.message || '导入受管 Hook 包失败。', 'error'); }
            finally { button.disabled = false; }
        }

        function bindControls() {
            const packagesTarget = document.getElementById('agent-lifecycle-hook-packages');
            if (!packagesTarget || packagesTarget.dataset.hookPackageControlsBound === 'true') return;
            packagesTarget.dataset.hookPackageControlsBound = 'true';
            packagesTarget.addEventListener('click', event => {
                const button = event.target.closest('[data-agent-hook-package-status]');
                if (button && packagesAllowed()) setPackageStatus(button);
            });
            document.getElementById('agent-lifecycle-hook-package-import-submit')?.addEventListener('click', event => {
                if (packagesAllowed()) importPackage(event.currentTarget);
            });
        }

        return { bindControls, load, render };
    }

    window.Pivot?.exposeModule?.('agent.lifecycleHookPackages', { create });
})();
