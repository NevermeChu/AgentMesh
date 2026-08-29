# AgentMesh (Multi-Agent Bridge MVP)

> **把不同第一方 Agent Harness 暴露成统一 MCP Tool 的本地桥接与编排网格层。**

**AgentMesh** 允许主控 Agent（如 Antigravity / Codex / Claude Code）通过标准 **Model Context Protocol (MCP)** 调用其他厂商的第一方 Coding Agent，而不是直接调用各家的模型底层 API。管理 CLI 用于启动服务、检查配置和诊断适配器；正常任务编排由主控 Agent 完成。各厂商的 Harness、订阅额度和工具链保持不变。

---

## 🌟 核心特性

- 🔌 **官方连接优先 (Official MCP Preferred)**：支持直接连接底层 Agent 的原生 MCP Server（如 `codex mcp-server`、`claude mcp serve`），并在不可用时自动无缝降级为 Headless CLI。
- 🛡️ **结构化错误传播**：底层 Agent 未安装、未登录、额度不足或执行失败时，适配器和 MCP Tools 会尽量捕获错误并返回结构化诊断；启动配置、Session 存储或进程级故障仍会显式失败，而不是被静默忽略。
- 🔍 **独立 Reviewer 规范**：内置代码评审提示词模板与只读权限约束（如 Codex `--sandbox read-only`）；`review_changes` 声明严格评审契约，无法解析为 `PASS` / `FAIL` 的结果按失败处理，避免误报通过。Reviewer 结论为显式 `FAIL` 时始终失败；`PASS` 附带 critical/high（或严重度不可解析）findings 时按矛盾输出 fail-closed 判失败，仅附带 medium/low findings 时保持 PASS 并作为非阻塞 observations 随结果返回。经 `delegate_task` 以 reviewer 角色发起的**一般性对话**（讨论、答疑）不适用该严格契约：无 verdict 但有实质回答的结果保持 SUCCESS，`reviewOutcome=UNKNOWN` 与警告一并返回供调用方自行裁决；空/垃圾输出仍判失败。
- 🧵 **轻量 Session 跟踪**：支持 `continue_task` 继续原 Agent 会话，也支持通过 `contextSessionId` 向新角色传递规范化历史。Reviewer/Tester 结果不会自动写回 Worker 原会话，Orchestrator 负责在修复任务中明确携带反馈。多源注入的共享上下文会以 sidecar 工件逐字持久化（`contexts/<sessionId>/<turn>.txt`），并在会话 history 的 `sharedContextAudit` 中记录 SHA-256、字节数与逐源截断标志，交接内容可事后审计；零轮次的会话不落盘，客户端中途取消不会留下空壳会话。
- 💻 **Orchestrator-first**：正常工作流由主控 Agent 通过 MCP Tools 编排；CLI 负责启动服务、配置、状态和会话管理，直接执行仅保留在 `debug` 命名空间用于诊断。

真实链路中已经确认的问题、修复状态和平台限制见 [PROBLEMS.md](./PROBLEMS.md)。

---

## 🚧 非目标与边界

明确不做的事，避免误用；需要这些能力时请在 Orchestrator 或上层工具中实现：

- **不是编排器**：任务拆分、阶段顺序、重试决策归外部 Orchestrator 所有。AgentMesh 只负责角色解析、执行、会话和规范化交接，不内置 DAG、调度策略或自动重试。
- **不是守护进程**：没有独立后台 daemon，执行生命周期跟随 MCP stdio 连接；Orchestrator 断开会中止在途任务。这是当前设计，不是缺陷。
- **不是双向消息通道**：`delegate_task` 是 turn 边界的一次性调用，不支持 mid-turn 注入或 Agent 间自由对话；跨角色通信只有 `contextSessionId` 规范化上下文交接一条路，也不存在 Agent 间的回环消息路由。
- **不是安全沙箱**：`prompt-only` 适配器没有任何运行时强制力（见 P-006/P-010）；Reviewer `best-effort` 只做执行前后指纹比对以检测误写，不阻止写入。需要硬边界时配置 `safety: enforced` 或使用 Codex Reviewer。
- **不管凭证与额度**：不做登录代理、不缓存或转发 token、不感知订阅配额窗口；额度耗尽表现为 vendor 的结构化失败诊断，由调用方决定是否改派其他 Agent。
- **不承诺 vendor 行为兼容**：厂商 CLI 参数、输出格式或 MCP schema 变化导致的不兼容，以结构化诊断如实报告并记录在 PROBLEMS.md，不做静默绕过或参数猜测。
- **不是远程服务**：本地单机工具，无网络传输层、无多租户概念、无中心化状态服务。

判断标准：如果一个能力需要 AgentMesh 对 vendor 运行时撒谎——假装沙箱、假装模型/推理配置生效、假装语义失败是成功——它就在边界之外。

---

## 🤖 支持的 Agent 矩阵

| Agent 名称        | 别名 (Aliases)                                         | 默认二进制       | 首选模式 (Preferred)        | 降级/备选模式 (Fallback)            | 环境变量覆盖             |
| :---------------- | :----------------------------------------------------- | :--------------- | :-------------------------- | :---------------------------------- | :----------------------- |
| **`codex`**       | `openai-codex`, `codex-cli`                            | `codex`          | MCP (`codex mcp-server`)    | CLI (`codex exec` / `codex review`) | `CODEX_BIN`              |
| **`claude`**      | `claude-code`, `anthropic-claude`                      | `claude`         | CLI (`claude -p`)           | —                                   | `CLAUDE_BIN`             |
| **`antigravity`** | `gemini`, `agy`, `google-gemini`, `google-antigravity` | `agy` / `gemini` | CLI (`agy -p`)              | —                                   | `AGY_BIN` / `GEMINI_BIN` |
| **`grok`**        | `xai-grok`, `grok-cli`, `grok-build`                   | `grok`           | CLI (`grok -p`)             | —                                   | `GROK_BIN`               |
| **`opencode`**    | `opencode-ai`, `opencode-cli`                          | `opencode`       | CLI (`opencode run --auto`) | —                                   | `OPENCODE_BIN`           |
| **`zcode`**       | `z-code`, `zcode-cli`                                  | `zcode`          | CLI (`zcode <prompt>`)      | —                                   | `ZCODE_BIN`              |

> Claude 适配器目前仅使用 CLI 传输：当前版本的 `claude mcp serve` 暴露的是 Claude Code 的原始工具集（Read/Edit/Agent 等）而非一次性任务入口，因此显式 `mode=mcp` 会返回结构化错误。Claude Reviewer 在 CLI 中通过 `--tools` 只保留只读工具并移除 Bash/Edit/Write 等可写工具。Codex 的 MCP 调用严格遵循服务端 schema（`additionalProperties: false`），原生续接使用 `codex-reply(threadId)`。Antigravity Reviewer 在非 Windows 平台使用原生 `--sandbox` 与 `plan` 模式；Windows 上因原生沙箱可能在受保护工具链路径初始化失败，目前降级为 `plan` + `prompt-only`。所有标记为 `prompt-only` 的适配器都不能视为运行时只读沙箱。

> 底层 Agent CLI 只需已经安装、可执行并完成各自所需的登录或授权，不需要全部预先启动。AgentMesh 在收到任务后只会按角色配置启动本次使用的 CLI 或原生 MCP Server。

> `mode=auto` 会优先使用适配器的首选传输，并在支持时自动降级；显式指定 `mode=mcp` 或 `mode=cli` 时严格执行该选择，不支持的模式直接返回结构化错误。Windows 上 npm 生成的 `.cmd` CLI shim 会被解析为对应的 Node.js 或包内原生可执行入口，Prompt 不经过 `cmd.exe`；无法安全识别的任意 `.cmd` / `.bat` 会被拒绝。子进程环境继承时会移除 Shell 注入的 `PWD`/`OLDPWD`（POSIX 上按 spawn 目录重写 `PWD`），避免信任这些变量的 Agent CLI（如 OpenCode）在错误的项目目录中执行。

---

## 🚀 快速开始

### 1. 安装与构建

开发与发布要求 Node.js `>=22.13.0`，CI 同时验证 Node.js 22 和 24。仓库固定使用 npm `11.16.0`；本机 Node.js 24 与构建目标并不冲突，`tsup` 的 `node22` target 表示发布产物兼容的最低 Node.js 运行时，而不是实际执行构建的本机版本。

```bash
# 按 lockfile 安装完全一致的依赖
npm ci

# 编译构建
npm run build
```

### 2. 检查本地 Agent 可用状态

```bash
node dist/cli/index.js list
# 或全局链接后使用:
# agentmesh list
```

输出示例：

```text
Supported Agent Adapters & System Status:

NAME            DISPLAY NAME                       STATUS        PREFERRED   PATH / NOTE
-----------------------------------------------------------------------------------------------
codex           OpenAI Codex                       [AVAILABLE]   MCP         D:\Work\Env\global_modules\npm_global\codex.cmd
claude          Anthropic Claude Code              [AVAILABLE]   MCP         D:\Work\Env\global_modules\npm_global\claude.cmd
antigravity     Google Antigravity (AGY / Gemini)  [MISSING]     CLI         Binary 'agy' was not found in system PATH.
grok            xAI Grok                           [MISSING]     CLI         Binary 'grok' was not found in system PATH.
opencode        OpenCode                           [MISSING]     CLI         Binary 'opencode' was not found in system PATH.
zcode           ZCode                              [MISSING]     CLI         Binary 'zcode' was not found in system PATH.
```

---

## 🛠️ AgentMesh CLI（管理与诊断）

正常任务不通过 CLI 手动执行，而是由 Orchestrator 调用 AgentMesh MCP。顶层 CLI 只提供管理能力：

```bash
agentmesh serve                 # 启动 stdio MCP Server（通常由 Orchestrator 自动执行）
agentmesh config                # 查看并校验项目角色配置
agentmesh list                  # 检查本机 Agent CLI 可用性
agentmesh doctor [cwd]          # 只读聚合诊断（运行时/适配器/配置/能力矩阵/会话存储/仓库）
agentmesh sessions              # 查看 Bridge Sessions
agentmesh session <sessionId>   # 查看单个会话
```

`doctor` 不执行任何任务、不消耗额度、不修改任何文件，把分散在 `list`、`config`、`sessions` 中的健康信息与交叉检查一次汇总：Node 版本、适配器可用性（被项目角色引用的缺失二进制会升级为 FAIL）、config schema 校验、Reviewer `safety: enforced` 与 `prompt-only` 适配器的矛盾组合、capabilities.json 版本漂移与无效文件、会话存储损坏/残留锁/隔离痕迹/容量水位、以及 cwd 的 Git 仓库状态。发现会在启动时必然失败的组合时以退出码 1 结束；`--json` 输出机器可读报告供 Orchestrator 或 CI 消费。

直接执行仅用于排查 MCP、适配器或 CLI 参数问题：

```bash
agentmesh debug run antigravity "协议冒烟测试" --role worker
agentmesh debug review claude "检查当前 diff"
agentmesh debug continue bridge-sess_8f3d1a "继续诊断"
```

### 项目级角色映射 (`.agentmesh/config.json`)

在用户项目根目录创建 `.agentmesh/config.json`：

```json
{
  "version": 1,
  "roles": {
    "orchestrator": "antigravity",
    "worker": "antigravity",
    "reviewer": {
      "agent": "claude",
      "mode": "cli",
      "timeoutMs": 300000,
      "safety": "best-effort"
    },
    "tester": "claude"
  }
}
```

```json
{
  "version": 1,
  "roles": {
    "orchestrator": "antigravity",
    "worker": "antigravity",
    "reviewer": {
      "agent": "claude",
      "mode": "cli",
      "timeoutMs": 300000,
      "safety": "best-effort"
    },
    "tester": "claude"
  }
}
```

同一 Agent 可以配置到多个角色。Worker、Reviewer、Tester 启动新的角色任务时会创建独立的 Bridge Session，因此同一 CLI 的不同会话可以同时承担不同角色；显式传入 `sessionId` 时则继续并校验已有 Session。`orchestrator` 用于记录项目的主控 Agent，不会替代三个可执行角色。

角色对象（`worker`/`reviewer`/`tester`）还支持可选的 `contextBudgetTokens`（正整数）：覆盖该角色执行轮次的共享上下文注入 token 预算（默认 6000，单源下限 1200）。注入超预算时按"先丢复现细节、后丢结论"的固定顺序裁剪，并在该轮 `sharedContextAudit.budgetTokens` / `droppedSections` 中留痕。`continue_task` 不会重新解析角色执行配置，但会按会话所属角色的 `contextBudgetTokens` 应用注入预算。

Reviewer 的 `safety` 支持：

- `best-effort`（默认）：允许所有 Agent，使用适配器当前能提供的最强保护；`prompt-only` 会返回明确警告。
- `enforced`：只允许 `native-sandbox` 或 `tool-filtering`，遇到 `prompt-only` Agent 时在启动前失败。

所有 Reviewer 都禁止调用者追加 `extraArgs`，避免覆盖固定的沙箱、工具或权限参数。AgentMesh 会比较 Reviewer 执行前后的仓库内容指纹；工作树在执行期间发生变化时，Review 会返回 `FAIL`、列出变更路径且不会自动回滚，以免覆盖用户的并发修改。该检测能发现误写，但 `best-effort` 本身不是操作系统级只读隔离。

```bash
# 查看并校验当前生效配置
agentmesh config
```

Orchestrator 调用 `delegate_task` / `review_changes` 时省略 `agent`，AgentMesh 就会根据 `cwd` 和角色读取这份配置。显式 MCP `agent` 参数的优先级高于项目配置。

角色配置还可以请求 vendor-aware 的模型和推理强度：

```json
{
  "agent": "codex",
  "mode": "cli",
  "model": "o3",
  "reasoningEffort": "high"
}
```

`model` 与 `reasoningEffort` 由各 adapter 分别解释，不是所有 Agent 或传输都支持。Codex MCP 继续严格只发送 vendor schema 允许的 `prompt`、`cwd`、`sandbox` 或 `threadId`；模型/推理配置需要使用 CLI，或在能力文件明确声明支持后才可使用。请求的模型和推理强度会记录在 Session history，vendor 不支持时保留结构化诊断，不静默切换模型。

执行结束后，AgentMesh 会按**实际使用的 transport** 对照能力矩阵（优先读取 `.agentmesh/capabilities.json`，不存在时回退到内建静态矩阵）校验请求的 `model`/`reasoningEffort`：不支持或值不在声明列表中时，会在 MCP 返回的 `Warning:` 段和会话 history 的 `capabilityDiagnostics` 字段中附上结构化诊断（说明请求未生效及原因），任务本身不会因此失败。

首次显式生成项目能力说明：

```bash
agentmesh capabilities generate
agentmesh capabilities show
```

这会创建 `.agentmesh/capabilities.json`。普通任务不会隐式执行 vendor 文档探测或改写该文件；已有文件不加 `--force` 不会覆盖。能力文件只包含 adapter/CLI 参数能力和来源，不包含 token、完整环境变量、native session 或 Bridge session；它是能力声明，不是当前账号实际可用模型清单。

配置查找会从 `cwd` 向上查找，但不会越过最近的 Git 仓库根目录，防止意外继承其他项目的角色配置。

---

## 🔌 MCP Server 配置指南

将 AgentMesh 配置为 MCP Server，供主控 Agent（如 Antigravity、Codex、Claude Code、Cursor 等）调用。主控 Agent 负责规划和调用顺序；AgentMesh 负责角色解析、会话、上下文和底层 Agent 启动。

### 暴露的 MCP Tools

1. **`delegate_task`**
   - 让显式 Agent 或项目中分配给指定角色的 Agent 执行任务。
   - 参数：`task` (必填), `agent` (可选，省略时读取项目角色映射), `cwd` (可选), `role` (可选: `worker` | `reviewer` | `tester`), `mode` (可选: `auto` | `mcp` | `cli`), `timeoutMs` (可选，最大 3600000), `sessionId` (可选), `contextSessionIds` (可选，最多 4 个，按给定顺序一手注入多个 Bridge Session 的规范化历史), `contextSessionId` (可选，单源兼容形式), `baseCommit` (可选)。
2. **`review_changes`**
   - 调度指定 Agent 执行只读代码审查，强制遵循独立审查 Prompt 并返回结构化 PASS/FAIL 结果；PASS 可附带 medium/low 非阻塞 findings（critical/high 仍判失败）。
   - 参数：`agent` (可选，省略时读取 `roles.reviewer`), `task` (可选), `cwd` (可选), `baseCommit` (可选), `mode` (可选), `timeoutMs` (可选，最大 3600000), `contextSessionIds` (可选，最多 4 个，如同时注入 Worker 与 Tester 的结论), `contextSessionId` (可选，单源兼容形式)。
3. **`continue_task`**
   - 继续已有会话（Session Resume），并可同时注入其他会话的上下文。
   - 参数：`sessionId` (必填), `task` (必填), `contextSessionIds` (可选，最多 4 个，与该会话自身的历史续接并存，例如一手注入 Reviewer/Tester 的反馈), `mode` (可选), `timeoutMs` (可选，最大 3600000)。
4. **`list_agents`**
   - 查询所有支持的 Agent 及其在当前系统中的安装状态。
   - 无参数。
5. **`get_session`**
   - 查询指定 Bridge Session 的执行历史与元数据。
   - 参数：`sessionId` (必填)。
6. **`get_session_context`**
   - 按轮读取一个 Bridge Session 的记录内容：默认返回该轮的结构化 handoff（goal/decisions/artifacts/open items），也可按 `fields` 取回完整 `finalAnswer`、`findings` 或执行证据，并附当前工作树下的 `MATCHED`/`STALE`/`UNKNOWN` 新鲜度。这是 handoff 优先注入的按需取回通道：下游需要上游细节时调用本工具，而不是要求 AgentMesh 把全文灌进每个 prompt。
   - 参数：`sessionId` (必填), `turnIndex` (可选，1-based，缺省为最后一轮), `fields` (可选，`handoff` | `finalAnswer` | `findings` | `evidence` 的数组，缺省 `["handoff"]`)。
7. **`get_role_config`**
   - 加载并校验项目 `.agentmesh/config.json`，返回当前角色到 Agent 的映射。
   - 参数：`cwd` (可选，默认当前目录)。

### 配置到 MCP 客户端

#### 在 Antigravity, Claude Desktop 或 Cursor 中配置 (`mcp.json` 或 `claude_desktop_config.json`)：

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["d:/Project/Git Repository/AgentMesh/dist/cli/index.js", "serve"],
      "env": {
        "CODEX_BIN": "codex",
        "CLAUDE_BIN": "claude"
      }
    }
  }
}
```

配置完成后，Orchestrator 会自动启动 AgentMesh MCP Server，并按需要调用：

```text
delegate_task(role=worker) → 返回 Worker Session
review_changes(contextSessionIds=[Worker Session]) → 独立审查
delegate_task(role=tester, contextSessionIds=[Worker Session, Reviewer Session]) → 测试验证
continue_task(Worker Session, contextSessionIds=[Reviewer Session, Tester Session], task=修复要求) → 原 Worker 会话一手接收全部反馈
```

这段调用顺序由 Orchestrator 决定；AgentMesh 不会再建立第二套自动工作流状态机，也不会把 Reviewer/Tester 结果自动追加到 Worker Session。

`contextSessionIds`（最多 4 个）按给定顺序把多个来源 Session 的交接上下文**一手**注入目标 prompt，每个来源渲染为带独立标签的块（Session ID、Agent、轮数）并**各自计算** `MATCHED` / `STALE` / `UNKNOWN` 新鲜度（置于块尾）——接收方可以精确知道哪些来源可信、哪些需要重验，而不必经过 Orchestrator 在任务文本里转述。

注入采用 **handoff 优先**策略并以 token（估算值，非字符数）为预算（默认总预算 6000 token，按源均分、单源下限 1200）：每个来源**完整内联最近一轮的结构化 handoff**（goal、关键决定、产物文件/命令、未决事项），更早轮次只保留一行索引（`[Turn N | role | status] goal`）；历史条目没有 handoff 时（旧会话或 vendor 未遵循报告契约）回退为精简的 legacy 轮次回放（`Final answer` 截断到 1200 字符）。超预算时按"先丢复现细节、后丢结论"的固定顺序丢弃（Tests → Open Items → Commands → Files → Decisions → Findings → 证据 → 最终硬截断），实际丢弃的章节记录在该轮 `sharedContextAudit.droppedSections` 中，审计还记录 `strategy`（`handoff` | `legacy`）、`estimatedTokens` 与 `injectedOwnHistory`；被裁剪的信息不会丢失——下游可用 `get_session_context` 取回全文。该轮实际注入了哪些来源仍记录在 `contextSources` 字段中。`contextSessionId` 仍是可用的单源兼容形式。会话自身的原生续接与外部来源注入是并存的：`continue_task` 有原生 Session ID 时只免除自身历史的注入，`contextSessionIds` 指定的其他来源照常注入。

**Handoff 契约（写端）**：`delegate_task`/`continue_task` 的 worker 与 tester prompt 末尾会附加固定的 Handoff Report 契约（Reviewer 除外，其输出由严格的 PASS/FAIL findings 契约约束），要求 vendor Agent 在最终回答结尾以固定小节（`## Goal` / `## Decisions` / `## Files` / `## Commands` / `## Tests` / `## Open Items`）收尾并保持简洁；`Goal` 是 agent 自报的一句话目标，注入时优先生效（缺省回退为任务首行，而非整段任务文本）。runner 由此解析出每轮的 `handoff` 结构存入会话历史（解析失败时该轮无 `handoff`，注入自动回退 legacy 渲染）；解析会剥离列表项中的 Markdown 链接包装与反引号。长度约束在源头生效，接收端不再依赖大字符截断。**Reviewer 轮次的 handoff 无需额外契约**：runner 会从解析出的 PASS/FAIL 裁决与 findings 确定性派生（outcome 映射裁决、keyDecisions 记录裁决摘要、openItems 列出 findings、files 汇总涉及文件），使下游注入同样紧凑。

每次执行都会在 Session 历史中记录调用前后的 Git HEAD、工作树内容指纹、变更文件、传输方式、退出码和耗时。交接时 AgentMesh 将当前指纹与各来源 Session 最后一轮指纹比较，明确标记为 `MATCHED`、`STALE` 或 `UNKNOWN`：只有 `MATCHED` 可以直接复用已有结论，`STALE` 只要求重新验证受影响的证据，从而减少无关的重复检查。旧 Session 没有证据字段时仍可加载，但交接状态为 `UNKNOWN`。执行超时或客户端取消时，历史证据还会记录 `timedOut`/`aborted`、取消原因（含服务端断连的 `client_disconnect`）以及平台相关的进程树清理方式和结果；`auto` 模式发生传输回退时会持久化结构化 `transportFallback` 证据。执行证据中的 `resourceEvidence` 默认采集 AgentMesh 进程自身的 CPU 用户/系统时间和结束时 RSS，并明确标记 `collection: "process"`；它不代表 vendor 子进程或进程树峰值。资源 CPU/RSS 未能采集时不会伪造为 0；需要 vendor/process-tree 曲线、孤儿进程和高水位采样时应使用外部监控，并在报告中记录采样方法与局限。Orchestrator 需要完整未截断的 `finalAnswer` 时应调用 `get_session`（Session 存储保留全文；工具响应中的 `Final Answer` 截断到 12000 字符）或 `get_session_context(fields=["finalAnswer"])`（截断到 24000 字符）。

Session 持久化有容量上限以防止 `sessions.json` 无界增长：每个会话默认保留最近 50 轮历史（更早轮次按时间丢弃），存储整体默认保留最近更新的 200 个会话（超出按 LRU 逐出）。两个上限均可通过程序化 `SessionManagerOptions` 调整，设为 `0` 表示不限制。

### 长任务超时

AgentMesh Tool 的 `timeoutMs` 控制底层 Agent 进程或 Agent 原生 MCP 调用，不会修改 Orchestrator 自身 MCP 客户端的 request timeout。长任务必须同时满足：

```text
Orchestrator MCP request timeout > AgentMesh timeoutMs > 预期 Agent 执行时间
```

未显式传入 `timeoutMs` 且项目角色配置也未设置时，AgentMesh 会对底层执行应用 10 分钟（600000ms）的默认超时（`DEFAULT_RUN_TIMEOUT_MS`），避免挂死的 Agent 进程无限占用请求；程序化使用时可通过 `MultiAgentRunner` 的 `RunnerOptions.defaultTimeoutMs` 覆盖。

AgentMesh 在客户端请求 Progress 时会在任务开始、每 15 秒和完成时发送标准 MCP Progress 通知。使用 MCP SDK 直接调用时，应同时注册进度回调、允许进度重置空闲超时，并设置总超时上限，**且基础 `timeout` 必须大于 AgentMesh 任务的 `timeoutMs`**：

```ts
await client.callTool(params, undefined, {
  // 单次任务可达 600s+，这里给足余量；进度通知会自动重置空闲计时，
  // 因此大不设小。
  timeout: 1_800_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 1_900_000,
  onprogress: ({ message }) => console.log(message),
});
```

> **注意一**：SDK 客户端若不传 `timeout`，默认请求超时仅为 **60 秒**（`DEFAULT_REQUEST_TIMEOUT_MSEC`）。AgentMesh 单次 `delegate_task`/`review_changes` 经常超过此值——实测中默认值会在 60s 处直接掐断请求（`-32001 Request timed out`），即使底层 Agent 仍在正常运行。必须显式把 `timeout` 设到高于 AgentMesh `timeoutMs`，否则长任务会被客户端提前取消。
>
> **注意二**：请只通过 `onprogress` 回调接收进度。不要再额外调用 `setNotificationHandler(ProgressNotificationSchema, ...)` 注册全局进度处理器——在实测的 TS SDK 行为中，全局处理器会接管进度路由，`onprogress` 不再触发，`resetTimeoutOnProgress` 也随之失效，客户端会在基础超时处误判请求超时。
>
> **注意三**：用 `StdioClientTransport` 构造客户端时必须显式传 `env: process.env`。SDK 默认的环境白名单会丢弃 `PATHEXT` 与自定义 `PATH` 项，实测会把子进程环境裁剪到无法解析 `.cmd`/全局 bin（症状为迷惑性 ENOENT、`PATHEXT=null`）。这是 MCP TS SDK 的集成者陷阱，AgentMesh 自身的产品路径不受影响（内部已传全量环境）。

### 客户端取消与断连

取消通知到达后，AgentMesh 会终止底层 Agent 进程树（Windows 使用 `taskkill /T /F`；其他平台以独立进程组 spawn，终止时向整个进程组发送 SIGTERM 并在 1 秒后升级 SIGKILL，从而一并回收 vendor CLI fork 出的后台子进程），并将该轮记录为失败；取消后的 `auto` 模式不会再用 CLI 重跑同一任务。Codex MCP 在 Windows 受限沙箱中可能无法派生 Node 测试子进程并报 `spawn EPERM`，这是 vendor/platform 能力限制，不应向 Codex MCP 工具注入未知的测试参数。此时优先使用 `mode: "auto"` 让 AgentMesh 在 MCP 失败后回退 CLI，或让 Tester 使用 `node --test --test-isolation=none`；显式 `mode: "mcp"` 则保留失败，不会静默改变传输方式。AgentMesh 检测到 MCP 传输下的 `spawn EPERM` 特征时，会自动在结果 `warning` 中附带该缓解指引（同时写入内置能力矩阵的 codex MCP notes）。

`mode: "auto"` 在首选传输失败时回退执行的行为保持不变，但**不再静默**：回退发生时结果会携带结构化 `transportFallback` 证据（from/to/原始错误原因）与 warning 文本，并随该轮 Session 历史持久化，编排方可据此追溯传输切换的根因。

vendor 侧的结构化错误字段与实质结论并存时（如 CLI 收尾竞态产生的尾部 `context canceled`），Codex/Antigravity 适配器在 exit code 为 0 且已有完整最终回答时会保留该轮成功结果，并把错误降级为 `warning` 附带返回，而不是整体判失败并丢弃正文。

边界：如果客户端**直接关闭连接**（而非超时/取消），AgentMesh 服务进程在 stdio 关闭、SIGINT 或 SIGTERM 时会先中止所有 in-flight 执行，并**有界等待**（事件驱动 + 最长 10 秒兜底）每轮以 `cancelReason: "client_disconnect"` 落盘为失败记录后再退出——断连不再留下零痕迹的消失。进程被 SIGKILL 式强杀仍无法落盘，这是如实的残留边界；编排方仍应优先依赖请求超时 + 取消通知来取消长任务。

### 结果中的原始诊断输出

MCP 工具响应在 `Summary` / `Final Answer` 之外，还会包含截断到 8000 字符的 `Raw Output` 段（vendor CLI 的原始输出与 stderr），用于远程排查底层 Agent 失败；当原始输出与最终回答一致时该段省略。

### 已知的 vendor 运行时限制

真实链路中还观察到几类可影响可复核性的 vendor 限制，AgentMesh 不做静默修补，只如实记录：

- **Antigravity CLI 的临时测试产物无法写入工作区**：实测中 Antigravity Tester 运行对抗/临时测试时，其 `write_to_file` 工具要求产物位于自身 `antigravity-cli/brain/...` 目录，写入工作区路径会返回 `not a valid artifact path`。AgentMesh 不能改变 vendor 的 artifact 白名单；Tester 返回的测试结论只有在 `repository evidence` 中出现对应文件时才可复核。若文件未落入工作区，编排方必须将结果标记为“不可复核产物”，不能把 vendor 自述的通过数当作仓库证据。任务应要求使用可写工作区工具创建测试文件，或明确接受该限制。AgentMesh 检测到该特征时会在结果 `warning` 中标注「产物可能未落盘工作区、需独立复核」，防止下游把不可复核的自述当成功证据（该间歇性 vendor 行为在真实测试中曾以致命形态吞掉整轮产出，编排方宜默认在任务文本内嵌「改用 shell 写入」降级指引）。
- **OpenCode Reviewer 的 shell 常缺 `node`/`git`**：实测中 Reviewer 静态审阅通过但无法本地执行测试（`node`、`git` 不在其 shell PATH）。此时 PASS 仅代表静态结论，不代表已执行过测试。
- Windows 上 `taskkill /T /F` 只回收 AgentMesh 能定位到根 PID 的 vendor 进程树；某些 vendor CLI 会 fork 出已脱离父进程的后台守护进程，这些孤儿进程需外部监控或手工清理。POSIX 平台通过进程组信号可回收 fork 子进程，但主动 `setsid` 脱离进程组的守护进程同样无法定位。

具体配置入口取决于 Orchestrator；若客户端不请求 Progress 且固定在较短超时，即使 `.agentmesh/config.json` 已设置更长的 `timeoutMs`，外层请求仍会先取消。同步 MCP 链路通过 Progress 提供实时状态和失败结果；跨请求或离线 webhook 不属于当前本地 stdio Bridge 的职责。

---

## 📐 架构设计

```text
MCP Client / 主控 Agent (Antigravity / Codex / Claude Code)
         │ (stdio JSON-RPC)
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentMesh MCP Server                     │
│ (delegate_task, review_changes, continue_task, config...)  │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                         Core Runner                         │
│  - SessionManager (轻量 Bridge 会话持久化与状态跟踪)        │
│  - ProjectConfig (.agentmesh/config.json 角色映射)          │
│  - PromptBuilder (Reviewer 独立评审规则与格式约束)          │
│  - Executor (跨平台子进程调度与超时保护)                   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                        Adapters                             │
│   ├── CodexAdapter (MCP: codex mcp-server / CLI: exec)      │
│   ├── ClaudeAdapter (MCP: claude mcp serve / CLI: -p)       │
│   ├── AntigravityAdapter (CLI: agy -p / gemini -p)          │
│   ├── GrokAdapter (CLI: grok -p)                            │
│   ├── OpenCodeAdapter (CLI: opencode run --auto)            │
│   └── ZCodeAdapter (CLI: zcode)                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🧪 自动化测试

```bash
# 按仓库规则格式化全部受支持文件
npm run format

# 仅检查格式，不修改文件
npm run format:check

# 运行单元测试和内存内 MCP 协议测试
npm test

# 执行覆盖率门槛
npm run test:coverage

# 通过真实子进程调用假的 Agent CLI，验证参数、JSON 与会话交接
npm run test:integration

# 打包、安装到临时消费项目，并验证导出、版本和 CLI
npm run test:package

# 运行类型感知 ESLint
npm run lint

# 检查严格 TypeScript 类型安全
npm run typecheck

# 执行格式、Lint、类型、分层测试、构建和发布包验证
npm run check
```

VS Code 在安装推荐的 Prettier 扩展后会按 `.prettierrc.json` 在保存时格式化。Husky 的 pre-commit hook 会通过 lint-staged 格式化并检查暂存文件，再执行类型检查；GitHub Actions 会在 Ubuntu 与 Windows 的 Node.js 22/24 矩阵中执行完整校验。依赖统一从 npm 官方仓库解析，Dependabot 定期提交 npm 与 GitHub Actions 更新。

---

## 📄 授权协议

MIT License.
