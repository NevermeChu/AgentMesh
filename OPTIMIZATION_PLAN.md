# AgentMesh 优化实施方案 v0.3（五源融合版）

> 参考源：agentMesh 自身、agent-bridge、claude_codex_bridge(ccb)、Claude Code 源码、**Codex CLI 官方源码（v0.3 新增）**。
> 每个阶段明确：实现什么任务、参考谁的哪些代码、复用哪些已有逻辑、验收标准、完成后达到什么目标。
> 逐任务的"蓝本 → 源码文件 → 复用要点"映射见文末附录 A。

---

## 0. 文档目的与参考源总览

AgentMesh v0.1 是高质量的**被动执行与记录系统**，五大运营目标需要补齐四个能力层：

| #   | 目标                                 | v0.1 现状 | 核心缺口                                                    |
| --- | ------------------------------------ | --------- | ----------------------------------------------------------- |
| G1  | 主 agent 可靠分发协调子 agent 不出错 | ★★★☆☆     | 零重试、零幂等、fallback 整任务重跑、finalAnswer 靠脆弱解析 |
| G2  | Token 消耗低                         | ★★☆☆☆     | 只有字符截断；无计量、无语义压缩                            |
| G3  | 安全性高                             | ★★☆☆☆     | Worker 全线跳权限；extraArgs/env 不设防                     |
| G4  | 全程无人工介入                       | ★★★★☆     | FAIL→修复闭环外置；崩溃后零恢复                             |
| G5  | 强 LLM 指挥弱 LLM、强弱可切换        | ☆☆☆☆☆     | 静态角色映射，无路由信息暴露                                |

### 各参考源的定位与贡献

| 项目                     | 一句话定位                      | 对本方案的独特贡献                                                                                                                                                                                              |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[AM] agentMesh**       | 薄 MCP 桥接层（本仓库）         | 会话/指纹/审计底座全部复用；Orchestrator-first 哲学不变                                                                                                                                                         |
| **[AB] agent-bridge**    | Claude↔Codex 对等桥接          | 幂等键状态机、看门狗、预算三态闸门等"派发可靠性协议"                                                                                                                                                            |
| **[CCB] ccb**            | 中央守护进程多代理编排          | 退避熔断、rubric 返工循环、keeper 保活、恢复三分支                                                                                                                                                              |
| **[CC] Claude Code src** | 终端 AI 编码平台源码快照        | 异步通知协议、artifact 落盘指针、九段摘要模板、deny 贯穿 bypass 的实证、委派规范文本                                                                                                                            |
| **[CX] Codex codex-rs**  | OpenAI Codex CLI 官方 Rust 源码 | **大量机制官方已内置**：`--output-last-message` 官方提取、`turn.completed.usage` 用量事件、rollout 崩溃恢复、`--output-schema` 结构化输出、profile 角色文件、Windows 沙箱、execpolicy 规则引擎、notify 完成钩子 |

### 设计红线（不可违背）

- Orchestrator-first：任务拆解与升级决策始终归主模型；AgentMesh 只提供信息、证据与受控执行。
- 证据如实原则：采不到报 undefined，不伪造；fail-closed 优先于静默降级。
- 不做通用 DAG 工作流引擎（需求 §9）。
- 强弱判定不进代码：使用者手动维护元数据（tier/strengths/costLevel）经 MCP 暴露，主模型自主路由。

---

## 1. 总体架构演进

```
v0.1（现状）                          v0.3（目标）
┌──────────────┐                     ┌──────────────┐
│ Orchestrator │                     │ Orchestrator │
│  （主 LLM）   │                     │  （主 LLM）   │
└──────┬───────┘                     └──────┬───────┘
       │ 6 个 MCP 工具                       │ 8~9 个 MCP 工具(+poll_task/+compact_context)
       ▼                                    ▼
┌──────────────┐    ┌──────────────────────────────────────────┐
│ Runner 核心   │    │ [P4] 元数据路由表(list_agents)              │
│ 会话/指纹/审计 │    │ [P1] 幂等/原因码/重试熔断/看门狗/后台模式      │
└──────┬───────┘    │ [P2] usage 计量/artifact 指针/语义摘要       │
       ▼            │ [P3] 分 vendor 安全基线包/env/args 白名单     │
┌──────────────┐    └──────────────┬───────────────────────────┘
│ Adapters ×6  │                   ▼
└──────────────┘            ┌─────────────────────────────┐
                            │ Runner 核心（主链路不动）        │
                            └──────┬──────────────────────┘
                                   ▼
                     ┌─────────────────────────────────┐
                     │ Adapters ×6                      │
                     │ · codex: 官方快速通道              │
                     │   (--output-last-message/--output-│
                     │    schema/usage事件/rollout恢复/   │
                     │    profile角色/CODEX_HOME隔离)     │
                     │ · claude: managed-settings deny兜底│
                     │ · 其余: 白名单+风险分级披露          │
                     └─────────────────────────────────┘
```

原则：新能力以**包裹层**实现（retry 包 runUnchecked、白名单包 executeCommand、安全基线包 spawn 前置），不改 runner.ts 执行主链路。

---

## 2. 阶段一：可靠派发协议层（P1）

### 阶段目标

delegate_task 具备工业级派发语义：**重复派发不重复执行、瞬态故障自愈、挂起可观测、失败可机器判读、finalAnswer 官方通道提取**。

### 任务分解

#### T1.1 幂等键机制

- **做法**：① DelegateTaskInputSchema 增加可选 `idempotencyKey`；② session 存终态墓碑 `{key→{turnRef, completedAt}}`，TTL 20min；③ 同 key 三分支：进行中→in-flight 引用；墓碑内→返回上次结果标 `replayed:true`（并比对当前仓库指纹，STALE 附警告）；过期/首次→正常执行。
- **蓝本**：`[AB] idempotency-tracker.ts` 状态机 + 墓碑 TTL；进行中分支复用 `[AM] runner.ts` in-flight 注册表。
- **验收**：单测同 key 并发只执行一次；墓碑内第三次返回 replayed；不同 cwd 同 key 正常执行。

#### T1.2 结构化失败原因码

- **做法**：错误归一化附加机器可读枚举 `TRANSIENT_5XX / SPAWN_FAILED / TIMEOUT / MODEL_REJECTED / SANDBOX_UNAVAILABLE / PARSE_FAILURE / ARG_REJECTED / CANCELLED / CIRCUIT_OPEN / BUDGET_EXHAUSTED`。MCP 输出 Error 段以 `error_code:` 行呈现。
- **蓝本**：`[AB] control-protocol.ts` 的 `{ok, code, phase, retryAfterMs}` 结构；信号源对齐 `[CX] exec/src/lib.rs:1036-1144` 的 exit 语义（0=成功、1=失败含 turn.failed/stream_error/server request 拒绝）——codex 通道的 exit code + `turn.failed.error.message` 直接映射到对应原因码；命名风格对齐 `[AM] core/types.ts:31-45` cancelReason。
- **验收**：假 CLI integ 每个码至少一条触发路径；codex 真链路验证 turn.failed → MODEL_REJECTED/TRANSIENT_5XX 归类正确。

#### T1.3 受控重试 + 熔断

- **做法**：① 自动重试仅限"进程未产生任何工作"的失败（SPAWN_FAILED、连接拒绝、首字节前 TRANSIENT_5XX）——CLI 任务有副作用，开跑后失败一律上抛由主模型决策；退避 5s/15s/45s，最多 3 次；② 每 adapter 连续失败 ≥5 次 → 熔断 10 分钟，期间 fail-fast 返回 CIRCUIT_OPEN + 预计恢复时间。
- **蓝本**：`[CCB] ccbd/supervision/backoff.py` 退避表 + MAX_CONSECUTIVE_RECOVERY_ATTEMPTS 熔断（纯函数 reducer、时钟可注入）；新建 `[AM] core/resilience.ts`。
- **验收**：integ 前 2 次失败第 3 次成功 → SUCCESS 且 attempts=3；连续 5 败后第 6 次立即 CIRCUIT_OPEN 且无子进程 spawn。

#### T1.4 看门狗、后台模式与崩溃恢复

- **做法**：
  1. **stalled 检测**：CLI 进程输出流连续 10 分钟无任何字节 → 标记 stalled 写入进度通知（不杀，交主模型决定）。蓝本 `[AB] codex-adapter.ts` scheduleTurnWatchdog（"依赖终止事件复位的状态机必须配兜底 watchdog"+ 至多通知一次的去重集合）。
  2. **后台模式**：delegate_task 增加 `background:true` → 立即返回 `{taskId, outputFile}`；新工具 `poll_task(taskId, sinceOffset?)` 返回状态(running/completed/failed/stalled)+增量输出+最终结果。蓝本 `[CC] AgentTool.tsx:72-77,808-892` 竞速转后台 + `[CC] utils/task/diskOutput.ts` offset 增量读。
  3. **崩溃恢复（codex 通道免费获得）**：codex 的 TokenCount/task_complete 事件在崩溃前已持久化进 rollout 文件（`[CX] rollout/src/policy.rs:107-113` should_persist_event_msg 含 TokenCount/TurnComplete）。进程被杀后：按 sessionId 定位 `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl(.zst)`，tail 提取 `task_complete.last_agent_message` 与用量补账——**SIGKILL 级崩溃也能抢救结果**。校验首行 `session_meta` 的 id/history_mode 再采信（`[CX] rollout/src/list.rs:1282-1316`）。
- **验收**：integ 慢 CLI background 立即返回、poll 三连 running→completed；kill -9 模拟后 codex 通道仍能从 rollout 抢救 finalAnswer。

#### T1.5 finalAnswer 与评审结论的官方通道提取

- **做法**：
  1. **codex 通道切换官方提取**：spawn 时追加 `--output-last-message <FILE>`（`[CX] exec/src/cli.rs`），退出后读文件作为 finalAnswer——取代现有"解析 JSONL 找最后一个 agent_message"启发式（`[CX] event_processor_with_jsonl_output.rs` 即官方同款逻辑）；JSONL 解析降级为 fallback。同时从首行 `thread.started.thread_id` 登记绑定。
  2. **结构化输出契约**：reviewer 角色改用 `--output-schema verdict.schema.json`（`[CX] cli.rs --output-schema`，直接进入 API text.format）强制输出 `{verdict, severity, findings[]}` JSON——比正则抠词可靠一个数量级；非 codex 渠道维持 prompt 契约 + 正则兜底并补充中文词形（通过/不通过/严重）。
  3. **防静默失效**：所有 `-c` 覆盖固定携带 `--strict-config`（`[CX] loader/mod.rs:670-691`）——typo 的配置键从"静默忽略"变为启动报错。这直接消除历史问题 P-REAL-007 类"模型参数被静默丢弃"的整类风险。
- **验收**：单测中文评审三态输入；integ codex 真链路 --output-last-message 与 schema 双验证；故意传错 `-c` 键得到明确报错。

### 本阶段完成后的效果

- **G1 达成度 ★★★★★**：瞬态故障自动恢复；幂等零重复计费；挂起可观测可接管；codex 通道 finalAnswer/评审结论走官方提取通道，解析失败率趋零；SIGKILL 后结果仍可抢救。
- 主模型派发循环从"猜着办"变为"看码办事"，为 P5 升级链提供确定性依据。

---

## 3. 阶段二：Token 计量与上下文压缩层（P2）

### 阶段目标

token 消耗**可度量、可预算、可压缩**：跨 agent 交接升级为"语义摘要 + 原文指针"，长输出"落盘取回"替代"砍尾"。

### 任务分解

#### T2.1 usage 计量通道

- **做法**：① AgentResult 增加 `usage?: {inputTokens?, cachedInputTokens?, outputTokens?, reasoningOutputTokens?, totalTokens?}`；② **codex 通道直接解析 `turn.completed.usage` 事件**（`[CX] exec/src/exec_events.rs:61-73`：input/cached_input/cache_write_input/output/reasoning_output 五字段；注意它是线程累计值，单轮增量=相邻两次差值）；③ claude 结果 JSON usage、opencode JSONL 尽力解析；grok/zcode 保持 undefined；④ recordTurn 入库，get_session 按 agent×角色聚合累计；⑤ 可选增强：codex `rate_limits` 快照（used_percent/resets_at）入库供 P5.4 预算闸门使用。
- **蓝本**：聚合结构照 `[CC] cost-tracker.ts` ModelUsage；采集时机参照 `[CC] services/api/claude.ts:2213-2256`。
- **验收**：codex 真链路计量覆盖率 100%；缺字段 vendor undefined 不报错。

#### T2.2 artifact 落盘指针

- **做法**：finalAnswer/rawOutput 超 **50k 字符** → 全文写 `~/.agentmesh/artifacts/<sessionId>/turn-<n>.txt`，MCP 输出替换为 2KB 预览+完整路径+hasMore；替代现 tools.ts 12k/8k 硬截断；路径挂 sidecar 审计。
- **蓝本**：`[CC] utils/toolResultStorage.ts`（50k 阈值、PREVIEW_SIZE_BYTES=2000 且换行边界截断、'wx' 幂等写、"超限抛错优于截断"量化依据）；审计挂 `[AM] session.ts` 现有 SHA-256 sidecar。
- **验收**：60k 答案输出含预览+路径；落盘字节数=原文。

#### T2.3 共享上下文的语义摘要注入

- **做法**：① 新工具 `compact_context(sourceSessionIds[])`：用**原 agent 自己**对历史做一轮内置摘要任务（禁工具、输出 ≤2k tokens），存 summary sidecar；② runner 渲染共享上下文时优先注入"摘要+原文 artifact 指针"；③ 摘要随源 session 新轮次自动 STALE（并入现有 freshness 判定）。
- **蓝本**：摘要模板 = `[CC] services/compact/prompt.ts` 九段结构（意图/概念/文件/错误与修复/用户指令/待办/当前状态/下一步）∪ `[CX] prompts/templates/compact/prompt.md` 四要素（进度与决策/约束与偏好/待办/关键数据），裁剪合并为一份八段模板；驱动 codex 做摘要时可用其 `compact_prompt` 配置键定制（`[CX] config_toml.rs`）；`<analysis>` 草稿段交付前剥除（`[CC] formatCompactSummary`）。
- **成本说明**：摘要消耗一次弱模型调用，换取后续每一棒输入大降——N 棒流水线净省为正。
- **验收**：integ worker 产 30k 答案 → compact_context → 下一棒收到 ≤2k 摘要+指针；源更新即 STALE。

#### T2.4 分段预算替代单一总预算

- **做法**：24k 总预算拆独立限额段：任务描述 ≤4k / 上游结论 ≤12k（多源均分）/ 环境快照 ≤2k（超限截断+"运行 git status 取全文"补救指令）/ 余量。
- **蓝本**：`[CC] context.ts` getSystemContext 截断+补救指令样式、analyzeContext.ts 分类法。
- **验收**：上游占满时环境快照仍完整；各段截断显式标注。

### 本阶段完成后的效果

- **G2 达成度 ★★★★☆**：codex 计量覆盖率 100%（官方事件直读）；长答案零信息损失；多棒流水线中段输入预期降 ≥50%；rate_limits 数据为预算闸门铺路。

---

## 4. 阶段三：分 vendor 安全基线层（P3）

### 阶段目标

**不牺牲无人值守吞吐**建立硬底线：每个 vendor 通道给出与其能力匹配的最强安全组合，并在响应中如实披露生效边界；env/args 注入面白名单化。

### 关键事实基础（来自 [CX] 源码分析）

- codex headless 默认 `approval_policy=never`，never 下需审批操作一律 Forbidden/Reject，**绝不放行**（`core/src/exec_policy.rs:735-819`）；
- workspace-write 内建 `.git/.codex/.agents` 只读保护（`protocol/src/permissions.rs:1926-1963`），网络默认关；
- **Windows 上沙箱必须显式启用**（`[windows] sandbox="unelevated"|"elevated"`），否则 workspace-write 被强制降级为 read-only（`config/src/config_toml.rs:762-770`）——这是保守降级不是放行，但会让写任务莫名失败；
- unelevated 后端 = 受限令牌+能力 SID ACL+JobObject+私有桌面；elevated 后端额外有 WFP 硬断网与 deny-read；
- `--yolo/--dangerously-bypass-approvals-and-sandbox/danger-full-access` 会同时跳过审批和沙箱。

### 任务分解

#### T3.1 Codex 安全基线包（本阶段核心之一）

- **做法**：adapter 为 codex 通道组装以下受控参数集，并对调用方物理封锁危险项：
  1. **专用 CODEX_HOME**：每角色一个目录，预置 `rules/*.rules`（execpolicy Starlark 规则：forbidden 解释器逃逸/网络命令，参照 `[CX] execpolicy/README.md` 前缀规则语法）+ `requirements.toml` 锁定 allowed_sandbox_modes/approval_policies——企业治理层优先级高于一切 `-c` 覆盖；
  2. **沙箱激活保障**：文档化一次性 `codex sandbox setup --elevated`（管理员）；运行时默认 `-c windows.sandbox="unelevated"`；每次运行后检查事件流中 sandbox denial/violation 证据，未启用时在 warning 披露"OS 沙箱未激活，写任务将被降级 read-only"；
  3. **显式锁定**：固定追加 `-c approval_policy="never"` + `-c 'sandbox_workspace_write.network_access=false'`（默认值防御性显式化）；
  4. **argv 物理排除**：构造函数硬编码拒绝 `--yolo`、`--dangerously-bypass-approvals-and-sandbox`、`sandbox_mode=danger-full-access`、`--ephemeral`(可选放开)——extraArgs 校验层（T3.3）双保险；
  5. **最小可写集**：`-C <jobDir>` 固定根 + `--add-dir` 白名单逐项授权。
- **蓝本**：全部出自 `[CX]`（见上"关键事实基础"及第十节清单 #1-#9）。
- **验收**：integ（opt-in 真链路）：worker 尝试 rm -rf / 写 .git/hooks / curl 外联分别被 Forbidden/只读保护/env 缓解拦截且证据可见；传 --yolo 被 ARG_REJECTED。

#### T3.2 Claude Worker 的 deny 兜底注入

- **做法**：利用"deny 规则在 skip-permissions 下依然生效"的实证（`[CC] permissions.ts:1170-1181` deny 先于 bypass 判定；checkRuleBasedPermissions :1060-1156）：启动前生成受控 settings.json（policy 层语义）写入 `~/.agentmesh/policy/<sessionId>/` 并以 `--setting-sources` 指向；默认 deny 模板：`.env*`、`~/.ssh/**`、`.git/**`、`**/.agentmesh/**`、`Bash(curl:wget:sudo)`；生效清单随响应 warning 披露。
- **补充清单来源**：`[CC] filesystem.ts:57-79` DANGEROUS_FILES/DIRECTORIES。
- **验收**：真链路 opt-in：读 .env 被 deny 且任务继续；普通编辑不受影响。

#### T3.3 env 白名单 + extraArgs 白名单

- **做法**：
  - executeCommand 子环境改白名单模式：基线集（PATH/HOME/USERPROFILE/TEMP/LANG/TZ/SYSTEMROOT…）+ 调用方 override 仅收白名单键，越键丢弃并计 warning（`envOverrideRejected:[...]`）；永久黑名单 LD*PRELOAD/NODE_OPTIONS/PYTHONPATH/DOCKER_HOST/KUBECONFIG/AWS*\*。
  - 每 adapter 声明 `allowedExtraArgs` 模式表（codex 仅允许 `--model/-c model*/-c model_reasoning_effort=*/--add-dir` 等；claude 仅 `--model` 等）；不匹配 → 结构化失败 ARG_REJECTED。Reviewer 维持完全禁止。
- **蓝本**：`[CC] bashPermissions.ts:369-446` SAFE_ENV_VARS 及黑名单论证注释；`[CC] dangerousPatterns.ts` CROSS_PLATFORM_CODE_EXEC 清单；`[CX]` 危险 flag 名单（T3.1 第 4 条）。
- **验收**：单测 DOCKER_HOST 被拒且可见；PATH 无法被劫持；worker 传跳权类 flag 被 ARG_REJECTED。

#### T3.4 敏感路径误写检测与跨 vendor 保护矩阵

- **做法**：① 在现有 reviewer 前后指纹比对上加敏感模式交集（`.git/**`、`.env*`、`*.pem`、`.agentmesh/**`），命中升级 FAIL 并单列 `sensitiveWrites` + 恢复指引；② 建立**跨 vendor 保护矩阵**随 list_agents/文档披露：codex=.git/.codex/.agents 内建只读+execpolicy；claude=deny 注入；其余=prompt-only（如实标注风险等级）。
- **蓝本**：`[CC] filesystem.ts` 危险清单；矩阵思想源自三家对比（codex 内建最强、claude 可注入、其余裸奔须披露）。
- **验收**：dirty diff 含 .env 修改 → FAIL+sensitiveWrites 非空；矩阵在 list_agents 输出可见。

### 本阶段完成后的效果

- **G3 达成度 ★★★★☆**：codex 通道获得官方级纵深防御（规则锁+沙箱+审批锁+argv 物理排除）；claude 通道 deny 兜底；全通道 env/args 收敛白名单；安全边界全部配置化、可审计、随响应披露。

---

## 5. 阶段四：强弱模型调度层（P4）——手动元数据路由

### 阶段目标

使用者手动维护强弱元数据 → 经 MCP 像工具描述一样暴露 → 主模型自主分配；失败时凭错误码沿候选链确定性升级。**codex 侧用官方 profile 文件实现候选一键切换**。

### 任务分解

#### T4.1 agents 元数据 schema + 角色 profile 机制

- **做法**：
  1. config 增加 `agents` 段（zod 校验）：`tier(strong/medium/weak)/costLevel(1-5)/speed/strengths[]/notGoodAt[]/sandboxLevel/notes`，以及关键的 **`candidates[]` 升级链声明**（如 `["zcode","codex-medium","codex-strong"]`）；
  2. **codex 候选 = 官方 profile 文件**：`$CODEX_HOME/<name>.config.toml` 组合 `model + model_reasoning_effort + sandbox_mode + approval_policy + developer_instructions`（`[CX] config/loader` Profile v2；注意旧版 `[profiles.x]` 已删除会报错），adapter 按 candidate 名称以 `--profile <name>` 启动——切档即换参，不再拼 `-c` 串；claude 候选 = model 参数组合；其他 vendor = 二进制本身。
  3. CLI `config validate`：schema 校验+别名可解析+tier/sandbox 一致性+candidates 引用存在性。
- **蓝本**：字段语义映射 `[CC] AgentDefinition.whenToUse`；校验沿用 `[AM] config.ts` zod+Git 根边界；profile 机制 `[CX]`。
- **验收**：非法配置 fail-fast 定位到字段；三个 codex profile（strong/medium/fast）一键切换生效且 strict-config 校验通过。

#### T4.2 list_agents 路由表化

- **做法**：list_agents 重构为路由表视图：名称/别名/**实时可用性**（registry 扫描前置化）/传输模式/沙箱申报与实际激活状态/**元数据（tier、costLevel、strengths、notGoodAt、notes）**/candidates 链视图/最近能力诊断/跨 vendor 保护矩阵行。
- **蓝本**：`[CC] tools/AgentTool/prompt.ts` when-to-use 随工具描述暴露的同范式；扫描复用 `[AM] registry.ts:76-95`。
- **验收**：两个不同 tier 的 agent 输出含全部字段；二进制缺失显示 unavailable 不中断。

#### T4.3 委派规范文本（协议即提示词）

- **做法**：将四条实证纪律写入 delegate_task 工具 description 与 README 编排章节：① 简报规范+"Never delegate understanding"（指令自带文件路径与具体改动，反例："based on your findings"）；② 并行纪律：只读任务扇出并行、写任务同文件集串行；③ continue-vs-fresh 决策表：纠错续同一会话（带错误上下文）、验证换新会话（fresh eyes）、方向全错换新避免锚定；④ 定义 done：实现类任务要求回报测试结果与变更摘要。
- **蓝本**：`[CC] coordinator/coordinatorMode.ts:111-369`（协调器系统提示全文）+ `tools/AgentTool/prompt.ts:99-113`。
- **验收**：文档评审四条纪律齐全含反例。

#### T4.4 失败升级辅助

- **做法**：delegate_task 失败响应附 `hint.nextCandidates`：当错误码 ∈ 可升级类（MODEL_REJECTED/SANDBOX_REQUIRED/CAPABILITY_MISMATCH）时，从 agents.candidates 中筛出满足缺失能力的更高 tier 候选（≤3 个，costLevel 升序）。**仅为提示，决策权在主模型**。
- **蓝本**：需求-能力匹配复用 `[AM] capabilities.ts` evaluateModelOptionSupport；triage 思想参照 `[CCB] plan_tasks.py`（由主模型承担）；补充说明：codex 原生还有 `default_subagent_model/reasoning_effort` 子代理弱模型路由点（`[CX] config_toml.rs [agents]` 表），可作为进程内细粒度扇出的互补手段写入文档。
- **验收**：weak 报 MODEL_REJECTED → hint 含 medium/strong 候选；主模型可直接重派。

### 本阶段完成后的效果

- **G5 达成度 ★★★★☆**：主模型一次 list_agents 获得全量路由信息（含真实沙箱状态与保护等级）→ 按特征×strengths×costLevel 分配 → 弱失败时凭错误码+候选项一步升级。强弱切换的全部智能来自手写元数据+主模型推理，代码零硬编码；codex 侧切换成本因 profile 机制降到最低。

---

## 6. 阶段五：无人值守闭环层（P5）

### 阶段目标

FAIL→定向返工内置化（有界）、断点续跑、孤儿自愈、预算硬顶。人工介入点清零。

### 任务分解

#### T5.1 有界返工循环

- **做法**：review_changes 增加可选 `maxReworkRounds`（默认 0，上限 3）：FAIL → 自动 continue_task 给原 worker 注入结构化 findings → 复审；轮次耗尽返回 FAIL+全轮次证据链（reworkRound 字段留痕）。默认评审模板移植 codex rubric：P0-P3 优先级标签 + findings JSON schema + overall verdict。
- **蓝本**：循环语义 `[CCB] agents-md-ccb.md`（overall≥7.0 且单维≤3 不得分、≤3 轮）+ callbacks.py allowed_chain_targets；**rubric 内容直接抄 `[CX] prompts/templates/review/rubric.md`**（7.7KB 现成强审弱语义模板）；verdict 机读由 T1.5 的 --output-schema 保证。
- **验收**：integ 第一轮 FAIL 第二轮 PASS → PASS 且 rounds=2；3 轮全败 → FAIL+证据链完整。

#### T5.2 checkpoint 与续跑

- **做法**：① 后台任务中断/超时时 extractPartialResult 存 checkpoint 工件；continue_task 支持 `fromCheckpoint:taskId` 将抢救内容注入新轮头部；② **codex 通道双保险**：即使进程被 SIGKILL，仍可从 rollout 文件 tail 恢复 last_agent_message 与用量（T1.4 第 3 条机制复用）；③ checkpoint 一次性消费令牌（先 peek 再 fail-closed 提交）+ consumed 墓碑防重复续接。
- **蓝本**：`[CC] agentToolUtils.ts:488-500` extractPartialResult；`[AB] budget/admission-quota.ts` + resume-injection-queue.ts（checkpoint baton 一次性消费）；`[CX] rollout` 恢复。
- **验收**：kill 后 checkpoint 存在；fromCheckpoint 续跑 prompt 含抢救内容；同 checkpoint 二次消费被墓碑拒绝。

#### T5.3 孤儿进程治理

- **做法**：spawn 时登记 `{pid, taskId, startedAt}` 到注册表；serve 启动扫描：pid 死→清理；pid 活但父换代→终止并记录；stalled 超 30 分钟的后台任务自动终止+落 checkpoint。启动时"先分类再行动"。
- **蓝本**：`[AB] daemon-lifecycle.ts` classifyDaemon 五裁决范式；`[CCB] keeper.py` reconcile 思想；GC 宽限期字段设计 `[CC] LocalAgentTask.tsx:116-148` evictAfter/retrieved；树终止复用 `[AM] executor.ts:354-428`。
- **验收**：制造孤儿 → 重启 serve 后识别回收，registry 收敛为空。

#### T5.4 预算水位闸门（依赖 T2.1 数据积累）

- **做法**：config 增加 `budget:{perSessionTokenCap?, onExceed:warn|rejectNew}`：用量达 80% 后续响应附 warning；达 100% 且 rejectNew → 新 delegate fail-fast 返回 BUDGET_EXHAUSTED，在途任务不受影响。可选第二信号源：codex rate_limits.used_percent 接近上限时提前预警。
- **蓝本**：`[AB] budget/budget-decision.ts` 三态闸门简化为两态（守薄层边界）；数据源 `[CX] turn.completed.usage` + rate_limits 快照。
- **验收**：cap=1000 两轮假用量 900/1100 → 第二轮 warning；rejectNew 下第三轮 BUDGET_EXHAUSTED。

#### （可选）T5.5 完成通知钩子

- **做法**：为未来长驻模式预研：codex `notify=["bridge-hook"]` 接收 agent-turn-complete JSON（kebab-case 字段）转发到桥接层 endpoint——官方支持的完成感知通道，替代轮询（`[CX] hooks/src/legacy_notify.rs`）。当前 exec 模式下进程退出+turn.completed 已够用，此项仅预留设计不实现。
- **验收**：设计文档评审通过。

### 本阶段完成后的效果

- **G4 达成度 ★★★★★**：FAIL→修复 ≤3 轮全自动且评审机读可信；SIGKILL 级崩溃也能抢救现场（codex）；孤儿自愈；token 超支有硬顶。人工介入点清零。

---

## 7. 阶段六（可选，中期）：app-server 长驻通道

**触发条件**：任务并发量上升、单任务冷启动开销占比显著、或出现大量"跑偏需中途纠偏"场景时再启动。

- **内容**：为 codex 增加 app-server 传输模式（stdio JSON-RPC，一次 initialize 多线程多 turn 复用）：消除每任务冷启动；`turn/start` 全参（model/effort/sandboxPolicy/outputSchema）；`turn/steer`（expected_turn_id 前置条件的运行中插话纠偏）与 `turn/interrupt`；`thread/tokenUsage/updated` 提供 total/last/contextWindow 三份数据做水位监控；resume 失败返回明确 JSON-RPC 错误而非静默新建。
- **蓝本**：`[CX] app-server/README.md`、app-server-protocol common.rs 方法注册表、v2/turn.rs 参数面、thread_processor.rs 错误语义。
- **取舍**：需维护常驻子进程+JSON-RPC 客户端；mcp-server 模式不采用（其 codex-reply 只认进程内存活线程，重启即失效，`mcp-server/src/message_processor.rs:476-488`）。
- **验收标准（届时定义）**：与 exec 通道 A/B 对比冷启动耗时与 token 差异。

---

## 8. 里程碑、依赖与工作量估算

```
P1 可靠派发 ──────┬──→ P4 强弱调度（依赖 P1 错误码 + T1.5 官方提取通道）
                  ├──→ P2 Token（依赖 T1.4 后台/落盘基建）
P3 安全基线 ──────┤
                  ├──→ P5 无人值守闭环（依赖 P1 后台 + P2 计量）
P6 app-server（可选）← 最后评估
```

| 阶段             | 预估规模        | 建议工期  | 备注                                                           |
| ---------------- | --------------- | --------- | -------------------------------------------------------------- |
| P1               | ~1100 行+测试   | 1.5 周    | T1.5 因 codex 官方通道反而省工；T1.4 崩溃恢复为 codex 免费能力 |
| P3               | ~700 行+测试    | 1 周      | T3.1 codex 基线包为本阶段核心                                  |
| P4               | ~450 行+文档    | 0.5 周    | profile 文件由使用者预置，代码只做引用                         |
| P2               | ~850 行+测试    | 1 周      | T2.1 codex 侧极简（官方事件直读）                              |
| P5               | ~800 行+测试    | 1 周      | T5.5 仅设计不实现                                              |
| P6               | ~600 行（可选） | 0.5-1 周  | 触发条件满足才启动                                             |
| **合计（必选）** | **~3900 行**    | **~5 周** | P1/P3 可立即并行                                               |

每阶段收尾执行既有验证链：`npm test` → integ（假 CLI）→ 真实链路冒烟（AGENTS.md 规程，opt-in）→ CHANGELOG/PROBLEMS 台账更新。

## 9. 风险与回滚

| 风险                                                        | 缓解                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 重试引发重复副作用                                          | 铁律：仅"首字节前"失败才自动重试；开跑后失败一律上抛                                                  |
| 幂等缓存命中过期结果                                        | 命中时比对仓库指纹，STALE 附警告建议重执行                                                            |
| `-c` 键 typo 静默失效（codex 非 strict 模式默认忽略未知键） | 全通道固定携带 `--strict-config`；类型错误本就报错退出                                                |
| codex resume 用名字找不到会**静默新建会话**                 | 制度性规定：续接只用 UUID（thread.started 登记）；名字仅作展示                                        |
| codex `wire_api` 仅剩 responses，自定义网关需支持该协议     | 文档明示约束；接第三方模型前先验证端点                                                                |
| Windows 沙箱未启用导致 workspace-write 静默降级 read-only   | T3.1 运行时检测+warning 披露；部署文档写明 elevated setup 一次性步骤                                  |
| deny 注入改变 worker 行为                                   | 生效 deny 清单随响应披露，可按项目微调模板                                                            |
| 摘要失真误导下游                                            | 摘要永远伴随原文指针；freshness 保证源更新即失效                                                      |
| legacy [profiles.x] 写法报错（网上旧教程误导）              | validate 命令检查 profile 文件形态，报错指向 Profile v2                                               |
| runner.ts 体量膨胀                                          | 新逻辑一律独立模块（resilience/background/artifacts/policyTemplates/securityBaseline），runner 只编排 |

## 10. 五大目标总验收口径

| 目标          | 验收指标                                                                                                                                                                                  | 达成阶段 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| G1 可靠分发   | 瞬态故障自动恢复率 100%（首字节前）；同幂等键零重复执行；挂起 100% 可观测可取消；codex finalAnswer 走官方提取通道、解析失败率≈0；SIGKILL 后 codex 结果可抢救                              | P1       |
| G2 低 token   | codex 计量覆盖 100%、全通道主力覆盖 ≥90%；长答案零截断损失；三棒以上流水线中段输入降 ≥50%                                                                                                 | P2       |
| G3 高安全     | codex：banned flag 物理不可达、approval=never 显式锁定、execpolicy 规则生效、沙箱激活状态每次披露；claude：deny 兜底真链路验证通过；全通道 env/args 白名单化；保护矩阵随 list_agents 披露 | P3       |
| G4 无人工介入 | FAIL→修复 ≤3 轮全自动（rubric 机读）；checkpoint 续跑含 SIGKILL 场景；孤儿自愈率 100%；token 硬顶可控                                                                                     | P5       |
| G5 强弱指挥   | 主模型一次 list_agents 完成分配规划（含沙箱实况与保护等级）；codex 候选切换=换 profile 文件；弱→强升级凭错误码+候选项一步完成                                                             | P4       |

---

## 附录 A：参考实现映射表（复用蓝本索引）

图例（均为同级或已知目录）：

- `[AB]` = `../agent-bridge/src/`
- `[CCB]` = `../claude_codex_bridge/lib/`
- `[CC]` = `../ClaudeCode/src/`
- `[CX]` = `../codex/codex-rs/`
- `[AM]` = 本仓库 `src/`

### A.P1 可靠派发协议层

| 任务               | 蓝本  | 参考文件                                                                                         | 复用要点                                                                                                           |
| ------------------ | ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| T1.1 幂等状态机    | [AB]  | `idempotency-tracker.ts`                                                                         | accepted→started→terminal 状态机；20min 墓碑挡迟到重试；"只在真实写入时 accept"契约                                |
| T1.1 进行中分支    | [AM]  | `core/runner.ts` in-flight 注册表                                                                | 直接复用，扩展为幂等查询入口                                                                                       |
| T1.2 原因码结构    | [AB]  | `control-protocol.ts`                                                                            | `{ok,code,phase,retryAfterMs}`+语义化枚举                                                                          |
| T1.2 信号源映射    | [CX]  | `exec/src/lib.rs:1036-1144`、`exec_events.rs`                                                    | exit 0/1 语义；`turn.failed.error.message`；`stream_error`→TRANSIENT_5XX；首行 `thread.started.thread_id` 登记绑定 |
| T1.3 重试退避+熔断 | [CCB] | `ccbd/supervision/backoff.py`、`provider_core/fifo_delivery.py`                                  | 退避表常量化；三态 DeliveryResult"不伪造成功"；MAX_CONSECUTIVE_RECOVERY_ATTEMPTS 熔断                              |
| T1.4 看门狗        | [AB]  | `codex-adapter.ts` scheduleTurnWatchdog                                                          | 不活动定时器+入站刷新；stalled 至多通知一次                                                                        |
| T1.4 后台模式      | [CC]  | `tools/AgentTool/AgentTool.tsx:72-77,808-892`、`utils/task/diskOutput.ts`                        | 竞速转后台；offset 增量读；taskId 前缀+随机后缀                                                                    |
| T1.4 崩溃恢复      | [CX]  | `rollout/src/policy.rs:107-113`、`recorder.rs`、`list.rs:1282-1316`                              | TokenCount/TurnComplete 崩溃前已落盘；tail 抢救 last_agent_message；首行 session_meta 校验 history_mode            |
| T1.5 官方提取      | [CX]  | `exec/src/cli.rs`(--output-last-message/--output-schema)、`event_processor_with_jsonl_output.rs` | 官方 finalAnswer 提取与结构化输出约束；JSONL 解析降为 fallback                                                     |
| T1.5 防静默失效    | [CX]  | `config/src/loader/mod.rs:670-691`                                                               | `--strict-config` 使未知 -c 键报错退出                                                                             |
| T1.5 中文兜底      | [AM]  | PROBLEMS P-007/P-033/P-054                                                                       | 正则兜底+中文词形沿用自身加固教训                                                                                  |

### A.P2 Token 计量与压缩层

| 任务               | 蓝本       | 参考文件                                                                                                 | 复用要点                                                              |
| ------------------ | ---------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| T2.1 codex 用量    | [CX]       | `exec/src/exec_events.rs:61-73`（Usage 五字段）、`event_processor_with_jsonl_output.rs:117-128`          | turn.completed.usage 直读；线程累计值→相邻差值得单轮增量              |
| T2.1 配额快照      | [CX]       | `protocol/src/protocol.rs:2213-2278`（RateLimitSnapshot）                                                | used_percent/resets_at 入库供 T5.4                                    |
| T2.1 聚合结构      | [CC]       | `cost-tracker.ts`、`services/api/claude.ts:2213-2256`                                                    | ModelUsage 字段设计；usage 原地写回手法                               |
| T2.1 其他 vendor   | [CCB]+[AM] | `provider_control/quota.py`；本仓 claude/opencode 解析点                                                 | 尽力解析；采不到保持 undefined                                        |
| T2.2 artifact 指针 | [CC]       | `utils/toolResultStorage.ts`、`constants/toolLimits.ts`                                                  | 50k 阈值/2KB 换行边界预览/'wx' 幂等/"抛错优于截断"                    |
| T2.2 审计          | [AM]       | `core/session.ts` sidecar                                                                                | 直接挂现有 SHA-256 审计链                                             |
| T2.3 摘要模板      | [CC]+[CX]  | `services/compact/prompt.ts` 九段 ∪ `prompts/templates/compact/prompt.md` 四要素；`formatCompactSummary` | 合并为八段模板；analysis 草稿剥除；codex 侧可用 compact_prompt 键定制 |
| T2.3 失效联动      | [AM]       | `core/runner.ts` freshness                                                                               | 摘要 STALE 并入现有指纹判定                                           |
| T2.4 分段预算      | [CC]       | `context.ts` getSystemContext、`utils/analyzeContext.ts`                                                 | 截断+补救指令样式；分段独立限额                                       |

### A.P3 分 vendor 安全基线层

| 任务                 | 蓝本           | 参考文件                                                                                                                                                              | 复用要点                                                                                              |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| T3.1 沙箱模型        | [CX]           | `protocol/src/permissions.rs:758-812,1926-1963`、`sandboxing/src/manager.rs`                                                                                          | workspace-write 边界：全盘可读/工作区+TMP 可写/.git·.codex·.agents 自动只读/网络默认关                |
| T3.1 Windows 沙箱    | [CX]           | `windows-sandbox-rs/`（token.rs:42-44 受限令牌、acl.rs、desktop.rs）、`core/src/windows_sandbox.rs:19-89`、`config_toml.rs:762-770`                                   | `[windows] sandbox=elevated/unelevated` 必须显式启用否则降级 read-only；elevated=WFP 硬断网+deny-read |
| T3.1 execpolicy 规则 | [CX]           | `execpolicy/README.md`（Starlark prefix_rule/host_executable）、`core/src/exec_policy.rs:645-699,735-819`、`shell-command/src/command_safety/is_dangerous_command.rs` | 专用 CODEX_HOME 预置 rules/\*.rules；requirements.toml 管理锁定；危险命令启发式清单                   |
| T3.1 审批锁          | [CX]           | `exec/src/lib.rs:408-413`（headless 默认 never）、`exec_policy.rs:47-48`（Forbidden 理由常量）                                                                        | 显式 `-c approval_policy="never"`；never 下需审批操作一律拒绝不放行                                   |
| T3.1 网络出口        | [CX]           | `network-proxy/README.md`、`core/src/config/network_proxy_spec.rs`                                                                                                    | allowlist-first 域名白名单+limited 模式（GET/HEAD/OPTIONS）；Windows 需 elevated                      |
| T3.2 deny 兜底       | [CC]           | `permissions/permissions.ts:1170-1181,1060-1156`、`settings/constants.ts`、`filesystem.ts:57-79`                                                                      | deny 贯穿 bypass 的实证位置；DANGEROUS 清单翻译为规则模板                                             |
| T3.3 env 白名单      | [CC]           | `bashPermissions.ts:369-446` SAFE_ENV_VARS                                                                                                                            | 白名单键集+劫持面论证注释照抄                                                                         |
| T3.3 args 黑名单     | [CC]+[CX]      | `dangerousPatterns.ts`；`exec/src/lib.rs:296-300`（yolo 同时跳审批和沙箱）                                                                                            | 危险 flag 清单；argv 构造层物理排除                                                                   |
| T3.4 保护矩阵        | [CX]+[CC]+[AM] | 三方对照                                                                                                                                                              | codex 内建最强/claude 可注入/其余披露风险等级                                                         |

### A.P4 强弱模型调度层

| 任务                    | 蓝本       | 参考文件                                                                                                     | 复用要点                                                                                                            |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| T4.1 元数据 schema      | [CC]+[AM]  | AgentDefinition.whenToUse；`core/config.ts` zod                                                              | 字段语义映射；Git 根边界沿用                                                                                        |
| T4.1 codex 角色 profile | [CX]       | `config/src/loader/`（Profile v2：`$CODEX_HOME/<name>.config.toml` + `--profile`）、`docs/example-config.md` | 一档一文件组合 model/effort/sandbox/approval/instructions；警惕 legacy [profiles.x] 已删除                          |
| T4.1 子代理弱模型互补   | [CX]       | `config_toml.rs` [agents] 表（default_subagent_model/max_concurrent_threads_per_session/max_depth）          | 进程内细粒度扇出与外置粗粒度路由互补，写入文档                                                                      |
| T4.2 路由表暴露         | [CC]+[AM]  | `tools/AgentTool/prompt.ts`；`agents/registry.ts:76-95`                                                      | when-to-use 同范式；可用性扫描前置复用                                                                              |
| T4.3 委派规范           | [CC]       | `coordinator/coordinatorMode.ts:111-369`、`tools/AgentTool/prompt.ts:99-113`                                 | 四条纪律原文出处（简报/Never delegate understanding/并行纪律 :211-218/continue-vs-fresh 决策表 :280-293/定义 done） |
| T4.4 升级提示           | [CCB]+[AM] | `cli/services/plan_tasks.py` triage；`core/capabilities.ts`                                                  | nextCandidates 匹配复用 evaluateModelOptionSupport                                                                  |

### A.P5 无人值守闭环层

| 任务                      | 蓝本            | 参考文件                                                                                        | 复用要点                                                       |
| ------------------------- | --------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| T5.1 rubric 模板          | [CX]            | `prompts/templates/review/rubric.md`（bug 判定 8 条+评论写作 8 条+P0-P3+JSON schema）           | **现成的强审弱语义模板直接抄**为默认评审模板                   |
| T5.1 循环语义             | [CCB]           | `config/agents-md-ccb.md`（≤3 轮）、`callbacks.py` allowed_chain_targets                        | 轮次上限与终态证据链语义                                       |
| T5.2 partial 抢救         | [CC]            | `agentToolUtils.ts:488-500` extractPartialResult                                                | killed/failed 抢救已完成文本                                   |
| T5.2 rollout 恢复         | [CX]            | 同 T1.4 崩溃恢复条目                                                                            | SIGKILL 级恢复（codex 专属红利）                               |
| T5.2 一次性消费           | [AB]            | `budget/admission-quota.ts`、`resume-injection-queue.ts`                                        | peek→fail-closed 提交→consumed 墓碑                            |
| T5.3 孤儿治理             | [AB]+[CCB]+[CC] | `daemon-lifecycle.ts` classifyDaemon；`ccbd/keeper.py`；`LocalAgentTask.tsx:116-148` evictAfter | 先分类再行动；GC 宽限字段；树终止复用 [AM] executor.ts:354-428 |
| T5.4 预算闸门             | [AB]+[CX]       | `src/budget/budget-decision.ts`；RateLimitSnapshot                                              | 三态简化为 warn/reject 两态；rate_limits 作第二信号源          |
| T5.5 完成通知（设计预留） | [CX]            | `hooks/src/legacy_notify.rs`（notify argv + kebab-case JSON）                                   | 官方完成感知通道，长驻模式启用                                 |

### A.P6 app-server 长驻通道（可选）

| 主题            | 蓝本 | 参考文件                                                                                            | 要点                                                             |
| --------------- | ---- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| 协议与方法面    | [CX] | `app-server/README.md`、`app-server-protocol/src/protocol/common.rs:514-1241`、`v2/turn.rs:142-247` | initialize→thread/start                                          | resume→turn/start 全参面 |
| steer/interrupt | [CX] | `common.rs:261-303`（expected_turn_id 前置条件）                                                    | 运行中纠偏不打断已完成工作                                       |
| 精确用量        | [CX] | `v2/thread.rs:1828-1897`（ThreadTokenUsage total/last/modelContextWindow）                          | 水位监控数据源                                                   |
| 不采用项        | [CX] | `mcp-server/src/message_processor.rs:476-488`                                                       | codex-reply 仅认进程内存活线程，重启失效——故不选 mcp-server 模式 |

### A.0 agentMesh 存量资产复用汇总

| 存量逻辑                            | 位置                             | 被哪些新任务复用                                     |
| ----------------------------------- | -------------------------------- | ---------------------------------------------------- |
| 文件锁+LRU+延迟首写+corrupt 隔离    | `core/session.ts`                | T1.1 墓碑、T2.2 sidecar、T5.3 注册表                 |
| in-flight 注册表                    | `core/runner.ts`                 | T1.1 进行中分支                                      |
| freshness 仓库指纹                  | `core/runner.ts`+`repository.ts` | T1.1 STALE 校验、T2.3 摘要失效、T3.4 敏感交集        |
| 能力矩阵 evaluateModelOptionSupport | `core/capabilities.ts`           | T4.4 候选匹配                                        |
| 进程树终止                          | `core/executor.ts:354-428`       | T1.4 后台取消、T5.3 孤儿清理                         |
| cancelReason 分类+AbortSignal 穿透  | `core/types.ts`+全链路           | T1.2 错误码基准、T1.4 poll 取消                      |
| warning 合流去重管道                | `core/runner.ts`                 | T2.1/T3.1/T3.3/T5.4 所有 warning 注入                |
| zod 校验+Git 根边界配置加载         | `mcp/tools.ts`+`core/config.ts`  | 一切新参数与新配置段入口                             |
| codex JSONL 解析器                  | `agents/codex.ts:26-65`          | T1.5 降级为 fallback 路径保留；T2.1 usage 解析扩展点 |

---

## 附录 B：效果评判与测试标准（详细版）

### B.0 评判总原则

1. **基线先行**：动手改代码前，先在 v0.1 当前 commit 上把基准场景全部跑一遍并记录（打 git tag `v0.1-baseline`）。没有基线的"提升"无法证明。
2. **同景对比**：每个阶段收尾用**完全相同**的场景集重跑，唯一变量是代码版本。真实链路场景因 vendor 波动，每场景至少跑 3 次取中位数。
3. **四层测试金字塔 + 混沌专项**：
   - L1 单元测试（vitest）：纯逻辑，时钟/随机可注入，秒级；
   - L2 假 CLI 集成测试（现有 `*.integ.ts` 模式）：确定性故障注入；
   - L3 内存 MCP 协议测试（现有 tools.test.ts 模式）：新工具全链路契约；
   - L4 真实链路冒烟（opt-in，遵循 AGENTS.md 规程，成本封顶）；
   - L5 混沌专项：kill -9、锁争用、半途损坏输出——只在 P1/P5 收尾跑。
4. **证据留痕**：每次评测产出报告（`docs/eval/v0.x-P<n>.md`），格式见 B.7。沿用项目"修复必须真链路复验"的既有文化。
5. **体验即指标**：把"用户实际感受"作为一等验收维度——这里的用户是**双重的**：人类操作者与主模型（Orchestrator）。等待可观测、错误可行动、中断可善后，都是正式验收项而非锦上添花（详见 B.4）。
6. **双视角记录**：每条结论同时标注机器断言结果（自动判定）与人工体验评价（主观打分 1-5），两者都达标才算通过。

### B.1 测试环境与数据规范

#### B.1.1 环境矩阵

| 环境                                                                | 用途                                         | 层级  |
| ------------------------------------------------------------------- | -------------------------------------------- | ----- |
| Windows 11 + PowerShell 5.1 + 锁定 Node LTS（package.json engines） | 主开发与回归环境，全部场景必跑               | L1-L5 |
| WSL2                                                                | 仅 L2 对照（验证跨平台分支逻辑），不作为门禁 | L2    |
| 真实 vendor 账号（codex / claude 各一）                             | L4 冒烟，每次评测设调用次数与 token 上限     | L4    |

#### B.1.2 假 CLI fixture 清单（tests/fixtures/fake-cli/，L2 专用）

| 脚本                                | 行为                                                         | 服务场景                 |
| ----------------------------------- | ------------------------------------------------------------ | ------------------------ |
| `fail-twice-then-ok`                | 前 2 次 exit 1（任何 stdout 之前），第 3 次正常输出并 exit 0 | S6、T1.3                 |
| `hang-silent`                       | 启动后零输出无限挂起                                         | 看门狗 stalled           |
| `chatty-hang`                       | 每 30s 输出一行日志但任务永不推进（假活）                    | 看门狗误报测试           |
| `huge-output`                       | 输出 60k 字符答案                                            | S5、T2.2                 |
| `malformed-jsonl`                   | 输出半行合法 JSON 后中断                                     | T1.5 fallback、T1.4 抢救 |
| `partial-then-die`                  | 先产出完整答案文本，然后 exit 137                            | S8、T5.2                 |
| `cn-review-pass` / `cn-review-fail` | 全中文评审输出（通过/不通过 + 严重度）                       | T1.5 中文兜底            |
| `slow-first-byte`                   | 启动后 90s 才输出首个字节                                    | T1.3"首字节前"判定       |
| `emit-usage`                        | 输出含 turn.completed.usage 的 JSONL                         | T2.1                     |
| `flag-echo`                         | 把收到的 argv 原样回显                                       | T3.3 白名单校验          |

#### B.1.3 测试仓库模板

固定 git repo fixture（`tests/fixtures/repo-template/`）：含 `.env` 诱饵文件、`.git/hooks/` 占位、一个预埋缺陷的实现文件（供 S4 必然返工）。每次场景执行前从模板重新实例化到临时目录，保证指纹与基线可比。

#### B.1.4 数据卫生

每次运行前后清理本测试用户的 `~/.agentmesh/`（或以 AGENTMESH_HOME 重定向到临时目录——推荐实现此 env 支持以便隔离）与 `~/.codex/sessions/` 中的测试产物，防止跨场景串扰。

### B.2 基准场景卡（定义冻结至 v0.3 发布）

> 每张卡：目标 → 前置 → 步骤 → 断言（逐条，全部满足才算通过）→ 边界变体。

#### S1 简单只读（考基础通路 + 中文）

- 前置：repo-template 实例化；config 含 weak agent 映射
- 步骤：① 全中文任务派发给 weak agent（"阅读 X 文件并用中文总结三个要点"）② 等待终态
- 断言：a) exit 语义 SUCCESS b) finalAnswer 非空且为中文 c) usage 已入库 d) summary ≤200 字符且非乱码 e) 全程 warning 段为空或均为已知良性项
- 边界变体：任务描述含 emoji 与全角标点；答案恰好在 summary 截断边界

#### S2 标准写任务（考 G1/G3/G4 主链路）

- 前置：同上；reviewer 配置为 enforced
- 步骤：① delegate worker 修改两个文件 ② review_changes ③ 若 FAIL 则人工记录（P5 前闭环未启用）
- 断言：a) 前后指纹变化被捕获 b) reviewer verdict 机读字段存在 c) 无 sensitiveWrites d) 执行证据含 attempts/model/sandbox 字段 e) deny 生效清单出现在响应披露区（claude/codex 通道各自格式）
- 边界变体：worker 修改 .env 诱饵 → 必须触发 sensitiveWrites 且 FAIL

#### S3 三棒流水线（考 G2 上下文搬运）

- 前置：三角色配置就绪
- 步骤：① A 调研（产 ≥15k 字符结论）② compact_context(A) ③ B 实现（注入 A 摘要+指针）④ C 评审
- 断言：a) B 收到的上下文 ≤ 预算段限额且有 `[truncated]`/指针标注 b) B 的输入 token（usage 差值）< v0.1 同任务 50% c) C 评审 PASS d) A 在 B 执行前新增一轮则 B 侧 freshness=STALE 且警告可见
- 边界变体：A 答案恰 50,000 字符（阈值点）/50,001；compact_context 对单轮 session 执行；compact 过程中源 session 又新增一轮（竞态）

#### S4 必然返工（考 G4 闭环，P5 后生效）

- 前置：repo-template 缺陷文件；maxReworkRounds=3
- 步骤：① review_changes 带 maxReworkRounds ② 自动循环至 PASS 或耗尽
- 断言：a) 第一轮必 FAIL（fixture 保证）b) 每轮 reworkRound 递增留痕 c) 修复指令包含 findings 结构化字段 d) 最终 PASS 或带完整证据链的 FAIL e) 总耗时与轮次记录在案
- 边界变体：maxReworkRounds=0（行为须与 v0.1 完全一致，回归保护）；返工中调用方取消（AbortSignal → 立即停止循环并落 checkpoint）

#### S5 超长输出（考 G2 artifact）

- 步骤：① huge-output 场景执行
- 断言：a) 落盘文件字节数=原始输出字节数（字节等价）b) 响应含 2KB 预览+绝对路径+hasMore c) 预览在换行边界截断 d) sidecar 登记含 SHA-256
- 边界变体：恰 50,000/50,001 字符；答案为纯空白字符；答案含非法文件名字符的任务 id；模拟磁盘满（写失败 → 必须回退为带 [truncated] 标注的截断而非崩溃）

#### S6 瞬态故障（考 G1 重试，L2）

- 步骤：① fail-twice-then-ok 执行
- 断言：a) 整体 SUCCESS b) attempts=3 c) 响应注明经历重试 d) 三次尝试间隔符合 5s/15s 退避表（±10%）
- 边界变体：slow-first-byte（首字节 90s——必须判定为"未产生工作"可重试类）；第 3 次仍失败 → 上抛 TRANSIENT_5XX 且不自动第 4 次；重试等待期间调用方取消 → 立即中止不再发起

#### S7 幂等重放（考 G1 幂等，L2）

- 步骤：① 同 key 并发派发 3 次
- 断言：a) 底层执行恰好 1 次 b) 两次后续调用收到 replayed:true + 相同结果 c) 不同 cwd 同 key 正常各执行
- 边界变体：key 为空串（schema 拒绝）；墓碑 TTL 到期瞬间再来第 4 次调用；桥接进程重启后同 key 再来（墓碑丢失 → 如实重执行并在 warning 说明幂等状态未持久化恢复——明确这是已知边界而非 bug）；命中缓存时当前指纹已变 → STALE 警告必须出现

#### S8 崩溃恢复（考 G1/G4，L5）

- 步骤：① 启动 partial-then-die 或真 codex 任务 ② 输出完成后、桥接收尾前 kill -9 桥接进程 ③ 重启 serve ④ poll/查 session
- 断言：a) codex 通道：从 rollout tail 抢救出 finalAnswer 与用量 b) 非 codex 通道：checkpoint 存在部分结果 c) 注册表中死任务条目被清理 d) 会话历史无半写损坏（corrupt 隔离机制未触发或正确触发）
- 边界变体：kill 发生在 JSONL 半行写入时；rollout 文件被外部截断一半；恢复的是 7 天前的 .zst 压缩会话；fromCheckpoint 二次消费同一 checkpoint（墓碑拒绝）

#### S9 安全违规组（考 G3）

- 五个探测动作依次执行，各自独立断言：
  1. worker 读 `.env` → claude 通道 deny 拦截 / codex 通道 execpolicy 或只读拦截 / 其余通道至少事后 sensitiveWrites 取证
  2. 写 `.git/hooks/pre-commit` → codex 内建只读保护命中；claude deny 命中
  3. `curl https://example.com` → codex：network_access=false 下 Forbidden 或 env 级缓解证据可见
  4. extraArgs 传 `--yolo` / `--dangerously-bypass-approvals-and-sandbox` → ARG_REJECTED（构造层物理排除，单测另证）
  5. env 注入 DOCKER_HOST → envOverrideRejected 出现且子进程环境确无此键（flag-echo 回显验证）
- 边界变体：`.ENV`（大小写）；symlink 指向 .env；Windows 短名 `GIT~1` 路径写 .git；相对路径 `..\.env` 穿越——以上全部按命中敏感规则处理（借鉴 CC hasSuspiciousWindowsPathPattern 检测思路，检测而非规范化）

#### S10 弱败升级（考 G5）

- 步骤：① weak agent 注入 MODEL_REJECTED 类失败（假 CLI 或真链路错配模型）② 观察 error_code 与 hint.nextCandidates ③ 主模型（人或脚本代拟）按 hint 重派强候选
- 断言：a) error_code=MODEL_REJECTED 准确 b) nextCandidates ≤3 个且 costLevel 升序 c) 重派一次成功 d) 全程额外交互轮次=1
- 边界变体：candidates 链全部失败 → 返回末位失败原因码+完整尝试链证据；hint 为空（无更高候选）→ 明示"无可用升级候选"

### B.3 边界用例矩阵（按能力域）

> 层级标注：L1=单测 L2=假CLI L4=真链路。每行一条可执行断言。

**幂等（T1.1）**

| 用例                             | 预期                           | 层级 |
| -------------------------------- | ------------------------------ | ---- |
| key 相同+cwd 相同+指纹已变       | replayed:true + STALE 警告     | L1   |
| key 含 Unicode/极长（>256 字符） | 正常处理或 schema 明确上限拒绝 | L1   |
| 墓碑写入后进程重启               | 幂等态不保证恢复，warning 明示 | L2   |

**重试与熔断（T1.3）**

| 用例                                        | 预期                                     | 层级           |
| ------------------------------------------- | ---------------------------------------- | -------------- |
| 第 4 次才会成功的 fixture                   | 第 3 次后上抛，不第 4 次                 | L2             |
| 熔断窗口恰好到期瞬间新请求                  | 放行且连续失败计数清零                   | L1（注入时钟） |
| 熔断期间 get_session/list_agents 等只读工具 | 不受熔断影响                             | L3             |
| 重试期间另一请求到达同 adapter              | 排队或并行均可，但 attempts 各自独立计数 | L2             |

**后台与看门狗（T1.4）**

| 用例                              | 预期                                                        | 层级 |
| --------------------------------- | ----------------------------------------------------------- | ---- |
| poll 不存在的 taskId              | 结构化 NOT_FOUND，非崩溃                                    | L3   |
| offset 超过输出文件长度           | 返回空增量 + hasMore:false                                  | L2   |
| 服务重启后 poll 旧 taskId         | 状态如实（running 孤儿接管清理 / completed 读盘）           | L2   |
| chatty-hang（假活）               | 判 running 不误报 stalled，但 30 分钟无状态推进触发二级提示 | L2   |
| hang-silent 恰好 9min59s 恢复输出 | 不触发 stalled（10min 阈值边界 ±5s 容差）                   | L2   |
| 多个任务同时 stalled              | 通知各自独立、至多一次                                      | L2   |

**artifact（T2.2）**：见 S5 变体；另加——sessionId 含路径分隔符注入（`../`）→ 落盘路径规范化拒绝；并发写同一 artifact 名 → 'wx' 幂等语义，第二写失败不覆盖。

**计量（T2.1）**

| 用例                           | 预期                         | 层级 |
| ------------------------------ | ---------------------------- | ---- |
| usage 字段缺失/null            | undefined 入库，不估算       | L1   |
| 单轮增量为负（线程累计值回退） | 取 0 并 warning 说明异常     | L1   |
| rate_limits 缺失               | 仅跳过配额预警，不影响主流程 | L1   |

**安全校验（T3.x）**：见 S9 变体；另加——allowedExtraArgs 匹配大小写变体 flag（Windows argv 大小写不敏感语义需按 vendor 实际语义决定，codex 区分大小写→精确匹配）；白名单键值本身含引号/空格注入 → 原样透传由 vendor 解析（我们不做二次解释，注释明示威胁模型）。

**编码与本地化**

| 用例                     | 预期                                                 | 层级  |
| ------------------------ | ---------------------------------------------------- | ----- |
| GBK 控制台代码页下 spawn | UTF-8 分块解码不受污染（既有 P-020 机制回归）        | L2    |
| 答案含 emoji/RTL 文本    | 截断不在代理字符对中间劈开（或劈开处有替换符且不崩） | L1    |
| 全中文 verdict/summary   | cn-review fixtures 全部正确判定                      | L1/L2 |

**平台（Windows 重点）**

| 用例                              | 预期                                                    | 层级 |
| --------------------------------- | ------------------------------------------------------- | ---- |
| >260 字符长路径工作区             | 正常 spawn 与指纹采集（\\?\ 前缀处理）                  | L2   |
| UNC 网络盘 cwd                    | 明确不支持→结构化失败（对齐 CC UNC 不算只读的保守立场） | L2   |
| taskkill 权限不足（受限测试账户） | 树终止失败的 warning 如实上报，不留僵尸引用             | L2   |
| 盘符大小写 C: vs c: 指纹一致性    | 归一化后一致                                            | L1   |

**并发与锁**

| 用例                               | 预期                                                               | 层级 |
| ---------------------------------- | ------------------------------------------------------------------ | ---- |
| 10 并发 delegate 同 cwd            | 全部完成或明确失败原因，sessions.json 无损坏（既有第九轮实测回归） | L5   |
| 锁等待超上限瞬间                   | 失败信息含"锁竞争"指引而非裸超时                                   | L2   |
| 后台任务与前台任务混跑同一 adapter | 互不干扰，attempts/日志分离                                        | L2   |

### B.4 用户体验评测（双视角：人 + 主模型）

| #   | 维度           | 关键问题                                                                        | 测量方法                                         | 通过标准                                                                                                             |
| --- | -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| U1  | 等待可观测性   | 等待期最长静默多久？心跳有无增量价值？                                          | 分析 L4 日志时间戳序列                           | 同步模式静默 ≤15s（既有心跳）；后台 poll 返回自上次以来的新增输出而非整段重复                                        |
| U2  | 错误可行动性   | 每个 error_code 是否告诉调用方"下一步做什么"？                                  | 遍历全部错误码检查表                             | 100% 附 actionable hint（CIRCUIT_OPEN→预计恢复时间；SANDBOX_UNAVAILABLE→setup 命令；MODEL_REJECTED→nextCandidates…） |
| U3  | 中断善后       | 取消后进程树多久消失？半成品是否返还？                                          | S8 变体计时 + 结果检查                           | 树终止 ≤5s；partial result/checkpoint 存在且已耗 token 如实记录                                                      |
| U4  | 进度可信度     | stalled 判定会不会冤枉慢任务、放过假活？                                        | hang-silent 与 chatty-hang 对照                  | 慢而活→running；静默超阈→stalled 至多通知一次；假活 30min 无状态推进→二级提示                                        |
| U5  | 主模型可消费性 | 主模型拿到 preview+指针格式能否正确决策（去读 artifact 而不是复述"信息不全"）？ | 1 次 S5 真链路行为观察，记录主模型后续动作       | 主模型正确引用 artifact 路径取回细节，或明确声明无需更多细节                                                         |
| U6  | 中文端到端     | 全中文任务从派发到评审通过是否顺畅？                                            | S1/S2 中文变体                                   | verdict/summary 正确提取，无乱码、无英文标签依赖导致的 UNKNOWN 误判                                                  |
| U7  | 首次上手       | config 写错时能否自助修复？未配元数据时界面是否友好降级？                       | 反例配置遍历 validate + 空 agents 段 list_agents | 每条报错含字段路径+修复示例；缺元数据显示"未分级"而非报错中断                                                        |
| U8  | 时延感知       | 异步入口是否真的"立即"？                                                        | L2 计时                                          | background 派发返回 ≤1s；poll 单次 ≤500ms（不含子进程操作）                                                          |

U1/U5/U6 属 L4 人工观察项，其余可自动化。**人工体验评价采用 1-5 分制随评测报告归档，<4 分的项即使机器断言全绿也视为未通过**（双视角原则）。

### B.5 指标定义与计算公式

**G1 可靠性**

| 指标                       | 公式                                            | 目标                               | 层级/场景  |
| -------------------------- | ----------------------------------------------- | ---------------------------------- | ---------- |
| 瞬态自愈率                 | 自动重试成功数 ÷ 注入瞬态故障数                 | 100%（限首字节前类）               | S6/L2      |
| 重复执行率                 | 同 key 并发 3 次派发下实际执行次数 −1           | =0                                 | S7/L2      |
| finalAnswer 官方通道成功率 | 官方通道取得非空答案 ÷ codex 任务总数           | ≥99%；fallback <1% 且必有 warning  | S1-S5/L4   |
| 崩溃抢救率                 | kill -9 后取回 finalAnswer 或 checkpoint 的比例 | codex ≥95%；其他通道如实统计不设标 | S8/L5      |
| stalled 感知时延           | 输出停滞到 stalled 通知                         | 10min ± 5s                         | S6 变体/L2 |

**G2 Token**

| 指标         | 公式                                                                           | 目标                    | 场景    |
| ------------ | ------------------------------------------------------------------------------ | ----------------------- | ------- |
| 计量覆盖率   | 有 usage 的 turn ÷ 总 turn                                                     | codex=100%，全通道 ≥90% | 全部    |
| 中段输入降幅 | Σ下游输入tokens(v0.1) ÷ 同值(v0.3)，S3 同任务                                  | ≥50%                    | S3/L4×3 |
| 信息保真度   | ① artifact 字节等价 ② 摘要关键事实抽检（预先从原答案提 10 条事实，核对保留数） | ①100% ②≥8/10            | S5+S3   |
| 用量账目误差 | 桥接层 Σusage 对比 vendor 控制台                                               | ±5%                     | 抽查    |

**G3 安全**：违规拦截率（S9 五项）=100% 且每项有结构化证据；注入面收敛（envOverrideRejected 可见 + 危险 flag 构造层抛异常的单测证明）=100%；披露完整性（沙箱未激活 warning、deny 生效清单）=100%。

**G4 无人值守**：返工闭环成功率（S4 ≤3 轮转 PASS）≥80%（其余为真不可修，FAIL 证据链完整亦算合格退出）；全自动端到端（S2/S4 零人工操作，日志证明）=100%；孤儿回收率=100%。

**G5 强弱调度**：路由表完备性（list_agents 过 schema 断言：字段全/可用性实时/保护矩阵在位）=100%；升级决策步数（S10）=1；profile 切换正确性（三档启动后生效参数与声明一致）=100%。

**UX（对应 B.4）**：U1-U8 机器项 100%；人工评分均值 ≥4。

### B.6 阶段门禁（Phase Gate）

| 门禁          | 放行条件                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| P1 完成       | S6/S7/S8 全绿；T1.1-T1.5 新模块单测行覆盖 ≥85%；U2 错误码检查表 100%、U3/U8 达标；既有安全/协议回归零删除 |
| P2 完成       | S3 降幅达标 ×3 次中位；S5 字节等价 + U5 行为观察通过；计量覆盖率达标                                      |
| P3 完成       | S9 五项全拦 + 披露完整；真链路 deny/沙箱验证各 1 次（opt-in）；S9 边界变体（大小写/symlink/短名）全绿     |
| P4 完成       | 路由表 schema 断言全绿；S10 升级步数=1；U7 首次上手检查表通过；config validate 反例齐                     |
| P5 完成       | S4 闭环达标；S8 抢救+续跑贯通含全部边界变体；孤儿清理演练通过；U4 假活对照通过                            |
| v0.3 整体发布 | 全场景相对 `v0.1-baseline` 出具对比报告；G1-G5 核心指标 + UX 八项全部达标注明证据路径；人工体验总分 ≥4    |

### B.7 评测报告模板

```
# Eval Report: v0.3-P<n> vs v0.1-baseline
date / commit / 执行人 / 环境（B.1.1 矩阵勾选）

## 一、场景结果（机器断言）
| 场景 | 指标 | v0.1 基线 | v0.3 | 目标 | 通过 | 证据路径 |
| S6 | 瞬态自愈率 | 0%(无重试) | 100% | 100% | ✅ | logs/s6-run3.log |

## 二、真实链路记录（每场景 3 次取中位）
run1/run2/run3 原始数据 + 成本（tokens/调用次数/配额余量快照）

## 三、边界用例矩阵执行情况（本轮涉及的组）
| 组 | 用例数 | 通过 | 未通过与原因 |

## 四、用户体验记录（人工）
| 维度 | 评分1-5 | 观察笔记 | 证据（截图/日志摘录） |

## 五、偏差与未达项
现象 → 根因假设 → PROBLEMS.md 台账号 → 是否阻塞发布
```

### B.8 注意事项

- 真实链路有配额与波动：S1-S5 每次评测预算封顶（调用次数与 token 双上限），失败先排查 vendor 侧再判回归；
- 基准场景与边界矩阵定义变更 = 基线作废重测，原则上冻结至 v0.3 发布；
- 性能类指标（stalled 时延、后台返回耗时、树终止耗时）只在 L2 假 CLI 上测才可复现，L4 仅抽查；
- 所有"达标"结论必须附证据文件路径，不接受口头达标——与项目"证据如实"原则一致；
- L4 涉及真实凭据与真实仓库：一律在一次性临时目录与专用测试账号进行，禁止指向生产目录（沿用 AGENTS.md 真实测试规程的 opt-in 精神）。
