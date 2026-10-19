/* global document, Event, sessionStorage, window -- Playwright 浏览器端执行上下文全局变量 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const XLSX = require('@e965/xlsx');
const Sqlite = require('better-sqlite3');
const { spawnSync } = require('node:child_process');
const { expect, test } = require('@playwright/test');

if (process.env.PIVOT_E2E_DEBUG === 'true') {
    test.beforeEach(({ page }) => {
        page.on('pageerror', error => console.error(`[pageerror] ${error.stack || error.message}`));
        page.on('console', message => {
            if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
        });
    });
}

async function ensureBrowserSession(page) {
    await page.goto('/chat', { waitUntil: 'domcontentloaded' });
    const app = page.locator('#app');
    try {
        await expect(app).toBeVisible({ timeout: 8_000 });
        return;
    } catch (_) {
        // Cookie 登录失败或未完成时，回退到真实登录表单。
    }
    await expect(page.locator('#username')).toBeVisible({ timeout: 8_000 });
    if (await page.locator('#username').isVisible()) {
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
        await page.locator('#auth-submit').click();
    }
    await expect(page.locator('#auth-container')).toBeHidden({ timeout: 15_000 });
    await expect(app).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
}

async function expectDataAnalysisSidebarNavigationLayout(page) {
    const menuItems = await page.locator('.data-analysis-tabs .data-analysis-tab').evaluateAll(items => items.map(item => {
        const rect = item.getBoundingClientRect();
        return {
            tab: item.dataset.dataAnalysisTab,
            left: rect.left,
            width: rect.width,
            display: window.getComputedStyle(item).display,
            hasSecondaryButtonStyle: item.classList.contains('btn-secondary')
        };
    }));
    const overviewMenuItem = menuItems.find(item => item.tab === 'overview');
    expect(overviewMenuItem).toBeTruthy();
    for (const item of menuItems) {
        expect(item.display).toBe('flex');
        expect(item.hasSecondaryButtonStyle).toBe(false);
        expect(Math.abs(item.left - overviewMenuItem.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(item.width - overviewMenuItem.width)).toBeLessThanOrEqual(1);
    }
}

test.describe('Pivot browser smoke', () => {
    for (const native of [false, true, 'server']) test(native === 'server' ? '浏览器无中文包时两个语音按钮经部署内服务器正常工作' : native ? '桌面语音绕过浏览器中文语音包并贯通连续对话' : '语音按钮贯通本地识别、两轮模型对话、朗读及停止', async ({ page }) => {
        await page.addInitScript(useNative => {
            window.__voiceTest = { spoken: [], stopped: 0, active: null };
            class Recognition {
                constructor() { this.processLocally = false; }
                static available() { return Promise.resolve('available'); }
                start() { window.__voiceTest.active = this; setTimeout(() => this.onstart?.(), 0); }
                abort() {}
            }
            Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
            if (useNative === true) {
                Recognition.available = () => Promise.resolve('unavailable');
                let listener;
                window.pivotDesktop = {
                    getVoiceRecognitionStatus: async () => ({ available: true, languages: ['zh-CN'] }),
                    onVoiceRecognitionEvent(callback) { listener = callback; return () => { listener = null; }; },
                    async startVoiceRecognition(input) {
                        const active = { onresult(event) {
                            listener?.({ id: input.id, type: 'result', text: event.results[0][0].transcript });
                        } };
                        window.__voiceTest.active = active;
                        listener?.({ id: input.id, type: 'started' });
                        return { success: true };
                    },
                    async stopVoiceRecognition() { window.__voiceTest.stopped++; }
                };
            }
            if (useNative === 'server') {
                Recognition.available = () => Promise.resolve('unavailable');
                const node = () => ({ connect() {}, disconnect() {} });
                Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {
                    constructor() { this.sampleRate = 16000; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
                    createMediaStreamSource() { return node(); }
                    createGain() { return { ...node(), gain: { value: 0 } }; }
                    resume() { return Promise.resolve(); }
                    close() { return Promise.resolve(); }
                } });
                Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: class {
                    constructor() {
                        this.port = {};
                        window.__voiceTest.active = { onresult: () => {
                            this.port.onmessage({ data: new Float32Array(8000).fill(0.1) });
                            this.port.onmessage({ data: new Float32Array(16000).fill(0) });
                        } };
                    }
                    connect() {} disconnect() {}
                } });
            }
            Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: {
                getUserMedia: async () => ({ getTracks: () => [{ stop() { window.__voiceTest.stopped++; } }] })
            } });
            Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
                getVoices: () => [{ name: 'Test local', lang: 'zh-CN', localService: true }],
                cancel() {}, speak(utterance) { window.__voiceTest.spoken.push(utterance.text); setTimeout(() => utterance.onend?.(), 0); }
            } });
            Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: class { constructor(text) { this.text = text; } } });
        }, native);
        let transcriptions = 0;
        if (native === 'server') {
            await page.route('**/api/chat/voice-recognition', route => route.fulfill({ contentType: 'application/json',
                body: JSON.stringify({ available: true, languages: ['zh-CN'], thirdPartyForwarding: false, audioRetention: 'none' }) }));
            await page.route('**/api/chat/voice-transcriptions', route => {
                const input = route.request().postDataJSON();
                expect(input.language).toBe('zh-CN');
                expect(Buffer.from(input.audioBase64, 'base64').subarray(0, 4).toString()).toBe('RIFF');
                const text = ['语音草稿测试', '解释一下四季形成的原因', '继续刚才的话题'][transcriptions++];
                return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, text }) });
            });
        } else {
            await page.route('**/api/chat/voice-recognition', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: false, reason: '测试浏览器本地路径' }) }));
        }
        await ensureBrowserSession(page);
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const name = `Voice e2e ${Date.now()}`;
        expect((await page.request.post('/api/models', { headers: { 'x-csrf-token': csrf },
            data: { name, url: process.env.E2E_MODEL_URL, model_name: 'voice-e2e', supports_vision: 1 } })).ok()).toBeTruthy();
        const models = await (await page.request.get('/api/models?limit=100')).json();
        const model = models.data.find(item => item.name === name);
        const originalDefault = models.data.find(item => Number(item.is_default) === 1);
        await page.request.put('/api/settings/default-model', { headers: { 'x-csrf-token': csrf }, data: { default_model_id: model.id } });
        await page.reload();
        await ensureBrowserSession(page);
        await expect(page.locator('#model-selector')).toHaveValue(String(model.id));
        await page.locator('#chat-voice-input').click();
        await page.waitForFunction(() => !!window.__voiceTest.active?.onresult);
        await page.evaluate(() => window.__voiceTest.active.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '语音草稿测试' } }] }));
        await expect(page.locator('#user-input')).toHaveValue('语音草稿测试');
        if (native !== 'server') await page.locator('#chat-voice-input').click();
        await page.locator('#user-input').fill('');
        const requests = [];
        page.on('request', request => { if (new URL(request.url()).pathname === '/api/chat') requests.push(request.postDataJSON()); });
        await page.locator('#chat-realtime-voice').click();
        await expect(page.locator('#chat-realtime-voice')).toHaveAttribute('aria-pressed', 'true');
        const say = async text => {
            await page.evaluate(value => window.__voiceTest.active.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: value } }] }), text);
            await expect(page.locator('#send-btn')).toBeVisible();
        };
        await say('解释一下四季形成的原因');
        await expect.poll(() => page.evaluate(() => window.__voiceTest.spoken.length)).toBeGreaterThan(0);
        await page.waitForTimeout(120);
        await say('继续刚才的话题');
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[0].content).toBe('解释一下四季形成的原因');
        expect(requests[1].voiceHistory.some(item => item.content === requests[0].content)).toBe(true);
        await expect.poll(() => page.evaluate(() => window.__voiceTest.spoken.length)).toBeGreaterThan(1);
        await page.locator('#chat-realtime-voice').click();
        await expect(page.locator('#chat-realtime-voice')).toHaveAttribute('aria-pressed', 'false');
        expect(await page.evaluate(() => window.__voiceTest.stopped)).toBeGreaterThanOrEqual(2);
        const detail = await (await page.request.get(`/api/sessions/${requests[0].sessionId}`)).json();
        expect(detail.messages || []).toHaveLength(0);
        if (originalDefault?.id) {
            await page.request.put('/api/settings/default-model', { headers: { 'x-csrf-token': csrf }, data: { default_model_id: originalDefault.id } }).catch(() => {});
        }
        if (native === 'server') expect(transcriptions).toBe(3);
    });

    test('浏览器真实音频工作线程经 HTTP 和服务器实际引擎识别合成中文音频', async ({ page }) => {
        test.skip(process.platform !== 'win32', '本用例验证 Windows 本地语音引擎');
        const source = [
            "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.Speech",
            '$voiceSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
            "$voiceName = $voiceSynth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1",
            '$voiceSynth.SelectVoice($voiceName.VoiceInfo.Name)',
            '$voiceBytes = New-Object System.IO.MemoryStream',
            '$voiceSynth.SetOutputToWaveStream($voiceBytes)',
            "$voiceSynth.Speak('你好，这是一个本地语音测试。')",
            '$voiceSynth.SetOutputToNull(); $voiceSynth.Dispose()',
            '[Console]::Out.WriteLine([Convert]::ToBase64String($voiceBytes.ToArray())); $voiceBytes.Dispose()'
        ].join('\n');
        const generated = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
            { windowsHide: true, encoding: 'utf8', timeout: 15000 });
        expect(generated.status).toBe(0);
        await page.addInitScript(base64 => {
            Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
            Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
            Object.defineProperty(window.navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
                const context = new window.AudioContext();
                const bytes = Uint8Array.from(window.atob(base64), value => value.charCodeAt(0));
                const buffer = await context.decodeAudioData(bytes.buffer);
                const sound = context.createBufferSource(); sound.buffer = buffer;
                const output = context.createMediaStreamDestination(); sound.connect(output);
                await context.resume();
                setTimeout(() => sound.start(), 500);
                const stop = output.stream.getTracks()[0].stop.bind(output.stream.getTracks()[0]);
                output.stream.getTracks()[0].stop = () => { stop(); void context.close(); };
                return output.stream;
            } });
        }, generated.stdout.trim());
        await ensureBrowserSession(page);
        const status = await (await page.request.get('/api/chat/voice-recognition')).json();
        expect(status.available).toBe(true);
        expect(status.thirdPartyForwarding).toBe(false);
        const request = page.waitForResponse(response => response.url().endsWith('/api/chat/voice-transcriptions'));
        await page.locator('#chat-voice-input').click();
        const recognized = await request;
        expect(recognized.ok()).toBe(true);
        const data = await recognized.json();
        expect(data.provider).toBe('server_windows_speech');
        expect(data.audioRetention).toBe('none');
        expect(data.text).toContain('你好');
        await expect(page.locator('#user-input')).toHaveValue(data.text);
        await expect(page.locator('#chat-voice-input')).toHaveAttribute('aria-pressed', 'false');
    });

    test('自动记忆融入聊天并保留可用的个人设置开关', async ({ page }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await ensureBrowserSession(page);
        await expect(page.locator('#chat-memory-menu')).toHaveCount(0);
        await expect(page.locator('#chat-memory-intent-modal')).toHaveCount(0);
        await page.evaluate(() => window.Pivot.moduleApi('chat.memoryActions').openChatMemoryManagement());
        const toggle = page.locator('#long-term-memory-toggle');
        await expect(toggle).toBeVisible();
        await expect(page.locator('#tab-content-memories')).toContainText('无需手动保存或逐条确认');
        await expect(toggle).toBeChecked();
        const save = page.waitForResponse(response => response.url().endsWith('/api/memories/settings') && response.request().method() === 'PUT');
        await toggle.uncheck();
        expect((await (await save).json()).enabled).toBe(false);
        const restore = page.waitForResponse(response => response.url().endsWith('/api/memories/settings') && response.request().method() === 'PUT');
        await toggle.check();
        expect((await (await restore).json()).enabled).toBe(true);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
        await expect(page.locator('#user-input')).toBeVisible();
        expect(errors).toEqual([]);
    });

    test('login form establishes a browser session and reveals the authenticated workspace', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#auth-container')).toBeVisible();
        await page.locator('#username').fill('admin');
        await page.locator('#password').fill(process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123');
        await page.locator('#auth-submit').click();
        await expect(page.locator('#auth-container')).toBeHidden();
        await expect(page.locator('#app')).toBeVisible();
        await expect(page.locator('#user-info')).toContainText(/admin|管理员/i);
    });

    test('对话页模型统计样式来自首屏消息壳，而不是设置工作区 CSS', async ({ page }) => {
        await ensureBrowserSession(page);
        const stats = page.locator('#message-container .message-stats').first();
        await expect(stats).toHaveCount(0);
        await page.evaluate(() => {
            const container = document.getElementById('message-container');
            const message = document.createElement('div');
            message.className = 'message assistant';
            message.innerHTML = `
                <div class="avatar">✦</div>
                <div class="message-content">
                    <div class="text-body"><p>样式回归测试消息</p></div>
                    <div class="message-footer">
                        <div class="message-stats">
                            <span class="stat-item stat-model">◈chatgpt-5.5</span>
                            <span class="stat-item">◷10.0s</span>
                            <span class="stat-item">◈305 Tokens</span>
                            <span class="stat-item">↯30.4 t/s</span>
                        </div>
                    </div>
                </div>`;
            container.appendChild(message);
        });
        const renderedStats = page.locator('#message-container .message-stats').last();
        await expect(renderedStats).toBeVisible();
        await expect.poll(() => renderedStats.evaluate(element => {
            const style = window.getComputedStyle(element);
            const model = window.getComputedStyle(element.querySelector('.stat-model'));
            return style.borderRadius === '999px'
                && style.gap === '8px'
                && style.backgroundColor.includes('15, 23, 42')
                && ['flex', 'inline-flex'].includes(style.display)
                && model.maxWidth === '180px';
        })).toBe(true);
    });

    test('对话列表可被真实鼠标滚轮滚动，触底后自动继续加载下一页', async ({ page }) => {
        await page.route('**/api/sessions?*', async route => {
            const url = new URL(route.request().url());
            const isAppend = Boolean(url.searchParams.get('cursor') || url.searchParams.get('page') === '2');
            if (isAppend) {
                return route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify({
                        data: Array.from({ length: 5 }, (_, i) => ({
                            id: 9900 + i,
                            title: `滚动加载会话 ${i + 1}`,
                            updated_at: new Date().toISOString()
                        })),
                        hasMore: false
                    })
                });
            }
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({
                    data: Array.from({ length: 25 }, (_, i) => ({
                        id: 9800 + i,
                        title: `初始会话 ${i + 1}`,
                        updated_at: new Date().toISOString()
                    })),
                    hasMore: true,
                    cursor: 'mock-cursor-page-2'
                })
            });
        });
        await ensureBrowserSession(page);
        const list = page.locator('#session-list');
        await expect(list).toBeVisible();
        await page.evaluate(() => document.body.classList.add('pivot-desktop-runtime'));
        await expect.poll(() => list.evaluate(element => {
            const style = window.getComputedStyle(element);
            return {
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
                isScrollable: ['auto', 'scroll'].includes(style.overflowY),
                minHeight: style.minHeight
            };
        })).toMatchObject({ isScrollable: true, minHeight: '0px' });
        const initialMetrics = await list.evaluate(element => ({
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight
        }));
        if (initialMetrics.scrollHeight > initialMetrics.clientHeight) {
            await list.hover();
            await page.mouse.wheel(0, 640);
            await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        }
        if (await list.locator('.session-item').count() > 0) {
            const before = await list.locator('.session-item').count();
            await list.hover();
            await page.mouse.wheel(0, 4_000);
            await expect.poll(() => list.locator('.session-item').count()).toBeGreaterThan(before);
        }
    });

    test('Agent 工作台 exposes profile wizard, goals, inbox and channel controls', async ({ page }) => {
        await ensureBrowserSession(page);
        await expect(page.locator('#agent-workbench-modal')).toHaveCount(0);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.());
        await expect(page.locator('#agent-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
        await expect(page.locator('#agent-control-plane')).toBeVisible();
        await page.locator('[data-agent-cp-subview="governance"]').click();
        await expect(page.locator('[data-agent-cp-pane="governance"]')).toBeVisible();
        await page.locator('[data-agent-cp-subview="inbox"]').click();
        await expect(page.locator('#agent-inbox-panel')).toBeVisible();
        await page.locator('[data-agent-cp-subview="goals"]').click();
        await expect(page.locator('#agent-goals-panel')).toBeVisible();
        await page.locator('[data-agent-cp-subview="channels"]').click();
        await expect(page.locator('#agent-channels-panel')).toBeVisible();
        await page.locator('[data-agent-cp-subview="goals"]').click();
        await page.locator('#agent-profile-wizard-panel').evaluate(panel => { panel.classList.remove('hidden'); panel.style.display = 'block'; });
        await expect(page.locator('#agent-profile-wizard-panel')).toHaveClass(/agent-profile-wizard-panel/);
        await page.locator('#agent-goal-create').evaluate(button => button.click());
        await expect(page.locator('#agent-goal-editor')).toBeVisible();
        await page.locator('#agent-goal-title').fill('E2E 临时目标');
        await page.locator('#agent-goal-goal').fill('E2E 验证持续目标入口');
        await page.locator('#agent-goal-trigger').selectOption('manual');
        await page.locator('#agent-goal-editor button[type="submit"]').click();
        await expect(page.locator('#agent-goals-panel')).toContainText('E2E 临时目标');

        await page.locator('#agent-workbench-modal [data-automation-section="workflows"]').click();
        await expect(page.locator('#agent-dag-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#agent-workbench-modal')).toBeHidden();
    });

    test('个人档案偏好编辑器以标签管理工作习惯、任务和工具，并适配窄屏', async ({ page }) => {
        await page.setViewportSize({ width: 1920, height: 800 });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.());
        await expect(page.locator('#agent-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.locator('#agent-workbench-modal [data-automation-section="workbench"]').click();
        await page.locator('[data-agent-cp-subview="governance"]').click();
        await expect(page.locator('#agent-profile-preferences-editor')).toBeVisible();
        await expect.poll(() => page.locator('.agent-profile-preference-grid').evaluate(element => window.getComputedStyle(element).gridTemplateColumns)).toMatch(/^[\d.]+px [\d.]+px [\d.]+px$/);

        const habitInput = page.locator('#agent-profile-work-habits-input');
        await habitInput.fill('先给出可执行结论');
        await habitInput.press('Enter');
        await expect(page.locator('#agent-profile-work-habits')).toContainText('先给出可执行结论');
        await expect(page.locator('#agent-profile-tools-suggestions')).toBeVisible();
        await expect.poll(() => page.locator('#agent-control-plane').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
        await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'agent-profile-preferences-desktop.png'), fullPage: true });

        await page.setViewportSize({ width: 640, height: 900 });
        await expect.poll(() => page.locator('.agent-profile-preference-grid').evaluate(element => window.getComputedStyle(element).gridTemplateColumns)).toMatch(/^[\d.]+px$/);
        await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'agent-profile-preferences-mobile.png'), fullPage: true });
    });

    test('组织管理员可在 Agent 控制台编辑受限协作角色策略', async ({ page }) => {
        const policies = {
            researcher: { id: 'researcher-org-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 12, maxTokenBudget: 30000 },
            analyst: { id: 'analyst-org-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 12, maxTokenBudget: 30000 },
            reviewer: { id: 'reviewer-org-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 8, maxTokenBudget: 20000 },
            writer: { id: 'writer-org-v1', toolPolicy: 'builtin_only', approvalPolicy: 'approve_all_mcp', maxSteps: 8, maxTokenBudget: 20000 }
        };
        let saved = null;
        await page.route('**/api/agents/delegation/role-policies', async route => {
            if (route.request().method() === 'PUT') {
                saved = route.request().postDataJSON();
                await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: { organizationId: 1, policies: { ...policies, ...saved.policies } } }) });
                return;
            }
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { organizationId: 1, policies } }) });
        });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.({ tab: 'workbench', subview: 'governance' }));
        await expect(page.locator('#agent-workbench-modal')).toBeVisible({ timeout: 15_000 });
        const policyTab = page.locator('[data-agent-harness-nav="delegation-policies"]');
        await expect(policyTab).toBeVisible();
        await policyTab.click();
        const panel = page.locator('[data-agent-harness-section="delegation-policies"]');
        await expect(panel).toBeVisible();
        const reviewerSteps = panel.locator('[data-agent-delegation-max-steps="reviewer"]');
        await expect(reviewerSteps).toHaveClass(/form-input/);
        await reviewerSteps.fill('5');
        await panel.locator('[data-agent-delegation-max-tokens="reviewer"]').fill('10000');
        await panel.locator('#agent-delegation-policy-save').click();
        await expect.poll(() => saved?.policies?.reviewer?.maxSteps).toBe(5);
        expect(saved.policies.reviewer.maxTokenBudget).toBe(10000);
        await expect(panel).toContainText('仅内置工具');
        await expect(panel).toContainText('始终审批 MCP');
    });

    test('自动化任务与工作流在样式延迟时显示稳定加载页，样式就绪后再展示内容', async ({ page }) => {
        await ensureBrowserSession(page);
        const agentStylePreload = page.locator('link[data-pivot-workspace-style-preload="/chat/chat.workspace.agent.css"]');
        await expect(agentStylePreload).toHaveCount(0);

        await page.evaluate(() => {
            const styles = window.Pivot.moduleApi('workspaces.styleLoader');
            let resolve = null;
            window.__resolveAutomationStyleGate = () => resolve?.();
            styles.isWorkspaceStyleLoaded = () => false;
            styles.waitForWorkspaceStyles = () => Promise.resolve(false);
            styles.whenWorkspaceStylesLoaded = () => new Promise(done => { resolve = done; });
        });
        await page.evaluate(() => { void window.Pivot.moduleApi('workspaces.navigation').openAgentWorkbench?.(); });
        const agentPanel = page.locator('#agent-workbench-modal');
        await expect(agentPanel).toBeVisible({ timeout: 15_000 });
        await expect(agentPanel).toHaveClass(/workspace-style-gated/);
        await expect(agentPanel.locator(':scope > .workspace-style-gate')).toContainText('正在准备自动化工作台');
        await expect.poll(() => agentPanel.locator(':scope > .agent-modal').evaluate(element => window.getComputedStyle(element).visibility)).toBe('hidden');
        await page.evaluate(() => window.__resolveAutomationStyleGate());
        await expect(agentPanel.locator(':scope > .workspace-style-gate')).toHaveCount(0);
        await expect(agentPanel.locator(':scope > .agent-modal')).toBeVisible();

        await page.evaluate(() => { void window.Pivot.moduleApi('workspaces.navigation').openAgentDagWorkbench?.(); });
        const workflowPanel = page.locator('#agent-dag-workbench-modal');
        await expect(workflowPanel).toBeVisible({ timeout: 15_000 });
        await expect(workflowPanel).toHaveClass(/workspace-style-gated/);
        await expect(workflowPanel.locator(':scope > .workspace-style-gate')).toContainText('工作流编排器');
        await page.evaluate(() => window.__resolveAutomationStyleGate());
        await expect(workflowPanel.locator(':scope > .workspace-style-gate')).toHaveCount(0);
        await expect(workflowPanel.locator(':scope > .agent-dag-modal')).toBeVisible();
    });

    test('工作流画布支持负坐标拖拽、缩放与自由平移', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => { void window.Pivot.moduleApi('workspaces.navigation').openAgentDagWorkbench?.({ editor: true }); });
        const canvas = page.locator('#agent-dag-editor-canvas');
        await expect(canvas).toBeVisible({ timeout: 15_000 });
        await expect(canvas.locator('.pivot-dag-svg')).toBeVisible({ timeout: 15_000 });

        await page.evaluate(() => {
            const textarea = document.getElementById('agent-dag-spec');
            textarea.value = JSON.stringify({
                nodes: [{ id: 'input_1', title: '工作流输入', tool: 'workflow.input', input: {}, dependsOn: [] }],
                layout: { input_1: { x: 80, y: 80 } }
            });
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            window.mountAgentDagEditor?.();
        });
        const node = canvas.locator('.pivot-dag-node[data-pivot-dag-id="input_1"]');
        await expect(node).toBeVisible();
        const nodeBox = await node.boundingBox();
        if (!nodeBox) throw new Error('工作流节点没有可用的可视区域');
        await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(nodeBox.x - 360, nodeBox.y - 260, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => page.evaluate(() => {
            const layout = JSON.parse(document.getElementById('agent-dag-spec').value).layout || {};
            return layout.input_1 || null;
        })).toMatchObject({ x: expect.any(Number), y: expect.any(Number) });
        await expect.poll(() => page.evaluate(() => {
            const position = JSON.parse(document.getElementById('agent-dag-spec').value).layout?.input_1 || {};
            return Number(position.x) < 0 && Number(position.y) < 0;
        })).toBe(true);

        const root = canvas.locator('.pivot-dag-svg');
        const beforeZoom = await root.getAttribute('viewBox');
        await canvas.getByRole('button', { name: '放大画布' }).click();
        await expect.poll(() => root.getAttribute('viewBox')).not.toBe(beforeZoom);
        await canvas.getByRole('button', { name: '适配全部节点到当前画布' }).click();
        const initialView = canvas.getByRole('button', { name: '默认缩放并将现有节点居中' });
        await expect(initialView).toBeVisible();
        await initialView.click();
        await expect(node).toBeVisible();
        await expect.poll(async () => {
            const [currentNodeBox, canvasBox] = await Promise.all([node.boundingBox(), canvas.boundingBox()]);
            if (!currentNodeBox || !canvasBox) return false;
            return currentNodeBox.x + currentNodeBox.width > canvasBox.x
                && currentNodeBox.x < canvasBox.x + canvasBox.width
                && currentNodeBox.y + currentNodeBox.height > canvasBox.y
                && currentNodeBox.y < canvasBox.y + canvasBox.height;
        }).toBe(true);
    });

    test('表格分组汇总通过可点击上游字段选择器保存分组字段', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => { void window.Pivot.moduleApi('workspaces.navigation').openAgentDagWorkbench?.({ editor: true }); });
        await expect(page.locator('#agent-dag-editor-canvas')).toBeVisible({ timeout: 15_000 });
        await page.evaluate(() => {
            const textarea = document.getElementById('agent-dag-spec');
            textarea.value = JSON.stringify({
                nodes: [
                    {
                        id: 'query', title: '数据查询', tool: 'db.run_readonly_query', dependsOn: [],
                        input: {
                            queryBuilder: { columns: ['部门', '状态'] },
                            sql: 'SELECT department AS 部门, status AS 状态 FROM employees'
                        }
                    },
                    {
                        id: 'group', title: '表格分组汇总', tool: 'data.group_summary', dependsOn: ['query'],
                        input: { rows: '{{nodes.query.output.rows}}', groupBy: [], metrics: [{ field: '', aggregation: 'count', alias: '数量' }] }
                    }
                ],
                layout: { query: { x: 80, y: 80 }, group: { x: 400, y: 80 } }
            });
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            window.mountAgentDagEditor?.();
        });

        const groupNode = page.locator('.pivot-dag-node[data-pivot-dag-id="group"]');
        await groupNode.click();
        await page.locator('[data-pivot-dag-open-wizard]').click();
        const wizard = page.locator('#pivot-dag-input-wizard');
        const department = wizard.locator('[data-pivot-dag-group-field-option="部门"]');
        await expect(department).toBeVisible();
        await expect(wizard).toContainText('点击字段即可加入分组');
        await expect(wizard).not.toContainText('字段候选项来自上游查询配置');
        await expect(wizard).not.toContainText('从上游表格行添加一个或多个字段');
        await expect(wizard).toContainText('计数可留空；其他方式请选择数值字段并填写结果名称');
        await department.click();
        await expect(wizard.locator('[data-pivot-dag-group-field-value="部门"]')).toBeVisible();
        await expect(department).toBeDisabled();
        await wizard.locator('[data-pivot-dag-wizard-apply]').click();
        await expect(wizard).toHaveClass(/hidden/);
        await expect.poll(() => page.evaluate(() => {
            const spec = JSON.parse(document.getElementById('agent-dag-spec').value);
            return spec.nodes.find(node => node.id === 'group')?.input?.groupBy || [];
        })).toEqual(['部门']);
    });

    test('应用、知识库、工具库和设置工作区均在首次打开时按需挂载', async ({ page }) => {
        await ensureBrowserSession(page);
        const workspaces = [
            ['apps', 'apps-workbench-modal', () => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.()],
            ['knowledge', 'knowledge-workbench-modal', () => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.()],
            ['mcp', 'mcp-workbench-modal', () => window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.()],
            ['settings', 'admin-container', () => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true })]
        ];
        for (const [name, panelId, open] of workspaces) {
            await expect(page.locator(`#${panelId}`)).toHaveCount(0);
            const responsePromise = page.waitForResponse(response => response.url().endsWith(`/chat/workspaces/${name}`));
            await page.evaluate(open);
            await expect((await responsePromise).status()).toBe(200);
            await expect(page.locator(`#${panelId}`)).toBeVisible({ timeout: 15_000 });
            const styleName = name === 'settings' ? 'settings' : name;
            await expect(page.locator(`link[href*="/chat/chat.workspace.${styleName}.css"]`)).toHaveCount(1);
            await expect.poll(() => page.evaluate((href) => {
                const link = [...document.querySelectorAll('link[rel="stylesheet"]')]
                    .find(item => (item.getAttribute('href') || '').includes(href));
                return Boolean(link?.sheet);
            }, `/chat/chat.workspace.${styleName}.css`)).toBe(true);
            if (name === 'knowledge') {
                const table = page.locator('#knowledge-workbench-modal .data-table');
                await expect(table).toBeVisible();
                await expect.poll(() => table.evaluate(element => {
                    const header = element.querySelector('th');
                    const tableStyle = window.getComputedStyle(element);
                    const headerStyle = window.getComputedStyle(header);
                    return {
                        tableLayout: tableStyle.tableLayout,
                        headerBackground: headerStyle.backgroundColor,
                        headerBorder: headerStyle.borderTopStyle
                    };
                })).toEqual({
                    tableLayout: 'fixed',
                    headerBackground: 'rgb(248, 250, 252)',
                    headerBorder: 'solid'
                });
            }
            const closeButton = {
                apps: '#apps-modal-close',
                knowledge: '#knowledge-modal-close',
                mcp: '#mcp-modal-close',
                settings: '#admin-modal-close'
            }[name];
            const closeControl = page.locator(closeButton);
            await expect.poll(() => closeControl.evaluate(button => {
                const rect = button.getBoundingClientRect();
                const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return hit === button || button.contains(hit);
            })).toBe(true);
            if (name === 'knowledge' || name === 'mcp') {
                const closeFunction = name === 'knowledge' ? 'closeKnowledgeWorkbench' : 'closeMcpWorkbench';
                await page.evaluate((functionName) => {
                    const original = window.Pivot.legacy[functionName];
                    window.__workspaceCloseCalls = 0;
                    window.Pivot.legacy[functionName] = (...args) => {
                        window.__workspaceCloseCalls += 1;
                        return original(...args);
                    };
                }, closeFunction);
                await closeControl.click();
                await expect.poll(() => page.evaluate(() => window.__workspaceCloseCalls)).toBe(1);
                await expect(page.locator(`#${panelId}`)).toBeHidden();
            } else {
                await closeControl.click();
                await expect(page.locator(`#${panelId}`)).toBeHidden();
            }
        }
    });

    test('系统设置首次进入会等待设置样式完成后再展示画布', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.route('**/chat/chat.workspace.settings.css**', async route => {
            await new Promise(resolve => setTimeout(resolve, 6_000));
            await route.continue();
        });

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 20_000 });

        await expect.poll(() => page.evaluate(() => {
            const link = document.querySelector('link[data-pivot-workspace-style="/chat/chat.workspace.settings.css"]');
            const content = document.querySelector('.settings-workspace-view .admin-content');
            const panels = document.querySelector('#tab-content-monitor .monitor-panels');
            const canvas = document.querySelector('#settings-scale-canvas');
            return {
                styleLoaded: link?.dataset.loaded === 'true' && Boolean(link.sheet),
                contentDisplay: content ? window.getComputedStyle(content).display : '',
                panelsDisplay: panels ? window.getComputedStyle(panels).display : '',
                canvasPosition: canvas ? window.getComputedStyle(canvas).position : ''
            };
        })).toEqual({
            styleLoaded: true,
            contentDisplay: 'flex',
            panelsDisplay: 'grid',
            canvasPosition: 'absolute'
        });
    });

    test('数据概览首次进入后 Token 趋势按最终容器宽度绘制', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.route('**/api/stats/ops-summary', async route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ isPersonal: true, sessions: 1, messages: 2, attachments: 0, models: 1, tokens: 3000 })
        }));
        await page.route('**/api/stats/trend', async route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(Array.from({ length: 30 }, (_item, index) => ({
                day: `2026-09-${String(index + 1).padStart(2, '0')}`,
                tokens: 1000 + index * 100
            })))
        }));

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#tab-content-ops')).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => page.evaluate(() => {
            const canvas = document.getElementById('usage-trend-chart');
            const parent = canvas?.parentElement;
            return {
                visible: canvas?.style.visibility,
                width: canvas?.width,
                expectedWidth: Math.round((parent?.clientWidth || 0) * window.devicePixelRatio),
                pointCount: canvas ? Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
                    .some(channel => channel !== 0) : false
            };
        })).toMatchObject({
            visible: 'visible',
            pointCount: true
        });
        await expect.poll(() => page.evaluate(() => {
            const canvas = document.getElementById('usage-trend-chart');
            const parent = canvas?.parentElement;
            return canvas?.width === Math.round((parent?.clientWidth || 0) * window.devicePixelRatio);
        })).toBe(true);
    });

    test('工作区样式资源短暂失败时，知识库仍会挂载并保持关闭控件可点击', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => {
            window.Pivot.moduleApi('workspaces.styleLoader').waitForWorkspaceStyles = () => Promise.resolve(false);
        });
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.());
        const panel = page.locator('#knowledge-workbench-modal');
        const closeControl = page.locator('#knowledge-modal-close');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => closeControl.evaluate(button => {
            const rect = button.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit === button || button.contains(hit);
        })).toBe(true);
        await closeControl.click();
        await expect(panel).toBeHidden();
    });

    test('知识库在辅助统计尚未完成时优先渲染文档表', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.route('**/api/rag/quality-report', async route => {
            await new Promise(resolve => setTimeout(resolve, 2_000));
            await route.continue();
        });
        const docsResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/rag/docs');
        await page.evaluate(() => { void window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.(); });
        await docsResponse;
        const docsBody = page.locator('#rag-docs-body');
        const state = page.locator('#rag-workbench-state');
        await expect.poll(() => docsBody.getAttribute('data-loaded')).toBe('1');
        await expect(state).toContainText('文档已加载，正在补充统计信息');
    });

    test('工具库请求较慢或部分失败时显示可恢复状态，不显示空白页', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.route('**/api/mcp/governance', async route => {
            await new Promise(resolve => setTimeout(resolve, 700));
            await route.abort('failed');
        });
        await page.evaluate(() => { void window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.(); });
        const panel = page.locator('#mcp-workbench-modal');
        const state = page.locator('#mcp-workbench-state');
        await expect(panel).toBeVisible({ timeout: 15_000 });
        await expect(state).toContainText('正在加载工具库');
        await expect(state).toContainText('工具库已打开，但部分数据暂不可用', { timeout: 15_000 });
        await expect(state.getByRole('button', { name: '重试' })).toBeVisible();
    });

    test('系统监控固定在工作区视口内，仅慢查询与异常告警列表支持内部滚动', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.route('**/api/monitor/stats*', async route => {
            const response = await route.fetch().catch(() => null);
            const json = response?.ok() ? await response.json().catch(() => ({})) : {};
            json.observability = json.observability || {};
            json.observability.events = Array.from({ length: 24 }, (_, index) => ({
                id: index + 1,
                type: 'sql_slow',
                severity: index % 2 ? 'warning' : 'critical',
                message: `慢查询与异常告警验收记录 ${index + 1}`,
                duration_ms: 1200,
                created_at: new Date().toISOString()
            }));
            return route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify(json)
            });
        });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        await page.locator('#tab-monitor').click();
        await expect(page.locator('#tab-content-monitor')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#monitor-summary-grid .monitor-card')).toHaveCount(8, { timeout: 15_000 });
        await page.locator('#monitor-auto-refresh').uncheck();

        await page.evaluate(() => {
            const list = document.getElementById('monitor-observability-list');
            list.replaceChildren(...Array.from({ length: 24 }, (_, index) => {
                const row = document.createElement('div');
                row.className = `monitor-observability-row ${index % 2 ? 'is-warning' : 'is-critical'}`;
                row.textContent = `慢查询与异常告警验收记录 ${index + 1}`;
                return row;
            }));
        });

        await expect.poll(() => page.evaluate(() => {
            const content = document.querySelector('.settings-workspace-view .admin-content');
            const list = document.getElementById('monitor-observability-list');
            return {
                outerHasHorizontalOverflow: content.scrollWidth > content.clientWidth + 1,
                outerHasVerticalOverflow: content.scrollHeight > content.clientHeight + 1,
                documentHasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                documentHasVerticalOverflow: document.documentElement.scrollHeight > window.innerHeight + 1,
                alertCanScroll: list.scrollHeight > list.clientHeight,
                alertOverflowY: window.getComputedStyle(list).overflowY
            };
        })).toEqual({
            outerHasHorizontalOverflow: false,
            outerHasVerticalOverflow: false,
            documentHasHorizontalOverflow: false,
            documentHasVerticalOverflow: false,
            alertCanScroll: true,
            alertOverflowY: 'auto'
        });
    });

    test('工具库的动态操作在重绘后仍可刷新、自检并打开本机授权中心', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openMcpWorkbench?.());
        await expect(page.locator('#mcp-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#mcp-refresh-btn')).toBeVisible({ timeout: 15_000 });

        const refreshRequest = page.waitForRequest(request => (
            request.method() === 'GET' && new URL(request.url()).pathname === '/api/mcp/governance'
        ));
        await page.locator('#mcp-refresh-btn').click();
        await refreshRequest;
        await expect(page.locator('#mcp-refresh-btn')).toHaveText('刷新');

        await page.evaluate(() => {
            const api = window.Pivot.moduleApi('mcp.workbench');
            window.__mcpHealthCheckCalls = 0;
            api.runMcpBatchHealthCheck = async () => {
                window.__mcpHealthCheckCalls += 1;
            };
        });
        await page.locator('#mcp-health-check-btn').click();
        await expect.poll(() => page.evaluate(() => window.__mcpHealthCheckCalls)).toBe(1);

        await page.locator('[data-mcp-section="data"]').click();
        await expect(page.locator('[data-mcp-pane="data"]')).toBeVisible();
        await expect(page.locator('[data-mcp-open-local-auth] .mcp-source-btn-wrap em')).toHaveText(/授权/);
        await page.locator('[data-mcp-open-local-auth]').first().click();
        await expect(page.locator('#mcp-local-auth-modal')).toBeVisible();
        await expect(page.locator('#mcp-local-auth-body')).toContainText(/网页端|桌面客户端|本机授权/);

        await page.locator('#mcp-local-auth-close-btn').click();
        await page.locator('[data-mcp-create="database"]').click();
        await expect(page.locator('#mcp-edit-modal')).toBeVisible();
    });

    test('个人工作台入口可打开并关闭所有按需工作区', async ({ page }) => {
        test.setTimeout(90_000);
        await ensureBrowserSession(page);
        await page.evaluate(() => {
            sessionStorage.setItem('pivot.agent.onboarding.dismissed', '1');
            window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('personal');
        });
        await expect(page.locator('#personal-workbench-modal')).toBeVisible();
        const onboardingSkip = page.locator('#personal-agent-onboarding [data-onboarding-action="skip"]');
        if (await onboardingSkip.isVisible()) {
            await onboardingSkip.click();
            await expect(page.locator('#personal-agent-onboarding')).toBeHidden();
        }

        const cases = [
            ['open-apps', '#apps-workbench-modal', '#apps-modal-close'],
            ['open-automation', '#agent-workbench-modal', '#agent-modal-close'],
            ['open-knowledge', '#knowledge-workbench-modal', '#knowledge-modal-close'],
            ['open-tools', '#mcp-workbench-modal', '#mcp-modal-close'],
            ['open-settings', '#admin-container', '#admin-modal-close']
        ];
        for (const [action, panel, close] of cases) {
            await page.locator(`[data-personal-action="${action}"]`).first().click();
            await expect(page.locator(panel)).toBeVisible({ timeout: 20_000 });
            await page.locator(close).click();
            await expect(page.locator(panel)).toBeHidden({ timeout: 15_000 });
            await expect(page.locator('#personal-workbench-modal')).toBeVisible({ timeout: 15_000 });
        }
    });

    test('统一分页与设置页分页均可翻页，并会钳制越界页码', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => {
            const pager = document.createElement('div');
            pager.id = 'pagination-contract-smoke';
            document.body.appendChild(pager);
            window.__workspacePaginationPages = [];
            window.Pivot.legacy.renderWorkspacePagination(pager, {
                total: 30,
                limit: 15,
                page: 99,
                onPageChange: pageNo => window.__workspacePaginationPages.push(pageNo)
            });
        });
        await expect(page.locator('#pagination-contract-smoke')).toContainText('第 2 / 2 页');
        await expect(page.locator('#pagination-contract-smoke button', { hasText: '下一页' })).toBeDisabled();
        await page.locator('#pagination-contract-smoke button', { hasText: '上一页' }).click();
        await expect.poll(() => page.evaluate(() => window.__workspacePaginationPages)).toEqual([1]);

        await page.evaluate(() => {
            const pager = document.getElementById('pagination-contract-smoke');
            window.__workspacePaginationPages = [];
            window.Pivot.legacy.renderWorkspacePagination(pager, {
                total: 30,
                limit: 15,
                page: 1,
                onPageChange: pageNo => window.__workspacePaginationPages.push(pageNo)
            });
        });
        await page.locator('#pagination-contract-smoke button', { hasText: '末页' }).click();
        await expect.poll(() => page.evaluate(() => window.__workspacePaginationPages)).toEqual([2]);

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        const modelsLoaded = page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname === '/api/models' && url.searchParams.get('limit') === '15';
        });
        await page.locator('#tab-models').click();
        await modelsLoaded;
        await expect(page.locator('#tab-content-models')).toBeVisible();
        await page.evaluate(() => {
            window.__settingsPaginationCalls = [];
            window.Pivot.legacy.loadTabData = async (tab, pageNo) => {
                window.__settingsPaginationCalls.push({ tab, pageNo });
            };
            window.renderPagination('models', 30, 1);
        });
        await page.locator('#pagination-models button', { hasText: '下一页' }).click();
        await expect.poll(() => page.evaluate(() => window.__settingsPaginationCalls)).toEqual([{ tab: 'models', pageNo: 2 }]);
    });

    test('chat shell loads safe HTML and Pivot module namespace', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('body')).toBeVisible();
        await page.waitForFunction('() => Boolean(window.Pivot && window.Pivot.modules && window.Pivot.html)');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.ui"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.attachments"])');
        await page.waitForFunction('() => Boolean(window.Pivot.modules["chat.messageVirtualizer"])');
    });

    test('Markdown code and formula vendors load only when a rendered message needs them', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => Boolean(window.Pivot && window.renderMarkdown)');
        await expect(page.locator('script[src*="highlight.min.js"]')).toHaveCount(0);
        await expect(page.locator('script[src*="katex.min.js"]')).toHaveCount(0);
        await page.evaluate(() => window.renderMarkdown('```js\nconst value = 1;\n```\n\n$x^2$'));
        await page.waitForFunction('() => Boolean(window.hljs && window.katex)', null, { timeout: 10_000 });
        await expect(page.locator('script[src*="highlight.min.js"]')).toHaveCount(1);
        await expect(page.locator('script[src*="katex.min.js"]')).toHaveCount(1);
        await expect(page.locator('link[href*="katex.min.css"]')).toHaveCount(1);
    });

    test('knowledge workspace exposes RAG debug controls', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#rag-debug-modal')).toHaveCount(1);
        await expect(page.locator('#rag-debug-history')).toHaveCount(0);
        await expect(page.locator('#rag-debug-results')).toHaveCount(1);
    });

    test('召回测试每次打开重置界面，带入聊天会明确请求知识库', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.());
        await expect(page.locator('#knowledge-workbench-modal')).toBeVisible({ timeout: 15_000 });
        const retrievalMenu = page.locator('.knowledge-action-menu').filter({ hasText: '检索与图谱' });
        await retrievalMenu.locator('summary').click();
        const openDebug = page.locator('#rag-debug-modal-open-btn');
        await expect(openDebug).toBeVisible();
        await openDebug.click();
        const debugModal = page.locator('#rag-debug-modal');
        await expect(debugModal).toBeVisible();
        await page.locator('#rag-debug-query').fill('上一轮调试问题');
        await page.locator('#rag-debug-results').evaluate(element => { element.textContent = '上一轮结果'; });
        await page.locator('#rag-debug-modal-close').click();
        if (!(await openDebug.isVisible())) await retrievalMenu.locator('summary').click();
        await openDebug.click();
        await expect(page.locator('#rag-debug-query')).toHaveValue('');
        await expect(page.locator('#rag-debug-results')).toContainText('请输入测试问题');
        await expect(page.locator('#rag-debug-history')).toHaveCount(0);

        await page.locator('#rag-debug-query').fill('请说明当前资料的审批流程');
        await page.locator('#rag-debug-results').evaluate(element => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.ragDebugChat = '请说明当前资料的审批流程';
            button.textContent = '带着资料去聊天';
            element.replaceChildren(button);
        });
        await page.locator('[data-rag-debug-chat]').click();
        await expect.poll(() => page.evaluate(() => window.Pivot.moduleApi('chat.autoRoute').getOverrides('请说明当前资料的审批流程').forceRag)).toBe(true);
        await expect(page.locator('#user-input')).toHaveValue('请说明当前资料的审批流程');
    });

    test('long chat opens at the newest message and remains scrollable both ways', async ({ page }) => {
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => Boolean(window.Pivot?.modules?.["chat.messageVirtualizer"])');
        await page.evaluate(() => {
            const container = document.getElementById('message-container');
            document.body.appendChild(container);
            Object.assign(container.style, {
                display: 'flex',
                height: '600px',
                inset: '0',
                position: 'fixed',
                width: '900px',
                zIndex: '99999'
            });
            const records = Array.from({ length: 140 }, (_, index) => ({
                id: index + 1,
                role: index % 2 ? 'assistant' : 'user',
                content: 'virtual-message-' + (index + 1) + ' ' + 'variable height content '.repeat(18),
                created_at: '2026-08-17 12:00:00',
                token_count: index + 1
            }));
            window.Pivot.modules['chat.messageVirtualizer'].start({
                sessionId: 'virtual-scroll-smoke',
                records,
                page: { hasMore: false, beforeId: 1 }
            });
        });
        await page.waitForTimeout(500);

        const readWindow = () => page.locator('#message-container').evaluate(container => ({
            distanceFromBottom: container.scrollHeight - container.clientHeight - container.scrollTop,
            firstId: Number(container.querySelector('.message')?.dataset.virtualMessageKey?.split(':')[1] || 0),
            lastId: Number(Array.from(container.querySelectorAll('.message')).at(-1)?.dataset.virtualMessageKey?.split(':')[1] || 0)
        }));

        const initial = await readWindow();
        expect(initial.lastId).toBe(140);
        expect(initial.distanceFromBottom).toBeLessThanOrEqual(5);

        await page.locator('#message-container').evaluate(container => {
            container.scrollTop = Math.max(0, container.scrollTop - 5000);
            container.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(250);
        const earlier = await readWindow();
        expect(earlier.firstId).toBeLessThan(initial.firstId);

        await page.locator('#message-container').evaluate(container => {
            container.scrollTop = container.scrollHeight;
            container.dispatchEvent(new Event('scroll'));
        });
        await page.waitForTimeout(250);
        const newest = await readWindow();
        expect(newest.lastId).toBe(140);
        expect(newest.distanceFromBottom).toBeLessThanOrEqual(5);
    });

   test('chat input defaults to adaptive routing and keeps the plus menu for attachments only', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 520 });
        await page.addInitScript(() => {
            window.localStorage.setItem('pivot_chat_mcp_tool_mode', 'manual');
            window.localStorage.setItem('pivot_chat_mcp_tool_allowlist', JSON.stringify([
                'mcp.17.report.read_report',
                'mcp.17.report.list_reports',
                'mcp.17.report.export_report',
                'mcp.17.report.share_report',
                'mcp.17.report.refresh_report',
                'mcp.17.report.archive_report',
                'mcp.17.report.seventh_report'
            ]));
        });
        await page.route('**/api/mcp/tools', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                tools: [
                    { fullName: 'mcp.17.report.read_report', name: 'report.read_report', title: 'read report', displayTitle: '读取报表', description: 'Read a report.', displayDescription: '读取指定报表的数据与摘要。', searchAliases: ['读取报表', 'read report'], serverName: '报表工具' },
                    { fullName: 'mcp.17.report.list_reports', name: 'report.list_reports', title: '列出报表', serverName: '报表工具' },
                    { fullName: 'mcp.17.report.export_report', name: 'report.export_report', title: '导出报表', serverName: '报表工具' },
                    { fullName: 'mcp.17.report.share_report', name: 'report.share_report', title: '共享报表', serverName: '报表工具' },
                    { fullName: 'mcp.17.report.refresh_report', name: 'report.refresh_report', title: '刷新报表', serverName: '报表工具' },
                    { fullName: 'mcp.17.report.archive_report', name: 'report.archive_report', title: '归档报表', serverName: '报表工具' },
                    { fullName: 'mcp.17.report.seventh_report', name: 'report.seventh_report', title: '第七报表工具', serverName: '报表工具' },
                    { fullName: 'mcp.17.report.delete_report', name: 'report.delete_report', title: '删除报表', serverName: '报表工具' }
                ]
            })
        }));
       await ensureBrowserSession(page);
        await page.evaluate(() => {
            const models = window.Pivot.legacy._cachedModels || [];
            const visionModel = models.find(m => Number(m.supports_vision || 0) === 1);
            if (visionModel) {
                window.Pivot.legacy.selectDropdownModel(visionModel.id, true);
            } else {
                const currentId = document.getElementById('model-selector')?.value;
                const current = models.find(m => String(m.id) === String(currentId));
                if (current) current.supports_vision = 1;
                const uploadBtn = document.getElementById('chat-tools-menu-btn');
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.style.opacity = '1';
                    uploadBtn.style.cursor = 'pointer';
                    uploadBtn.title = '添加文件或文件夹';
                }
            }
        });

        await expect(page.locator('#chat-auto-route-enabled')).toHaveCount(0);
        await expect(page.locator('#chat-rag-enabled')).toHaveCount(0);
        await expect(page.locator('#chat-mcp-enabled')).toHaveCount(0);
        await expect(page.locator('#chat-mode-trigger')).toHaveCount(0);
        await expect(page.locator('#chat-agent-execute-btn')).toHaveCount(0);
        await expect(page.locator('#chat-task-suggestion')).toHaveCount(0);
        await expect(page.locator('#user-input')).toHaveAttribute('placeholder', '输入消息… 需要指定资料或工具时可输入 @');
        await expect.poll(() => page.evaluate(() => (
            window.Pivot.moduleApi('chat.inputMenu').getAutoRouteEnabled()
        ))).toBe(true);

        await page.locator('#chat-tools-menu-btn').click();
        await expect(page.locator('#chat-tools-menu-panel')).toBeVisible();
        await expect(page.locator('#upload-file-choice')).toBeVisible();
        await expect(page.locator('#upload-folder-choice')).toBeVisible();
        await expect(page.locator('#chat-tools-menu-panel button')).toHaveCount(2);
        const attachmentMenuBounds = await page.locator('#chat-tools-menu-panel').evaluate(panel => {
            const rect = panel.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
        });
       expect(attachmentMenuBounds.top).toBeGreaterThanOrEqual(11.5);
       expect(attachmentMenuBounds.bottom).toBeLessThanOrEqual(attachmentMenuBounds.viewportHeight - 11.5);

        // 裸 @ 同时提供知识库、Wiki 综合和当前执行白名单内工具的能力范围选择；选中工具仅形成显式候选，
        // 不会绕过后续的本会话授权与重新发送步骤。
        await page.locator('#user-input').fill('@');
        await expect(page.locator('[data-route-mention-scope]')).toHaveCount(3);
        await expect(page.locator('[data-route-mention-scope="collection"]')).toBeVisible();
        await expect(page.locator('[data-route-mention-scope="wiki"]')).toBeVisible();
        await expect(page.locator('[data-route-mention-scope="tool"]')).toBeVisible();
        await expect(page.locator('.chat-route-mention-item')).toHaveCount(0);
        await page.locator('[data-route-mention-scope="tool"]').click();
        const mentionSearch = page.locator('.chat-route-mention-search');
        await expect(mentionSearch).toBeVisible();
        await expect(page.locator('.chat-route-mention-result-summary')).toHaveText('已显示 1–6 / 7');
        await expect(page.locator('.chat-route-mention-item')).toHaveCount(6);
        await page.locator('.chat-route-mention-pager button', { hasText: '下一页' }).click();
        await expect(page.locator('.chat-route-mention-result-summary')).toHaveText('已显示 7–7 / 7');
        await expect(page.locator('.chat-route-mention-item', { hasText: '@第七报表工具' })).toBeVisible();
        await page.locator('.chat-route-mention-pager button', { hasText: '上一页' }).click();
        await expect(page.locator('.chat-route-mention-result-summary')).toHaveText('已显示 1–6 / 7');
        await mentionSearch.fill('read report');
        const allowedTool = page.locator('.chat-route-mention-item', { hasText: '@读取报表' });
        await expect(allowedTool).toBeVisible();
        await expect(page.locator('#chat-route-mention-menu')).toContainText('@读取报表');
        await expect(page.locator('#chat-route-mention-menu')).not.toContainText('@read report');
        await expect(page.locator('.chat-route-mention-item', { hasText: '@删除报表' })).toHaveCount(0);
        await allowedTool.click();
        await expect(page.locator('#user-input')).toHaveValue('@读取报表 ');
        await expect.poll(() => page.evaluate(() => (
            window.Pivot.moduleApi('chat.inputMenu').getRouteOverrides(document.getElementById('user-input').value)
        ))).toEqual({ collections: [], tools: ['mcp.17.report.read_report'], wikiSpaces: [] });
   });

    test('普通发送保持直答，明确委托会自动进入受控 Agent', async ({ page }) => {
        const requests = [];
        const agentRunRequests = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/chat' && request.method() === 'POST') {
                requests.push(request.postDataJSON());
            }
            if (/^\/api\/agents\/runs\//.test(new URL(request.url()).pathname) && request.method() === 'GET') {
                agentRunRequests.push(request.url());
            }
        });
        const login = await page.request.post('/api/auth/login', {
            data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
        });
        expect(login.ok()).toBeTruthy();
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const modelName = `E2E explicit agent ${Date.now()}`;
        const created = await page.request.post('/api/models', {
            headers: { 'x-csrf-token': csrf },
            data: { name: modelName, url: process.env.E2E_MODEL_URL, model_name: 'e2e-explicit-agent' }
        });
        expect(created.ok()).toBeTruthy();
        const models = await (await page.request.get('/api/models?limit=100')).json();
        const model = (models.data || []).find(item => item.name === modelName);
        expect(model).toBeTruthy();
        const defaultResponse = await page.request.put('/api/settings/default-model', {
            headers: { 'x-csrf-token': csrf }, data: { default_model_id: model.id }
        });
        expect(defaultResponse.ok()).toBeTruthy();
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
        await page.evaluate(() => Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined }));
        await expect(page.locator('#user-input')).toBeVisible({ timeout: 10_000 });
        await page.locator('#user-input').fill('请简要解释什么是向量检索。');
        await page.locator('#send-btn').click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0].chatMode).toBe('normal');
        expect(requests[0].clientRequestId).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        await expect(page.locator('#send-btn')).toBeVisible();
        await expect(page.locator('.chat-task-suggestion-card')).toHaveCount(0);

        await page.locator('#user-input').fill('请汇总本周订单，核对异常并生成一份风险报告。');
        await page.locator('#send-btn').click();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[1].chatMode).toBe('normal');
        expect(requests[1].clientRequestId).not.toBe(requests[0].clientRequestId);
        await expect.poll(() => agentRunRequests.length).toBeGreaterThan(0);
        await expect(page.locator('.chat-task-suggestion-card')).toHaveCount(0);
        expect(requests).toHaveLength(2);

        await expect(page.locator('#send-btn')).toBeVisible();
        const correctionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat' && response.request().method() === 'POST');
        await page.locator('#user-input').fill('我只是问一下，不需要执行');
        await page.locator('#send-btn').click();
        const correctionStream = await (await correctionResponse).text();
        expect(correctionStream).toContain('"status":"corrected"');
        expect(correctionStream).not.toContain('"status":"automatic_execution"');
        await expect(page.locator('.chat-route-feedback-form')).toHaveCount(0);
        expect(requests).toHaveLength(3);

        await expect(page.locator('#send-btn')).toBeVisible();
        const knowledgeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat' && response.request().method() === 'POST');
        await page.locator('#user-input').fill('我们公司婚假有几天？');
        await page.locator('#send-btn').click();
        const knowledgeStream = await (await knowledgeResponse).text();
        expect(knowledgeStream).toContain('"type":"rag"');
        expect(knowledgeStream).not.toContain('"status":"automatic_execution"');
        expect(requests).toHaveLength(4);
    });

    test('个人助手无需首次配置，工作台按需管理偏好且刷新后不弹向导', async ({ page }) => {
        await ensureBrowserSession(page);
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('personal'));
            await expect(page.locator('#personal-assistant-list')).toContainText('无需预先配置即可使用');
            await expect(page.locator('#personal-agent-onboarding')).toHaveCount(0);
            await expect(page.locator('#personal-assistant-list')).not.toContainText('待设置');
        }
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.locator('#personal-agent-onboarding')).toHaveCount(0);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
        await expect(page.locator('#user-input')).toBeVisible();
    });

    test('自然纠正替代路由表单，管理员区分异常复核和自动归档', async ({ page }) => {
        await page.route('**/api/stats/observability/decision-feedback?*', route => {
            const archived = new URL(route.request().url()).searchParams.get('reviewStatus') === 'not_required';
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{
                feedback_id: archived ? 'archived' : 'incident', decision_id: 'decision-correction', scenario: 'chat.execution',
                selected_action_id: 'agent_run', corrected_action_id: 'direct_answer', review_status: archived ? 'not_required' : 'pending',
                username: 'admin', session_title: '纠正回归', query_preview: '请分析订单',
                metadata: { note: '我只是问一下，不需要执行', reviewReasons: archived ? [] : ['execution_scope'],
                    naturalCorrection: { sourceMessageId: 12, priorMessageId: 10, applied: { pausedRunIds: ['r'] } }, executionEvidence: [] }
            }] }) });
        });
        await ensureBrowserSession(page);
        const replay = await page.evaluate(() => {
            const holder = document.createElement('div');
            document.body.appendChild(holder);
            const streaming = window.Pivot.moduleApi('chat.streaming');
            streaming.renderAssistantRouteMetadata(holder, { decisions: [{ decisionId: 'd', scenario: 'chat.execution', selectedActionId: 'agent_run', allowedActionIds: ['agent_run','direct_answer'] }] });
            const retiredControls = holder.querySelectorAll('[data-chat-trace-action="decision-feedback"], .chat-route-feedback-form').length;
            streaming.renderAssistantTraceEvent(holder, { type: 'route', status: 'corrected', message: '已暂停当前任务，并按本次要求调整处理方式' });
            const visibleText = holder.textContent;
            holder.remove();
            return { retiredControls, visibleText };
        });
        expect(replay.retiredControls).toBe(0);
        expect(replay.visibleText).toContain('已暂停当前任务');
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#tab-decision-review')).toHaveCount(0);
        await page.locator('#tab-monitor').click();
        await page.locator('#monitor-quality-tab').click();
        await expect(page.locator('#route-feedback-review-list')).toContainText('任务执行与续接');
        await expect(page.locator('#route-feedback-review-list')).toContainText('任务执行范围纠正');
        const tableScroll = await page.locator('.route-feedback-table-wrap').evaluate(element => {
            element.scrollLeft = element.scrollWidth;
            const reached = element.scrollLeft > 0;
            element.scrollLeft = 0;
            return reached;
        });
        expect(tableScroll).toBeTruthy();
        await page.screenshot({ path: path.resolve(__dirname, '../../output/quality-navigation-desktop.png') });
        await page.locator('#route-feedback-review-list [data-route-feedback-detail]').first().click();
        await expect(page.locator('#route-feedback-detail-modal')).toBeVisible();
        await expect(page.locator('#route-feedback-detail-content')).toContainText('sourceMessageId');
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 844 });
            const box = await page.locator('.route-feedback-detail-dialog').boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
            const overflow = await page.locator('#route-feedback-detail-content').evaluate(element => element.scrollWidth - element.clientWidth);
            expect(overflow).toBeLessThanOrEqual(1);
            if (width === 390) await page.screenshot({ path: path.resolve(__dirname, '../../output/quality-navigation-mobile.png') });
        }
        await page.setViewportSize({ width: 1280, height: 844 });
        await page.locator('#route-feedback-detail-footer').getByRole('button', { name: '关闭', exact: true }).click();
        await page.locator('#route-feedback-status-filter').selectOption('not_required');
        await expect(page.locator('#route-feedback-review-list')).toContainText('无需逐条复核');
        await expect(page.locator('#route-feedback-review-list [data-route-feedback-review]')).toHaveCount(0);
        await page.evaluate(() => window.Pivot.legacy.switchTab('route-feedback'));
        await expect(page.locator('#monitor-quality-tab')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#monitor-overview-panel')).toBeHidden();
        await page.locator('#monitor-quality-tab').focus();
        await page.keyboard.press('ArrowLeft');
        await expect(page.locator('#monitor-overview-tab')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#monitor-overview-panel')).toBeVisible();
        await page.locator('#monitor-quality-tab').click();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#monitor-quality-tab')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#decision-review-feedback-panel')).toBeVisible();
    });

    test('chat Agent detail button lazy-loads the task detail and shows safe reasoning summary', async ({ page }) => {
        await page.route(/\/api\/agents\/runs\/run-lazy-detail\/context-windows(?:\?.*)?$/, route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: [{ window_version: 1, status: 'active', opened_reason: '开始执行' }] })
        }));
        await page.route(/\/api\/agents\/runs\/run-lazy-detail\/world-states(?:\?.*)?$/, route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: [{ snapshot_version: 7, state: { detail: '<img src=x onerror=alert(1)>' } }] })
        }));
        await page.route('**/api/agents/runs/run-lazy-detail', route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                run: {
                    id: 'run-lazy-detail',
                    title: '连续 Agent 测试任务',
                    goal: '检查详情按钮和执行判断摘要',
                    status: 'running',
                    run_mode: 'standard',
                    tool_policy: 'builtin_only',
                    metadata: {},
                    created_at: '2026-08-24 14:00:00'
                },
                steps: [{
                    step_index: 1,
                    type: 'plan',
                    title: '先检查当前任务上下文',
                    output: { thought: '先检查当前任务上下文', action: 'final', answer: '测试' },
                    status: 'success',
                    duration_ms: 12
                }],
                dagNodes: [],
                progress: { stepCount: 1, roundCount: 1, maxSteps: 30, percent: 20, totalDurationMs: 12 },
                trace: {
                    spans: [{
                        id: 'trace-lazy-detail',
                        name: 'plan',
                        span_type: 'plan',
                        status: 'error',
                        duration_ms: 12,
                        error_message: '<img src=x onerror=alert(1)>'
                    }],
                    summary: { errorCount: 1 }
                },
                checkpoints: { total: 0 }
            })
        }));
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => Boolean(window.attachChatAgentControls && window.ensureWorkspaceScripts)');
        await page.evaluate(() => {
            const card = document.createElement('div');
            card.id = 'chat-agent-detail-smoke';
            card.style.position = 'fixed';
            card.style.inset = '20px auto auto 20px';
            card.style.zIndex = '99999';
            card.style.background = 'white';
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            card.appendChild(actions);
            document.body.appendChild(card);
            window.attachChatAgentControls(card, 'run-lazy-detail', 'running');
        });

        await page.locator('#chat-agent-detail-smoke .chat-agent-controls button', { hasText: '详情' }).click();
        await expect(page.locator('#agent-run-detail-modal')).toBeVisible();
        await expect(page.locator('#agent-run-detail')).toContainText('先检查当前任务上下文');
        const processPanel = page.locator('#agent-run-detail details.agent-run-process');
        if (!(await processPanel.evaluate(element => element.open))) await processPanel.locator(':scope > summary').click();
        const tracePanel = processPanel.locator('details.agent-trace-panel');
        await expect(tracePanel).toBeVisible();
        await tracePanel.locator(':scope > summary').click();
        const traceBar = tracePanel.locator('.agent-trace-track rect');
        await expect(traceBar).toHaveAttribute('width', '100.00');
        expect(await traceBar.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(0);
        const traceDetail = tracePanel.locator('details.agent-trace-detail');
        await traceDetail.locator(':scope > summary').click();
        await expect(traceDetail).toContainText('<img src=x onerror=alert(1)>');
        await expect(traceDetail.locator('img')).toHaveCount(0);
        const diagnostics = page.locator('#agent-run-detail .agent-run-harness-diagnostics');
        await diagnostics.locator(':scope > summary').click();
        await expect(diagnostics.locator('[data-agent-harness-panel="context"]')).toContainText('开始执行');
        await diagnostics.locator('[data-agent-harness-diagnostic-tab="world"]').click();
        await expect(diagnostics.locator('[data-agent-harness-panel="world"]')).toContainText('快照 7');
        await expect(diagnostics.locator('[data-agent-harness-panel="world"] img')).toHaveCount(0);
        await page.evaluate(() => window.Pivot.legacy.openAgentRun('run-lazy-detail', { silent: true }));
        await expect(page.locator('#agent-run-detail details.agent-run-process')).toHaveAttribute('open', '');
        await expect(page.locator('#agent-run-detail details.agent-trace-panel')).toHaveAttribute('open', '');
        await expect(page.locator('#agent-run-detail details.agent-trace-detail')).toHaveAttribute('open', '');
        await expect(page.locator('#agent-run-detail [data-agent-harness-diagnostic-tab="world"]')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#agent-run-detail [data-agent-harness-panel="world"]')).toContainText('快照 7');
    });

    test('chat desktop connector sync uses the desktop bridge without browser heartbeat', async ({ page }) => {
        let browserHeartbeats = 0;
        await page.route('**/api/mcp/local-device/heartbeat', async route => {
            browserHeartbeats++;
            await route.fulfill({ status: 500, body: 'unexpected' });
        });
        await page.goto('/chat', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('() => typeof window.syncChatLocalMcpBridgeBeforeSend === "function"');
        const result = await page.evaluate(async () => {
            const calls = [];
            window.pivotDesktop = {
                getLocalAuthorizationStatus: async () => ({ grants: { local_database: { authorized: true } } }),
                syncLocalMcpConnector: async () => { calls.push('sync'); return { status: 'ok' }; },
                getLocalMcpConnectorStatus: async () => { calls.push('status'); return { running: true, identity: { deviceName: '测试电脑' } }; }
            };
            const value = await window.syncChatLocalMcpBridgeBeforeSend();
            return { value, calls, debug: window.getChatLocalMcpBridgeDebugSnapshot() };
        });
        expect(result.value).toBeNull();
        expect(result.calls).toEqual(['sync', 'status']);
        expect(result.debug.status).toBe('persistent_connector_synced');
        expect(result.debug.grants.local_database).toBe(true);
        expect(browserHeartbeats).toBe(0);
    });

    test('管理员可在设置工作台提交冻结金标的独立审核', async ({ page }) => {
        let submitted = null;
        await page.route(/\/api\/stats\/observability\/decision-evaluation-sets\/v2\/cases\?limit=500$/, async route => {
            await route.fulfill({
                contentType: 'application/json',
                body: JSON.stringify({ data: [{
                    caseId: 'tools-consent-001', scenario: 'chat.tools', language: 'zh', reviewStatus: 'pending_human_review',
                    inputContext: { requestState: { routingText: '用户请求调用外部工具，必须先征得授权。' } },
                    candidates: [{ id: 'candidate_only', description: '等待工具授权', allowed: true }, { id: 'direct_answer', description: '直接回答', allowed: true }]
                }] })
            });
        });
        await page.route(/\/api\/stats\/observability\/decision-evaluation-sets\/v2\/cases\/tools-consent-001\/review$/, async route => {
            submitted = route.request().postDataJSON();
            await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, review: { reviewStatus: 'pending_human_review', distinctReviewerCount: 1 } }) });
        });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#tab-decision-review')).toHaveCount(0);
        await page.locator('#tab-models').click();
        await page.locator('#models-evaluation-tab').click();
        const panel = page.locator('#decision-review-gold-panel');
        await expect(panel).toBeVisible();
        await expect(panel).toContainText('用户请求调用外部工具');
        await panel.locator('[data-decision-gold-action="tools-consent-001"]').selectOption('candidate_only');
        await panel.locator('[data-decision-gold-note="tools-consent-001"]').fill('独立确认需要先授权。');
        await panel.locator('[data-decision-gold-review="tools-consent-001"]').click();
        await expect.poll(() => submitted).toEqual({ expectedActionId: 'candidate_only', reviewNote: '独立确认需要先授权。' });
        await expect(panel).toContainText('待第二审核');
        await page.evaluate(() => window.Pivot.legacy.switchTab('decision-gold-review'));
        await expect(page.locator('#models-evaluation-tab')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#models-configuration-panel')).toBeHidden();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('#models-evaluation-tab')).toBeVisible();
        await expect(panel).toBeVisible();
        await page.locator('#models-configuration-tab').click();
        await expect(page.locator('#models-configuration-panel')).toBeVisible();
        await expect(panel).toBeHidden();
    });

    test('普通用户无法通过旧审核入口或保存状态打开管理员质量与评测数据', async ({ page, browser }) => {
        await ensureBrowserSession(page);
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const username = `quality_user_${Date.now()}`;
        const password = 'QualityUser123!';
        const created = await page.request.post('/api/admin/users', { headers: { 'x-csrf-token': csrf }, data: { username, password, nickname: '质量权限回归', unit: 'QA', role: 'user' } });
        expect(created.ok()).toBeTruthy();
        const context = await browser.newContext();
        try {
            const login = await context.request.post(`${process.env.PIVOT_E2E_BASE_URL}/api/auth/login`, { data: { username, password } });
            expect(login.ok()).toBeTruthy();
            const regular = await context.newPage();
            await regular.goto(`${process.env.PIVOT_E2E_BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
            await regular.evaluate(() => {
                sessionStorage.setItem('pivot_settings_tab', 'decision-review');
                sessionStorage.setItem('pivot_settings_decision_review_subtab', 'gold');
                sessionStorage.setItem('pivot_settings_models_section', 'evaluation');
            });
            await regular.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
            await expect(regular.locator('#models-configuration-panel')).toBeVisible();
            await expect(regular.locator('#models-evaluation-tab')).toBeHidden();
            await expect(regular.locator('#tab-monitor')).toBeHidden();
            await regular.evaluate(() => window.Pivot.legacy.switchTab('route-feedback'));
            await expect(regular.locator('#decision-review-feedback-panel')).toBeHidden();
            const feedback = await context.request.get(`${process.env.PIVOT_E2E_BASE_URL}/api/stats/observability/decision-feedback`);
            const evaluation = await context.request.get(`${process.env.PIVOT_E2E_BASE_URL}/api/stats/observability/decision-evaluation-sets/v2/cases`);
            expect(feedback.status()).toBe(403);
            expect(evaluation.status()).toBe(403);
        } finally { await context.close(); }
    });

    test('usage audit workspace switches between statistics, details and report', async ({ page }) => {
        await ensureBrowserSession(page);

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible();
        await page.locator('#tab-usage').click();

        await expect(page.locator('#usage-title')).toHaveText('用量统计');
        await expect(page.locator('#tab-content-stats')).toBeVisible();
        await expect(page.locator('#tab-content-details')).toBeHidden();
        await expect(page.locator('#tab-content-report')).toBeHidden();

        await page.locator('#usage-subtab-details').click();
        await expect(page.locator('#usage-subtab-details')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#usage-title')).toHaveText('用量明细');
        await expect(page.locator('#tab-content-stats')).toBeHidden();
        await expect(page.locator('#tab-content-details')).toBeVisible();

        await page.locator('#usage-subtab-report').click();
        await expect(page.locator('#usage-subtab-report')).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#usage-title')).toHaveText('审计报表');
        await expect(page.locator('#tab-content-details')).toBeHidden();
        await expect(page.locator('#tab-content-report')).toBeVisible();
        await expect(page.locator('#report-query-btn')).toBeVisible();
    });

    test('知识库预加载配置后，设置工作区仍会绑定运行时参数和记忆操作', async ({ page }) => {
        test.setTimeout(60_000);
        await ensureBrowserSession(page);

        // 知识库会按需预加载 admin-settings.js；这里刻意在设置模板挂载前走这条路径，
        // 防止脚本缓存后设置页的事件监听未重新绑定。
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench?.());
        await expect(page.locator('#knowledge-workbench-modal')).toBeVisible({ timeout: 15_000 });

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });

        await page.locator('#tab-memories').click();
        await expect(page.locator('#memory-refresh-btn')).toBeVisible();
        await page.evaluate(() => {
            window.__memoryRefreshCalls = 0;
            window.Pivot.legacy.loadMemories = async () => { window.__memoryRefreshCalls += 1; };
        });
        await page.locator('#memory-refresh-btn').click();
        await expect.poll(() => page.evaluate(() => window.__memoryRefreshCalls)).toBe(1);

        await page.locator('#tab-global-params').click();
        await expect(page.locator('#runtime-settings-page-refresh')).toBeVisible();
        await page.evaluate(() => {
            window.__runtimeSettingsRefreshCalls = 0;
            window.Pivot.legacy.loadSettings = async () => { window.__runtimeSettingsRefreshCalls += 1; };
        });
        await page.locator('#runtime-settings-page-refresh').click();
        await expect.poll(() => page.evaluate(() => window.__runtimeSettingsRefreshCalls)).toBe(1);
    });

    test('长期记忆使用记录在设置页首次加载后可打开', async ({ page }) => {
        await ensureBrowserSession(page);
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const created = await page.request.post('/api/memories/remember', {
            headers: csrf ? { 'x-csrf-token': csrf } : {},
            data: { content: '使用记录按钮的首次加载回归验证内容。', type: 'fact', scope: 'user' }
        });
        expect(created.ok()).toBeTruthy();
        const memory = await created.json();
        expect(memory?.id).toBeTruthy();

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        await page.locator('#tab-memories').click();
        const usageButton = page.locator(`[data-memory-action="usage"][data-memory-id="${memory.id}"]`);
        await expect(usageButton).toBeVisible({ timeout: 15_000 });
        const usageResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/memories/${memory.id}/usage`);
        await usageButton.click();
        await expect((await usageResponse).ok()).toBeTruthy();
        await expect(page.locator('#memory-source-modal')).toBeVisible();
        await expect(page.locator('#memory-source-body')).toContainText('实际使用记录');
        await expect.poll(() => page.evaluate(() => {
            const modal = document.querySelector('#memory-source-modal .memory-source-modal');
            return modal
                ? Math.round(modal.getBoundingClientRect().width) === Math.round(Math.min(960, window.innerWidth - 32))
                : false;
        })).toBe(true);
    });

    test('长期记忆导出提供真实下载并使用重复读一致性快照', async ({ page }) => {
        await ensureBrowserSession(page);
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const createdIds = [];
        for (const suffix of ['甲', '乙']) {
            const response = await page.request.post('/api/memories/remember', {
                headers: csrf ? { 'x-csrf-token': csrf } : {},
                data: { content: `用于导出回归验证的独立长期记忆${suffix}。`, type: 'fact', scope: 'user' }
            });
            expect(response.ok()).toBeTruthy();
            createdIds.push(String((await response.json()).id));
        }
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        await page.locator('#tab-memories').click();
        const downloadEvent = page.waitForEvent('download');
        await page.locator('#memory-export-btn').click();
        const download = await downloadEvent;
        const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        expect(exported.consistency).toBe('repeatable_read_snapshot');
        expect(exported.complete).toBe(true);
        expect(exported.exportedCount).toBe(exported.memories.length);
        for (const id of createdIds) expect(exported.memories.some(memory => String(memory.id) === id)).toBe(true);
        await expect(page.getByText(/一致性快照/)).toBeVisible();
    });

    test('长期记忆合并建议使用独立弹窗，评测取消编辑不占用字段操作行', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.route('**/api/memories/merge-suggestions?limit=20', async route => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                suggestions: [{
                    score: 0.92,
                    primary: { id: 101, type: 'fact', content: '项目交付采用受控目录。' },
                    duplicate: { id: 102, type: 'fact', content: '项目文件通过授权目录交付。' }
                }]
            })
        }));
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const evaluation = await page.request.post('/api/memories/evaluations/cases', {
            headers: csrf ? { 'x-csrf-token': csrf } : {},
            data: { name: '评测编辑布局', query: '验证评测取消编辑按钮布局' }
        });
        expect(evaluation.ok()).toBeTruthy();
        const evaluationCase = (await evaluation.json()).case;
        expect(evaluationCase?.id).toBeTruthy();

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        await page.locator('#tab-memories').click();

        await page.locator('#memory-merge-suggestions-btn').click();
        await expect(page.locator('#memory-merge-modal')).toBeVisible();
        await expect(page.locator('#memory-merge-body')).toContainText('项目交付采用受控目录。');
        await expect(page.locator('#memory-merge-panel')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => {
            const modal = document.querySelector('#memory-merge-modal .memory-merge-modal');
            return modal
                ? Math.round(modal.getBoundingClientRect().width) === Math.round(Math.min(900, window.innerWidth - 32))
                : false;
        })).toBe(true);
        await page.locator('#memory-merge-close').click();
        await expect(page.locator('#memory-merge-modal')).toBeHidden();

        await page.locator('#memory-evaluations-open-btn').click();
        const editButton = page.locator(`[data-memory-evaluation-action="edit"][data-memory-evaluation-id="${evaluationCase.id}"]`);
        await expect(editButton).toBeVisible({ timeout: 15_000 });
        await editButton.click();
        const resetButton = page.locator('#memory-evaluation-reset-btn');
        await expect(resetButton).toBeVisible();
        await expect.poll(() => resetButton.evaluate(button => button.closest('.memory-eval-form-head-actions') !== null)).toBe(true);
        await expect.poll(() => page.locator('.field-actions').evaluate(actions => !actions.contains(document.getElementById('memory-evaluation-reset-btn')))).toBe(true);
        await resetButton.click();
        await expect(resetButton).toBeHidden();
        await expect(page.locator('#memory-evaluation-case-form button[type="submit"]')).toHaveText('添加用例');
    });

    test('长期记忆没有失败任务时重试按钮仍提供明确反馈', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: false }));
        await expect(page.locator('#admin-container')).toBeVisible({ timeout: 15_000 });
        await page.locator('#tab-memories').click();
        const retryButton = page.locator('#memory-jobs-retry-btn');
        await expect(retryButton).toBeVisible({ timeout: 15_000 });
        await expect(retryButton).toBeEnabled();
        const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/memories/jobs/retry');
        await retryButton.click();
        await expect((await retryResponse).ok()).toBeTruthy();
        await expect(page.locator('#toast-container')).toContainText('没有可重试的失败任务');
        await expect(page.locator('#memory-jobs-panel')).toContainText('0 失败');
    });

    test('system monitor renders RAG diagnostics and embedding latency state', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await page.locator('#tab-monitor').click();

        await expect(page.locator('#tab-content-monitor')).toBeVisible();
        await expect(page.locator('#monitor-summary-grid')).toContainText('平均延迟');
        await expect(page.locator('#monitor-rag-storage-list')).toContainText('检索诊断（24h）');
        await expect(page.locator('#monitor-rag-latency-trend')).toContainText(/Embedding|暂无/);
    });

    test('model configuration sends the native tool-call mode selected by an administrator', async ({ page }) => {
        let savedPayload = null;
        await page.route('**/api/models', async route => {
            if (route.request().method() !== 'POST') return route.continue();
            savedPayload = route.request().postDataJSON();
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
        });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAdminPanel?.({ restore: true }));
        await page.locator('#tab-models').click();
        await page.locator('#model-add-btn').click();
        await expect(page.locator('#m-tool-call-mode')).toHaveValue('auto');
        await page.locator('#m-name').fill('E2E tool mode');
        await page.locator('#m-url').fill('https://models.example.com/v1');
        await page.locator('#m-model').fill('e2e-tool-mode');
        await page.locator('#m-tool-call-mode').selectOption('disabled');
        await page.locator('#m-submit-btn').click();
        await expect.poll(() => savedPayload).not.toBeNull();
        expect(savedPayload.tool_call_mode).toBe('disabled');
    });

    test('chat submits an SSE request and renders the persisted streaming answer', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
        });
        expect(login.ok()).toBeTruthy();
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const modelName = `E2E real model ${Date.now()}`;
        const created = await page.request.post('/api/models', {
            headers: { 'x-csrf-token': csrf },
            data: { name: modelName, url: process.env.E2E_MODEL_URL, model_name: 'e2e-real-model' }
        });
        expect(created.ok()).toBeTruthy();
        const modelsResponse = await page.request.get('/api/models?limit=100');
        expect(modelsResponse.ok()).toBeTruthy();
        const modelsBody = await modelsResponse.json();
        const model = (modelsBody.data || []).find(item => item.name === modelName);
        expect(model).toBeTruthy();
        const defaultResponse = await page.request.put('/api/settings/default-model', {
            headers: { 'x-csrf-token': csrf },
            data: { default_model_id: model.id }
        });
        expect(defaultResponse.ok()).toBeTruthy();
        await ensureBrowserSession(page);
        await expect(page.locator(`#model-dropdown-list .model-item[data-id="${model.id}"]`)).toHaveCount(1, { timeout: 15_000 });
        await expect(page.locator('#model-selector')).toHaveValue(String(model.id));
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').showMainWorkspace('chat'));
        await expect(page.locator('#user-input')).toBeVisible({ timeout: 10_000 });
        await page.locator('#user-input').fill('请返回一段 E2E 流式文本');
        const chatResponsePromise = page.waitForResponse(response => response.url().endsWith('/api/chat'));
        await page.locator('#send-btn').click();
        const chatResponse = await chatResponsePromise;
        expect(chatResponse.ok()).toBeTruthy();
        await expect(page.locator('#message-container')).toContainText('真实 E2E 流式回答', { timeout: 20_000 });
    });

    test('knowledge upload queue accepts a selected file and sends it through the guarded upload route', async ({ page }) => {
        const login = await page.request.post('/api/auth/login', {
            data: { username: 'admin', password: process.env.DEFAULT_ADMIN_PASSWORD || 'E2eAdmin123' }
        });
        expect(login.ok()).toBeTruthy();
        await ensureBrowserSession(page);
        await page.evaluate(async () => window.Pivot.moduleApi('workspaces.navigation').openKnowledgeWorkbench());
        await expect(page.locator('#knowledge-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.locator('#rag-upload-btn').click();
        await expect(page.locator('#knowledge-upload-modal')).toBeVisible();
        await page.locator('#rag-upload-input').setInputFiles({
            name: 'e2e-knowledge.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('# E2E 知识库\n\n用于验证上传队列。', 'utf8')
        });
        await expect(page.locator('#knowledge-upload-list')).toContainText('e2e-knowledge.md');
        await expect(page.locator('#knowledge-upload-submit-btn')).toBeEnabled();
        const uploadResponsePromise = page.waitForResponse(response => response.url().includes('/api/rag/upload') && response.request().method() === 'POST');
        await page.locator('#knowledge-upload-submit-btn').click();
        const uploadResponse = await uploadResponsePromise;
        expect(uploadResponse.ok()).toBeTruthy();
        const uploadBody = await uploadResponse.json();
        expect(Number(uploadBody.docId)).toBeGreaterThan(0);
        await expect(page.locator('#knowledge-upload-modal')).toBeHidden();
    });

    test('数据分析侧边菜单保持等宽左对齐的导航布局', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
        await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.evaluate(async () => {
            await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
            await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' });
        });
        await expect(page.locator('#data-analysis-view')).toBeVisible({ timeout: 15_000 });
        await expectDataAnalysisSidebarNavigationLayout(page);
        for (const [tab, title] of [
            ['governance', '字段治理'],
            ['assets', '分析资产'],
            ['dashboards', '仪表盘']
        ]) {
            await page.locator(`[data-data-analysis-tab="${tab}"]`).click();
            await expect(page.locator('#data-analysis-title')).toHaveText(title);
        }
    });

    test('数据分析完成上传、非破坏性清洗、图表、字段治理、计算字段、保存视图和仪表盘刷新闭环', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
        await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.evaluate(async () => {
            window.Pivot.legacy.showConfirm = async () => true;
            await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
            await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' });
        });
        await expect(page.locator('#data-analysis-view')).toBeVisible({ timeout: 15_000 });
        await expectDataAnalysisSidebarNavigationLayout(page);
        const initialDatasetCount = await page.locator('#data-analysis-dataset-table-body .data-analysis-dataset-name').count();
        await page.locator('#data-analysis-file').setInputFiles({
            name: 'e2e-sales.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from('区域,销售额,客户密钥\n华东,100,S-001\n华南,200,S-002\n华东,100,S-001\n', 'utf8')
        });
        await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('e2e-sales', { timeout: 15_000 });
        await page.locator('[data-data-analysis-tab="cleaning"]').click();
        await expect(page.locator('#data-analysis-cleaning-panel')).toBeVisible();
        await page.locator('#data-cleaning-add-rule').click();
        await page.locator('#data-cleaning-apply').click();
        await expect(page.locator('#data-analysis-overview-panel')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#data-analysis-dataset-table-body .data-analysis-dataset-name')).toHaveCount(initialDatasetCount + 2, { timeout: 15_000 });

        await page.locator('[data-data-analysis-tab="chart"]').click();
        await page.locator('#data-analysis-chart-x').selectOption('c_1');
        await page.locator('#data-analysis-chart-y').selectOption('c_2');
        await page.locator('#data-analysis-build-chart').click();
        await expect(page.locator('#data-analysis-chart-result')).toContainText(/区域|销售额/, { timeout: 15_000 });

        await page.locator('[data-data-analysis-tab="governance"]').click();
        await expect(page.locator('#data-analysis-field-governance')).toContainText('区域', { timeout: 15_000 });
        const amountRow = page.locator('[data-analysis-governance-field="c_2"]');
        await amountRow.locator('[data-governance-input="displayName"]').fill('已确认销售额');
        await amountRow.locator('[data-governance-input="isMetric"]').check();
        await page.locator('#data-analysis-governance-save').click();
        await page.locator('#data-analysis-open-calc-modal').click();
        await page.locator('#data-analysis-calc-name').fill('含税销售额');
        await page.locator('#data-analysis-calc-expression').fill('{{c_2}} * 1.13');
        await page.locator('#data-analysis-calc-preview').click();
        await expect(page.locator('#data-analysis-calc-preview-result')).toContainText('calculated_value', { timeout: 15_000 });
        await page.locator('#data-analysis-calc-modal [data-analysis-modal-close="data-analysis-calc-modal"]').first().click();
        await expect(page.locator('#data-analysis-calc-modal')).toBeHidden();

        await page.locator('#data-analysis-open-scale-modal').click();
        await expect(page.locator('#data-analysis-scalability-panel')).toBeVisible({ timeout: 15_000 });
        await page.locator('#data-analysis-scale-partition-field').selectOption('c_1');
        const partitionResponse = page.waitForResponse(response => response.url().endsWith('/partitions') && response.request().method() === 'POST');
        await page.locator('#data-analysis-scale-partition').click();
        await expect((await partitionResponse).status()).toBe(201);
        await expect(page.locator('#data-analysis-scale-assets')).toContainText('分区', { timeout: 15_000 });
        await page.locator('#data-analysis-scale-materialization-name').fill('区域销售额物化');
        await page.locator('#data-analysis-scale-materialization-group').selectOption('c_1');
        await page.locator('#data-analysis-scale-materialization-field').selectOption('c_2');
        const materializationResponse = page.waitForResponse(response => response.url().endsWith('/materializations') && response.request().method() === 'POST');
        await page.locator('#data-analysis-scale-materialization-save').click();
        await expect((await materializationResponse).status()).toBe(201);
        await expect(page.locator('#data-analysis-scale-assets')).toContainText('区域销售额物化', { timeout: 15_000 });
        await page.locator('#data-analysis-scalability-modal [data-analysis-modal-close="data-analysis-scalability-modal"]').first().click();
        await expect(page.locator('#data-analysis-scalability-modal')).toBeHidden();

        await page.locator('[data-data-analysis-tab="assets"]').click();
        await page.locator('#data-analysis-open-save-view-modal').click();
        await page.locator('#data-analysis-view-name').fill('区域销售额图表');
        await page.locator('#data-analysis-view-type').selectOption('chart');
        const saveViewResponse = page.waitForResponse(response => response.url().includes('/api/apps/data-analysis/datasets/') && response.url().endsWith('/views') && response.request().method() === 'POST');
        await page.locator('#data-analysis-save-view').click();
        await expect((await saveViewResponse).status()).toBe(201);
        await expect(page.locator('#data-analysis-saved-views')).toContainText('区域销售额图表', { timeout: 15_000 });

        await page.locator('[data-data-analysis-tab="dashboards"]').click();
        await page.locator('#data-analysis-open-create-dashboard-modal').click();
        await page.locator('#data-analysis-dashboard-name').fill('销售看板');
        await page.locator('#data-analysis-dashboard-create').click();
        await expect(page.locator('#data-analysis-dashboard-title')).toContainText('销售看板', { timeout: 15_000 });
        await page.locator('#data-analysis-open-add-view-modal').click();
        const savedViewId = await page.locator('#data-analysis-dashboard-view-select option').filter({ hasText: '区域销售额图表' }).getAttribute('value');
        await page.locator('#data-analysis-dashboard-view-select').selectOption(String(savedViewId));
        await page.locator('#data-analysis-dashboard-add-view').click();
        await expect(page.locator('#data-analysis-dashboard-items')).toContainText('区域销售额图表', { timeout: 15_000 });
        await page.locator('#data-analysis-dashboard-refresh').click();
        await expect(page.locator('#data-analysis-dashboard-snapshot')).toContainText('已刷新', { timeout: 15_000 });

        await page.locator('[data-data-analysis-tab="query"]').click();
        await page.locator('#data-analysis-query-mode-sql').click();
        await page.locator('#data-analysis-query-sql').fill('SELECT COUNT(*) AS total FROM data');
        await page.locator('#data-analysis-run-query-async').click();
        await expect(page.locator('#data-analysis-async-query-jobs')).toContainText('后台查询', { timeout: 15_000 });
    });

    test('数据分析在浏览器中导入 XLSX 和 SQLite，并保留表格字段与记录计数', async ({ page }) => {
        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pivot-analysis-e2e-import-'));
        const workbookPath = path.join(fixtureDir, 'e2e-orders.xlsx');
        const sqlitePath = path.join(fixtureDir, 'e2e-inventory.sqlite');
        try {
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
                ['订单号', '金额'],
                ['SO-001', 120],
                ['SO-002', 260]
            ]), '订单');
            XLSX.writeFile(workbook, workbookPath);
            const sqlite = new Sqlite(sqlitePath);
            sqlite.exec('CREATE TABLE inventory (sku TEXT NOT NULL, stock INTEGER NOT NULL); INSERT INTO inventory VALUES (\'SKU-01\', 8), (\'SKU-02\', 13);');
            sqlite.close();

            await ensureBrowserSession(page);
            await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
            await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15_000 });
            await page.evaluate(async () => {
                await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
                await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' });
            });
            await expect(page.locator('#data-analysis-view')).toBeVisible({ timeout: 15_000 });

            const workbookUpload = page.waitForResponse(response => response.url().endsWith('/api/apps/data-analysis/datasets') && response.request().method() === 'POST');
            await page.locator('#data-analysis-file').setInputFiles(workbookPath);
            expect((await workbookUpload).ok()).toBeTruthy();
            await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('e2e-orders', { timeout: 15_000 });
            await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('2 行');

            const sqliteUpload = page.waitForResponse(response => response.url().endsWith('/api/apps/data-analysis/datasets') && response.request().method() === 'POST');
            await page.locator('#data-analysis-file').setInputFiles(sqlitePath);
            const sqliteUploadResponse = await sqliteUpload;
            expect(sqliteUploadResponse.ok(), await sqliteUploadResponse.text()).toBeTruthy();
            await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('e2e-inventory', { timeout: 15_000 });
            await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('2 行');
        } finally {
            fs.rmSync(fixtureDir, { recursive: true, force: true });
        }
    });

    test('数据分析全量语义任务可启动、取消、重试并在刷新后恢复历史记录', async ({ page }) => {
        await ensureBrowserSession(page);
        const csrf = (await page.context().cookies()).find(cookie => cookie.name === 'pivot_csrf_token')?.value;
        const modelName = `E2E semantic model ${Date.now()}`;
        const createdModel = await page.request.post('/api/models', {
            headers: { 'x-csrf-token': csrf },
            data: { name: modelName, url: process.env.E2E_MODEL_URL, model_name: 'e2e-semantic-model' }
        });
        expect(createdModel.ok()).toBeTruthy();
        const models = await page.request.get('/api/models?limit=100');
        const model = (await models.json()).data.find(item => item.name === modelName);
        expect(model).toBeTruthy();
        const defaultModel = await page.request.put('/api/settings/default-model', {
            headers: { 'x-csrf-token': csrf },
            data: { default_model_id: model.id }
        });
        expect(defaultModel.ok()).toBeTruthy();

        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
        await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.evaluate(async () => {
            window.Pivot.legacy.showConfirm = async () => true;
            await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
            await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' });
        });
        await expect(page.locator('#data-analysis-view')).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#data-analysis-file')).toHaveCount(1, { timeout: 15_000 });
        const upload = page.waitForResponse(response => response.url().endsWith('/api/apps/data-analysis/datasets') && response.request().method() === 'POST');
        await page.locator('#data-analysis-file').setInputFiles({
            name: 'e2e-semantic.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from('编号,反馈\n1,物流速度需要改进\n2,客服响应及时\n', 'utf8')
        });
        expect((await upload).ok()).toBeTruthy();
        await expect(page.locator('#data-analysis-dataset-table-body')).toContainText('e2e-semantic', { timeout: 15_000 });

        await page.locator('[data-data-analysis-tab="ai"]').click();
        await page.locator('[data-ai-subtab="semantic"]').click();
        await expect(page.locator('#data-analysis-ai-subpanel-semantic')).toBeVisible();
        await page.locator('#data-analysis-semantic-field').selectOption('c_2');
        await page.locator('#data-analysis-semantic-instruction').fill('E2E_SEMANTIC_DELAY：提取反馈主题');
        const createJob = page.waitForResponse(response => response.url().includes('/semantic-analysis') && response.request().method() === 'POST');
        await page.locator('#data-analysis-semantic-run').click();
        expect((await createJob).status()).toBe(202);
        await expect(page.locator('#data-analysis-semantic-cancel')).toBeVisible({ timeout: 15_000 });

        const cancelJob = page.waitForResponse(response => response.url().includes('/semantic-analysis/jobs/') && response.url().endsWith('/cancel') && response.request().method() === 'POST');
        await page.locator('#data-analysis-semantic-cancel').click();
        expect((await cancelJob).ok()).toBeTruthy();
        await expect(page.locator('#data-analysis-semantic-status')).toContainText('已取消');
        await expect(page.locator('#data-analysis-semantic-retry')).toBeVisible();

        const retryJob = page.waitForResponse(response => response.url().includes('/semantic-analysis/jobs/') && response.url().endsWith('/retry') && response.request().method() === 'POST');
        await page.locator('#data-analysis-semantic-retry').click();
        expect((await retryJob).status()).toBe(202);
        await expect(page.locator('#data-analysis-semantic-job option:not([value=""])')).toHaveCount(1);
        const jobId = await page.locator('#data-analysis-semantic-job').inputValue();
        expect(jobId).not.toBe('');
        const datasetId = await page.evaluate(() => window.Pivot.legacy.PivotDataAnalysis.state.activeId);
        expect(datasetId).not.toBe('');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
        await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.evaluate(async restoredDatasetId => {
            window.Pivot.legacy.showConfirm = async () => true;
            await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
            await window.Pivot.legacy.showDataAnalysisApp({ tab: 'ai', datasetId: restoredDatasetId });
        }, datasetId);
        await expect(page.locator('#data-analysis-view')).toBeVisible({ timeout: 15_000 });
        await page.locator('[data-ai-subtab="semantic"]').click();
        await expect(page.locator('#data-analysis-semantic-job')).toHaveValue(jobId, { timeout: 15_000 });
    });

    test('数据分析对非法查询和网络中断提供中文可操作提示', async ({ page }) => {
        await ensureBrowserSession(page);
        await page.evaluate(() => window.Pivot.moduleApi('workspaces.navigation').openAppsWorkbench?.());
        await expect(page.locator('#apps-workbench-modal')).toBeVisible({ timeout: 15_000 });
        await page.evaluate(async () => {
            window.Pivot.legacy.showConfirm = async () => true;
            await window.Pivot.loadScriptOnce('/chat/apps-workbench-data-analysis.js');
            await window.Pivot.legacy.showDataAnalysisApp({ tab: 'overview' });
        });
        const upload = page.waitForResponse(response => response.url().endsWith('/api/apps/data-analysis/datasets') && response.request().method() === 'POST');
        await page.locator('#data-analysis-file').setInputFiles({ name: 'e2e-query-errors.csv', mimeType: 'text/csv', buffer: Buffer.from('地区,金额\n华东,100\n', 'utf8') });
        expect((await upload).ok()).toBeTruthy();
        await page.locator('[data-data-analysis-tab="query"]').click();
        await page.locator('#data-analysis-query-mode-sql').click();
        await page.locator('#data-analysis-query-sql').fill('SELECT * FROM data; DROP TABLE data');
        const rejected = page.waitForResponse(response => response.url().includes('/query') && response.request().method() === 'POST');
        await page.locator('#data-analysis-run-query').click();
        expect((await rejected).status()).toBe(400);
        await expect(page.locator('#toast-container')).toContainText(/单条查询|不允许/, { timeout: 10_000 });

        await page.route('**/api/apps/data-analysis/datasets/*/query', route => route.abort('failed'));
        await page.locator('#data-analysis-query-sql').fill('SELECT * FROM data');
        await page.locator('#data-analysis-run-query').click();
        await expect(page.locator('#toast-container')).toContainText('网络连接中断，请检查网络后重试。', { timeout: 10_000 });
    });
});
