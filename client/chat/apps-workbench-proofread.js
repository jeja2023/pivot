// ===== 公文校对检查（敏感词 / 易错字 / 标点规范 / 标题文种一致性）=====

// 常见公文易错词、错别字与不规范表述（错误写法 -> 建议写法）。
const OFFICIAL_WRITING_TYPO_RULES = [
    ['做出决定', '作出决定', '公文固定搭配多用“作出决定”。'],
    ['做出部署', '作出部署', '公文固定搭配多用“作出部署”。'],
    ['截止目前', '截至目前', '表示时间到某点用“截至”，“截止”指停止。'],
    ['截止到', '截至', '表示时间到某点用“截至”。'],
    ['有序的推进', '有序推进', '“的/地/得”误用：状语后多不加“的”。'],
    ['进行研究', '研究', '“进行+双音节动词”啰嗦，可直接用动词。'],
    ['进行讨论', '讨论', '“进行+双音节动词”啰嗦，可直接用动词。'],
    ['汇报', '报告', '向上级行文时文种用“报告”，“汇报”偏口语。'],
    ['第一时间', '及时', '“第一时间”偏口语，公文宜用“及时”“立即”。'],
    ['一定要', '务必', '“一定要”偏口语，公文宜用“务必”“应”。']
].filter(rule => rule[0] && rule[1]);

// 敏感/不当表述提示（仅提示，不强制）。
const OFFICIAL_WRITING_SENSITIVE_WORDS = ['最高级', '最佳', '国家级', '世界级', '绝对', '百分之百', '一律', '严禁一切', '彻底杜绝'];

function getOfficialWritingProofreadIssues() {
    const draft = String(officialWritingState.draft || '');
    const issues = [];
    if (!draft.trim()) return issues;

    // 1. 易错字 / 不规范表述
    OFFICIAL_WRITING_TYPO_RULES.forEach(([from, to, note], ruleIndex) => {
        let index = draft.indexOf(from);
        let guard = 0;
        while (index >= 0 && guard < 50) {
            guard += 1;
            issues.push({
                id: `typo-${ruleIndex}-${index}`,
                kind: '易错字',
                level: '低',
                start: index,
                end: index + from.length,
                excerpt: from,
                suggestion: `建议改为“${to}”${note ? '：' + note : ''}`
            });
            index = draft.indexOf(from, index + from.length);
        }
    });

    // 2. 敏感 / 绝对化措辞
    OFFICIAL_WRITING_SENSITIVE_WORDS.forEach((word, wordIndex) => {
        const index = draft.indexOf(word);
        if (index >= 0) {
            issues.push({
                id: `sensitive-${wordIndex}-${index}`,
                kind: '敏感词',
                level: '中',
                start: index,
                end: index + word.length,
                excerpt: word,
                suggestion: `“${word}”属绝对化或敏感表述，建议核实是否符合事实并改为克制措辞。`
            });
        }
    });

    // 3. 标点规范：连续标点、英文标点混用、成对括号/引号不匹配
    const doublePunct = draft.match(/[，。、；：]{2,}/);
    if (doublePunct) {
        const index = draft.indexOf(doublePunct[0]);
        issues.push({
            id: `punct-double-${index}`,
            kind: '标点',
            level: '低',
            start: index,
            end: index + doublePunct[0].length,
            excerpt: doublePunct[0],
            suggestion: '存在连续标点，建议核对并删除多余标点。'
        });
    }
    const enPunct = draft.match(/[a-zA-Z0-9一-龥][,;:?!](\s|[一-龥])/);
    if (enPunct) {
        const index = enPunct.index;
        issues.push({
            id: `punct-en-${index}`,
            kind: '标点',
            level: '低',
            start: index,
            end: index + enPunct[0].length,
            excerpt: enPunct[0].trim(),
            suggestion: '正文中疑似使用了英文标点，公文建议统一使用中文全角标点。'
        });
    }
    const openQuote = (draft.match(/“/g) || []).length;
    const closeQuote = (draft.match(/”/g) || []).length;
    if (openQuote !== closeQuote) {
        issues.push({
            id: 'punct-quote',
            kind: '标点',
            level: '中',
            start: 0,
            end: 0,
            excerpt: '引号',
            suggestion: `中文引号“”数量不匹配（${openQuote} 对 ${closeQuote}），请检查是否漏配。`
        });
    }
    const openParen = (draft.match(/（/g) || []).length;
    const closeParen = (draft.match(/）/g) || []).length;
    if (openParen !== closeParen) {
        issues.push({
            id: 'punct-paren',
            kind: '标点',
            level: '中',
            start: 0,
            end: 0,
            excerpt: '括号',
            suggestion: `中文括号（）数量不匹配（${openParen} 对 ${closeParen}），请检查是否漏配。`
        });
    }

    // 4. 标题与文种一致性
    const docType = getOfficialWritingDocType();
    const firstLine = draft.split(/\r?\n/).find(line => line.trim()) || '';
    const allTypes = ['通知', '请示', '报告', '函', '会议纪要', '通报', '意见', '决定', '批复', '公告', '通告', '纪要'];
    if (firstLine.trim() && docType !== '其他公文') {
        const titleType = allTypes.find(type => firstLine.includes(type));
        const start = draft.indexOf(firstLine);
        if (titleType && titleType !== docType && !(docType === '会议纪要' && titleType === '纪要')) {
            issues.push({
                id: 'title-doctype',
                kind: '文种一致性',
                level: '中',
                start,
                end: start + firstLine.length,
                excerpt: compactTextPreview(firstLine, 30),
                suggestion: `标题文种“${titleType}”与所选文种“${docType}”不一致，请确认文种或修改标题。`
            });
        } else if (!titleType) {
            issues.push({
                id: 'title-doctype-missing',
                kind: '文种一致性',
                level: '低',
                start,
                end: start + firstLine.length,
                excerpt: compactTextPreview(firstLine, 30),
                suggestion: `标题未体现文种“${docType}”，建议在标题中明确，如“关于……的${docType}”。`
            });
        }
    }
    return issues;
}

function renderOfficialWritingProofread() {
    const list = document.getElementById('official-writing-proofread-list');
    const issues = getOfficialWritingProofreadIssues();
    setText('official-writing-proofread-count', `${issues.length} 项`);
    setText('official-writing-proofread-badge', String(issues.length));
    if (!list) return;
    list.innerHTML = issues.map(issue => `
        <article class="official-writing-check-item" ${issue.end > issue.start ? `data-official-writing-proof-start="${issue.start}" data-official-writing-proof-end="${issue.end}"` : ''}>
            <strong>${escapeAppsHtml(issue.kind)}<span>${escapeAppsHtml(issue.level)}</span></strong>
            <p>${escapeAppsHtml(issue.excerpt || '')}</p>
            <em>${escapeAppsHtml(issue.suggestion)}</em>
        </article>
    `).join('') || '<div class="official-writing-empty-note">未发现敏感词、易错字、标点或文种一致性问题</div>';
}

function applyOfficialWritingViewMode(mode = 'document') {
    const nextMode = ['document', 'compare'].includes(mode) ? mode : 'document';
    officialWritingUiState.viewMode = nextMode;
    const panel = document.querySelector('.official-writing-panel');
    if (panel) panel.dataset.writingViewMode = nextMode;
    document.querySelectorAll('[data-official-writing-view-mode]').forEach(button => {
        button.classList.toggle('active', button.dataset.officialWritingViewMode === nextMode);
    });
    const title = document.getElementById('official-writing-editor-title');
    const subtitle = document.getElementById('official-writing-editor-subtitle');
    if (title) title.textContent = nextMode === 'compare' ? '对照审改' : '正文编辑';
    if (subtitle) {
        subtitle.textContent = nextMode === 'compare'
            ? '左侧原文、右侧正文稿，适合审改和差异核对。'
            : '单页公文编辑器，优先保留正文空间。';
    }
    applyOfficialWritingLeftRailState();
    updateOfficialWritingSurfaceVisibility();
    renderOfficialWritingSurfaces({ force: true });
    resizeOfficialWritingDraftPage();
    renderOfficialWritingStats();
}

function openOfficialWritingDrawer(view = 'suggestions') {
    const drawer = document.getElementById('official-writing-drawer');
    const shell = document.querySelector('.official-writing-shell');
    const title = document.getElementById('official-writing-drawer-title');
    const desc = document.getElementById('official-writing-drawer-desc');
    const tab = OFFICIAL_WRITING_DRAWER_META[view] ? view : 'suggestions';
    if (!drawer) return;
    officialWritingUiState.drawerTab = tab;
    officialWritingUiState.rightCollapsed = false;
    drawer.classList.remove('hidden');
    shell?.classList.remove('is-drawer-hidden');
    drawer.setAttribute('aria-hidden', 'false');
    Object.keys(OFFICIAL_WRITING_DRAWER_META).forEach(key => {
        document.getElementById(`official-writing-${key}-drawer`)?.classList.toggle('hidden', key !== tab);
    });
    document.querySelectorAll('[data-official-writing-drawer-tab]').forEach(button => {
        const isActive = button.dataset.officialWritingDrawerTab === tab;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.tabIndex = isActive ? 0 : -1;
    });
    const meta = OFFICIAL_WRITING_DRAWER_META[tab];
    if (title) title.textContent = meta[0];
    if (desc) desc.textContent = meta[1];
    renderOfficialWritingStats();
    renderOfficialWritingCompliance();
    renderOfficialWritingSuggestions();
    renderOfficialWritingReferences();
    renderOfficialWritingProofread();
    if (tab === 'elements') hydrateOfficialWritingMetaForm();
    resizeOfficialWritingDraftPage();
    updateOfficialWritingDrawerToggleLabel();
}

function closeOfficialWritingDrawer() {
    const drawer = document.getElementById('official-writing-drawer');
    const shell = document.querySelector('.official-writing-shell');
    if (!drawer) return;
    drawer.classList.add('hidden');
    shell?.classList.add('is-drawer-hidden');
    drawer.setAttribute('aria-hidden', 'true');
    officialWritingUiState.rightCollapsed = true;
    document.querySelectorAll('[data-official-writing-drawer-tab]').forEach(button => {
        button.classList.remove('active');
        button.setAttribute('aria-selected', 'false');
    });
    resizeOfficialWritingDraftPage();
    updateOfficialWritingDrawerToggleLabel();
}

function toggleOfficialWritingDrawer() {
    const drawer = document.getElementById('official-writing-drawer');
    if (!drawer) return;
    if (drawer.classList.contains('hidden')) {
        officialWritingUiState.rightCollapsed = false;
        openOfficialWritingDrawer(officialWritingUiState.drawerTab || 'suggestions');
    } else {
        closeOfficialWritingDrawer();
    }
}

function updateOfficialWritingDrawerToggleLabel() {
    const button = document.getElementById('official-writing-toggle-right-btn');
    if (!button) return;
    const visible = !officialWritingUiState.rightCollapsed;
    button.textContent = '审改栏';
    button.classList.toggle('active', visible);
    button.setAttribute('aria-pressed', visible ? 'true' : 'false');
    button.title = visible ? '隐藏审改栏' : '显示审改栏';
}

function applyOfficialWritingLeftRailState() {
    const workbench = document.querySelector('.official-writing-workbench');
    const button = document.getElementById('official-writing-toggle-left-btn');
    const collapsed = Boolean(officialWritingUiState.leftCollapsed);
    workbench?.classList.toggle('is-left-rail-hidden', collapsed);
    if (button) {
        button.textContent = '资料栏';
        button.classList.toggle('active', !collapsed);
        button.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
        button.title = collapsed ? '显示资料栏' : '隐藏资料栏';
    }
    resizeOfficialWritingDraftPage();
}

function toggleOfficialWritingLeftRail() {
    officialWritingUiState.leftCollapsed = !officialWritingUiState.leftCollapsed;
    applyOfficialWritingLeftRailState();
}

function closeOfficialWritingCommandMenu() {
    const menu = document.getElementById('official-writing-command-more-menu');
    if (menu) menu.open = false;
}

function setOfficialWritingMaterialTab(tab) {
    const nextTab = OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE[tab] ? tab : 'materials';
    officialWritingUiState.materialTab = nextTab;
    document.querySelectorAll('[data-official-writing-material-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.officialWritingMaterialTab === nextTab);
    });
    ['outline', 'materials', 'history', 'standards', 'templates'].forEach(key => {
        document.getElementById(`official-writing-${key}-panel`)?.classList.toggle('hidden', key !== nextTab);
    });
    const select = document.getElementById('official-writing-material-source');
    if (select) select.value = OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE[nextTab];
    // 进入历史/规范检索 tab 时按需加载知识库专题库列表。
    if (nextTab === 'history' || nextTab === 'standards') {
        ensureOfficialWritingRagCollections();
    }
}

function setOfficialWritingMaterialSource(source) {
    const entry = Object.entries(OFFICIAL_WRITING_MATERIAL_TAB_TO_SOURCE).find(([, value]) => value === source);
    setOfficialWritingMaterialTab(entry?.[0] || 'materials');
}

function getSelectionFromTextarea(textarea) {
    if (!textarea) return '';
    const target = getOfficialWritingTargetFromTextarea(textarea);
    const surfaceSelection = getOfficialWritingSurfaceSelection(target);
    if (surfaceSelection?.text) return surfaceSelection.text.trim();
    const start = Number(textarea.selectionStart || 0);
    const end = Number(textarea.selectionEnd || 0);
    return start === end ? '' : textarea.value.slice(start, end).trim();
}

function captureSelection(fieldId, targetId) {
    const selection = getSelectionFromTextarea(document.getElementById(fieldId));
    const target = document.getElementById(targetId);
    if (target) target.value = selection || '全文';
    openOfficialWritingDrawer('comments');
}

function addOfficialWritingComment() {
    const target = document.getElementById('official-writing-comment-target')?.value || 'source';
    const anchor = document.getElementById('official-writing-comment-anchor')?.value.trim() || '全文';
    const textEl = document.getElementById('official-writing-comment-text');
    const text = textEl?.value.trim() || '';
    if (!text) return showToast('请先填写批注内容', 'warning');
    officialWritingState.comments.unshift({
        id: `comment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        target,
        anchor,
        text,
        createdAt: new Date().toISOString()
    });
    if (officialWritingState.comments.length > OFFICIAL_WRITING_COMMENT_LIMIT) {
        officialWritingState.comments = officialWritingState.comments.slice(0, OFFICIAL_WRITING_COMMENT_LIMIT);
    }
    if (textEl) textEl.value = '';
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
}

function deleteOfficialWritingComment(commentId) {
    officialWritingState.comments = officialWritingState.comments.filter(comment => comment.id !== commentId);
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
}

function addOfficialWritingSuggestion(payload) {
    const suggestion = {
        id: `suggestion-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        status: 'pending',
        createdAt: new Date().toISOString(),
        ...payload
    };
    officialWritingState.suggestions.unshift(suggestion);
    if (officialWritingState.suggestions.length > OFFICIAL_WRITING_SUGGESTION_LIMIT) {
        officialWritingState.suggestions = officialWritingState.suggestions.slice(0, OFFICIAL_WRITING_SUGGESTION_LIMIT);
    }
    saveOfficialWritingState();
    openOfficialWritingDrawer('suggestions');
    renderOfficialWritingWorkspace();
    return suggestion;
}

function saveOfficialWritingVersion(stage = '') {
    syncOfficialWritingStateFromInputs();
    if (!officialWritingState.draft.trim() && !officialWritingState.source.trim()) {
        showToast('暂无正文或材料，无法保存版本', 'warning');
        return;
    }
    const nameInput = document.getElementById('official-writing-version-name');
    const stageLabel = typeof stage === 'string' ? stage.trim() : '';
    const name = nameInput?.value.trim() || (stageLabel ? `${stageLabel} ${officialWritingState.versions.length + 1}` : `正文稿 ${officialWritingState.versions.length + 1}`);
    officialWritingState.versions.unshift({
        id: `version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name,
        stage: stageLabel || '普通版本',
        source: officialWritingState.source,
        draft: officialWritingState.draft,
        createdAt: new Date().toISOString()
    });
    if (nameInput) nameInput.value = '';
    saveOfficialWritingState();
    renderOfficialWritingWorkspace();
    showToast(stageLabel ? `${stageLabel}已生成` : '版本已保存');
}

function loadOfficialWritingVersion(versionId) {
    const version = [...officialWritingState.versions, ...(officialWritingState.autoSaves || [])].find(item => item.id === versionId);
    if (!version) return;
    pushOfficialWritingUndoSnapshot();
    setOfficialWritingTextareaValue('draft', version.draft || '');
    syncOfficialWritingStateFromInputs();
    renderOfficialWritingWorkspace();
    showToast('已载入版本到正文稿');
}

function getVersionCompareText(value) {
    if (value === 'source') return officialWritingState.source || '';
    if (value === 'draft') return officialWritingState.draft || '';
    const version = officialWritingState.versions.find(item => item.id === value);
    return version?.draft || '';
}

function buildLineDiff(leftText, rightText) {
    const left = String(leftText || '').split(/\n{2,}/);
    const right = String(rightText || '').split(/\n{2,}/);
    const max = Math.max(left.length, right.length);
    const rows = [];
    let changed = 0;
    for (let index = 0; index < max; index += 1) {
        const before = left[index] ?? '';
        const after = right[index] ?? '';
        if (before === after) {
            rows.push({ type: 'same', before, after, line: index + 1 });
        } else {
            changed += 1;
            const type = before && after ? 'changed' : before ? 'removed' : 'added';
            rows.push({ type, before, after, line: index + 1 });
        }
    }
    return { rows, changed, total: max };
}

function compareOfficialWritingVersions() {
    syncOfficialWritingStateFromInputs();
    const left = getVersionCompareText(document.getElementById('official-writing-base-version')?.value || 'source');
    const right = getVersionCompareText(document.getElementById('official-writing-target-version')?.value || 'draft');
    const diff = buildLineDiff(left, right);
    const summary = document.getElementById('official-writing-diff-summary');
    const result = document.getElementById('official-writing-diff-result');
    if (summary) summary.textContent = `共 ${diff.total} 段，${diff.changed} 段存在差异`;
    if (!result) return;
    result.innerHTML = diff.rows.map(row => `
        <div class="official-writing-diff-row is-${row.type}">
            <span>段 ${row.line}</span>
            <p>${escapeAppsHtml(row.before || ' ')}</p>
            <p>${escapeAppsHtml(row.after || ' ')}</p>
        </div>
    `).join('');
}

async function copyAppsText(text) {
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
    if (!success) throw new Error('copy failed');
}

function buildOfficialWritingPrompt() {
    syncOfficialWritingStateFromInputs();
    const docType = getOfficialWritingDocType();
    const mode = getOfficialWritingMode();
    const modeLabel = OFFICIAL_WRITING_MODES[mode] || '起草正文';
    const requirements = getOfficialWritingRequirements();
    const summary = getOfficialWritingWorkspaceSummary();
    const comments = officialWritingState.comments.map(comment => `- [${comment.target === 'draft' ? '正文稿' : '原文'} / ${comment.anchor || '全文'}] ${comment.text}`).join('\n');
    const lines = [
        `请作为公文写作助手，基于编辑器内容完成「${docType}」的「${modeLabel}」。`,
        '',
        `规范库：${getOfficialWritingStandard()}`,
        `材料来源：${getOfficialWritingMaterialSource()}`,
        `工作区状态：${summary.statusTitle}（${summary.statusDetail}）`,
        `待处理建议：${summary.pendingSuggestions} 条，规范风险：${summary.risks.length} 项，材料引用：${summary.referenceCount} 处。`,
        '',
        '处理要求：',
        '- 使用规范、准确、克制的公文语体。',
        '- 不编造单位、时间、数据和事实；缺失信息请用【待补充】标注。',
        '- 优先保留原有事实信息，优化结构、语气和表达。'
    ];
    if (mode === 'rewrite_section') lines.push('- 对当前正文稿进行整体改写，保留事实信息和必要结构。');
    if (mode === 'review') lines.push('- 按“问题 / 建议 / 示例修改”输出审校意见。');
    if (requirements) lines.push(`- 用户补充要求：${requirements}`);
    lines.push('', '原文：', officialWritingState.source || '【暂无原文】', '', '当前正文稿：', officialWritingState.draft || '【暂无正文稿】');
    if (comments) {
        lines.push('', '批注：', comments);
    }
    return lines.join('\n');
}

async function copyOfficialWritingPrompt() {
    const prompt = buildOfficialWritingPrompt();
    try {
        await copyAppsText(prompt);
        showToast('提示词已复制');
    } catch (e) {
        showToast('复制失败，请手动选择内容复制', 'error');
    }
}


function sendOfficialWritingToChat() {
    const prompt = buildOfficialWritingPrompt();
    window.showMainWorkspace?.('chat');
    const input = document.getElementById('user-input');
    if (!input) return;
    input.value = prompt;
    window.resizeUserInput?.();
    input.focus();
    showToast('已带入聊天，请确认后发送');
}
