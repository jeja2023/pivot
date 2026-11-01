(function () {
let confirmCallback = null;
let confirmResolve = null;
window.Pivot.legacy.showConfirm = (title, message, callback) => {
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
window.Pivot.legacy.closeConfirmModal = (confirmed = false) => {
    document.getElementById('confirm-container')?.classList.add('hidden');
    const resolve = confirmResolve;
    confirmCallback = null;
    confirmResolve = null;
    if (resolve) resolve(confirmed);
};
document.getElementById('confirm-ok-btn')?.addEventListener('click', () => {
    const callback = confirmCallback;
    if (callback) callback();
    window.Pivot.legacy.closeConfirmModal(true);
});
document.getElementById('modal-confirm-cancel')?.addEventListener('click', () => window.Pivot.legacy.closeConfirmModal(false));

// --- 消息操作 ---
let inputPromptResolve = null;
let inputPromptOptions = {};

function resetInputPromptError() {
    const errorEl = document.getElementById('input-prompt-error');
    if (!errorEl) return;
    errorEl.innerText = '';
    errorEl.classList.add('hidden');
}

function updateInputPromptMeta() {
    const field = inputPromptOptions.multiline === true
        ? document.getElementById('input-prompt-textarea')
        : document.getElementById('input-prompt-field');
    const clearBtn = document.getElementById('input-prompt-clear');
    const counterEl = document.getElementById('input-prompt-counter');
    if (!field) return;
    const val = field.value || '';
    if (clearBtn) clearBtn.classList.toggle('hidden', !val);
    if (counterEl) {
        const max = inputPromptOptions.maxLength || (inputPromptOptions.multiline ? 4000 : null);
        if (max) {
            counterEl.classList.remove('hidden');
            counterEl.innerText = `${val.length} / ${max}`;
            const nearLimit = val.length >= Math.floor(max * 0.85) && max >= val.length;
            const overLimit = val.length > max;
            counterEl.classList.toggle('limit-near', nearLimit);
            counterEl.classList.toggle('limit-reached', overLimit);
        } else {
            counterEl.classList.add('hidden');
        }
    }
}

function closeInputPrompt(value = null) {
    const container = document.getElementById('input-prompt-container');
    container?.classList.add('hidden');
    // 还原自定义宽度，避免影响下一个复用该弹窗的调用方。
    const modal = container?.querySelector('.modal');
    if (modal) modal.style.width = '';
    const suggestionsBox = document.getElementById('input-prompt-suggestions');
    const suggestionsList = document.getElementById('input-prompt-suggestions-list');
    if (suggestionsBox) suggestionsBox.classList.add('hidden');
    if (suggestionsList) suggestionsList.replaceChildren();
    const clearBtn = document.getElementById('input-prompt-clear');
    if (clearBtn) clearBtn.classList.add('hidden');
    const counterEl = document.getElementById('input-prompt-counter');
    if (counterEl) counterEl.classList.add('hidden');

    const resolve = inputPromptResolve;
    inputPromptResolve = null;
    inputPromptOptions = {};
    const field = document.getElementById('input-prompt-field');
    const textarea = document.getElementById('input-prompt-textarea');
    if (field) {
        field.value = '';
        field.classList.remove('hidden');
    }
    if (textarea) {
        textarea.value = '';
        textarea.classList.add('hidden');
    }
    if (resolve) resolve(value);
}

window.Pivot.legacy.showInputPrompt = function(options = {}) {
    const container = document.getElementById('input-prompt-container');
    const titleEl = document.getElementById('input-prompt-title');
    const messageEl = document.getElementById('input-prompt-message');
    const field = document.getElementById('input-prompt-field');
    const textarea = document.getElementById('input-prompt-textarea');
    const okBtn = document.getElementById('modal-input-prompt-ok');
    const cancelBtn = document.getElementById('modal-input-prompt-cancel');
    const tipEl = document.getElementById('input-prompt-shortcut-tip');
    const suggestionsBox = document.getElementById('input-prompt-suggestions');
    const suggestionsList = document.getElementById('input-prompt-suggestions-list');

    if (!container || !titleEl || !messageEl || !field || !textarea) return Promise.resolve(null);

    if (inputPromptResolve) closeInputPrompt(null);
    inputPromptOptions = options;
    // 可选自定义宽度；不传则回退到 CSS 默认宽度。
    const modal = container.querySelector('.modal');
    if (modal) modal.style.width = options.width ? `min(${options.width}px, calc(100vw - 32px))` : '';
    titleEl.innerText = options.title || '输入';
    messageEl.innerText = options.message || options.label || '';
    if (okBtn) okBtn.innerText = options.okText || '确认';
    if (cancelBtn) cancelBtn.innerText = options.cancelText || '取消';

    const activeField = options.multiline === true ? textarea : field;
    field.classList.toggle('hidden', activeField !== field);
    textarea.classList.toggle('hidden', activeField !== textarea);
    if (activeField === field) field.type = options.type || 'text';
    activeField.value = options.value || '';
    activeField.placeholder = options.placeholder || '';
    activeField.autocomplete = options.autocomplete || 'off';

    if (tipEl) {
        tipEl.innerText = options.multiline === true
            ? '按 Ctrl + Enter 提交，Esc 取消'
            : '按 Enter 提交，Esc 取消';
    }

    // 快捷标签 / 建议项渲染
    if (suggestionsBox && suggestionsList) {
        suggestionsList.replaceChildren();
        if (Array.isArray(options.suggestions) && options.suggestions.length > 0) {
            suggestionsBox.classList.remove('hidden');
            for (const item of options.suggestions) {
                const text = typeof item === 'string' ? item : (item?.text || item?.label || '');
                if (!text) continue;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-secondary input-prompt-chip';
                btn.textContent = text;
                btn.addEventListener('click', () => {
                    const current = activeField.value.trim();
                    if (!current) {
                        activeField.value = text;
                    } else if (!current.includes(text)) {
                        activeField.value = `${current}\n${text}`;
                    }
                    activeField.focus();
                    resetInputPromptError();
                    updateInputPromptMeta();
                });
                suggestionsList.appendChild(btn);
            }
        } else {
            suggestionsBox.classList.add('hidden');
        }
    }

    resetInputPromptError();
    updateInputPromptMeta();
    container.classList.remove('hidden');
    setTimeout(() => activeField.focus(), 0);

    return new Promise(resolve => {
        inputPromptResolve = resolve;
    });
};

function submitInputPrompt() {
    const field = inputPromptOptions.multiline === true
        ? document.getElementById('input-prompt-textarea')
        : document.getElementById('input-prompt-field');
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
    const max = inputPromptOptions.maxLength || (inputPromptOptions.multiline ? 4000 : null);
    if (max && trimmed.length > max) {
        errorEl.innerText = `内容长度不能超过 ${max} 个字符（当前 ${trimmed.length} 字）`;
        errorEl.classList.remove('hidden');
        field.focus();
        return;
    }
    closeInputPrompt(inputPromptOptions.trim === false ? value : trimmed);
}

document.getElementById('modal-input-prompt-ok')?.addEventListener('click', submitInputPrompt);
document.getElementById('modal-input-prompt-cancel')?.addEventListener('click', () => closeInputPrompt(null));
document.getElementById('modal-input-prompt-close')?.addEventListener('click', () => closeInputPrompt(null));
document.getElementById('input-prompt-container')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
        closeInputPrompt(null);
    }
});
document.getElementById('input-prompt-clear')?.addEventListener('click', () => {
    const field = inputPromptOptions.multiline === true
        ? document.getElementById('input-prompt-textarea')
        : document.getElementById('input-prompt-field');
    if (field) {
        field.value = '';
        field.focus();
        resetInputPromptError();
        updateInputPromptMeta();
    }
});
['input-prompt-field', 'input-prompt-textarea'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
        resetInputPromptError();
        updateInputPromptMeta();
    });
    el.addEventListener('keydown', (event) => {
        if (event.isComposing || event.keyCode === 229) return;
        if (inputPromptOptions.multiline === true && event.key === 'Enter' && !event.ctrlKey && !event.metaKey) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            submitInputPrompt();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeInputPrompt(null);
        }
    });
});

// --- 通用提示与详情弹窗 ---
let alertResolve = null;

function showAlert(title, message) {
    const container = document.getElementById('alert-container');
    const titleEl = document.getElementById('alert-title');
    const messageEl = document.getElementById('alert-message');
    if (!container || !titleEl || !messageEl) {
        return Promise.resolve();
    }
    if (alertResolve) {
        alertResolve();
        alertResolve = null;
    }
    titleEl.innerText = title || '提示';
    messageEl.innerText = message || '';
    container.classList.remove('hidden');
    container.setAttribute('aria-hidden', 'false');
    const okBtn = document.getElementById('modal-alert-ok');
    setTimeout(() => okBtn?.focus(), 0);
    return new Promise(resolve => {
        alertResolve = resolve;
    });
}

function closeAlertModal() {
    const container = document.getElementById('alert-container');
    container?.classList.add('hidden');
    container?.setAttribute('aria-hidden', 'true');
    const resolve = alertResolve;
    alertResolve = null;
    if (resolve) resolve();
}

Object.assign(window.Pivot.legacy, {
    showAlert,
    closeAlertModal
});
window.Pivot.registerModule?.('ui.dialogs', {
    showAlert,
    closeAlertModal
});

document.getElementById('modal-alert-ok')?.addEventListener('click', () => closeAlertModal());
document.getElementById('alert-container')?.addEventListener('click', event => {
    if (event.target === document.getElementById('alert-container')) closeAlertModal();
});
document.getElementById('alert-container')?.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'Enter') {
        event.preventDefault();
        closeAlertModal();
    }
});

function copyWithExecCommand(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '-9999px';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    textArea.style.fontSize = '12pt';
    const selection = document.getSelection();
    const originalRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, textArea.value.length);
    let success = false;
    try {
        success = document.execCommand('copy');
    } catch (_) {
        success = false;
    }
    document.body.removeChild(textArea);
    if (originalRange && selection) {
        selection.removeAllRanges();
        selection.addRange(originalRange);
    }
    return success;
}

async function writeTextToClipboard(text) {
    if (!text && text !== '') return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (_) {
            // Electron 客户端或浏览器权限受限时静默进入降级兜底方案
        }
    }
    const success = copyWithExecCommand(text);
    if (!success) throw new Error('执行命令复制失败');
}
    window.Pivot.legacy.chatDialogHelpers = { writeTextToClipboard };
})();
