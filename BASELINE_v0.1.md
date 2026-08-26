# v0.1 基线测试记录（Baseline Test Record）

- commit: `0b9da02`（feat/v0.3-optimization，代码与 master@4c83764 完全一致）
- 机器：Windows 11 / PowerShell 5.1 / 本机磁盘（含 Defender 实时扫描）
- 日期：2026-08-26

## 结果

`npm test`：**157 用例，150 通过 / 7 失败** —— 失败集合在多次运行间不完全一致（flaky）。

## 已知不稳定用例（Known Flaky Set）

| 测试文件 | 用例 | 观察到的现象 | 初步归因 |
|---|---|---|---|
| tests/core/repository.test.ts | keeps untracked fingerprints deterministic beyond the content-hash cap | `Test timed out in 5000ms`（505 文件写入+哈希循环），随后 ENOTEMPTY 级联清理失败 | 本机小文件 I/O 慢，5s 默认超时过紧 |
| tests/core/diagnostics.test.ts | fails on an unparseable project config / fails on a schema-violating project config / enforced reviewer fail-closed / best-effort reviewer warn 等（每次运行子集不同） | 断言失败 `expected 'fail' to be 'pass'`、`expected 1 to be +0` | 待查；疑似环境相关或负载下超时引发的级联 |
| tests/core/runner.test.ts | returns failure when continuing/delegating to a missing session | 偶发 | 待查 |
| tests/mcp/tools.test.ts | （名称随运行变化） | 偶发 | 待查 |
| tests/agents/args.test.ts | returns a structured failure for a missing binary | 偶发 | 待查 |

## 对各升级窗口的约束

1. **判定标准**：任何窗口的验收 = 相对本基线**不新增失败用例**。上表所列 flaky 用例不计为你的回归——但若你的改动恰好触及对应模块（如 runner/diagnostics/repository），必须先单测复跑确认是存量失败再继续。
2. 单独复跑命令示例：`npx vitest run tests/core/repository.test.ts`
3. 根因修复（调大 testTimeout / 排查断言环境依赖）归属 **W1（核心协议窗口）**顺带处理，不单独开窗。
4. L4 真链路冒烟不受此影响。

## 后续正式基线

按 OPTIMIZATION_PLAN.md 附录 B，S1-S10 基准场景的首次真链路测量仍需在各阶段开工前择机执行并追加到本文档。
