// --- 默认模型保存模块 ---
window.saveMyDefaultModel = async (modelId = undefined, btn = null) => {
    const targetModelId = (modelId === undefined) ? document.getElementById('model-selector')?.value : modelId;
    if (btn) {
        btn.innerText = targetModelId ? '取消默认' : '设为默认';
        btn.style.borderColor = targetModelId ? 'var(--danger)' : 'var(--primary)';
        btn.style.color = targetModelId ? 'var(--danger)' : 'var(--primary)';
    }
    if (targetModelId === undefined) return;
    try {
        const res = await apiFetch(`${API_BASE}/settings/default-model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ default_model_id: targetModelId }) });
        if (res.ok) {
            showToast(targetModelId ? '已设为默认模型' : '已取消默认设置');
            const selector = document.getElementById('model-selector');
            if (selector) selector.value = targetModelId;
        }
    } catch (e) { showToast('设置失败', 'error'); }
};
