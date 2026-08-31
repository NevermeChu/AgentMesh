# 真实测试 SPEC 模板（强制条款 v1）

> 来源：R20 十轮复杂任务战役暴露的两类系统性问题（`real_test.md` R20 收官 §4）：
> ① SPEC 未定义区（原型污染、RFC4180 空隙、终止边界）反复依赖 reviewer/tester 越出文本补位；
> ② worker 自测对"顺序语义/内部哨兵/宿主键冲突"类缺陷全盲（R04/R10 的缺陷均通过 worker 自测）。
> 本模板把教训固化为强制条款：为真实测试轮编写 SPEC.md 时，以下 M1-M6 必须逐条落实；
> 不适用者必须显式写 "N/A + 理由"，不得留空。

## M1 不可信键名防护（强制）

凡接受外部对象/嵌套结构作为输入的 API，SPEC 必须显式规定：`__proto__`、`constructor`、`prototype`
键在任意深度出现时的行为——`TypeError`（含错误信息锚词）或文档化忽略，二者择一。
同时要求实现不得用字符串哨兵键（如 `_isLeaf`）挂在用户数据可达的对象上（R10 缺陷形态），
内部标记必须使用 `Symbol` / `Map` / 侧表。

```markdown
- 不可信键：`__proto__` / `constructor` / `prototype` 在任意输入深度出现时抛出
  `TypeError`，消息包含 "prototype"。（对应测试向量必须在 tests 中按 id 出现）
```

## M2 顺序语义（凡返回集合必写）

API 返回数组/列表时，SPEC 必须逐处声明顺序（文档序、插入序、字典序、无序），
且验收向量必须包含**至少一个顺序敏感断言**（同集合、不同顺序 = 不同结果）。
R04 缺陷形态：`..` 递归下降父键先于子键输出，worker 的 fixture 恰好顺序不敏感而漏测。

```markdown
- `$..key` 的结果顺序为文档文本序（深度优先前序）；向量 C6 用
  `{a:{price:1}, price:5}` 断言结果为 `[1, 5]`。
```

## M3 未定义区策略（禁止静默宽松）

规格作者必须主动枚举行为留白区（解析器的非法输入、越界索引、混合类型比较、
部分应用无效参数等），逐条给出：显式行为（报错 + 错误类型 + 消息锚词）或
文档化宽松行为（"按 X 处理，理由 Y"）。禁止出现"SPEC 未定义"而实现自选。
R02/R05/R06/R08 的 low findings 全部源于此。

```markdown
- 行为未定义区处理：闭引号后尾随字符 → 保留原样（宽松，与"逐字保留"一致）；
  裸 `\r` 终止 → 不支持，按普通字符处理。
```

## M4 解析/生成类任务的边界语义（强制）

凡涉及分块、分行、分记录的解析器，SPEC 必须显式定义：
终止条件（空行？无分隔符？EOF？）、尾随分隔符、空白行的地位、多连续边界
（如多个空行）、转义序列与边界字符的复合规则（左结合）。

## M5 往返与有损声明（凡 build/parse 成对出现必写）

若 API 同时提供序列化与反序列化，必须声明：往返是否无损、哪些输入有损、
有损方向是什么（丢弃哪个字段/形态），并给出往返测试向量。

## M6 worker 任务文本附加段（反自测盲区）

每轮 worker 任务的固定尾段（拼在任务文本里）：

```markdown
Self-test requirements (in addition to SPEC vectors):

1. Include ORDER-SENSITIVE assertions for every API that returns a collection.
2. Include HOSTILE-KEY assertions: "**proto**", "constructor", "prototype",
   and any key name your implementation uses internally.
3. Include BOUNDARY assertions from SPEC's termination/edge clauses.
4. Before finishing, re-read SPEC.md section by section and list any behavior
   you implemented that SPEC does not state — declare it in Open Items.
```

## 使用约定

- Orchestrator 在每轮 `setup` 阶段把模板条款并入该轮 SPEC.md；逐条检查
  "示例与文字规则一致"（AGENTS.md）后才允许调用 worker。
- reviewer/tester 任务的固定提示中保留"SPEC 未定义区 findings 标注为
  spec-silent，不升级为违规，除非违反 M1-M6 的显式条款"——避免把留白
  误判为缺陷，也避免留白被静默放过。
- 历史依据：R01（原型链泄漏）、R04（顺序违规）、R05（原型污染）、R10
  （哨兵键冲突）均可由 M1/M2/M4/M6 在 SPEC 源头拦截。
