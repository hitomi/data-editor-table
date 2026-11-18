# 保存一致性与数据协议迁移

本文件描述当前持久化与同步实现。宿主提供版本、完整快照和操作回执；库负责协调读取、发布和本地草稿结算。

## 三个决定各由谁负责

1. **操作影响谁**。每张表从当前投影取实体身份。选择、编辑会话、菜单和异步任务保存发起时的目标。执行时按实体身份解析，编辑器回调还要核对会话。远端重排行只改变目标的位置，同键替换行有新的身份。
2. **哪些服务器事实可以同时成立**。物理作用域的 `ScopeVersionEvidence` 接纳版本证据。种子、推送、读取响应和精确回执使用同一份因果关系。每次接纳先验证再提交，`ScopeAuthority` 将可展示的完整快照发给所有订阅表。
3. **现在能否保存、恢复或关闭**。每张表的内核记录待保存工作、冻结请求和结算事实，共享网关持有实际写入许可。各入口从 `selectGridActions(snapshot, target?)` 取得当前目标、拒绝原因、保存、重试及恢复动作。退出时 Controller 另用 `getCloseState()` 核对剩余工作。

现在由一个 Runtime 持有 authority、实体身份、不可变 journal、提交覆盖和贡献式历史。旧 React、选择、编辑、批量和行事务入口继续使用；data backend 不持有第二份可写 rows，也没有第二个 Workspace。

| 边界 | 实现 | 责任 |
| --- | --- | --- |
| 写入准备 | `src/data/kernel-authoring.ts` | 编码原始输入，隔离执行 setter，固定目标和完整读写集合，原子接纳 |
| 内核调用 | `src/controller/data-backend.ts` | 同步 prepare/apply/authority/receipt/history/resolution，不执行 I/O |
| 数据事实 | `src/kernel/*` | 权威顺序、实体生命周期、精确覆盖、冲突和历史控制 |
| 状态发布 | `src/controller/controller-runtime.ts` | 同批发布内部事实、只读展示、会话和能力，再执行 effects |
| 版本证明与分发 | `src/kernel/version-evidence.ts`、`src/kernel/scope-authority.ts` | 按物理源、scope、epoch 校验版本与实体生命周期，向订阅者有序分发完整快照 |
| 宿主接入 | `src/data/grid-authority-sync.ts` | 提供行解码与主键校验，连接推送，持有重开所用的快照 |
| 保存执行 | `src/controller/kernel-persistence-effects.ts`、`src/kernel/gateway.ts` | 共享作用域写入许可、摘要、请求、查询和读取；未知操作保留许可 |
| 目标解析 | `src/data/operation-targets.ts` | 在当前投影中核对实体身份及操作依赖，供会话、选择与异步任务使用 |
| 保存动作 | `src/controller/controller-persistence.ts` | 从内核提交、调度和所属操作的反馈推导错误、恢复动作与重试能力 |
| 展示 | `kernel-projection.ts`、`kernel-read-model.ts` | 派生行、dirty、冲突、原值、保存能力和贡献式历史；不反向生成意图 |

保存 A 后继续编辑 B，A 的回执只结算 A 的 `coverage`。B 仍是独立操作。撤销作用于具体 application，未发送贡献可被抑制，已提交贡献通过补偿撤销；未知提交仍保留原请求，直到证据明确。刷新和晚到回执不能将已接受的新 authority 回退。

共享 gateway 的最新 frontier 是下一次读取/取得写入许可的要求，不能成为已结算操作不断变化的释放条件。其他工作区读取可能在当前 read 验证与 Runtime 发布之间推进共享版本；当前操作只需以已接受工作区证据、原 baseAuthority 和确切 committedVersion 验证自己的屏障与覆盖，再释放许可。后续写入仍必须读取覆盖共享 frontier 的完整 authority。Controller 的关闭检查同时读取实际 gateway reservation，不能仅凭内核 idle 推断没有未释放许可。

## 一份快照如何到达表格

1. 每个物理源的 `(sourceId, scope.id, scope.epoch)` 对应一个 `ScopeAuthority`。初始快照、宿主推送和读取响应都由它接纳。它先检查范围、行与主键、完整顺序、版本内容摘要及当前精确回执。每个完整因果快照都要检查其前驱证明的行身份生命周期，包括尚不能展示的分支。接纳失败时，已有快照和版本证据保持在上一次成功状态，因此服务端可以在同一版本返回修正后的内容。
2. 每张表通过 `dataSource.subscribe` 接收行。订阅同步重放当前可展示快照及仍需覆盖的版本，后续按接纳顺序通知所有表，包括发起读取的表和通过其他适配器打开的表。每个适配器在首个订阅时连接宿主推送，最后一次退订时断开。嵌套推送会排队，单个订阅者抛错不会中断其他订阅者。
3. 读取响应用请求发出时的 frontier 校验。响应满足原请求且与途中收到的推送并发时，两者都进入作用域的待合并版本，共用下一次覆盖读取。请求票据只结算那次刷新或保存的等待者。`dataSource.readAtLeast` 在分发后返回接纳的版本。旧票据已经返回 `superseded`，其迟到响应仍可能携带更新的有效快照。每张表收到快照后，在自己的内核中绑定实体、保留草稿和未确认的创建。
4. 同时遇到互不覆盖的版本时，表格继续展示最后可用行，作用域保留全部待覆盖版本。多张表对同一组合并要求共用一次读取。读取失败后，重新订阅或重放任一待合并分支都能重试。因果覆盖关系按传递性计算。若 O 含有某个 incarnation，B 覆盖 O 且已删除该行，覆盖 B 的合并快照只能以新 incarnation 恢复该行。无共同创建证据的并发分支可分别包含和缺少该行。迟到的内容或覆盖关系还须与已知后继一致。在 A → B → C 后重放 A，仍然显示 C。
5. 适配器和活动订阅持有完整行。为校验很晚才到的快照或回执，物理作用域保留已见版本的行身份、文档 SHA-256、顺序摘要、观察标识和因果关系。证据占用随观察到的版本和行数增长，当前由进程生命周期管理。完整行被回收后，重新打开需要向宿主读取。只有原操作的精确回执和覆盖提交的完整快照都到达后，才能结算本地贡献并释放写入许可。

运行 `pnpm test` 可核对数据源同步、保存恢复及网关回收；`pnpm run prepublishOnly` 还会运行三个浏览器和实际打包消费者。

## 宿主协议

`createRemoteGridDataSource` 接收 `source`、`scope`、`model`、`columns`、`getRowKey`、`persistence`，可选 `initialAuthority`、推送订阅和行能力。公开 `GridDataSource` 指向新契约。

业务接入工厂与 GridDataSource 类型保留在主入口及 engine；PersistenceSource、ServerAuthority、FrozenSubmission、ExactReceipt、OperationLookup、身份/版本类型和 hash/编码工具从 `data-editor-table/protocol` 导入。主入口不再通配暴露内核模型。保存使用 await controller.save()，未知操作使用选择器给出的 recoverSave.target 调用 controller.recoverSave，先检查 enabled 及 target，读取使用 await controller.refresh()；旧同步 persistence/save、persistence/retry、source/refresh 不再接纳。恢复描述只保留 recovery 对象，不再重复暴露 retryOperationId/recoveryAction。

`PersistenceSource` 的能力必须由真实后端提供：

- 相同物理数据源使用相同 ID；scope 和 epoch 固定权限与身份域。
- 完整 authority 提供服务器有序版本或因果版本、唯一 observation、每行的业务 key 与 incarnation，以及完整顺序。
- 若服务器保证 epoch 内不复用业务 key，可声明 `no-key-reuse-in-epoch`；否则每个生命周期必须有 incarnation。
- 保存请求携带固定 operation ID、payload hash、base authority、明确 items、coverage 和 frontier。一个 scope 内的 items 原子提交。
- 后端保存请求身份和精确结果，重复 ID/hash 返回原结果，不执行第二次写入。哈希不匹配必须拒绝。
- `readAtLeast` 返回覆盖 frontier 的完整真实数据；不能把旧缓存补上较新版本标签。
- operation lookup 的不存在不是天然的未执行证明。返回 `not-applied` 前必须阻止同 ID 的迟到写入随后执行。
- `operationRetentionMs` 是后端承诺的结果保留期限；`restoreDeleted` 只在后端能验证删除证明、恢复完整文档并分配新 incarnation 时开启。

`demo/src/demo-source.ts` 使用一笔 IndexedDB readwrite 事务原子保存完整行、版本和 operation outcome。它是 demo 自己的真实 authority，不能被复制为远端 HTTP 接口的保证声明。

## 保存结果和恢复

| 返回值 | 含义和处理 |
| --- | --- |
| `{ kind: 'applied', receipt }` | 精确回执。包含 scope、operationId、payloadHash、committedVersion 和逐 item 的 canonical 结果。必要时读取覆盖该版本的 authority 后结算 |
| `{ kind: 'applied-without-receipt', commitToken }` | 已确认写入，缺精确回执。保留 token 和固定请求，通过 lookup 获取原结果 |
| `{ kind: 'unknown', issue }` / `{ kind: 'pending' }` | 结果不明或仍在执行。保留原 operation、覆盖和写入许可；重试仍是原请求 |
| `{ kind: 'not-applied', proof }` | 后端确认且永久封住该请求未执行。保留本地操作，允许重读后准备新提交 |

精确回执中的每一份 canonical 文档按完整快照相同的 codec 和主键规则验收，失败不写入版本历史。回执推进 frontier 时，作用域立即向现有订阅者分发读取要求，也向新订阅者重放。作者补读失败时，其他表仍可从各自的连接取得覆盖快照。在 A 上提交、回执 C 只列出直接前驱 B 时，作用域可以用已接纳的 B 覆盖 A 证明 C 覆盖 A。如果证明晚到，网关保留回执并在作用域接纳新证据后重新核验原操作。有序版本同样检查迟到的完整快照。若 v1 和 v3 都含同一行实例，v2 声称该实例缺失会被拒绝，同一 v2 可携带修正后的内容再送达。

Promise rejection 属于未知结果，不能默认转换为 not-applied。HTTP 200、当前值等于期望值、或者 latest rows 都不能代替精确回执。确认写入但读取失败时显示恢复入口，不能再准备一个新写入。

### 处理相互矛盾的证据

已发送的查询以原冻结请求为目标跟到结束，释放许可或关闭原表后仍校验迟到结果。另一笔操作已发出时，它的返回继续按自己的身份结算。发现争议后，所有表在开始新写入前被拦截；等待中的草稿和编辑原文保留。

宿主监听 `remote.subscribeDisputes(listener)`，按 `remote.getDispute(id)` 取得原操作引用与证据，从权威账本核验后调用 `remote.resolveDispute(id, result)`。结果须为匹配 scope、操作 ID 和摘要的精确回执或有围栏的未执行证明。新增矛盾证据会更新争议 ID。处理一项后，其他未决争议继续封写。若核验结论推翻已接纳终局，须由宿主在新 epoch 中重建权威历史并核对本地工作。刷新和重开表会看到同一作用域的争议，本版的本地追踪随进程结束。

## 列、输入与恢复操作

`column.field('name', …)` 的普通写入比较实际存储路径，另一张表写 `count` 可以同时成立。显式 `planEdit` 比较所写路径，并用 `context.read(path)` 记录计算所依赖的值。列级 `validate(value)` 保留字段依赖，`validateWithRow(value, row)` 声明整行依赖。同时配置时，后者收到前者校验后的值。自定义 setter、依赖行的列准入条件以及读取行的单元格类型校验也记录整行依赖。粘贴、编辑器、直接命令与事务都在写入准备时生成这些证据，之后的刷新和保存复用它们。

编辑器和剪贴板解析器产出具体输入值。若某项业务计算依赖其他存储字段，且保存时必须核对那些字段，应在 `planEdit` 中读取它们。

`editable(row)` / `isEditable(row)` 是每条新编辑命令的准入条件，使用包含先前本地修改的行判断，并将该行上下文记录为依赖。因此可以先解锁、再编辑、一起保存；之后重新锁定会拒绝新的编辑，但不会追溯撤销此前合法接纳的操作。永久存储只读限制由文档模型的 `fields[].readonly` 表达，来源仍需独立校验服务器权限，不能用旧 authority 上的列编辑条件代替这些限制。

整行还原记录明确贡献处置并保留可撤销记录，批量还原在同一次发布中全部接纳或全部拒绝。请求已冻结的贡献不能被还原操作悄悄删除。行顺序冲突提供使用已保存顺序或保留本地顺序的决定。创建主键碰撞与服务端删除属于身份决策，不能按行号重绑定。

`canDelete(row)` 同样按当前本地行检查新删除命令；删除冲突的重新确认，以及历史操作产生的新物理删除，也要检查当前条件。它不是服务器权限证明：如果来源要求先持久化解锁，必须先保存再删除；来源拒绝时保留删除意图供恢复。

事务目标和顺序来自内核的有效成员，不能从包含待删除冲突行的展示 rows 重建。普通新增、复制、删除通过事务 builder 表达明确操作；只有实际指定插入位置或移动后改变了自然顺序，才生成完整排序命令。因此删除冲突不会阻塞其他行的内容事务或追加创建；涉及全表顺序的操作仍受结构依赖约束。

Editor/BulkEditor 原文、composition、session ID 和固定实体目标由原 Controller 会话持有。图片 effect 的文件保留在其执行资源中，完成事件把原输入和未应用结果交回 Runtime。取消只撤销应用权限；任务未结束前仍算 pending work。

过期/失败 cell 结果可以在原菜单或页脚中应用、重试或明确丢弃；页脚在空表和筛选无匹配行时仍提供入口。页脚应用绑定原实体，原实体消失时拒绝应用并保留材料；替换目标必须通过单元格菜单明确选择。处理结果后同步移除对应任务的错误提示。宿主可以用 `effect/inspect-result` 读取保留材料；宿主单格任务交付 value，多格任务按发起时声明的 write 顺序交付 values；`effect/apply-host-result` 复核原读写集合后整体应用。失败宿主写入必须由宿主查询其实际结果，不自动重发。

React detach 不销毁未处理工作。同一个 data-source 对象重新挂载时复用保留的 binding，组件自动接入和 hook 共用保留缓存；显式 binding 由宿主保持可达和最终销毁。三种 React 接入方式切换目标时都等待旧工作处理完成，期间继续显示旧实例。`getCloseState()` 返回类型化阻塞原因；`destroy()` 再次检查并返回接纳/拒绝结果，有未保存输入、运行中任务、保留结果或未结算提交时拒绝销毁。详见[生命周期与接口方案](lifecycle-api-design.md)。

每个 binding 独立持有宿主 effect 回调，切换 data-source 不会改写旧 binding 的回调；同一 data-source 的回调更新在 React 提交后生效。远端订阅初始化失败会撤销本次注册，允许重新连接；取消订阅幂等，已断开或初始化失败的推送不再发布数据。每次发布固定通知接收者集合，单个订阅者异常不阻断其他接收者。

跨表仍是两个独立数据域。复制和剪切分别准备两侧动作；补偿必须携带目标插入的 `applicationId`。如果那些行已经有后续修改，补偿拒绝并提示复核两侧，不能用普通 undo 撤销其他工作。本协议不声称跨 scope 的服务器原子事务。

## 从旧接口迁移

- 移除 `initialSnapshot/load/persistence.mutate/commit`、`beginRead`、`afterOperationId` 和 `GridCommitError` 约定，改用上述服务器证据协议。
- 原本直接实现 data source 的宿主也需提供 `GridDocumentModel` 和 `PersistenceSource`；不能仅升级 React props。
- 快照的 `draft.undoStack/redoStack` 现在只有 application 身份、标签和版本，不再包含 before/after rows。
- `selectGridActions(snapshot).recoverSave` 给出此刻可执行的恢复动作及其目标。畸形回执先执行 review，再读取新的描述并由用户明确 confirm 或 refresh。已接纳的事实相互矛盾时保留操作并停止自动恢复。已证实未写入或准备失败时，使用 `retrySave.enabled` 展示重新保存。撤销并开始新工作后，旧失败信息不影响新一轮自动保存。
- 同步 dispatch/transaction 的 accepted 仅表示本地接纳。远端结果使用 `await controller.save()` 或 `recoverSave()`，检查 confirmed/partial/recovery-required 等结果与 remaining。结果归属于实际冻结请求，不能从全局 idle 推测；普通刷新使用 `await controller.refresh()`。
- 这次集成不启用备份 Workspace、durable ingress、checkpoint 或崩溃恢复。硬刷新/进程终止会丢失尚未保存的内存工作；demo 只持久保存确认后的 authority 和 operation outcomes。
