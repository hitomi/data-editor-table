# 保存一致性：链路审计与回归约束

2026-09-07。范围是写入、权威快照发布、保存回执、草稿重放、恢复、React 显示的完整链路。

## 为什么修过仍会出现

`2c5e766` 为防止保存回执覆盖更晚的外部更新，增加了 `authorityRevision` 判断。
它保护了一个合法时序，但把“请求期间收到一个新版本”当成“该版本包含本次写入”。
旧测试直接把外部数据命名为 `Externally newer`，没有让适配器获得这个因果事实。
`1f016c5` 修正了无效 publication 对 refresh 的干扰，没有改变这个假设。
`2811ca1` 拆分运行时、领域转移和 effect，也保留了原协议。

Controller 的结算规则同时把第三个 opaque token 视为已写入结果的后继。
因此适配器与 controller 各自符合当时的局部假设，组合后仍可能出现：

```text
权威 base → 本地编辑 Submitted → 发起 mutation
    → 旧查询返回 intermediate（尚未包含 mutation）
    → mutation 成功，返回 applied（值 Submitted）
    → adapter 不发布 applied
    → controller 先确认 applied，再把 intermediate 当成 latest rebase
    → 页面回到旧值，dirtyCells=[]，persistence=idle
```

若简单改成“保存回执总是覆盖外部 publication”，又会破坏真正的后续服务器更新。
仅凭两个不透明版本 token、数据内容或客户端到达时间，不可能区分这两个世界。
必须给协议增加因果依据，或进行包含本次写入的新读取。

历史计划还记录过一次性反例脚本，但这些脚本被删除，没有形成永久回归。
本次将跨层场景和浏览器流程保留在仓库，后续重构必须保持这些约束。

## 各层的职责

| 层 | 文件 | 约束 |
| --- | --- | --- |
| 服务器/宿主 | `mutate`、`load`、外部查询 | 原子应用 changes，幂等 operation ID；读取必须包含指定写入 |
| Remote adapter | `src/data/remote-data-source.ts` | 串行 mutation；管理 refresh/read 生命周期；确认后读取失败不得转成未知写入 |
| Effect runner | `src/controller/persistence-effects.ts` | 传递 receipt 或未知/明确失败；资源取消不能伪造提交结论 |
| 保存协调器 | `src/controller/persistence-coordinator.ts` | 验证回执和因果关系；冻结未知结果的 proposal；恢复时重新确认原 proposal |
| 状态机 | `src/controller/persistence-machine.ts` | applied-unreconciled 只能通过成功 acknowledgment 解锁 |
| 草稿协调 | `source-reconciliation.ts`、`replay-after-commit.ts` | 先确认已提交部分，再重放后续编辑、主键映射和历史，最后接受已证明的后继 |
| React | `src/react/controller-react.ts`、`data-grid.tsx` | 订阅一次完整状态；确认写入但读取失败时提供 Refresh，而非 Retry save |

## 当前协议

1. **版本仍然是不透明 token。** 不排序，不使用数值大小，不根据单元格值猜测服务器顺序。
2. **`afterOperationId` 是宿主的因果承诺。** 快照包含该操作或其后继；不是收到响应时随手添加的标签。
   自定义 data source 在 receipt 结算时提供第三个版本，必须携带匹配的 operation ID。
3. **顺序不明先读。** Remote adapter 收到无证明的不同版本时，在 mutation 确认后调用 `load`。
   有证明的后继保留；不能读取时保持失败/待恢复，不清空可恢复输入，不假称成功。
4. **外部读取在开始时登记。** `beginRead()` 捕获读取代次及 `afterOperationId`。
   跨过 mutation、被更新读取替代或被其他 publication 取代的结果返回 `false`，宿主应重新读取。
   写入后直接发布不同版本必须提供因果承诺，否则抛错且不改变 store。
5. **确认写入与确认读取分开。** mutation 成功后的 reload/校验错误返回 `reconciliationError`。
   有合法 applied snapshot 时保留；没有时返回 `applied: null`。这不是未知写入结果。
6. **恢复保留原始证据。** 重新读取 ready authority 后，再验证原 operation ID、keyRemap，
   重放原 proposal 与后续编辑，然后解锁。status-only publication 不得释放保护。
   原回执的错误 operation ID/非法 keyRemap 不能被刷新绕过。
7. **兼容回执先到。** Store 尚在 request base 时可以使用合法 applied；在 store 追上之前，
   忽略旧 base 的状态通知，不把它重新解释成新的权威内容。
8. **未知结果才重试写入。** Promise reject 的未知/transient outcome 仍复用原 proposal 和 operation ID。
   两次尝试之间的外部更新同样需要协调，不能用幂等 API 返回的旧回执覆盖后继。

`load` / 外部查询仍必须提供 read-after-write consistency。对已知 request base 可以明确拒绝，
但库无法识别服务器返回的任意未知旧 token。若使用副本或缓存，需要宿主等待指定 operation 可见、
绕过旧缓存，或从 operation-aware API 获取结果。`beginRead` 防止客户端请求跨写入，不能替代服务器端的一致性保证。

## 接入迁移

- 已使用 adapter `load` 的接入无需自行管理读取代次，但要遵守 `operationId` 的读取约束。
- 直接把 query/cache 回调传给 `publish` 的接入，改为在请求开始时 `beginRead()`，
  并将同一个读取对象带到结果处理；不能在结果回调里才生成凭据。无法保留请求上下文时使用 `load`。
- 可信推送在能够证明包含指定 operation 时使用 `afterOperationId`；不能证明则重新读取。
- 自定义 `commit` 在第三版本上补充因果证明；已确认写入后读取失败要返回确认回执，不能抛成未知结果。
- 消费 `GridCommitReceipt` 的代码要处理 `applied: null` / `reconciliationError`，不能把 receipt 到达等同于完整协调成功。

## 永久回归

`src/controller/persistence-consistency.test.ts` 通过公开 adapter/controller API 验证：

- 回执先到、publication 先到，以及旧 base 的 status-only 通知；
- 原生 data source 的第三版本有证明/无证明两个分支；
- manual / auto / immediate 三种模式下中间旧快照不得回退已确认值；
- 真正后续服务器更新仍被保留，包括主动恢复原值的合法服务器编辑；
- 无 loader 的歧义保存保留 draft，拒绝 Save/Retry，权威证明到达后恢复；
- 写入前和写入期间开始的外部读取晚到时被拒绝，写入后新读取仍能推进数据；
- 已确认写入之后读取失败、返回无效 rows 或解析响应元数据异常，不再发送 mutation；
- 保存后刷新返回已知的写入前 base 时拒绝回退，允许再次刷新恢复；
- 恢复时保留后续编辑、服务器主键、删除和排序、selection、undo/redo；
- 未知写入结果重试保持同一 request 身份，并保留两次尝试之间的后续服务器更新；
- 错误回执不能被仅改变状态的 publication 解锁。

`tests/browser/persistence-consistency.spec.ts` 使用可控服务器 fixture，在 Chromium、Firefox、WebKit
验证编辑 → 保存 → 中间/后继 publication → 读取失败及 Refresh → 晚到缓存 → 重新打开编辑器。
同时检查 mutation 次数，防止只看最终文本而漏掉重复写入。

现有 `remote-data-source.test.ts` 继续保护刷新乱序/取消、提交队列、主键映射、未知结果幂等重试。
“外部更新更晚”的旧测试保留这个行为断言，并补充对应因果证明，而不是改成一律用保存结果覆盖它。
