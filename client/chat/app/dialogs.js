(function () {
let confirmCallback = null;
let confirmResolve = null;
window.showConfirm = (title, message, callback) => {
    const container = document.getElementById('confirm-container');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    if (!container || !titleEl || !messageEl) return Promise.resolve(false);
    if (confirmResolve) confirmResolve(false);
    titleEl.innerText = title;
    messageEl.innerText = message;
    confirmCallback = typeof callback === 'function' ? callback : null;
    container.classList.remove('hidden');
    return new Promise(resolve => {
        confirmResolve = resolve;
    });
};
window.closeConfirmModal = (confirmed = false) => {
    document.getElementById('confirm-container')?.classList.add('hidden');
    const resolve = confirmResolve;
    confirmCallback = null;
    confirmResolve = null;
    if (resolve) resolve(confirmed);
};
document.getElementById('confirm-ok-btn')?.addEventListener('click', () => {
    const callback = confirmCallback;
    if (callback) callback();
    window.closeConfirmModal(true);
});
document.getElementById('modal-confirm-cancel')?.addEventListener('click', () => window.closeConfirmModal(false));

// --- 消息操作 ---
let inputPromptResolve = null;
let inputPromptOptions = {};

function resetInputPromptError() {
    const errorEl = document.getElementById('input-prompt-error');
    if (!errorEl) return;
    errorEl.innerText = '';
    errorEl.classList.add('hidden');
}

function closeInputPrompt(value = null) {
    const container = document.getElementById('input-prompt-container');
    container?.classList.add('hidden');
    // 还原自定义宽度，避免影响下一个复用该弹窗的调用方。
    const modal = container?.querySelector('.modal');
    if (modal) modal.style.width = '';
    const resolve = inputPromptResolve;
    inputPromptResolve = null;
    inputPromptOptions = {};
    if (resolve) resolve(value);
}

window.showInputPrompt = function(options = {}) {
    const container = document.getElementById('input-prompt-container');
    const titleEl = document.getElementById('input-prompt-title');
    const messageEl = document.getElementById('input-prompt-message');
    const field = document.getElementById('input-prompt-field');
    if (!container || !titleEl || !messageEl || !field) return Promise.resolve(null);

    if (inputPromptResolve) closeInputPrompt(null);
    inputPromptOptions = options;
    // 可选自定义宽度（如重命名长公文标题）；不传则回退到 CSS 默认宽度。
    const modal = container.querySelector('.modal');
    if (modal) modal.style.width = options.width ? `${options.width}px` : '';
    titleEl.innerText = options.title || '输入';
    messageEl.innerText = options.message || '';
    field.type = options.type || 'text';
    field.value = options.value || '';
    field.placeholder = options.placeholder || '';
    field.autocomplete = options.autocomplete || 'off';
    resetInputPromptError();
    container.classList.remove('hidden');
    setTimeout(() => field.focus(), 0);

    return new Promise(resolve => {
        inputPromptResolve = resolve;
    });
};

function submitInputPrompt() {
    const field = document.getElementById('input-prompt-field');
    const errorEl = document.getElementById('input-prompt-error');
    if (!field || !errorEl) return closeInputPrompt(null);
    const value = field.value;
    const trimmed = value.trim();
    if (inputPromptOptions.required !== false && !trimmed) {
        errorEl.innerText = inputPromptOptions.requiredMessage || '请输入内容';
        errorEl.classList.remove('hidden');
        field.focus();
        return;
    }
    closeInputPrompt(inputPromptOptions.trim === false ? value : trimmed);
}

document.getElementById('modal-input-prompt-ok')?.addEventListener('click', submitInputPrompt);
document.getElementById('modal-input-prompt-cancel')?.addEventListener('click', () => closeInputPrompt(null));
document.getElementById('input-prompt-field')?.addEventListener('input', resetInputPromptError);
document.getElementById('input-prompt-field')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        submitInputPrompt();
    } else if (event.key === 'Escape') {
        event.preventDefault();
        closeInputPrompt(null);
    }
});

async function writeTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const success = document.execCommand('copy');
    textArea.remove();
    if (!success) throw new Error('执行命令复制失败');
}
    window.chatDialogHelpers = { writeTextToClipboard };
})();
