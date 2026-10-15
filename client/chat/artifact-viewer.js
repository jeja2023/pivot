/**
 * Pivot ArtifactViewer (交互空间主视图控制器)
 * 类似 Claude Artifacts 的多模态产物交互空间与版本协同工作区
 */

(function () {
    class ArtifactViewer {
        constructor() {
            this.modalEl = null;
            this.drawerEl = null;
            this.currentArtifact = null;
            this.activeTab = 'preview';
            this.isFullscreen = false;
            this.renderer = new window.Pivot.ArtifactRenderer();
            this.initDOM();
        }

        /**
         * 初始化交互空间 DOM 结构
         */
        initDOM() {
            if (document.getElementById('pivot-artifact-modal-overlay')) {
                this.modalEl = document.getElementById('pivot-artifact-modal-overlay');
                this.drawerEl = this.modalEl.querySelector('.pivot-artifact-drawer');
                return;
            }

            const overlay = document.createElement('div');
            overlay.id = 'pivot-artifact-modal-overlay';
            overlay.className = 'pivot-artifact-modal-overlay';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');

            PivotSafeHtml.setHtml(overlay, `
                <div class="pivot-artifact-drawer">
                    <!-- 头部工具栏 -->
                    <div class="pivot-artifact-header">
                        <div class="pivot-artifact-header-left">
                            <div class="pivot-artifact-header-icon">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                            </div>
                            <div class="pivot-artifact-header-titles">
                                <h3 class="pivot-artifact-header-title" id="pivot-artifact-header-title">产物交互空间</h3>
                                <div class="pivot-artifact-header-meta">
                                    <span class="pivot-artifact-version-pill" id="pivot-artifact-version-pill">v1</span>
                                    <span id="pivot-artifact-type-label">HTML</span>
                                    <span id="pivot-artifact-time-label">刚刚更新</span>
                                </div>
                            </div>
                        </div>

                        <!-- 导航 Tabs -->
                        <div class="pivot-artifact-tabs">
                            <button type="button" class="pivot-artifact-tab-btn active" data-tab="preview">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                                <span>预览</span>
                            </button>
                            <button type="button" class="pivot-artifact-tab-btn" data-tab="source">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                                <span>源码</span>
                            </button>
                            <button type="button" class="pivot-artifact-tab-btn" data-tab="versions">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>
                                <span>版本</span>
                            </button>
                            <button type="button" class="pivot-artifact-tab-btn" data-tab="comments">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                                <span>讨论</span>
                            </button>
                        </div>

                        <!-- 快捷操作按钮 -->
                        <div class="pivot-artifact-header-actions">
                            <button type="button" class="pivot-artifact-icon-btn" id="pivot-artifact-action-share" title="分享产物">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
                            </button>
                            <button type="button" class="pivot-artifact-icon-btn" id="pivot-artifact-action-fullscreen" title="全屏切换">
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
                            </button>
                            <button type="button" class="pivot-artifact-icon-btn pivot-artifact-close-btn" id="pivot-artifact-action-close" title="关闭 (Esc)">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>
                    </div>

                    <!-- 视图内容区域 -->
                    <div class="pivot-artifact-body">
                        <!-- 1. 预览 Tab -->
                        <div class="pivot-artifact-tab-pane active" id="pivot-artifact-pane-preview"></div>

                        <!-- 2. 源码 Tab -->
                        <div class="pivot-artifact-tab-pane" id="pivot-artifact-pane-source">
                            <div class="pivot-artifact-source-view">
                                <div class="pivot-artifact-source-toolbar">
                                    <span>编辑当前内容并保存新版本</span>
                                    <button type="button" class="pivot-artifact-action-btn" id="pivot-artifact-btn-save-version">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
                                        <span>保存为新版本</span>
                                    </button>
                                </div>
                                <textarea class="pivot-artifact-source-textarea" id="pivot-artifact-source-editor" spellcheck="false"></textarea>
                            </div>
                        </div>

                        <!-- 3. 版本历史 Tab -->
                        <div class="pivot-artifact-tab-pane" id="pivot-artifact-pane-versions">
                            <div class="pivot-artifact-versions-view" id="pivot-artifact-versions-container">
                                <div style="color: #94a3b8; text-align: center; padding: 40px;">正在加载版本历史...</div>
                            </div>
                        </div>

                        <!-- 4. 评论与讨论 Tab -->
                        <div class="pivot-artifact-tab-pane" id="pivot-artifact-pane-comments">
                            <div class="pivot-artifact-comments-view">
                                <div class="pivot-artifact-comments-list" id="pivot-artifact-comments-list">
                                    <div style="color: #94a3b8; text-align: center; padding: 40px;">暂无讨论</div>
                                </div>
                                <form class="pivot-artifact-comment-form" id="pivot-artifact-comment-form">
                                    <input type="text" class="pivot-artifact-comment-input" id="pivot-artifact-comment-input" placeholder="发表评论或修改批注..." autocomplete="off">
                                    <button type="submit" class="pivot-artifact-action-btn" style="background:#0284c7;color:#fff;border-color:#38bdf8;">发送</button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>
            `);

            document.body.appendChild(overlay);
            this.modalEl = overlay;
            this.drawerEl = overlay.querySelector('.pivot-artifact-drawer');

            // 事件绑定
            this.bindEvents();
        }

        /**
         * 绑定各种视图交互事件
         */
        bindEvents() {
            // 点击遮罩外部关闭
            this.modalEl.addEventListener('click', (e) => {
                if (e.target === this.modalEl) {
                    this.close();
                }
            });

            // 关闭按钮
            const closeBtn = this.modalEl.querySelector('#pivot-artifact-action-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this.close());
            }

            // Esc 键关闭
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.modalEl.classList.contains('active')) {
                    this.close();
                }
            });

            // 全屏切换
            const fsBtn = this.modalEl.querySelector('#pivot-artifact-action-fullscreen');
            if (fsBtn) {
                fsBtn.addEventListener('click', () => {
                    this.isFullscreen = !this.isFullscreen;
                    this.drawerEl.classList.toggle('fullscreen', this.isFullscreen);
                });
            }

            // 分享按钮
            const shareBtn = this.modalEl.querySelector('#pivot-artifact-action-share');
            if (shareBtn) {
                shareBtn.addEventListener('click', () => this.handleShare());
            }

            // Tab 切换
            const tabBtns = this.modalEl.querySelectorAll('.pivot-artifact-tab-btn');
            tabBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    const tab = btn.dataset.tab;
                    this.switchTab(tab);
                });
            });

            // 保存新版本
            const saveBtn = this.modalEl.querySelector('#pivot-artifact-btn-save-version');
            if (saveBtn) {
                saveBtn.addEventListener('click', () => this.handleSaveVersion());
            }

            // 评论表单提交
            const commentForm = this.modalEl.querySelector('#pivot-artifact-comment-form');
            if (commentForm) {
                commentForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.handleAddComment();
                });
            }
        }

        /**
         * 切换 Tab
         */
        switchTab(tabName) {
            this.activeTab = tabName;

            // 更新 Tab 按钮状态
            const tabBtns = this.modalEl.querySelectorAll('.pivot-artifact-tab-btn');
            tabBtns.forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tabName);
            });

            // 更新面板状态
            const panes = this.modalEl.querySelectorAll('.pivot-artifact-tab-pane');
            panes.forEach(pane => {
                pane.classList.toggle('active', pane.id === `pivot-artifact-pane-${tabName}`);
            });

            // 加载对应数据
            if (tabName === 'source') {
                const editor = this.modalEl.querySelector('#pivot-artifact-source-editor');
                if (editor && this.currentArtifact) {
                    editor.value = this.currentArtifact.content || '';
                }
            } else if (tabName === 'versions') {
                this.loadVersions();
            } else if (tabName === 'comments') {
                this.loadComments();
            }
        }

        /**
         * 打开指定 Artifact
         * @param {string} artifactId 产物 UUID
         */
        async open(artifactId) {
            this.initDOM();
            this.modalEl.classList.add('active');
            this.switchTab('preview');

            const titleEl = this.modalEl.querySelector('#pivot-artifact-header-title');
            titleEl.textContent = '正在加载产物...';

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(artifactId)}`)
                    : fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`));
                
                const data = await res.json();
                if (!res.ok || !data.success) {
                    throw new Error(data.error || '获取产物失败');
                }

                this.setArtifact(data.data);
            } catch (err) {
                console.error('加载 Artifact 失败:', err);
                const previewPane = this.modalEl.querySelector('#pivot-artifact-pane-preview');
                PivotSafeHtml.setHtml(previewPane, `
                    <div class="pivot-artifact-error-box">
                        <div class="pivot-artifact-error-title">加载失败</div>
                        <div>${this.escapeHtml(err.message || '无法获取产物数据')}</div>
                    </div>
                `);
            }
        }

        /**
         * 直接用数据对象打开预览（免接口先览）
         */
        openPreview(artifactData) {
            this.initDOM();
            this.modalEl.classList.add('active');
            this.setArtifact(artifactData);
            this.switchTab('preview');
        }

        /**
         * 设置并渲染产物
         */
        setArtifact(artifact) {
            this.currentArtifact = artifact;

            const titleEl = this.modalEl.querySelector('#pivot-artifact-header-title');
            const versionPill = this.modalEl.querySelector('#pivot-artifact-version-pill');
            const typeLabel = this.modalEl.querySelector('#pivot-artifact-type-label');
            const timeLabel = this.modalEl.querySelector('#pivot-artifact-time-label');

            if (titleEl) titleEl.textContent = artifact.title || '交互产物';
            if (versionPill) versionPill.textContent = `v${artifact.version || 1}`;
            if (typeLabel) typeLabel.textContent = (artifact.type || 'HTML').toUpperCase();
            if (timeLabel) timeLabel.textContent = artifact.updated_at ? new Date(artifact.updated_at).toLocaleTimeString() : '刚刚';

            // 渲染预览
            const previewPane = this.modalEl.querySelector('#pivot-artifact-pane-preview');
            this.renderer.render(previewPane, artifact, { showToolbar: true });
        }

        /**
         * 关闭视图
         */
        close() {
            if (this.modalEl) {
                this.modalEl.classList.remove('active');
            }
        }

        /**
         * 保存新版本
         */
        async handleSaveVersion() {
            if (!this.currentArtifact || !this.currentArtifact.id) {
                if (typeof showToast === 'function') showToast('当前为临时预览，无法保存版本', 'warning');
                return;
            }

            const editor = this.modalEl.querySelector('#pivot-artifact-source-editor');
            const newContent = editor.value;

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: newContent })
                    })
                    : fetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: newContent })
                    }));

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || '保存失败');

                if (typeof showToast === 'function') showToast('已保存为新版本', 'success');
                this.setArtifact(data.data);
                this.switchTab('preview');
            } catch (err) {
                console.error('保存新版本失败:', err);
                if (typeof showToast === 'function') showToast(err.message, 'error');
            }
        }

        /**
         * 加载历史版本
         */
        async loadVersions() {
            if (!this.currentArtifact || !this.currentArtifact.id) return;
            const container = this.modalEl.querySelector('#pivot-artifact-versions-container');
            PivotSafeHtml.setHtml(container, '<div class="pivot-artifact-placeholder">正在获取版本列表...</div>');

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/versions`)
                    : fetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/versions`));

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || '加载版本失败');

                const versions = data.data || [];
                if (!versions.length) {
                    PivotSafeHtml.setHtml(container, '<div class="pivot-artifact-placeholder">暂无历史修订版本</div>');
                    return;
                }

                PivotSafeHtml.setHtml(container, versions.map(v => `
                    <div class="pivot-artifact-version-card">
                        <div class="pivot-artifact-version-info">
                            <span class="pivot-artifact-version-tag">版本 v${v.version}</span>
                            <span class="pivot-artifact-version-time">${new Date(v.created_at).toLocaleString()}</span>
                        </div>
                        <div class="pivot-artifact-version-actions">
                            <button type="button" class="pivot-artifact-action-btn" data-restore-version="${v.version}">
                                回滚至此版本
                            </button>
                        </div>
                    </div>
                `).join(''));

                container.querySelectorAll('[data-restore-version]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const ver = btn.dataset.restoreVersion;
                        this.restoreVersion(ver);
                    });
                });
            } catch (err) {
                PivotSafeHtml.setHtml(container, `<div class="pivot-artifact-error">${this.escapeHtml(err.message)}</div>`);
            }
        }

        /**
         * 回滚到指定版本
         */
        async restoreVersion(verNum) {
            if (!confirm(`确定要回滚到版本 v${verNum} 吗？当前最新内容将自动归档。`)) return;

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/restore`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ version: verNum })
                    })
                    : fetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/restore`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ version: verNum })
                    }));

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || '回滚失败');

                if (typeof showToast === 'function') showToast(`已成功恢复至版本 v${verNum}`, 'success');
                this.setArtifact(data.data);
                this.switchTab('preview');
            } catch (err) {
                console.error('回滚版本失败:', err);
                if (typeof showToast === 'function') showToast(err.message, 'error');
            }
        }

        /**
         * 加载评论与讨论
         */
        async loadComments() {
            if (!this.currentArtifact || !this.currentArtifact.id) return;
            const list = this.modalEl.querySelector('#pivot-artifact-comments-list');
            PivotSafeHtml.setHtml(list, '<div class="pivot-artifact-placeholder">正在获取讨论记录...</div>');

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/comments`)
                    : fetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/comments`));

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || '加载评论失败');

                const comments = data.data || [];
                if (!comments.length) {
                    PivotSafeHtml.setHtml(list, '<div class="pivot-artifact-placeholder">暂无评论讨论，来发表第一条观点吧</div>');
                    return;
                }

                PivotSafeHtml.setHtml(list, comments.map(c => `
                    <div class="pivot-artifact-comment-item">
                        <div class="pivot-artifact-comment-header">
                            <span class="pivot-artifact-comment-author">${this.escapeHtml(c.nickname || c.username || '用户')}</span>
                            <span class="pivot-artifact-comment-time">${new Date(c.created_at).toLocaleString()}</span>
                        </div>
                        <div class="pivot-artifact-comment-content">${this.escapeHtml(c.content)}</div>
                    </div>
                `).join(''));
            } catch (err) {
                PivotSafeHtml.setHtml(list, `<div class="pivot-artifact-error">${this.escapeHtml(err.message)}</div>`);
            }
        }

        /**
         * 添加评论
         */
        async handleAddComment() {
            if (!this.currentArtifact || !this.currentArtifact.id) return;
            const input = this.modalEl.querySelector('#pivot-artifact-comment-input');
            const content = input.value.trim();
            if (!content) return;

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/comments`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content })
                    })
                    : fetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/comments`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content })
                    }));

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || '发送评论失败');

                input.value = '';
                await this.loadComments();
            } catch (err) {
                console.error('发送评论失败:', err);
                if (typeof showToast === 'function') showToast(err.message, 'error');
            }
        }

        /**
         * 分享链接生成
         */
        async handleShare() {
            if (!this.currentArtifact || !this.currentArtifact.id) {
                if (typeof showToast === 'function') showToast('当前为临时预览，无法创建分享链接', 'warning');
                return;
            }

            try {
                const res = await (typeof apiFetch === 'function'
                    ? apiFetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/share`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ visibility: 'public', expiresIn: 7 * 86400 })
                    })
                    : fetch(`/api/artifacts/${encodeURIComponent(this.currentArtifact.id)}/share`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ visibility: 'public', expiresIn: 7 * 86400 })
                    }));

                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || '创建分享链接失败');

                const shareUrl = `${window.location.origin}${data.data.shareUrl}`;
                await navigator.clipboard.writeText(shareUrl);
                if (typeof showToast === 'function') {
                    showToast('公开分享链接已生成并复制到剪贴板！', 'success');
                }
            } catch (err) {
                console.error('分享失败:', err);
                if (typeof showToast === 'function') showToast(err.message, 'error');
            }
        }

        escapeHtml(str) {
            return String(str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }
    }

    // 单例与全局快捷 API
    const viewerInstance = new ArtifactViewer();
    if (typeof window !== 'undefined' && window.Pivot) {
        window.Pivot.ArtifactViewer = viewerInstance;
        window.Pivot.openArtifact = (id) => viewerInstance.open(id);
        window.Pivot.openArtifactPreview = (data) => viewerInstance.openPreview(data);

        /**
         * 辅助函数：在对话中渲染产物卡片
         */
        window.Pivot.createArtifactCard = function (artifact) {
        const card = document.createElement('div');
        card.className = 'pivot-artifact-chat-card';
        PivotSafeHtml.setHtml(card, `
            <div class="pivot-artifact-card-left">
                <div class="pivot-artifact-card-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
                </div>
                <div>
                    <div class="pivot-artifact-card-title">${viewerInstance.escapeHtml(artifact.title || '交互空间产物')}</div>
                    <div class="pivot-artifact-card-type">${viewerInstance.escapeHtml(artifact.type || 'HTML').toUpperCase()} · 点击在右侧交互空间中打开</div>
                </div>
            </div>
            <button type="button" class="pivot-artifact-card-btn">
                <span>进入交互空间</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
            </button>
        `);

        card.addEventListener('click', () => {
            if (artifact.id) {
                viewerInstance.open(artifact.id);
            } else {
                viewerInstance.openPreview(artifact);
            }
        });

        return card;
    };
    }
})();
