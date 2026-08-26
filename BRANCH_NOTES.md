# BRANCH_NOTES — w2/codex-channel

供主会话合并 `feat/v0.3-optimization` 时收敛的窗口①独占文件变更请求与本分支决策记录。

## 1. 请求共享类型新增字段：`AgentResult.usage`（agents/types.ts）

本窗口按边界约束未触碰 `agents/types.ts` / `core/types.ts`，在 `src/agents/codex.ts`
内以局部扩展类型过渡：

```ts
export interface CodexAgentResult extends AgentResult {
  usage?: CodexUsage;
}
```

请主会话在合并时将以下正式字段收敛进共享类型（建议放 `agents/types.ts` 的
`AgentResult`）：

```ts
/** Token usage as reported by the vendor (see per-adapter semantics). */
usage?: {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};
```

收敛后动作：删除 `CodexAgentResult` 局部类型与测试中的 `as CodexAgentResult`
收窄（tests/agents/codex-channel.test.ts 两处），直接使用共享字段。

## 2. usage 语义备忘（T2.1）

- CLI 通道数值来自 codex 官方 `turn.completed` 事件（exec_events.rs Usage 五字段：
  input_tokens / cached_input_tokens / cache_write_input_tokens /
  output_tokens / reasoning_output_tokens）。
- **该值是线程累计值**：`codex exec resume` 场景下包含此前所有轮次；单轮增量 =
  相邻两次差值。增量聚合需要 runner 层跨轮状态，属窗口①职责，本分支只如实上报累计值。
- `totalTokens`：stdout usage 事件无此字段（保持 undefined 不伪造）；rollout 恢复
  路径的 token_count.info.total_token_usage 自带 total_tokens，此时才填充。
- 崩溃抢救路径的 usage 来自 rollout 文件，同为线程累计值。

## 3. 本分支实现的安全基线范围（T3.1 子集）

已落地（src/core/codexSecurity.ts，codex.ts 全部 spawn 前强制接线）：

- `-c approval_policy="never"` 显式锁定；
- `-c sandbox_workspace_write.network_access=false` 防御性显式化；
- 所有 `-c` 覆盖固定携带 `--strict-config`（worker 与 reviewer 均带）；
- argv 物理排除：`--yolo`、`--dangerously-bypass-approvals-and-sandbox`、
  `sandbox_mode="danger-full-access"`（含引号/大小写变体），构造层抛
  `CodexSecurityViolationError`（结构化失败，spawn 之前触发）；
- 安全锁参数固定追加在调用方 extraArgs 之后（vendor last-wins 合并语义下保证锁胜出）；
- `withCodexHome()` 支持专用 CODEX_HOME（每角色治理目录）；adapter 崩溃抢救同样
  尊重 `options.env.CODEX_HOME`。

尚未包含（留给后续窗口/主会话，见 OPTIMIZATION_PLAN T3.1 第 1/2/5 条）：

- `[windows] sandbox="unelevated"` 运行时默认注入 + 沙箱未激活 warning 披露
  （需事件流 sandbox denial 证据检查，涉及 runner 管道）；
- execpolicy rules/\*.rules 与 requirements.toml 的专用 CODEX_HOME 预置物；
- `-C <jobDir>` 固定根 + `--add-dir` 白名单最小可写集。

## 4. 其他决策记录

- reviewer 角色追加 `--output-schema <verdict.schema.json>`（T1.5.2）：schema 由
  adapter 写入临时文件并在运行后清理；finalAnswer 为 schema 形 JSON 时以机器可读
  verdict 覆盖正则解析结果，解析失败回落既有正则管道（严格契约下仍 fail-closed）。
- worker/reviewer 均携带 `--output-last-message <tmp>`（官方 finalAnswer 提取通道，
  T1.5.1）；JSONL 解析降级为 fallback 且必附 warning。
- 进程异常死亡（非零退出/超时/中止/spawn error）且能正定 UUID 形态 thread id 时，
  调用 codexRollout 从 `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl(.zst)`
  抢救 last_agent_message 与用量；抢救内容进入 failed 结果的 finalAnswer/usage/warning，
  业务失败状态不变（证据如实原则）。
- `.jsonl.zst`：当前 Node 运行时无原生 zstd 解码（zlib.zstdDecompressSync 缺失），
  结构化报错不伪造内容；未来 Node 提供原生解码后自动可用。引入第三方 zstd 依赖需改
  package.json，超出本窗口边界，留主会话决策。
- MCP 传输路径未改动（codex mcp-server 工具 schema 拒绝额外参数，沙箱锁定已有）。

## 5. 测试基线核对

- 新增测试 27 个（rollout 11 + security 6 + channel 行为 7 + args 断言扩充 3 组），
  全部通过。
- 全量 `npm test` 失败集均落在 BASELINE_v0.1.md 已知 flaky 集合
  （repository/diagnostics/runner/mcp-tools，超时级联型）；已用 stash 对照验证
  无本次改动的 HEAD 同样甚至更多失败（7 vs 6），非本窗口回归。
