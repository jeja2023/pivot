(function () {
    'use strict';
    let active = false;
    let sequence = 0;
    const send = message => window.parent.postMessage({ type: 'pivot:mermaid-result', ...message }, '*');
    const color = value => typeof value === 'string' && /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value) ? value : undefined;
    if (!window.Pivot?.vendor?.mermaid) {
        window.parent.postMessage({ type: 'pivot:mermaid-unavailable' }, '*'); return;
    }

    window.addEventListener('message', async event => {
        const input = event.data;
        if (event.source !== window.parent || input?.type !== 'pivot:mermaid-render' || typeof input.id !== 'string' || active) return;
        if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 65536) { send({ id: input.id, error: '源码为空或超过 64KB，请检查并拆分图形。' }); return; }
        active = true;
        const host = document.getElementById('mermaid-render-target');
        try {
            // 自定义配置仅影响原始源码；预览固定使用本站主题和安全边界，禁止指令扩大权限。
            const source = input.source.replace(/^\uFEFF/, '').replace(/^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').replace(/%%\{[\s\S]*?\}%%/g, '');
            const palette = input.palette || {};
            const variables = Object.fromEntries(Object.entries({ background: color(palette.surface), primaryColor: color(palette.side), primaryTextColor: color(palette.text),
                primaryBorderColor: color(palette.border), lineColor: color(palette.text), secondaryColor: color(palette.surface), tertiaryColor: color(palette.side),
                textColor: color(palette.text), mainBkg: color(palette.side), nodeBorder: color(palette.border), clusterBkg: color(palette.surface), clusterBorder: color(palette.border) }).filter(([, value]) => value));
            const mermaid = window.Pivot.vendor.mermaid;
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, maxTextSize: 65536, maxEdges: 500,
                theme: 'base', themeVariables: variables, fontFamily: 'sans-serif', htmlLabels: false,
                flowchart: { htmlLabels: false, useMaxWidth: false }, deterministicIds: true,
                secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'dompurifyConfig'] });
            const result = await mermaid.render(`pivot-mermaid-${++sequence}`, source, host);
            send({ id: input.id, svg: result.svg });
        } catch (error) {
            const detail = String(error?.message || '').split('\n').slice(0, 3).join(' ').slice(0, 240);
            send({ id: input.id, error: detail ? `图形语法或布局有误：${detail}` : '图形渲染失败，请检查源码后重试。' });
        } finally { host.replaceChildren(); active = false; }
    });
    window.parent.postMessage({ type: 'pivot:mermaid-ready' }, '*');
})();
