# Pivot（智枢）开源工具离线移植、精准选型与深度集成全景指南

> **版本状态说明（2026-10-23 修订版）**：
> 本指南对应主程序版本 `0.7.32`（落地方案 v1.2 规范），依据 [《开源工具离线移植与深度集成指南审查报告_2026-10-22.md》](docs/reports/开源工具离线移植与深度集成指南审查报告_2026-10-22.md) 修订架构说明；代码交付见 [v0.7.32 发布记录](docs/releases/v0.7.32-离线工具受控接入与产物交付.md)，实际验证以部署手册和验收记录为准，不把候选方向视为已安装的能力。
> **适用场景与核心定调**：针对**纯离线/无外网局域网**政企生产环境，系统阐述如何将优秀的开源工具（算法引擎、专业组件、技能配方等）通过自包含容器与标准化协议，原封移植并与 **Pivot 智能中枢** 实现嵌入式深度集成。
> **核心指导原则**：
> 1. **“复用既有运行时，拒绝双重引擎”**：坚决不引入外部大脑框架，外部开源资产仅作为被调用的单点功能微服务（Tool/Engine）；
> 2. **“联网端自包含固化，内网零出站运行”**：所有依赖、模型、环境在外网构建期锁死并生成物料清单（BOM），内网冷启动零网络依赖；
> 3. **“从协议打通到业务闭环”**：工具可调用（Schema 发现）不等于集成完成，必须经由适配层接入 UI Rendition、CAS 产物库与 RBAC/审批门禁。

---

## 阅读顺序

1. 先核对本文的能力现状和实际增量目标。
2. 参照 [离线工具部署与验收](docs/deployment/离线工具服务部署与验收.md) 构建、导出和安装真实服务。
3. 按技能发布流程完成完整验证，运行实际权限、产物与异常测试。
4. 根据备份与恢复章节完成同恢复点演练，再进行现场切换。

---

# 第一部分：现状盘点与精准选型篇（做与不做的界限）

## 1.1 Pivot 现有成熟能力全景与“防重复”红线

当前 **Pivot（智枢）** 已经完成了一个企业级/政企 AI 平台核心版图的构建，具备了完整的“办文、办事、办会、查法、识图、析数”业务矩阵。

在评估引入任何外部开源工具之前，必须严格排查，**凡属于已有成熟能力的，坚决不再重复建设**：

```mermaid
graph TD
    subgraph 已具备的成熟底座 [坚决不重复引入]
        M1["模型底座: 内网 OpenAI 兼容推理服务 (Qwen 2.5/3.x)"]
        M2["视觉感知: PaddleOCR 独立 HTTP 微服务"]
        M3["音频感知与播报: Vosk 离线 STT + 客户端/服务端受控 TTS"]
        M4["数据底座: PostgreSQL (业务主库) + 内置 DuckDB 分析引擎"]
    end

    subgraph 已具备的业务应用矩阵 [坚决不引入同质化应用]
        A1["公文写作与审校: 格式规整 / 模板编排 / 段落位置对照"]
        A2["法规查询: 专业法条检索 / 解读 / 知识库索引"]
        A3["演示与渲染: PPT 制作 / SVG 图形 / ECharts 统计图表"]
        A4["文档与比较: veraPDF 校验 / qpdf / PDF 逐页像素视觉差分"]
        A5["数据分析: 结构化表格 / 数据集只读分析 / 报表编排"]
        A6["知识同步: 目录/SMB/Wiki/数据库增量同步调度"]
    end

    subgraph 待补强的真正短板 [高 ROI 增量补强]
        G1["① 统一部署的高质量离线 TTS 引擎 (全双工与国产端体验)"]
        G2["② 公文/法规字符级与红线修订比对 (Word 修订与条款对照)"]
        G3["③ 思维导图与流程图确定性渲染 (Mermaid/PlantUML 矢量转图)"]
        G4["④ 局域网复杂 OA/门户智能抓取 (动态渲染与防噪 Markdown 清洗)"]
    end

    M1 & M2 & M3 & M4 -.-> A1 & A2 & A3 & A4 & A5 & A6
    A1 & A2 & A3 & A4 & A5 & A6 ==> G1 & G2 & G3 & G4
```

### 现有能力与开源工具“排重清单”

> [!NOTE]
> 模型与 OCR 应严格区分**“架构支持”**、**“目标现场已部署”**与**“当前镜像已包含”**：Pivot 核心服务维护任务、会话和产物状态，通过配置对接内网模型推理端点，PaddleOCR 作为独立微服务交付，业务持久化存储依赖独立 PostgreSQL，DuckDB 专注于只读分析计算。

| 业务领域 | Pivot 本地已有实现证据 | 常见的外部开源项目 | 决策建议 | 详细理由与现状边界 |
| :--- | :--- | :--- | :--- | :--- |
| **大模型推理** | 支持接入本地部署的 **Qwen 2.5/3.x**（OpenAI 兼容接口） | Llama 系列、ChatGLM、Mistral | ❌ **不重复引入** | Qwen 中文公文理解能力处于第一梯队；只需维护现有端点配置，无需引入多套模型底座。 |
| **文字识别** | 独立部署的 **PaddleOCR** HTTP 微服务 | Tesseract、EasyOCR、Umi-OCR | ❌ **不重复引入** | 现有 PaddleOCR 已能稳定处理公文印刷体与版面结构，同质化工具无增量价值。 |
| **PDF 校验与差分** | 内置 **qpdf + veraPDF** CLI，且具备 PDF 逐页像素比对（[advanced.js](server/services/document-processing/pdf/operations/advanced.js#L222)） | PDFtk、PyMuPDF 基础裁剪 | ❌ **不重复引入** | 已具备合规校验、修复与逐页视觉差异图能力，普通裁切与视觉比对无需新设工具。 |
| **通用数据分析** | **PostgreSQL**（主库）+ **DuckDB** + [database-mcp.js](server/services/database-mcp.js) | Pandas 独立执行壳、SQLite 探针 | ❌ **不重复引入** | Pivot 已有完善的关系库和高性能列存分析能力，杜绝无鉴权的数据探针容器。 |
| **语音输入与播放** | 内置 **Vosk (STT)**，服务端 [`AGENT_TTS_ENDPOINT`](server/services/agent-media-generation.js) 与客户端 [`realtime-voice.js`](client/chat/realtime-voice.js) | Whisper、FunASR | ❌ **不重复引入** | Vosk 纯 CPU 离线运行稳定，客户端已有 Web Speech 朗读与打断；缺口在离线高质量 TTS 统一后端。 |
| **知识来源增量同步** | [knowledge-sources.js](server/services/knowledge-sources.js) 支持本地目录、Wiki、HTTP 清单与数据库模板增量同步 | Dify 知识库连接器、FastGPT 导入器 | ❌ **不重复引入** | 现有调度器已支持哈希比对与删除同步；缺口仅在内网动态复杂 OA 渲染抓取。 |

---

## 1.2 为什么拒绝全套移植通用 Agent 框架

在评估开源 Agent 框架（如 `hermes-agent`、`LangChain`、`CrewAI`、`AutoGPT`）时，部分开发者倾向于“整体引入”。在企业级生产环境中，这种做法存在显著弊端：

1. **运行时机制重复与混乱**：
   Pivot 服务端自研了严谨的企业级 Agent 运行时，已包含完整的底层控制面：
   - 任务 DAG 编排：[agent-dag-runtime.js](server/services/agent-dag-runtime.js)
   - 技能严格版本控制与鉴权：[agent-skills.js](server/services/agent-skills.js) 与 [agent-releases.js](server/services/agent-releases.js)
   - 沙箱与终端隔离：[agent-terminal-runtime.js](server/services/agent-terminal-runtime.js) 与 [agent-sandbox.js](server/services/agent-sandbox.js)
   - 不可变内容寻址产物库：[agent-artifact-cas.js](server/services/agent-artifact-cas.js)
2. **复用统一企业治理能力（RBAC 与审批门禁）**：
   外部通用 Agent 框架（如 Hermes）虽然具备单机危险命令确认和基础容器隔离能力，但通常缺乏政企所需的组织层级可见性管控（[unit-visibility.js](server/services/unit-visibility.js)）、基于角色的权限隔离，以及跨会话的高危动作多级人工审批流（[agent-approval-requests.js](server/services/agent-approval-requests.js)）。
3. **架构烟囱化与审计断裂**：
   引入完整框架会导致系统内部存在两套 Prompt 组装逻辑、两套会话记忆机制、两份不可对齐的审计日志，造成排错与合规审计的灾难。

> [!IMPORTANT]
> **结论**：坚决不引入外部“框架类/大脑类”项目。外部工具只作为被调用的**“单点功能微服务（Tool/Engine）”**挂载进 Pivot 的工具总线中，统一纳入 Pivot 的治理、审批与审计闭环。

---

## 1.3 真正值得补强的四大高价值互补方向与选型分析

结合政企实际办公中的痛点与系统真实能力现状，明确四大增量补强目标及选型约束：

### 1. 全离线统一高保真语音合成引擎（TTS，补全全终端一致体验）
* **现状与差距**：系统已有 Vosk 实现了离线输入，[agent-media-generation.js](server/services/agent-media-generation.js) 已有 `AGENT_TTS_ENDPOINT` 受控 Provider，客户端 [realtime-voice.js](client/chat/realtime-voice.js) 也已具备朗读与打断逻辑。**现有缺口在于**：缺乏统一部署、跨国产终端体验一致的高质量中文离线 TTS 独立微服务（避免依赖各客户端操作系统自带的偶发发音引擎或外部云接口）。
* **高频业务场景**：公文通读审校（文字工作者用耳朵挑错字、语病）、法规条款摘要语音播音、会议纪要要点朗读。
* **推荐选型与许可边界**：
  - **Piper**（首选推荐）：原项目 `rhasspy/piper` 已归档，当前活跃维护分支为 [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl)（声明为 **GPL-3.0** 许可证；注意：中文音色模型权重需单独核查各自模型卡的 License，如商业友好度）。基于 C++ 与 ONNX Runtime，具备**低延迟、纯 CPU 运行开销小**的优势，适合打包为轻量无 GPU 依赖的微服务。
  - **CosyVoice**（阿里开源，Apache 2.0 许可证）：若现场 GPU 算力充裕（具体显存需求按所选模型与目标硬件实测）且追求极高拟人度与情感起伏，可作为可选增强节点部署。
  - **验收要求**：在目标内网 CPU 机器上实测并发吞吐、首字音频延迟（TTFB）与中文多音字发音准确率。

### 2. 公文与法规专属“红线精细比对”（Diff 引擎，字词级与 DOCX 修订）
* **现状与差距**：[apps-workbench-proofread.js](client/chat/apps-workbench-proofread.js) 已具备公文段落对照，[advanced.js](server/services/document-processing/pdf/operations/advanced.js#L222) 已具备 PDF 逐页像素级视觉渲染比对。**现有缺口在于**：字符/词级精准对齐、段落移动识别、标准 Word 审阅模式（DOCX Track Changes 修订批注）以及可核查的条款对比凭据。
* **高频业务场景**：
  - 领导批改公文草稿对比：草稿与修改稿一键生成标准 Word 审阅红线文件（增删改痕迹字字清晰）；
  - 新旧法规条文对照：条款增删、移位、变动左右双栏精准标红对照。
* **推荐选型与契约设计**：
  - 基于 AST/DOM 的文档比对微服务（封装 `python-docx` / XML 差分逻辑），作为独立微服务容器运行；
  - 明确输出契约：输出标准化 Diff JSON（包含变更类型 `add`/`delete`/`modify`/`move`、原文字符区间、修订理由）并直接合成带红线修订标记的 `.docx` 文件写入 CAS。

### 3. 思维导图与流程图确定性渲染（从代码到矢量图形可视化）
* **现状与差距**：Pivot 已具备 ECharts 统计图表（`pivot_chart`）、SVG 展示组件与 PPT 层次元素排版。但在产物视图中，通用 Mermaid 文本依然回退为纯代码块。**现有缺口在于**：从纯文本图表描述到高清矢量图形（SVG/PNG）的确定性渲染，以及可选的思维导图交互编辑能力。
* **高频业务场景**：法规审批审批流程高清流程图渲染、大型调研规划大纲一键生成思维导图（MindMap）。
* **推荐选型与许可边界**：
  - **Kroki**（首选推荐，MIT 许可证）：统一的多引擎网关镜像，传入纯文本输出 SVG/PNG；耗时与可用性须按实际引擎和样本验证。
    > [!WARNING]
    > **部署关键**：`yuzutech/kroki` 基础网关默认**不包含** Mermaid 引擎！生产部署必须额外拉起 `yuzutech/kroki-mermaid` 伴随容器，并配置环境变量 `KROKI_MERMAID_HOST`，详见 2.4 节。
  - **MindElixir**（MIT 许可证）：纯前端轻量级思维导图交互库，直接嵌入产物视图，无需额外服务端。

### 4. 局域网内网定向知识抓取与清洗（扩展动态 OA 与门户连接器）
* **现状与差距**：[knowledge-sources.js](server/services/knowledge-sources.js) 已经支持本地/SMB 目录、Wiki Markdown、HTTP API 清单与数据库模板的哈希增量同步与定时调度。**现有缺口在于**：缺少针对局域网内部复杂 OA 门户（涉及 Cookie/表单登录、动态 JavaScript 渲染、强广告/侧边栏干扰）的定向抽取与高保真 Markdown 清洗连接器。
* **高频业务场景**：定期巡检内网政务内网门户、自动抽取政策公文正文并过滤导航杂音，沉淀为干净知识库源文档。
* **推荐选型与许可边界**：
  - **Crawl4AI**（推荐，Apache 2.0 许可证）：专为 LLM 设计的高性能爬虫，基于 Playwright 支持无头渲染与结构化内容抽取，许可证友好。
  - **Firecrawl（自部署版）**：具备深层抽取能力，但主体采用 **AGPL-3.0** 许可证，且自部署依赖 Redis、Playwright 等多项重型组件，需严格核查网络边界与开源传染性风险。

---

## 1.4 新工具准入“三问评估决策法”

团队在评估引入任何外部开源工具时，必须严格执行以下决策树：

```
                ┌────────────────────────────────┐
                │ 提议引入某 GitHub 开源工具     │
                └───────────────┬────────────────┘
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │ 第一问：该能力是否与当前已有功能重合？       │
         │ (已有 Qwen、PaddleOCR、公文段落对照、        │
         │  PDF 像素比对、knowledge-sources 同步等)     │
         └──────────────┬───────────────────────────────┘
                        │
                [否] ───┴─── [是] ─────────► ❌ 坚决否决，复用现有链路
                 │
                 ▼
         ┌──────────────────────────────────────────────┐
         │ 第二问：能否在外网完成自包含固化打包？       │
         │ (内网运行期 0 外网出站、无在线权重/wheel下载)│
         └──────────────┬───────────────────────────────┘
                        │
                [是] ───┴─── [否] ─────────► ❌ 暂缓引入，不满足离线交付
                 │
                 ▼
         ┌──────────────────────────────────────────────┐
         │ 第三问：是否属于高频真实刚需且许可证合规？   │
         │ (有业务痛点，无 AGPL 意外传染，非极客尝鲜)   │
         └──────────────┬───────────────────────────────┘
                        │
                [是] ───┴─── [否] ─────────► ⏸️ 搁置，保持系统架构精简
                 │
                 ▼
      ════════════════════════════════════════════
      ✅ 批准引入：
         1. 制作自包含 Docker 镜像挂载至 ai-bridge 网络
         2. 通过标准 Streamable HTTP (MCP) 或受控 REST 接入
         3. 编写适配层接入 UI Rendition 与 CAS 产物库
      ════════════════════════════════════════════
```

---

# 第二部分：架构设计与深度集成篇（如何做到原装且内嵌）

## 2.1 总体架构拓扑图

```mermaid
graph TD
    subgraph 用户交互层 [Pivot 前端 UI]
        Chat["会话窗口 (Chat)"]
        Cards["原生交互卡片 (Renditions: 图表/Diff/下载)"]
        ApprovalModal["审批与授权弹窗 (ApprovalModal)"]
    end

    subgraph Pivot 核心控制面 [Node.js 主服务 :3000]
        AgentEngine["Agent 决策与任务编排 (agent-dag-runtime)"]
        ToolRouter["工具总线与 MCP 客户端 (mcp-client)"]
        Security["出站网络策略 (SSRF 防护) 与安全审计"]
        AdaptorLayer["规范化适配层 (Document IR 转换器)"]
        CASStore["不可变产物库 (agent-artifact-cas)"]
    end

    subgraph 虚拟共享网络 [Docker ai-bridge (受限互联)]
        PivotHost["pivot 核心容器"]
        ToolA["开源工具 A: 离线 FastMCP 容器<br>(如: AST 代码扫描微服务)"]
        ToolB["开源工具 B: 重型算法微服务<br>(如: Kroki 渲染伴随服务组)"]
        ToolC["开源工具 C: 扩展知识抓取连接器<br>(如: Crawl4AI 无头渲染服务)"]
    end

    Chat <--> AgentEngine
    AgentEngine --> ToolRouter
    ToolRouter --> Security
    Security <-->|纯内网 Streamable HTTP / JSON-RPC| ToolA
    Security <-->|纯内网受控 REST API| ToolB
    Security <-->|纯内网抓取调度| ToolC

    ToolA -->|结构化分析数据| AdaptorLayer
    ToolB -->|高清矢量图/二进制| AdaptorLayer
    AdaptorLayer -->|写入不可变 CAS 制品| CASStore
    AdaptorLayer -->|生成规范化 Rendition| Cards
    Cards <--> CASStore
```

---

## 2.2 本项目现有成熟范本对照

在当前的 Pivot 仓库中，“自包含开源底座 + 受控业务外壳”的架构已有成熟范本可供对照参考：

| 现有组件 | 底层开源技术 | 移植与打包方式 | Pivot 内的深度嵌入实现 | 对应代码与配置 |
| :--- | :--- | :--- | :--- | :--- |
| **离线语音转写** | 开源 Vosk (C/Python) | `Dockerfile` 多阶段构建，构建期运行脚本固化离线模型权重 | 前端录音、转写与错误提示；提供方行为按现场配置确认 | [Dockerfile](Dockerfile#L46-L55)<br>[docker/speech-service](docker/speech-service/Dockerfile) |
| **PDF 标准校验与修复** | 开源 veraPDF (Java) 与 qpdf (C++) | 构建期拉取官方无交互 CLI 安装器，直接以二进制 CLI 固化进运行镜像 | 文档解析时自动触发合规性校验，输出不可篡改的校验报告 | [Dockerfile](Dockerfile#L25-L45)<br>[document-rendering](server/services/document-rendering/index.js) |
| **标准 MCP 工具通信** | Model Context Protocol | 采用 JSON-RPC 与 Streamable HTTP 协议与外部服务通信 | 动态拉取工具 Schema，统一前缀治理与权限映射 | [mcp-client.js](server/services/mcp-client.js)<br>[tool-library.js](server/routes/tool-library.js) |
| **多容器网络隔离** | Docker Bridge 网络 | 预建统一的 `ai-bridge` 隔离网络 | 主容器与独立微服务通过内网容器名解析，无公网暴露 | [docker-compose.yml](docker-compose.yml#L51-L54) |

---

## 2.3 原封移植如何落地“四重深度嵌入”（从协议可调用到业务深度集成）

“工具可调用”仅仅是第一步，真正的深度嵌入必须经由适配层接入 Pivot 的四大管理维度：

```mermaid
classDiagram
    class OpenSourceEngine {
        +run_inference()
        +process_file()
        +query()
    }
    class PivotGlueLayer {
        +1_AgentLoop_Schema()
        +2_Result_Normalizer()
        +3_DocumentIR_Builder()
        +4_CAS_Store_Rendition()
    }
    class PivotPlatform {
        +ChatWindow
        +RBAC_Visibility
        +Approval_Gate
        +Artifact_CAS
    }

    OpenSourceEngine <--> PivotGlueLayer : 纯内网 Streamable HTTP / REST
    PivotGlueLayer <--> PivotPlatform : 注册至平台总线
```

### 1. 会话与决策嵌入（Agent Loop & Schema）
- **实现目标**：让模型明确理解工具能力边界与入参格式，自主决定调度时机。
- **做法**：在工具提供端输出符合 JSON Schema 规范的工具清单。参考 [mcp-tool-presentation.js](server/services/mcp-tool-presentation.js)。入参设计应避免让模型组装宿主机文件绝对路径，推荐内容直传或受控 ID 引用。

### 2. 权限与审批嵌入（Governance & Approval Gates）
- **实现目标**：外部微服务不具备组织级 RBAC，Pivot 必须作为统一安全前置网关。
- **做法**：
  - **可见性控制**：通过 [unit-visibility.js](server/services/unit-visibility.js) 限制特定工具仅允许特定角色或部门使用；
  - **高危动作审批门禁**：对存在持久化修改、执行代码或大范围扫描风险的工具，在登记时设置 `risk_level: high`，执行前由 [agent-approval-requests.js](server/services/agent-approval-requests.js) 自动拦截并触发人工审批。

### 3. 产物沉淀与版本嵌入（Artifacts & CAS Lifecycle）
- **实现目标**：外部工具生成的结构化数据、比对报表或渲染图形，严禁散落在宿主机临时目录，必须进入不可变版本生命周期。
- **做法**：适配层捕获执行结果，调用 [agent-artifacts.js](server/services/agent-artifacts.js) 创建产物记录，二进制数据通过 [agent-artifact-cas.js](server/services/agent-artifact-cas.js) 计算 SHA-256 哈希落库。

### 4. 界面与交互嵌入（UI Renditions & Document IR）
- **实现目标**：拒绝简单展示原始 JSON，通过原生卡片展示交互式表格、ECharts 图表、Diff 对照或下载浮窗。
- **必须明确的端到端产物转化管线（5 步闭环）**：
  ```
  外部工具返回原始数据
    ──► 1. 适配层解析与规范化 (Normalization)
    ──► 2. 写入/更新基础产物 (agent-artifacts.js)
    ──► 3. 组装 Document IR 结构 (document-ir.js)
    ──► 4. 创建不可变 Rendition 制品 (agent-artifact-renditions.js::createRendition)
    ──► 5. 前端安全消费与下载凭证签发 (短期一次性下载 Token)
  ```

---

## 2.4 实际接入与部署入口

本仓库已交付 [MCP 离线工具服务](docker/offline-tools/app.py)、[固定依赖锁](docker/offline-tools/requirements.lock)、[Dockerfile](docker/offline-tools/Dockerfile) 与 [Compose](docker-compose.tools.yml)。工具入口使用 Bearer 鉴权；Kroki 与 Mermaid 只接入独立内部渲染网络。完整构建、物料校验、服务登记与运行验收见 [离线工具部署手册](docs/deployment/离线工具服务部署与验收.md)。不要复制旧示例创建另一份 HTTP 客户端。

普通用户通过服务端核验的全局连接访问固定内网端点，仍受任务白名单、敏感地址检查和 DNS 复核约束；个人自行登记的连接不获得该委托。OpenAPI 接入复用 [受控操作导入](server/services/workflow-api-operations.js)，不允许任意 URL 透传。

工具产物由 [适配器](server/services/tool-result-artifacts.js) 消费明确的 `structuredContent.pivotArtifact` 契约，通过 IR、CAS、Rendition 和短期下载凭证交付。SVG 的结构检查与受限 PNG 转换在 [图形渲染器](server/services/document-rendering/image-renderer.js) 完成。只发现 Schema 不代表完成业务集成。

---

# 第三部分：深度实战案例：Hermes-Agent 工具与技能融合篇

## 3.1 资产两分法理念（Skills 技能配方 vs Tools 执行工具）

对于 `hermes-agent` 等开源项目，正确的融合策略是：**“取其弹药，用我战车”**：
1. **技能层（Skills）**：沉淀 Prompt 指令、多步骤排错流程与标准 SOP，转换为 Pivot 标准 `SKILL.md`；
2. **工具层（Tools）**：用 Python 编写的真实执行逻辑，包装为 FastMCP 独立微服务并挂载至工具总线。

```mermaid
flowchart TD
    subgraph Hermes 开源资产
        H_Skill["Hermes SKILL.md<br>(提示词与 SOP)"]
        H_Tool["Hermes Python 逻辑<br>(单点功能执行脚本)"]
    end

    subgraph 适配与转换层
        S_Map["元数据映射 Adapter<br>显式声明 Pivot capabilities 与真实 tools"]
        T_MCP["FastMCP 独立微服务<br>(暴露标准 Streamable HTTP /mcp 端点)"]
    end

    subgraph Pivot 平台核心控制面
        PivotSkill["Pivot 技能库<br>(agent-skill-authoring)"]
        PivotMCP["Pivot MCP 总线<br>(mcp-client)"]
        PivotEngine["Agent 运行时<br>(agent-dag-runtime)"]
        CAS["不可变产物库 (CAS)"]
    end

    H_Skill --> S_Map --> PivotSkill
    H_Tool --> T_MCP --> PivotMCP
    PivotSkill --> PivotEngine
    PivotMCP --> PivotEngine
    PivotEngine --> CAS
```

---

## 3.2 Skill（技能配方）标准对齐、安全校验与发布门禁

### 1. 规范对照与字段映射要求

在 [agent-skill-authoring.js](server/services/agent-skill-authoring.js) 和 [agent-skills.js](server/services/agent-skills.js) 中，Pivot 对 `SKILL.md` 执行严格的 Schema 门禁检查（`previewSkillSource()`）：
- **唯一标识与展示名**：稳定 ASCII 标识填入 `id` 与 `name`，中文展示名填入 `title`；
- **能力注册覆盖**：`capabilities` 中的每个标识必须在 [agent-capability-registry.js](server/services/agent-capability-registry.js) 中已登记（例如外部 MCP 工具调用需要声明 `network.request`，工作区读取需要声明 `filesystem.read_workspace`）；
- **工具名称精确绑定**：`tools` 声明必须是系统内已登记的工具名称（例如实际已挂载的数字服务 ID `mcp.42.run_ast_audit`，以及内置工作区读取工具 `mcp.0.workspace.read`）。

| 字段 | Hermes `SKILL.md` | Pivot 平台严格规范要求 | 转换动作与要求 |
| :--- | :--- | :--- | :--- |
| **唯一标识** | `name: security-audit` | `id: security-audit`<br>`name: security-audit` | 必须保持小写字母与连字符的稳定标识 |
| **展示标题** | （缺失） | `title: 源码安全漏洞审查专家` | 补充人类友好的展示标题 |
| **规范版本** | （无要求） | `schemaVersion: 1` | 严格模式固定填 `1` |
| **版本号** | 可选 `metadata.version`；上游扩展需单独识别 | `version: 1.0.0` | 必须符合 SemVer 规范 |
| **能力授权** | （无） | `capabilities: [...]` | **必填**，必须为注册表中存在的能力，并覆盖工具所需权限 |
| **工具授权** | 可选实验字段 `allowed-tools`，空格分隔字符串 | `tools: [...]` | **必填**，必须使用平台实际登记的全名（如 `mcp.42.run_ast_audit`） |
| **输入输出** | （隐式说明） | `inputs: { ... }`<br>`outputs: { ... }` | 严格模式下必须声明为 JSON Schema 对象 |
| **执行指令** | Markdown 正文 | Markdown 正文 | 保留执行步骤，去除对未挂载命令的依赖 |

### 2. 转换示例：符合 Pivot 严格门禁的 `SKILL.md`

```markdown
---
id: security-audit
name: security-audit
version: 1.0.0
schemaVersion: 1
title: 源码安全漏洞审查专家
description: 针对传入的源码执行抽象语法树静态分析，排查危险内置函数调用与反序列化漏洞
capabilities:
  - network.request
  - filesystem.read_workspace
tools:
  - mcp.42.run_ast_audit
  - mcp.0.workspace.read
inputs:
  target_file:
    type: string
    description: 待审查的代码文件相对路径
outputs:
  audit_report:
    type: string
    description: 结构化安全审查结果与风险评估
---

# Instructions for Security Audit
1. 首先调用 mcp.0.workspace.read 读取待审计文件的源代码文本。
2. 调用 mcp.42.run_ast_audit 传入代码文本，执行语法树风险模式扫描。
3. 提取扫描结果中的问题清单、代码行号与风险等级。
4. 按照安全规约生成包含定位与修复建议的结构化审计报告。
```

### 3. 技能发布与 ZIP 导入规范（解决发布门禁）

根据 [agent-skill-packages.js](server/services/agent-skill-packages.js) 与 [agent-releases.js](server/services/agent-releases.js)：
* **ZIP 离线技能包结构要求**：
  - **根目录必须直接包含清单文件**（`SKILL.md` 或 `SKILL.yaml`），禁止将多个技能子目录随意合并打包；
  - 严禁包含绝对路径、符号链接或超过大小限制的条目；
  - 包内脚本目录受供应链安全扫描（`scanSkillPackageEntries`）管控。
* **发布流程**：
  1. 上传包文件至接口 `POST /api/agents/skills/package`；
  2. 系统解压并执行数字签名与供应链安全检查；
  3. 创建技能草稿版本（`createSkillVersion`）；
  4. 执行 `previewSkillSource` 完整语法与权限覆盖校验；
  5. 个人使用可直接发布；发布至组织共享范围（`shared`/`global`）必须经过管理员审批与数字签名验签。

---

## 3.3 真实服务实现与安全边界

本仓库扫描器是独立实现，不声称抽取了 Hermes 的真实安全分析模块。官方 MCP Python SDK 固定为 `1.26.0`，其全部传递依赖及分发摘要记录在 [requirements.lock](docker/offline-tools/requirements.lock)，基础镜像摘要记录在 Dockerfile。

- [服务入口](docker/offline-tools/app.py)：Streamable HTTP `/mcp`，Host/Origin 检查、Bearer 验证、512 KiB 请求上限、并发限制、扫描进程超时与回收。
- [扫描规则](docker/offline-tools/audit.py)：只解析 Python 源码，不执行源码。支持常见导入别名与遮蔽名，限制 256 KiB、节点数和深度。语法错误和超限返回 `not_scanned`；无命中为 `no_known_findings`，不表示安全/合规。
- [工作进程](docker/offline-tools/worker.py)：每次扫描隔离进程；源码内容直传，不接收宿主机路径。
- [完整编排](docker-compose.tools.yml)：工具服务非 root、只读根文件系统、有限 CPU/内存/PID；不发布宿主机端口，且服务端仍验证密钥。普通 bridge 本身不保证零外网出站。

超级管理员以全局服务登记 `http://offline-tools:8501/mcp`，选择 `standard`、兼容协议版本 `2025-11-25` 及 `bearer` 鉴权，录入部署密钥后刷新目录。使用实际数字服务 ID 替换技能中的 42。任务网络策略显式允许 `http://offline-tools:8501` 和端口 8501。按 [部署手册](docs/deployment/离线工具服务部署与验收.md) 验证匿名拒绝、普通授权用户成功、撤销后拒绝与越界拒绝。

技能中的 `mcp.0.workspace.read` 需要桌面连接器在线且代码目录已授权；它不读取服务器上传目录。预览通过不保证实际服务或设备可用。

---

## 3.4 端到端执行闭环、时序图与产物回收

```mermaid
sequenceDiagram
    autonumber
    actor User as 局域网用户
    participant Web as Pivot Web 前端
    participant Kernel as Pivot 核心服务 (Qwen)
    participant MCP as Pivot MCP 客户端
    participant Hermes as Hermes 工具容器
    participant Adaptor as 产物适配层
    participant CAS as CAS 不可变存储

    User->>Web: 输入：“请对 demo.py 执行代码安全审查”
    Web->>Kernel: 发起会话请求
    Note over Kernel: 语义路由命中【security-audit】Skill
    Kernel->>Kernel: 加载 Skill SOP 步骤
    Kernel->>Kernel: 先调用 mcp.0.workspace.read 读取本地 demo.py 源码文本
    Kernel->>MCP: 调用工具 mcp.42.run_ast_audit (传入 source_code 文本)
    MCP->>Hermes: POST /mcp 发送 JSON-RPC 扫描请求
    Hermes->>Hermes: ast.parse 解析语法树，遍历检测危险函数
    Hermes-->>MCP: 返回结构化 issues 与风险等级
    MCP-->>Kernel: 返回工具执行 JSON
    Kernel->>Adaptor: 提交审查结果数据
    Adaptor->>CAS: 将原始审查报告写入 CAS 计算哈希
    Adaptor->>Adaptor: 组装 Document IR 卡片结构
    Adaptor-->>Web: 生成原生审查报告 (含行列定位与受控下载)
    Web-->>User: 用户预览报告并经授权下载、核对内容摘要
```

---

# 第四部分：离线生产交付与运维保障

## 4.1 构建、导出与内网启动

实际操作入口为 [离线工具部署与验收](docs/deployment/离线工具服务部署与验收.md)。使用固定镜像版本、依赖锁和物料清单；按目标 OS/CPU 架构构建并验证，不能将 Windows wheels 用于 Linux。使用 `node scripts/offline_tools_release.js --export <新目录>` 导出镜像和 BOM，传入内网后先校验摘要和镜像 ID，再导入启动。密钥经独立受控渠道配置，不包含在公开物料包中。

生产启动使用 `docker compose -f docker-compose.tools.yml up -d --no-build --pull never`。`pull_policy: never` 不替代出口防火墙。健康检查不替代真实源码和图形调用；验收包含断网冷启动、服务重启、错误/超限、任务取消、审批拒绝、用户可见性、产物归属和一次性下载。

## 4.2 备份与恢复

运行 `node scripts/offline_backup.js --plan` 确认实际目录。默认 CAS 为 `DATA_DIR/agent-artifact-objects`，上传为项目根目录 `uploads`；支持 `PIVOT_ARTIFACT_CAS_DIR`、`PIVOT_UPLOAD_DIR/UPLOAD_DIR` 覆盖。容器路径须按 bind mount 映射至宿主机，不能使用旧示例的 `data/cas`、`data/uploads`。

停止所有应用写入与后台任务，在能读取真实文件卷并安装 `pg_dump` 的维护环境执行：

```bash
node scripts/offline_backup.js --output /secure-backups/pivot-20261023 --maintenance-confirmed
node scripts/offline_backup.js --verify /secure-backups/pivot-20261023
```

输出目录必须全新。成功包包含 `database.dump`、`cas/`、`uploads/` 及摘要清单；失败包保留 `incomplete` 标记。连接串不写入清单或命令行。配置与凭据加密密钥另行受控备份。相同时间戳不保证数据库与文件原子一致，必须落实维护窗口或经验证的协调快照。

恢复时先校验清单，在隔离恢复库/新文件卷还原同批数据库、CAS 和上传目录，使用匹配的镜像和配置验证产物读取、摘要、权限和核心业务后再切换；保留旧数据，不覆盖旧卷。技能回滚使用既有发布回滚 API。

## 4.3 验收范围

代码与纯测试结果、真实 SDK 联调、Docker 冷启动、目标硬件性能及隔离恢复演练分别记录。未运行的验证不能视为通过。四大增量方向的候选引擎须经样本与许可评估后接入，不把统一 TTS 引擎、DOCX 修订保真或动态 OA 清洗的设计建议写成已有产品能力。
