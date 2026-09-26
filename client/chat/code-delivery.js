// 聊天代码块的受控文件保存：只在用户明确点击后进入 Artifact → Rendition → 桌面交付链。
/* global API_BASE, apiFetch, showToast */

const CODE_LANGUAGE_TO_EXTENSION = Object.freeze({
    python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js',
    typescript: 'ts', ts: 'ts', jsx: 'jsx', tsx: 'tsx', java: 'java',
    c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', hpp: 'hpp', cs: 'cs', 'c#': 'cs',
    go: 'go', rust: 'rs', rs: 'rs', php: 'php', ruby: 'rb', rb: 'rb', swift: 'swift',
    kotlin: 'kt', kt: 'kt', kts: 'kts', shell: 'sh', bash: 'sh', sh: 'sh',
    sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yml', xml: 'xml', css: 'css',
    scss: 'scss', markdown: 'md', md: 'md', text: 'txt', txt: 'txt'
});

function codeDeliveryError(message) {
    showToast(message, 'error');
    return null;
}

function activeDeliveryGrants(status, format = '') {
    const requiredFormat = String(format || '').trim().toLowerCase();
    return (Array.isArray(status?.grants) ? status.grants : []).filter(grant => {
        if (!grant?.grantId || grant.expired === true) return false;
        const allowedFormats = Array.isArray(grant.allowedFormats) ? grant.allowedFormats : [];
        return !requiredFormat || !allowedFormats.length || allowedFormats.includes(requiredFormat);
    });
}

async function getDesktopDeliveryGrant(format = '') {
    if (!window.pivotDesktop?.getDeliveryStatus) {
        return codeDeliveryError('请在 Pivot 桌面客户端中使用“保存到本机”。');
    }
    let status = await window.pivotDesktop.getDeliveryStatus();
    if (!status?.available) return codeDeliveryError(status?.reason || '本机交付设备不可用，请检查桌面客户端状态。');
    if (!activeDeliveryGrants(status, format).length) {
        const configured = await window.pivotDesktop.authorizeDeliveryDirectory();
        if (configured?.canceled) return null;
        status = await window.pivotDesktop.getDeliveryStatus();
    }
    const grants = activeDeliveryGrants(status, format);
    if (!grants.length) return codeDeliveryError('请先授权一个支持当前文件格式的本机交付目录。');
    let grant = grants[0];
    if (grants.length > 1) {
        const choices = grants.map((item, index) => `${index + 1}. ${item.pathHint || '已授权目录'}`).join('\n');
        const selected = window.prompt(`请选择本次保存的授权目录：\n${choices}`, '1');
        const index = Number.parseInt(String(selected || ''), 10) - 1;
        grant = grants[index] || null;
    }
    if (!grant) return codeDeliveryError('未选择有效的目录授权。');
    return { status, grant };
}

async function queueRenditionToDesktop(rendition, targetFilename = '') {
    try {
        const selected = await getDesktopDeliveryGrant(rendition?.format);
        if (!selected) return null;
        let { status, grant } = selected;
        if (typeof window.pivotDesktop.prepareDelivery === 'function') {
            status = await window.pivotDesktop.prepareDelivery();
            if (!status?.available || status.registered !== true) {
                return codeDeliveryError(status?.reason || '本机交付设备尚未就绪，请确认已登录桌面客户端后重试。');
            }
        }
        const intentRes = await apiFetch(`${API_BASE}/agents/deliveries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                renditionId: rendition.id,
                channel: 'local_device',
                deviceId: status.deviceId,
                targetDirGrant: grant.grantId,
                targetFilename: targetFilename || `产物-${rendition.id}`
            })
        })
        const intentData = await intentRes.json().catch(() => ({}));
        if (!intentRes.ok) return codeDeliveryError(intentData.error || '创建本机交付任务失败，请检查授权目录和文件格式。');
        // 客户端启动后通常已经在轮询；再次启动是幂等的，可覆盖刚恢复或手动停止的状态。
        await window.pivotDesktop.startDelivery?.();
        showToast(intentData.reused ? '该文件已在本机交付队列中。' : '已加入本机交付队列，正在写入授权目录。', 'success');
        return intentData;
    } catch (error) {
        return codeDeliveryError(error?.message || '本机交付初始化失败，请检查桌面客户端和目录授权。');
    }
}

async function saveCodeBlockToDesktop(button) {
    const block = button?.closest?.('.code-block');
    const code = block?.querySelector('code')?.textContent || '';
    const language = String(block?.dataset?.codeLanguage || '').trim().toLowerCase();
    const extension = CODE_LANGUAGE_TO_EXTENSION[language];
    if (!code.trim()) return codeDeliveryError('代码内容为空，无法保存。');
    if (!extension) return codeDeliveryError('当前代码语言暂不支持受控文件保存，请先复制代码或选择受支持的源码格式。');
    const filename = window.prompt('请输入保存文件名（只允许保存为受支持的文本/源码文件）：', `代码.${extension}`);
    if (!filename) return null;
    button.disabled = true;
    try {
        const response = await apiFetch(`${API_BASE}/agents/code-renditions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: code, language, filename })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.rendition) return codeDeliveryError(data.error || '代码文件产物创建失败，请检查文件名和内容。');
        return await queueRenditionToDesktop(data.rendition, filename);
    } catch (error) {
        return codeDeliveryError(error?.message || '代码文件保存失败，请稍后重试。');
    } finally {
        button.disabled = false;
    }
}

window.Pivot.exposeModule('chat.codeDelivery', {
    CODE_LANGUAGE_TO_EXTENSION,
    queueRenditionToDesktop,
    saveCodeBlockToDesktop
});
