# Workspace 保存一致性

当前公开 DataGrid 使用 Workspace；旧 controller、draft/rebase/replay 已删除。过去“保存后回旧数据”的根因与旧修复记录保存在 [历史审计](archive/persistence-consistency-legacy.md)。它们不再定义接入协议。

## 唯一写入链路

用户原文由 ingress、session 或 task 持有。准备器编译完整写集合，原子接纳后交给 journal；投影只能读取这些事实。保存冻结请求及精确 coverage，经过 durable 存储屏障后才允许发送。exact receipt 记录确切输出；完整权威达到所需 frontier 后，内核才原子结算 coverage 与提交贡献。

| 边界 | 当前实现 | 责任 |
| --- | --- | --- |
| Source | `src/kernel/source.ts` | `submit`、`lookupOperation`、`readAtLeast`；明确原子写、结果保留、身份与顺序保证 |
| Gateway | `src/kernel/gateway.ts` | scope 写入排他、同请求恢复、读取 frontier；冷启动恢复确切终态 |
| 请求与回执 | `src/kernel/persistence.ts`、`protocol.ts` | 冻结 coverage，校验完整回执、身份与 hash，区分写入结果和权威同步 |
| 事实转换 | `src/kernel/transition.ts`、`journal.ts` | 原子接纳；后继输入与无关行不被前一次 ack 清除 |
| 投影与历史 | `src/kernel/projection.ts`、`intent.ts`、`history.ts` | 只从 journal、精确事实和当前权威派生；条件撤销按真实执行分支解释 |
| Runtime | `src/kernel/workspace.ts`、`durable-commit.ts` | 顺序事件、存储屏障、恢复与 effect 执行 |
| React | `src/react/workspace-react.ts`、`workspace-data-grid.tsx` | 订阅完整快照，保留输入；卸载只分离视图 |

## 后端必须提供的证据

`PersistenceSource.capabilities` 是后端承诺，不是客户端自动补出的功能。后端必须原子验证并应用请求，保留按 OperationId 查询的确切结果，并在 scope epoch 中围住已拒绝请求，防止同 ID 后来执行。服务器 key 必须携带 incarnation，或保证 epoch 内不复用。

权威可使用 ordered 或 causal 证明；不能用响应到达时间、行值相等或另一个 opaque token 猜测先后。`readAtLeast(scope, frontier)` 返回完整 scope。未知结果保持原 OperationId 和逐字相同的冻结请求；404 或传输失败不能充当确定未执行的证据。具体类型与拒绝规则以设计第 8 节和 Source 契约为准。

## 三个必须分开的结果

- **结果未知**：保存请求仍被占用，只能查询或同 ID 重试；继续输入与 undo 仍需保留。
- **已写入、等待权威**：exact receipt 已存在，但完整读取尚未覆盖 frontier。保留 submitted 显示贡献，恢复读取，不重新发送已确认写入。
- **结算完成**：完整权威、身份绑定与该请求 coverage 原子接纳；未发送或受阻的意图继续存在。后继 write-base 使用真实 canonical 输出，semantic-read 不随规范化改写。

较新的合法外部更新仍可保留，不能为了防旧数据回退而一律用回执覆盖当前权威。动作级保存结果也不等于整个 Workspace 可以关闭；关闭另行校验 ticket 和全部 blockers。

## 验证入口与边界

`src/kernel/persistence.test.ts`、`gateway.test.ts`、`data-workflow.test.ts`、`history.test.ts` 验证保存、精确结算、后继输入和条件历史。`tests/kernel/source-fixture.ts` 模拟真正的服务器状态及请求结果，独立模型位于 `tests/kernel/`。

`tests/browser/persistence-consistency.spec.ts` 覆盖编辑、受控服务器写入、旧读/读失败/更晚外部更新、恢复及重开编辑器，同时断言提交次数。`tests/browser/review-regressions.spec.ts` 覆盖权限恢复、主键冲突显式替换与完整隐藏字段保存。三浏览器配置见 `playwright.config.ts`。

`pnpm test:mutations` 在隔离源码副本中注入十类语义错误，要求正常基线通过且每种错误触发具体测试失败。它补充回归敏感性证据，不证明任意后端正确。运行结果及仍待补齐的场景见 [测试审计](test-suite-audit.md) 和 [验收索引](state-kernel-acceptance.md)；本文不代表全部验收已完成。
