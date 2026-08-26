# 强弱模型路由表配置指南

> 对应 OPTIMIZATION_PLAN.md 阶段四 T4.1。设计红线：**强弱判定不进代码**——tier / costLevel /
> strengths 等全部由使用者手动维护，AgentMesh 只做 schema 校验与引用检查，路由决策权始终在主模型
> （Orchestrator）。本指南说明 `.agentmesh/config.json` 中可选 `agents` 段的各字段语义、升级链写法、
> codex Profile v2 角色文件规范，并给出完整三档示例。

---

## 1. 设计原则与向后兼容

- `agents` 段是**可选**的：不写该段时，config 行为与 v0.1 完全一致（既有配置零改动可用）。
- 元数据是给主模型看的"路由表"，不是运行时开关：AgentMesh 不会因为 `tier: "weak"` 就强制降级，
  也不会因为 `candidates` 自动重派——失败升级决策（Wave 后续 T4.4 的 hint）只提供提示。
- 键名可以是注册 agent 名/别名（`codex`、`claude-code`…），也可以是**档位变体 id**
  （如 `codex-strong`，对应一个 codex profile 文件）。validate 对后者给 warning 而非 error。

## 2. agents 元数据字段语义

```jsonc
{
  "version": 1,
  "roles": { "worker": "codex" },
  "agents": {
    "<agent 别名或档位变体 id>": {
      "tier": "strong | medium | weak",
      "costLevel": 1-5,
      "speed": "自由文本，如 \"fast (~30s per task)\"",
      "strengths": ["擅长领域", "..."],
      "notGoodAt": ["不擅长领域", "..."],
      "sandboxLevel": "native-sandbox | tool-filtering | prompt-only",
      "notes": "给主模型的一句话使用建议",
      "candidates": ["下一档候选", "更上一档候选"]
    }
  }
}
```

| 字段           | 类型              | 语义                                                                                                                       | 主模型如何使用                            |
| -------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `tier`         | enum              | 模型强度自评：`strong`（架构级重构/复杂评审）、`medium`（常规实现）、`weak`（机械性批量任务）                              | 任务复杂度 × tier 决定派发目标            |
| `costLevel`    | int 1-5           | 单任务综合成本档位（1 最便宜）                                                                                             | 同等能力下优先低档位                      |
| `speed`        | string ≤100 字符  | 典型耗时体感（自由文本，建议带量级）                                                                                       | 时间敏感任务参考                          |
| `strengths[]`  | string[] ≤32 项   | 明确擅长场景（如 `"code-review"`、`"windows 平台调试"`）                                                                   | 与任务特征匹配                            |
| `notGoodAt[]`  | string[] ≤32 项   | 已知短板（如长上下文、多文件重构）                                                                                         | **负向排除优先级高于 strengths 正向匹配** |
| `sandboxLevel` | enum              | 自申报保护等级：`native-sandbox`（OS 级隔离）/ `tool-filtering`（工具层过滤）/ `prompt-only`（仅提示词约束，**不是沙箱**） | 写敏感仓库的任务要求 ≥ tool-filtering     |
| `notes`        | string ≤2000 字符 | 其他需要主模型知道的注意事项                                                                                               | 直接进入路由表视图                        |
| `candidates[]` | string[] ≤16 项   | 失败时的升级链声明（见第 3 节）                                                                                            | 凭错误码沿链确定性升级                    |

字段约束（zod 全量校验，非法配置 fail-fast 定位到具体字段路径）：

- `tier`: 只接受 `strong | medium | weak`
- `costLevel`: 整数且 1 ≤ x ≤ 5（0、6、2.5 均拒绝）
- `sandboxLevel`: 只接受三个枚举值，与运行时 `SandboxMechanism` 词表一致
- 所有条目对象为 strict 模式：拼错键名（如 `tuer`）直接报错，防止静默失效
- 每个 agents 条目必须非空键；整段最多 32 个条目

### 安全一致性规则

`tier: "strong"` + `sandboxLevel: "prompt-only"` 是合法但被 validate 标记 warning 的组合：
强模型通道若只有提示词级保护，不要在元数据里夸大其安全能力——主模型可能因此把敏感写任务派给它。
修复方式二选一：换用真实隔离通道，或如实下调 tier 声明。

## 3. candidates 升级链

`candidates` 声明"本 agent 失败后，按序尝试谁"。每个引用必须满足其一：

1. 注册过的 agent 名/别名（如 `codex`、`codex-cli`、`zcode`）；
2. 同一 `agents` 段内声明的兄弟条目（如档位变体 `codex-medium`）。

否则 `agentmesh config validate` 报 error 并给出修复示例。此外：

- 链内重复条目 → error；
- 引用自身 → error；
- 跨条目成环（a→b→a）→ error；
- 引用不存在于别名表也不是兄弟条目 → error（防 typo 静默断链）。

### 示例：三档升级链

```json
{
  "agents": {
    "zcode": { "tier": "weak", "costLevel": 1, "candidates": ["codex-medium"] },
    "codex-medium": { "tier": "medium", "costLevel": 3, "candidates": ["codex-strong"] },
    "codex-strong": { "tier": "strong", "costLevel": 5 }
  }
}
```

约定链按 costLevel **升序**排列（弱→中→强）。主模型的预期行为：weak 任务报
`MODEL_REJECTED` 类错误码时，沿 `zcode → codex-medium → codex-strong` 一次重派到位，而不是
盲目重试同一目标。（T4.4 的 `hint.nextCandidates` 将自动从该声明生成提示，≤3 个、costLevel 升序。）

## 4. codex Profile v2 角色文件规范（一档一文件）

codex 候选切换使用官方 **Profile v2** 机制：每个档位一个独立配置文件，adapter 以
`--profile <name>` 启动，切档即换参，不再拼接 `-c` 覆盖串。

### 文件位置与命名

```text
$CODEX_HOME/<name>.config.toml
```

- `<name>` 必须与 config.json 里 `agents.<key>` / `candidates` 引用名称一致
  （如 `codex-strong.config.toml` ↔ `agents["codex-strong"]`）。
- 默认 `$CODEX_HOME` 为 `~/.codex`；AgentMesh P3 安全基线会为角色指定专用 CODEX_HOME，
  此时 profile 文件放在对应专用目录下。

### 文件内容：组合四类参数

`<name>.config.toml` 组合以下顶层键（Profile v2 语义，均为顶层键，不是嵌套表）：

```toml
# codex-strong.config.toml —— 强档：深推理 + 工作区可写
model = "gpt-5-codex"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "never"
developer_instructions = """
You are the strong-tier worker for high-stakes refactors.
Always run tests before reporting done.
"""
```

| 键                       | 作用     | 档位典型取值                                                                             |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| `model`                  | 底层模型 | strong/medium/fast 各自绑定不同 model 或同 model 不同 effort                             |
| `model_reasoning_effort` | 推理力度 | `high`（强）/ `medium`（中）/ `low` 或省略（快档）                                       |
| `sandbox_mode`           | 沙箱策略 | `workspace-write`（默认写任务）；Windows 需另行启用 `[windows] sandbox`（P3 基线包负责） |
| `approval_policy`        | 审批策略 | 无人值守一律 `"never"`（headless 默认即 never，需审批操作会被拒绝而非放行）              |
| `developer_instructions` | 角色指令 | 可选；注入该档位的职责说明                                                               |

### ⚠️ 旧版 `[profiles.x]` 写法已废弃

网上旧教程中的 `[profiles.x]` 表写法在当前 codex 版本**已删除，启动即报错**：

```toml
# ❌ 已废弃 —— 不要再写
[profiles.codex-strong]
model = "gpt-5-codex"
```

正确形态是上面第 4 节的**独立文件 + 顶层键**。`agentmesh config validate` 会把无法解析的
agents 键标 warning 提示检查对应 profile 文件是否存在且为新版形态；codex 侧配合
`--strict-config` 启动时，未知/过期配置键也会直接报错退出（fail-fast 而非静默忽略）。

### claude 与其他 vendor 的候选

- claude：候选 = 不同 `model` 参数组合（在 roles/assignment 层表达），无独立 profile 文件。
- 其他 vendor：候选 = 二进制本身（zcode/grok 等），元数据照常维护。

### 互补手段：进程内子代理路由（可选）

codex 原生还支持 `[agents]` 配置表的 `default_subagent_model` / `default_subagent_reasoning_effort`，
用于单个 codex 进程内部扇出时自动使用更弱的子代理模型。这是**进程内细粒度**路由点，
与本文件的跨 agent 外置粗粒度路由互补：前者省 token，后者控制强弱分工，二者不冲突。

## 5. 校验：`agentmesh config validate`

```bash
agentmesh config validate [cwd] [--json]
```

- schema 校验：每条违规定位到字段路径（如 `agents.codex.costLevel`）并附修复示例；
- 别名可解析性：roles.\* 的 agent 引用必须能解析为注册适配器（error）；
  agents 键不能解析时按档位变体 id 处理（warning）；
- candidates 引用存在性：悬空引用 / 重复 / 自环 / 成环均报 error；
- tier=strong 且 sandboxLevel=prompt-only → warning；
- 有 error 时进程退出码为 1，可直接用于 CI 门禁；`--json` 输出机器可读报告。

## 6. 完整三档配置示例

`.agentmesh/config.json`（可直接作为起点，含 roles 与 agents 路由元数据）：

```json
{
  "version": 1,
  "roles": {
    "orchestrator": "antigravity",
    "worker": "zcode",
    "reviewer": { "agent": "opencode", "safety": "enforced" },
    "tester": "claude"
  },
  "agents": {
    "zcode": {
      "tier": "weak",
      "costLevel": 1,
      "speed": "fast (~30s per task)",
      "strengths": ["quick summaries", "boilerplate edits", "batch renames"],
      "notGoodAt": ["multi-file refactors", "architecture decisions"],
      "sandboxLevel": "prompt-only",
      "notes": "Default bulk worker; do not assign security-sensitive writes.",
      "candidates": ["codex-medium"]
    },
    "codex-medium": {
      "tier": "medium",
      "costLevel": 3,
      "speed": "moderate (~2min per task)",
      "strengths": ["feature implementation", "test writing", "bug fixing"],
      "notGoodAt": ["large-scale architecture changes"],
      "sandboxLevel": "native-sandbox",
      "notes": "Backed by $CODEX_HOME/codex-medium.config.toml.",
      "candidates": ["codex-strong"]
    },
    "codex-strong": {
      "tier": "strong",
      "costLevel": 5,
      "speed": "slow (~4min per task)",
      "strengths": ["deep code review", "cross-module refactoring", "hard debugging"],
      "notGoodAt": [],
      "sandboxLevel": "native-sandbox",
      "notes": "Backed by $CODEX_HOME/codex-strong.config.toml; use when medium fails with MODEL_REJECTED or verdict quality matters.",
      "candidates": []
    }
  }
}
```

配套的两个 codex profile 文件：

```toml
# $CODEX_HOME/codex-medium.config.toml —— 中档
model = "gpt-5-codex"
model_reasoning_effort = "medium"
sandbox_mode = "workspace-write"
approval_policy = "never"
```

```toml
# $CODEX_HOME/codex-strong.config.toml —— 强档
model = "gpt-5-codex"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
approval_policy = "never"
developer_instructions = """
Strong-tier worker: handle complex refactors and final reviews.
Run the test suite before reporting completion.
"""
```

提交前执行 `agentmesh config validate` 确认零 error（warning 需逐条知情确认）。

## 7. 字段速查卡

| 想表达          | 写什么                                  |
| --------------- | --------------------------------------- |
| 这个 agent 多强 | `tier`                                  |
| 这个 agent 多贵 | `costLevel`（1-5）                      |
| 多快            | `speed`                                 |
| 擅长什么        | `strengths[]`                           |
| 不擅长什么      | `notGoodAt[]`（优先级高于 strengths）   |
| 保护等级        | `sandboxLevel`（prompt-only 不是沙箱）  |
| 补充说明        | `notes`                                 |
| 失败后找谁      | `candidates[]`（弱→强，costLevel 升序） |
