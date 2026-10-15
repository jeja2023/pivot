/**
 * 流式交互渲染器
 * 负责接收SSE事件并实时渲染到UI
 */

class StreamingRenderer {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      throw new Error(`Container ${containerId} not found`);
    }

    this.options = {
      showThinkingChain: options.showThinkingChain !== false,
      showToolCalls: options.showToolCalls !== false,
      enableSound: options.enableSound || false,
      chunkDelay: options.chunkDelay || 0, // 逐字延迟
      ...options
    };

    this.eventSource = null;
    this.sessionId = null;
    this.isConnected = false;
    this.eventHandlers = new Map();
    this.thinkingSteps = new Map();
    this.outputBuffer = '';

    this.initializeUI();
  }

  /**
   * 初始化UI容器
   */
  initializeUI() {
    this.container.innerHTML = `
      <div class="streaming-container">
        <!-- 状态栏 -->
        <div class="streaming-status" id="streaming-status">
          <span class="status-dot"></span>
          <span class="status-text">未连接</span>
        </div>

        <!-- 思考链面板 -->
        <div class="thinking-chain-panel" id="thinking-chain-panel" style="display: none;">
          <div class="panel-header">
            <h4>思考过程</h4>
            <button class="collapse-btn" onclick="streamingRenderer.toggleThinkingChain()">折叠</button>
          </div>
          <div class="thinking-steps" id="thinking-steps"></div>
        </div>

        <!-- 工具调用面板 -->
        <div class="tool-calls-panel" id="tool-calls-panel" style="display: none;">
          <div class="panel-header">
            <h4>工具调用</h4>
          </div>
          <div class="tool-calls" id="tool-calls"></div>
        </div>

        <!-- 输出内容区 -->
        <div class="output-panel" id="output-panel">
          <div class="output-content" id="output-content"></div>
        </div>

        <!-- 性能指标 -->
        <div class="performance-metrics" id="performance-metrics" style="display: none;">
          <span id="first-byte-latency">首字延迟: -</span>
          <span id="total-chunks">总块数: 0</span>
          <span id="avg-latency">平均延迟: -</span>
        </div>
      </div>
    `;

    this.statusEl = document.getElementById('streaming-status');
    this.thinkingPanel = document.getElementById('thinking-chain-panel');
    this.thinkingSteps = document.getElementById('thinking-steps');
    this.toolCallsPanel = document.getElementById('tool-calls-panel');
    this.toolCallsEl = document.getElementById('tool-calls');
    this.outputContent = document.getElementById('output-content');
    this.metricsEl = document.getElementById('performance-metrics');
  }

  /**
   * 连接到SSE流
   */
  async connect(runId) {
    if (this.isConnected) {
      console.warn('Already connected');
      return;
    }

    try {
      this.updateStatus('connecting', '正在连接...');

      // 建立SSE连接
      this.eventSource = new EventSource(`/api/agent/runs/${runId}/stream`);

      // 注册事件处理器
      this.eventSource.addEventListener('connected', (e) => this.handleConnected(e));
      this.eventSource.addEventListener('thinking_start', (e) => this.handleThinkingStart(e));
      this.eventSource.addEventListener('thinking_chunk', (e) => this.handleThinkingChunk(e));
      this.eventSource.addEventListener('thinking_end', (e) => this.handleThinkingEnd(e));
      this.eventSource.addEventListener('tool_call_start', (e) => this.handleToolCallStart(e));
      this.eventSource.addEventListener('tool_call_progress', (e) => this.handleToolCallProgress(e));
      this.eventSource.addEventListener('tool_call_end', (e) => this.handleToolCallEnd(e));
      this.eventSource.addEventListener('output_chunk', (e) => this.handleOutputChunk(e));
      this.eventSource.addEventListener('output_end', (e) => this.handleOutputEnd(e));
      this.eventSource.addEventListener('error', (e) => this.handleError(e));
      this.eventSource.addEventListener('status_change', (e) => this.handleStatusChange(e));
      this.eventSource.addEventListener('close', (e) => this.handleClose(e));

      // 错误处理
      this.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        this.updateStatus('error', '连接错误');
        this.disconnect();
      };

    } catch (error) {
      console.error('Failed to connect:', error);
      this.updateStatus('error', '连接失败');
      throw error;
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.isConnected = false;
    this.updateStatus('disconnected', '已断开');
  }

  /**
   * 处理连接建立
   */
  handleConnected(e) {
    const data = JSON.parse(e.data);
    this.sessionId = data.data.sessionId;
    this.isConnected = true;
    this.updateStatus('connected', '已连接');
    console.log('SSE connected:', data);
  }

  /**
   * 处理思考开始
   */
  handleThinkingStart(e) {
    if (!this.options.showThinkingChain) return;

    const { data } = JSON.parse(e.data);
    const step = data.step;

    // 显示思考链面板
    this.thinkingPanel.style.display = 'block';

    // 创建思考步骤元素
    const stepEl = document.createElement('div');
    stepEl.className = 'thinking-step';
    stepEl.id = `thinking-step-${step}`;
    stepEl.innerHTML = `
      <div class="step-header">
        <span class="step-number">步骤 ${step}</span>
        <span class="step-status">思考中...</span>
      </div>
      <div class="step-content" id="step-content-${step}"></div>
      <div class="step-progress">
        <div class="progress-bar" id="progress-bar-${step}" style="width: 0%"></div>
      </div>
    `;

    this.thinkingStepsEl.appendChild(stepEl);

    // 滚动到底部
    stepEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  /**
   * 处理思考内容块
   */
  async handleThinkingChunk(e) {
    if (!this.options.showThinkingChain) return;

    const { data, content } = JSON.parse(e.data);
    const step = data.step;
    const progress = data.progress;

    const contentEl = document.getElementById(`step-content-${step}`);
    const progressEl = document.getElementById(`progress-bar-${step}`);

    if (contentEl) {
      // 逐字显示效果
      if (this.options.chunkDelay > 0) {
        for (let char of content) {
          contentEl.textContent += char;
          await this.sleep(this.options.chunkDelay);
        }
      } else {
        contentEl.textContent += content;
      }
    }

    if (progressEl) {
      progressEl.style.width = `${progress}%`;
    }
  }

  /**
   * 处理思考结束
   */
  handleThinkingEnd(e) {
    if (!this.options.showThinkingChain) return;

    const { data } = JSON.parse(e.data);
    const step = data.step;

    const stepEl = document.getElementById(`thinking-step-${step}`);
    if (stepEl) {
      const statusEl = stepEl.querySelector('.step-status');
      statusEl.textContent = '已完成';
      statusEl.classList.add('completed');
    }

    if (data.observation) {
      const contentEl = document.getElementById(`step-content-${step}`);
      if (contentEl) {
        contentEl.innerHTML += `<div class="observation">观察: ${data.observation}</div>`;
      }
    }
  }

  /**
   * 处理工具调用开始
   */
  handleToolCallStart(e) {
    if (!this.options.showToolCalls) return;

    const { data } = JSON.parse(e.data);
    const toolName = data.tool;

    // 显示工具调用面板
    this.toolCallsPanel.style.display = 'block';

    // 创建工具调用元素
    const toolEl = document.createElement('div');
    toolEl.className = 'tool-call';
    toolEl.id = `tool-call-${toolName}`;
    toolEl.innerHTML = `
      <div class="tool-header">
        <span class="tool-name">${toolName}</span>
        <span class="tool-status">调用中...</span>
      </div>
      <div class="tool-progress">
        <div class="progress-bar" id="tool-progress-${toolName}" style="width: 0%"></div>
      </div>
    `;

    this.toolCallsEl.appendChild(toolEl);
  }

  /**
   * 处理工具调用进度
   */
  handleToolCallProgress(e) {
    if (!this.options.showToolCalls) return;

    const { data } = JSON.parse(e.data);
    const toolName = data.tool;
    const progress = data.progress;

    const progressEl = document.getElementById(`tool-progress-${toolName}`);
    if (progressEl) {
      progressEl.style.width = `${progress}%`;
    }
  }

  /**
   * 处理工具调用结束
   */
  handleToolCallEnd(e) {
    if (!this.options.showToolCalls) return;

    const { data } = JSON.parse(e.data);
    const toolName = data.tool;

    const toolEl = document.getElementById(`tool-call-${toolName}`);
    if (toolEl) {
      const statusEl = toolEl.querySelector('.tool-status');
      statusEl.textContent = '已完成';
      statusEl.classList.add('completed');

      if (data.result) {
        const resultEl = document.createElement('div');
        resultEl.className = 'tool-result';
        resultEl.textContent = typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2);
        toolEl.appendChild(resultEl);
      }
    }
  }

  /**
   * 处理输出内容块
   */
  async handleOutputChunk(e) {
    const { content } = JSON.parse(e.data);

    if (this.options.chunkDelay > 0) {
      for (let char of content) {
        this.outputBuffer += char;
        this.outputContent.textContent = this.outputBuffer;
        await this.sleep(this.options.chunkDelay);
      }
    } else {
      this.outputBuffer += content;
      this.outputContent.textContent = this.outputBuffer;
    }

    // 自动滚动
    this.outputContent.scrollTop = this.outputContent.scrollHeight;
  }

  /**
   * 处理输出结束
   */
  handleOutputEnd(e) {
    const { content } = JSON.parse(e.data);
    if (content) {
      this.outputBuffer += content;
      this.outputContent.textContent = this.outputBuffer;
    }

    // 标记完成
    this.outputContent.classList.add('completed');
  }

  /**
   * 处理错误
   */
  handleError(e) {
    const { data } = JSON.parse(e.data);
    console.error('Streaming error:', data);

    const errorEl = document.createElement('div');
    errorEl.className = 'error-message';
    errorEl.innerHTML = `
      <strong>错误:</strong> ${data.message}
    `;
    this.outputContent.appendChild(errorEl);

    this.updateStatus('error', '发生错误');
  }

  /**
   * 处理状态变更
   */
  handleStatusChange(e) {
    const { data } = JSON.parse(e.data);
    console.log('Status changed:', data);
    this.updateStatus('info', `${data.oldStatus} → ${data.newStatus}`);
  }

  /**
   * 处理连接关闭
   */
  handleClose(e) {
    const data = JSON.parse(e.data);
    console.log('Connection closed:', data);
    this.disconnect();
  }

  /**
   * 更新状态显示
   */
  updateStatus(status, text) {
    const statusDot = this.statusEl.querySelector('.status-dot');
    const statusText = this.statusEl.querySelector('.status-text');

    statusDot.className = `status-dot status-${status}`;
    statusText.textContent = text;
  }

  /**
   * 切换思考链显示
   */
  toggleThinkingChain() {
    const steps = this.thinkingPanel.querySelector('.thinking-steps');
    steps.style.display = steps.style.display === 'none' ? 'block' : 'none';
  }

  /**
   * 工具函数：延迟
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 清理
   */
  cleanup() {
    this.disconnect();
    this.container.innerHTML = '';
  }
}

// 导出
if (typeof window !== 'undefined') {
  window.StreamingRenderer = StreamingRenderer;
  window.Pivot = window.Pivot || {};
  window.Pivot.StreamingRenderer = StreamingRenderer;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamingRenderer;
}
