# 旧实现保存一致性审计（历史存档）

本文描述已删除的 controller/remote adapter；所有接口、路径和测试名称均是历史证据，不是当前接入要求。当前说明见 [保存一致性](../persistence-consistency.md)。

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

## 保存权限与整行冲突

保存计划是手动保存、自动保存和 immediate 后续提交的共同入口。每次生成新 proposal 时，
都用**最新权威行**检查已有行的 `isEditable` 和 `canDelete`；不使用本地修改后的行来决定权限，
也不缓存可能依赖宿主权限的回调结果。回调异常按拒绝处理。新行由 create/duplicate 工厂授权，
因此工厂提供的只读默认字段不会阻止正常新增。未知结果重试仍必须复用原始 proposal，不能
把可能已执行的操作拆成新请求；服务器必须原子检查版本及权限，并按 operation ID 幂等处理。

被阻止的行不进入 `acceptedRowKeys`、`deletedRowKeys` 或 `dirtyOriginals`，proposal.rows 中保留
其权威内容；其他行可以正常保存。界面显示受权限限制的行数，草稿及历史保留。恢复权限并发布/
刷新快照后可以继续保存；如有真实远端修改，还需处理对应冲突。

行级删除冲突和新增主键冲突使用完整行数据比较，不再使用展示列的值相等性。嵌套字段、日期、
二进制内容等未展示数据也参与判断；无法证明相等的 opaque 对象保守产生冲突。单元格级合并
仍使用 cell behavior 的值相等规则。服务器快照必须不可变；原地修改共享对象不能提供旧值证据。

新增主键冲突中的“保留本地行”表示对已有权威行的明确替换，使用独立的 `replacedRowKeys`，
不再复用 `insertedRowKeys`。只读列原始值不同时拒绝替换并保留本地输入；普通字段与整行替换
都必须满足当前权限。`changes.updated[].after` 是完整替换内容，不能只根据展示列的 `cells`
丢弃未展示字段。部分保存、其他新行的服务器主键、后续刷新及 undo/redo 都保留尚未确认的意图。

完整约束与迁移说明见 [草稿状态模型](../draft-state-model.md)。

`save-policy.test.ts` 覆盖权限恢复、回调异常、部分保存、删除冲突、整行冲突和历史；
`review-regressions.spec.ts` 在三个浏览器中验证权限反馈、保留本地冲突行、权威保存和重新打开。

## 剪贴板完整性与选区规模

剪贴板编码显式将单列空行写成 `""`，解码仅忽略没有内容的最后一个记录终止符，保留显式空记录。
因此表格自身复制可无损往返，外部 TSV 的末尾换行也不会凭空新增一行。引用、制表符、CRLF、
多个末尾空行与空目标覆盖均有回归测试，并验证粘贴后的撤销、重做、保存及重新打开。

选区展开和复制边界使用行列索引，边界只计算一次，不逐格扫描整个数据集，也不把整个选区展开
成函数实参。复制仍保留当前视图顺序、重叠选区去重及不连续选区的空隙，并按 UTF-8 字节限制
整体接受或拒绝。13 万单元格测试验证数据完整性及没有函数参数数量溢出；不使用易受环境影响的
固定毫秒阈值作为正确性测试。
