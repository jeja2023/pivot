/* 助手侧任务建议卡：本地轻量准入、显式用户触发、绝不直接执行。 */
(function () {
    const dismissed = new Set();
    let sendBusy = false;
    let planningBusy = false;
    let activeCard = null;

    const ACTION_PATTERN = /(查询|检索|读取|收集|汇总|整理|分析|核对|比对|生成|导出|更新|同步|跟进|监控|修复|部署|发布|发送|通知|执行|查找|统计|审查|对账|query|search|read|collect|summari[sz]e|analy[sz]e|verify|compare|generate|export|update|sync|monitor|fix|deploy|publish|send)/gi;
    const DELIVERY_PATTERN = /(报告|表格|清单|方案|文档|摘要|结论|看板|邮件|通知|交付物|文件|report|table|checklist|document|summary|dashboard)/i;
    const TASK_INTENT_PATTERN = /(任务|执行计划|后台|自动化|工作流|完成后|失败重试|持续跟进|task|plan|background|automation|workflow)/i;
    const CREATIVE_OR_QA_PATTERN = /^(?:请|帮我|能否|可以)?\s*(?:解释|说明|介绍|翻译|润色|改写|续写|写一封|写个|什么是|为什么|怎么做|how|what|why|translate|rewrite|explain)/i;

    function countActions(value) {
        const matches = String(value || '').match(ACTION_PATTERN) || [];
        return new Set(matches.map(item => item.toLowerCase())).size;
    }

    // 准入规则采用纯本地与确定性逻辑。绝不调用
    // 模型、知识库检索、长期记忆、工具目录或外部能力。
    function classifyTaskSuggestion(value) {
        const text = String(value || '').trim();
        if (text.length < 12 || text.startsWith('@') || CREATIVE_OR_QA_PATTERN.test(text)) return null;
        const actionCount = countActions(text);
        const explicitTask = TASK_INTENT_PATTERN.test(text);
        const deliverable = DELIVERY_PATTERN.test(text);
        if (!explicitTask && actionCount < 2 && !(actionCount >= 1 && deliverable)) return null;
        return {
            category: explicitTask ? 'explicit_task' : (deliverable ? 'deliverable_workflow' : 'multi_step_workflow'),
            title: '可将此请求转为受控任务',
            description: '先生成计划并审阅，不会立即执行。'
        };
    }

    function isAgentExecutionAvailable() {
        return window.Pivot.moduleApi('chat.inputMenu')?.isAgentExecutionEnabled?.() !== false;
    }

    function removeActiveCard() {
        if (activeCard?.isConnected) activeCard.remove();
        activeCard = null;
    }

    function dismiss({ sessionId, category } = {}) {
        if (sessionId && category) dismissed.add(`${sessionId}:${category}`);
        removeActiveCard();
    }

    function button(label, className, handler, title = '') {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = className;
        element.textContent = label;
        if (title) element.title = title;
        element.addEventListener('click', handler);
        return element;
    }

    function createCard({ messageContent, goal, sessionId, candidate }) {
        const card = document.createElement('section');
        card.className = 'chat-task-suggestion-card';
        card.dataset.taskSuggestionCategory = candidate.category;
        card.setAttribute('aria-label', '任务建议：先审阅计划，不会立即执行');

        const copy = document.createElement('div');
        copy.className = 'chat-task-suggestion-copy';
        const icon = document.createElement('span');
        icon.className = 'chat-task-suggestion-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '✦';
        const text = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = candidate.title;
        const description = document.createElement('p');
        description.textContent = candidate.description;
        text.append(title, description);
        copy.append(icon, text);

        const actions = document.createElement('div');
        actions.className = 'chat-task-suggestion-card-actions';
        const planButton = button('生成计划', 'btn-secondary chat-task-suggestion-plan', async () => {
            if (planningBusy || !isAgentExecutionAvailable()) return;
            planningBusy = true;
            card.classList.add('is-busy');
            planButton.disabled = true;
            try {
                await window.Pivot.moduleApi('chat.execution').createTaskDraft({
                    goal,
                    opener: planButton,
                    clearInput: false
                });
            } finally {
                planningBusy = false;
                card.classList.remove('is-busy');
                planButton.disabled = false;
            }
        }, '生成并审阅执行计划；不会立即执行');
        const dismissButton = button('暂不需要', 'chat-task-suggestion-dismiss', () => dismiss({ sessionId, category: candidate.category }), '关闭当前任务建议，本会话不再显示同类建议');
        actions.append(planButton, dismissButton);
        card.append(copy, actions);

        const footer = messageContent.querySelector('.message-footer');
        const messageActions = messageContent.querySelector('.message-actions');
        messageContent.insertBefore(card, footer || messageActions || null);
        return card;
    }

    function showForResponse({ messageContent, goal, sessionId = '' } = {}) {
        removeActiveCard();
        const candidate = classifyTaskSuggestion(goal);
        const key = `${String(sessionId || '')}:${candidate?.category || ''}`;
        if (!candidate || !messageContent?.isConnected || sendBusy || planningBusy || !isAgentExecutionAvailable() || dismissed.has(key)) return null;
        activeCard = createCard({ messageContent, goal: String(goal || '').trim(), sessionId: String(sessionId || ''), candidate });
        window.Pivot.legacy.scrollMessagesToBottom?.({ duration: 260 });
        return activeCard;
    }

    async function promoteFromInput() {
        const input = document.getElementById('user-input');
        const value = String(input?.value || '').trim();
        if (!/^\/task\s+.+/i.test(value)) return false;
        return await window.Pivot.moduleApi('chat.execution').createTaskDraft({
            goal: value,
            opener: input,
            clearInput: true
        });
    }

    document.addEventListener('pivot:chat-agent-execution-state', event => {
        if (event.detail?.enabled === false) removeActiveCard();
    });

    window.Pivot.exposeModule('chat.taskSuggestion', {
        classify: classifyTaskSuggestion,
        dismiss,
        promoteFromInput,
        setPlanningBusy: value => { planningBusy = Boolean(value); },
        setSendBusy: value => { sendBusy = Boolean(value); },
        showForResponse
    });
}());
