// 附件与事实材料分开：名称生成附件说明，正文另起页并与主文连续编页。
function renderOfficialWritingAttachments() {
    const list = document.getElementById('official-writing-attachments-editor');
    if (!list) return;
    list.replaceChildren();
    for (const [index, attachment] of (officialWritingState.attachments || []).entries()) {
        const fieldset = document.createElement('fieldset'); fieldset.className = 'official-writing-elements-group';
        const legend = document.createElement('legend'); legend.textContent = `附件 ${index + 1}`;
        const nameLabel = document.createElement('label'); nameLabel.textContent = '附件名称';
        const name = document.createElement('input'); name.className = 'form-input'; name.value = attachment.name; name.maxLength = 250;
        name.setAttribute('aria-label', `附件 ${index + 1} 名称`);
        const contentLabel = document.createElement('label'); contentLabel.textContent = '附件正文';
        const content = document.createElement('textarea'); content.className = 'form-input'; content.value = attachment.content; content.rows = 8;
        content.setAttribute('aria-label', `附件 ${index + 1} 正文`);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn-danger-outline'; remove.textContent = '移除附件';
        name.addEventListener('input', () => { attachment.name = name.value; saveOfficialWritingState(); });
        content.addEventListener('input', () => { attachment.content = content.value; saveOfficialWritingState(); });
        remove.addEventListener('click', async () => {
            if (attachment.content && !await window.Pivot.legacy.showConfirm?.('移除附件', '确认移除此附件及其正文？')) return;
            officialWritingState.attachments = officialWritingState.attachments.filter(item => item.id !== attachment.id);
            saveOfficialWritingState(); renderOfficialWritingAttachments();
        });
        fieldset.append(legend, nameLabel, name, contentLabel, content, remove); list.appendChild(fieldset);
    }
}

function bindOfficialWritingAttachmentEvents() {
    document.getElementById('official-writing-add-attachment-btn')?.addEventListener('click', () => {
        officialWritingState.attachments ||= [];
        if (officialWritingState.attachments.length >= 20) return showToast('每篇公文最多支持 20 份附件', 'warning');
        officialWritingState.attachments.push({ id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`, name: '', content: '' });
        saveOfficialWritingState(); renderOfficialWritingAttachments();
    });
}
