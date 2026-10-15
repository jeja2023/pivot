/**
 * Pivot ArtifactRenderer (多模态产物渲染器)
 * 具备多模态产物渲染能力（HTML、React、Vue、Markdown、Code、Chart、Diagram）
 * 提供安全的 iframe 隔离沙箱与自适应视口
 */

(function () {
    window.Pivot = window.Pivot || {};

    class ArtifactRenderer {
        constructor() {
            this.container = null;
            this.currentArtifact = null;
        }

        /**
         * 渲染产物到指定 DOM 容器
         * @param {HTMLElement|string} target 容器元素或选择器
         * @param {Object} artifact 产物数据对象
         * @param {Object} options 渲染选项
         */
        render(target, artifact, options = {}) {
            const container = typeof target === 'string' ? document.querySelector(target) : target;
            if (!container) {
                console.error('[ArtifactRenderer] 找不到目标容器:', target);
                return;
            }

            this.container = container;
            this.currentArtifact = artifact;
            const { type = 'html', content = '', title = '未命名产物' } = artifact;
            const showToolbar = options.showToolbar !== false;

            // 清空容器
            container.innerHTML = '';
            container.classList.add('pivot-artifact-render-container');

            // 1. 构建顶部小工具栏
            if (showToolbar) {
                const toolbar = document.createElement('div');
                toolbar.className = 'pivot-artifact-render-toolbar';

                const badgeClass = `pivot-artifact-badge pivot-artifact-badge-${type.toLowerCase()}`;
                toolbar.innerHTML = `
                    <div class="pivot-artifact-render-info">
                        <span class="${badgeClass}">${this.escapeHtml(type)}</span>
                        <span class="pivot-artifact-meta-text">${this.escapeHtml(title)}</span>
                    </div>
                    <div class="pivot-artifact-render-actions">
                        <button type="button" class="pivot-artifact-action-btn" id="pivot-artifact-btn-copy" title="复制内容">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            <span>复制</span>
                        </button>
                        <button type="button" class="pivot-artifact-action-btn" id="pivot-artifact-btn-download" title="下载产物文件">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            <span>下载</span>
                        </button>
                    </div>
                `;

                // 绑定复制与下载
                const copyBtn = toolbar.querySelector('#pivot-artifact-btn-copy');
                if (copyBtn) {
                    copyBtn.addEventListener('click', () => this.copyContent(content, copyBtn));
                }

                const downloadBtn = toolbar.querySelector('#pivot-artifact-btn-download');
                if (downloadBtn) {
                    downloadBtn.addEventListener('click', () => this.downloadContent(artifact));
                }

                container.appendChild(toolbar);
            }

            // 2. 构建视口
            const viewport = document.createElement('div');
            viewport.className = 'pivot-artifact-viewport';
            container.appendChild(viewport);

            // 3. 根据类型分发渲染
            switch (type.toLowerCase()) {
                case 'html':
                    this.renderHtmlSandbox(viewport, content);
                    break;
                case 'react':
                    this.renderReactSandbox(viewport, content);
                    break;
                case 'vue':
                    this.renderVueSandbox(viewport, content);
                    break;
                case 'markdown':
                    this.renderMarkdown(viewport, content);
                    break;
                case 'code':
                    this.renderCode(viewport, content, artifact.metadata?.language || 'text');
                    break;
                case 'chart':
                case 'diagram':
                    this.renderDiagram(viewport, content);
                    break;
                default:
                    this.renderHtmlSandbox(viewport, content);
                    break;
            }
        }

        /**
         * 渲染 HTML 沙箱 (iframe 隔离)
         */
        renderHtmlSandbox(viewport, htmlContent) {
            const iframeContainer = document.createElement('div');
            iframeContainer.className = 'pivot-artifact-iframe-container';

            const loading = document.createElement('div');
            loading.className = 'pivot-artifact-iframe-loading';
            loading.innerHTML = '<div class="pivot-artifact-spinner"></div><span>正在加载交互沙箱...</span>';
            iframeContainer.appendChild(loading);

            const iframe = document.createElement('iframe');
            iframe.className = 'pivot-artifact-iframe';
            // 安全沙箱限制：允许脚本运行，防止顶级跳转与破坏父窗体
            iframe.setAttribute('sandbox', 'allow-scripts allow-modals allow-forms');

            // 包装完整的 HTML 文档
            let fullDoc = htmlContent.trim();
            if (!fullDoc.toLowerCase().startsWith('<!doctype') && !fullDoc.toLowerCase().startsWith('<html')) {
                fullDoc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1e293b;
      background: #ffffff;
      box-sizing: border-box;
    }
  </style>
</head>
<body>
  ${htmlContent}
</body>
</html>`;
            }

            iframe.srcdoc = fullDoc;
            iframe.onload = () => {
                loading.style.opacity = '0';
                setTimeout(() => loading.remove(), 250);
            };

            iframeContainer.appendChild(iframe);
            viewport.appendChild(iframeContainer);
        }

        /**
         * 渲染 React 沙箱 (纯离线生产环境，无互联网依赖)
         */
        renderReactSandbox(viewport, reactCode) {
            if (/<html[\s>]|<script[\s>]|<body[\s>]/i.test(reactCode)) {
                this.renderHtmlSandbox(viewport, reactCode);
                return;
            }
            this.renderCode(viewport, reactCode, 'jsx');
        }

        /**
         * 渲染 Vue 沙箱 (纯离线生产环境，无互联网依赖)
         */
        renderVueSandbox(viewport, vueCode) {
            if (/<html[\s>]|<script[\s>]|<body[\s>]/i.test(vueCode)) {
                this.renderHtmlSandbox(viewport, vueCode);
                return;
            }
            this.renderCode(viewport, vueCode, 'html');
        }

        /**
         * 渲染 Markdown
         */
        renderMarkdown(viewport, markdownContent) {
            const mdContainer = document.createElement('div');
            mdContainer.className = 'pivot-artifact-markdown-view';

            let html = '';
            if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
                html = DOMPurify.sanitize(marked.parse(markdownContent));
            } else if (typeof marked !== 'undefined') {
                html = marked.parse(markdownContent);
            } else {
                html = `<pre style="white-space: pre-wrap;">${this.escapeHtml(markdownContent)}</pre>`;
            }

            mdContainer.innerHTML = html;
            viewport.appendChild(mdContainer);
        }

        /**
         * 渲染代码
         */
        renderCode(viewport, codeContent, language = 'text') {
            const codeContainer = document.createElement('div');
            codeContainer.className = 'pivot-artifact-code-view';

            const lines = codeContent.split('\n');
            const linesHtml = lines.map((line, idx) => {
                return `<span class="pivot-artifact-code-line"><span class="pivot-artifact-code-lineno">${idx + 1}</span>${this.escapeHtml(line)}</span>`;
            }).join('');

            codeContainer.innerHTML = `<pre class="pivot-artifact-code-pre"><code>${linesHtml}</code></pre>`;
            viewport.appendChild(codeContainer);
        }

        /**
         * 渲染图表或 SVG / 流程图
         */
        renderDiagram(viewport, content) {
            const trimmed = content.trim();
            const diagramContainer = document.createElement('div');
            diagramContainer.className = 'pivot-artifact-diagram-view';

            if (trimmed.startsWith('<svg') || trimmed.includes('<svg')) {
                // 直接渲染 SVG
                const wrapper = document.createElement('div');
                wrapper.className = 'pivot-artifact-svg-wrapper';
                if (typeof DOMPurify !== 'undefined') {
                    wrapper.innerHTML = DOMPurify.sanitize(trimmed, { USE_PROFILES: { svg: true, svgFilters: true } });
                } else {
                    wrapper.innerHTML = trimmed;
                }
                diagramContainer.appendChild(wrapper);
            } else {
                // 如果是 Mermaid 规范文本或 JSON 数据
                this.renderCode(viewport, content, 'mermaid');
                return;
            }

            viewport.appendChild(diagramContainer);
        }

        /**
         * 复制内容并给予反馈
         */
        async copyContent(text, btn) {
            try {
                await navigator.clipboard.writeText(text);
                const originalHtml = btn.innerHTML;
                btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span style="color:#34d399;">已复制</span>`;
                setTimeout(() => {
                    btn.innerHTML = originalHtml;
                }, 1800);
            } catch (err) {
                console.error('复制失败:', err);
                if (typeof showToast === 'function') {
                    showToast('复制失败，请手动选择复制', 'error');
                }
            }
        }

        /**
         * 下载文件
         */
        downloadContent(artifact) {
            const { title = 'artifact', type = 'txt', content = '' } = artifact;
            const extMap = {
                html: 'html',
                react: 'jsx',
                vue: 'vue',
                markdown: 'md',
                code: 'txt',
                chart: 'svg',
                diagram: 'svg'
            };
            const ext = extMap[type.toLowerCase()] || 'txt';
            const filename = `${title.replace(/[/\\?%*:|"<>]/g, '_')}.${ext}`;

            const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
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

    window.Pivot.ArtifactRenderer = ArtifactRenderer;
})();
