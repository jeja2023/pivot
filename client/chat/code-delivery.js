// 聊天代码块的受控文件保存：只在用户明确点击后进入 Artifact → Rendition → 桌面交付链。
/* global API_BASE, apiFetch, showToast */

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

async function queueRenditionToDesktop(rendition, targetFilename = '', current = () => true) {
    try {
        const selected = await getDesktopDeliveryGrant(rendition?.format);
        if (!selected || !current()) return null;
        let { status, grant } = selected;
        if (typeof window.pivotDesktop.prepareDelivery === 'function') {
            status = await window.pivotDesktop.prepareDelivery();
            if (!current()) return null;
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

async function deliverCodeBlock(button, local) {
    const block = button?.closest?.('.code-block');
    let code = block?.querySelector('code')?.textContent || '';
    const language = String(block?.dataset?.codeLanguage || '').trim().toLowerCase();
    if (!code.trim()) return codeDeliveryError('代码内容为空，无法保存。');
    if (button.disabled) return null;
    const originalCode = code;
    const userId = window.Pivot.legacy?.currentUser?.id;
    const current = () => block.isConnected !== false && window.Pivot.legacy?.currentUser?.id === userId && block.querySelector('code')?.textContent === originalCode;
    button.disabled = true;
    try {
        let formats = window.Pivot.moduleApi('chat.codeFormats');
        if (!formats?.extensionForLanguage && window.Pivot.loadScriptOnce) {
            await window.Pivot.loadScriptOnce('/common/code-formats.js');
            formats = window.Pivot.moduleApi('chat.codeFormats');
        }
        if (!formats?.extensionForLanguage) throw new Error('文件格式组件未就绪，请刷新页面后重试。');
        if (!current()) return null;
        const extension = formats.extensionForLanguage(language);
        const defaultFilename = extension === 'svg' ? '图形.svg' : (['mermaid', 'mmd'].includes(language) ? '流程图源码.txt' : `代码.${extension}`);
        const known = Object.prototype.hasOwnProperty.call(formats.CODE_FORMAT_ALIASES, language);
        const promptMessage = !known ? '当前语言按纯文本保存，请输入 TXT 文件名：' : `请输入保存文件名（.${extension}）：`;
        const filename = window.prompt(promptMessage, defaultFilename);
        if (!filename || !current()) return null;
        if (extension === 'svg') code = window.Pivot.moduleApi('chat.mermaidSvg').sanitize(code, { strict: true });
        const response = await apiFetch(`${API_BASE}/agents/code-renditions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: code, language, filename })
        });
        const data = await response.json().catch(() => ({}));
        if (!current()) return null;
        if (!response.ok || !data.rendition) return codeDeliveryError(data.error || '代码文件产物创建失败，请检查文件名和内容。');
        const target = data.artifact?.title || filename;
        return local ? await queueRenditionToDesktop(data.rendition, target, current) : await downloadRendition(data.rendition, target, current);
    } catch (error) {
        if (current()) return codeDeliveryError(error?.message || '代码文件保存失败，请稍后重试。');
        return null;
    } finally {
        button.disabled = false;
    }
}

async function saveCodeBlockToDesktop(button) { return deliverCodeBlock(button, true); }
async function downloadCodeBlock(button) { return deliverCodeBlock(button, false); }

async function downloadRendition(rendition, filename = '', current = () => true) {
    const response = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(rendition.id)}/download-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const issued = await response.json().catch(() => ({}));
    if (!current()) return null;
    if (!response.ok || !issued.token) throw new Error(issued.error || '获取下载许可失败，请重新查看文件状态。');
    const file = await apiFetch(`${API_BASE}/agents/renditions/${encodeURIComponent(rendition.id)}/download?token=${encodeURIComponent(issued.token)}`);
    if (!file.ok) throw new Error('读取结果文件失败，请重新查看文件状态。');
    const blob = await file.blob();
    if (!current()) return null;
    let target = filename || `产物-${rendition.id}`;
    const headerName = file.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (headerName) { try { target = decodeURIComponent(headerName); } catch (_) { } }
    else if (rendition.format && !target.toLowerCase().endsWith(`.${rendition.format}`)) target += `.${rendition.format}`;
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = target.replace(/[\\/\r\n]/g, '_');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return true;
}

window.Pivot.exposeModule('chat.codeDelivery', {
    downloadCodeBlock,
    downloadRendition,
    queueRenditionToDesktop,
    saveCodeBlockToDesktop
});
