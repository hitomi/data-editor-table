> 历史文档：描述 0.3.x 或更早的实现与设计，不是 0.4.0 API 契约。当前接入见 [文档索引](../README.md) 和 [迁移指南](../workspace-migration.md)。正文的“当前”与完成状态均指当时。

# GridController 模块化状态机重构

状态：已完成。2026-09-06 建立、实施并完成验收。

## 目标与范围

将 Controller 的共享闭包、分散发布和异步回调编排改为单一 Runtime、明确的领域转移、跨域 workflow 和有类型的 Effect/Event。保持现有公开 `GridController`、`GridIntent`、同步 dispatch 结果、React-free engine 及用户工作流。当前工作区已有的数据正确性、primitive rows、owned source 切换和包消费改动作为基线保留。

完成后，每个输入的状态变化都能解释其数据来源、校验、发布边界及失败恢复；领域模块能独立测试，外部 callback 和 I/O 有明确的执行边界。文件行数不作为完成标准。

本次不建立第二个 viewport store，不破坏公开 API，不迁移整个 React 目录，不改写完整 locale/feedback 协议，不引入 Redux/XState、event sourcing 或新依赖。几何仍是 React-free 计算，layout/feedback 保留在一致 snapshot 中。未来是否拆分这些状态需要独立设计组合读取协议。

## 架构与依赖

```text
public facade: dispatch / applyTransaction / subscribe / destroy
                            |
                    controller runtime
       prepare -> workflow -> candidate -> commit -> notify
                      |                       |
                domain transitions       effect outbox
                      |                       |
                 data algorithms          I/O runner
                                              |
                                    typed internal event
                                              |
                                      controller runtime
```

实际模块职责如下；不为目录对称而建立空抽象：

- `grid-controller.ts`：编译配置、初始状态、端口和公开 API 装配。
- `controller-runtime.ts`：唯一已提交 snapshot、同步执行、重入拒绝、内部事件队列、通知、outbox 和销毁。
- `controller-state.ts`：初始 snapshot 和配置校验；静态 columns/capability 与运行状态分离。
- `controller-workflow.ts`：跨域协调及命令路由。领域转移返回结果，不持有可修改整个 Controller 的 service locator。
- `editing-transitions.ts`、`bulk-transitions.ts`、`filter-transitions.ts`：各自 session 与完整候选计划；`session-policy.ts` 决定会话退出与写入归属。
- `interaction-transitions.ts`：保留已有 selection、pointer、navigation 纯算法。
- `view-transitions.ts`：query、派生 view、layout 及 selection reconciliation。
- `transaction-builder.ts`：同步公开 DSL 的受控执行和 staged row order，返回本地 transaction plan。
- `draft-commands.ts`：普通写入、历史、恢复和冲突的各自协议。
- `source-reconciliation.ts`：authority 验证、rebase、commit replay、key remap 及 session 恢复。
- `persistence-machine.ts`：持久化状态与命令/事件转移。
- `controller-effects.ts`、`persistence-effects.ts`：Promise、timer、AbortController 与资源销毁；source 订阅由 facade 管理。
- `effect-coordinator.ts`：effect 语义归属的 copy-on-write 工作状态；`persistence-coordinator.ts`：保存/刷新/回执 workflow，不执行 I/O。二者每个输入从 Runtime 恢复、返回候选，无独立提交权。
- `controller-protocol.ts`：内部状态及 Effect/Event 协议。
- `model/range-geometry.ts`：data、controller 和 React 共用的范围算法，消除 data 对 controller 的反向依赖。

`controller` 可以依赖 `data/model/layout` 的纯算法；领域计算不依赖 runtime、React 或 DOM。共享 range/identity 计算应位于下层，避免 data planner 反向依赖 Controller workflow。Public exports 不意外公开新内部模块。

## Runtime 执行协议

1. 公共 `dispatch` 和 `applyTransaction` 同步返回最终结果及本次已提交 revision。处理中/通知中的同步重入明确拒绝；不能把排队当作执行成功。内部事件允许入队，当前执行和通知结束后按顺序处理。
2. 对当前已提交状态准备候选状态。workflow 的内部步骤可组合多个领域结果，但外部 `getSnapshot()` 始终返回已提交 snapshot，callback 看不到半完成状态。
3. 所有会失败的校验、view/layout 派生、row identity 及 session reconciliation 在提交之前完成。不能在公开读取 snapshot 时再执行有失败风险的领域工作。
4. 一次逻辑输入最多发布一次完整 snapshot。无状态变化不增加 revision/通知；只启动 effect 的命令也可以保持 snapshot identity。内部领域 revision 根据语义变化维护，不等于顶层发布次数。
5. rejected command 可以更新 error/session，但不发布部分数据写入。`edit/commit-and-move` 保留“提交成功但无法移动”的成功结果。自动提交后目标操作不可用等组合语义逐项记录测试，不笼统回滚已确认的有效编辑。
6. outbox 与候选状态绑定；候选失败不能执行其 effect。提交后先完成一致状态通知，再运行 effect；执行前检查 destroy/cancel/owner。通知异常隔离，不回滚已提交状态，也不阻断其他 subscriber。
7. destroy 幂等且立即生效：取消可取消资源，丢弃待执行 effect/event，不允许后续发布。已经发出的远端写入不能被描述成已撤销。
8. 创建时处理 subscribe 期间同步通知及订阅前后 snapshot 改变。初始化失败释放已创建资源。内部事件错误必须有可观察的恢复状态。

## 领域状态与跨域 workflow

Controller 仍是 source、draft、view/query、interaction、edit/bulk/filter、persistence、feedback 和 layout 的唯一语义 owner。领域模块不能独立通知 subscriber。

本地写入的顺序为：session policy/成本预检 -> 受控能力调用 -> draft 转移 -> view 派生 -> selection/session 协调 -> 保存状态规划 -> 完整 snapshot 提交。提交前完成派生，避免新 rows 与旧 visibleRowKeys 同时可见。

`visibleRowKeys` 是已提交的派生读模型：由 draft/query/columns 决定，供命令和 UI 使用。保留引用稳定性和域 revision，按依赖失效缓存。row/column index 与 selector cache 不拥有业务真相。动态 permission callback 必须显式重新评估，不能按 rows identity 永久缓存。

会话策略区分：允许执行、需要先提交 edit、需要明确 Apply/Cancel、原 session 已失效。实际提交由 workflow 执行；policy 只给出决策，不调用 dispatch、publish 或 effect。edit/bulk/filter 的互斥规则及 cell effect 的 session ownership 由测试固定。

## Draft 的多个转移协议

单一 Draft 领域管理以下操作，不强制共用 CRUD operation：

| 转移 | 含义 | History |
| --- | --- | --- |
| applyLocalTransaction | edit/paste/fill/bulk/rows/公开 transaction | 非空本地事务至多新增一条，清 redo |
| restoreHistory | undo/redo 恢复历史内容 | 移动栈，不创建普通编辑历史 |
| resolveConflict / restoreOriginal | 恢复值/结构或只改变 conflict | 按恢复语义记录可撤销变化 |
| rebaseAuthority | 新 authority 与本地意图合并 | 协调 baseline/conflict/history |
| acknowledgeCommit | 确认 proposal、重放在途编辑、key remap | 保留未提交意图和有效历史 |

普通本地事务共享 validation、clone、row identity、permission、mutation limit 与 dirty 算法。恢复及 authority 转移不能强行走普通 setter/新增 history 路径。冲突解除即便 cell 值不变，也必须正确更新 conflict 和 undo。staged placement 始终按 draft row order，不能按过滤/排序后的 index 解释。

## Callback 与纯度边界

将 callback 放入 Environment 不代表它是纯函数。确定性领域算法接收显式输入；计时由 runner 执行，ID 由 persistence workflow 在构建新 proposal 时产生，不进入纯状态机；未知结果重试复用原 ID。row factory、公开 transaction builder、动态权限等在受控准备阶段执行，builder 每次调用只执行一次，不做自动重放。

保留 safe-callback、clone、输入保护、异常转换、同步性检查、重入拒绝及 base 检查。成本预检在昂贵的 callback/setter 前执行。纯行为回调约定同步、不修改原输入、无 controller 重入；外部权限发生变化需可观察的失效边界。不能以纯 reducer 测试替代 callback/Promise/订阅的集成测试。

## Persistence 与异步协议

operation 使用互斥的 idle、committing、outcome-unknown、rejected、applied-unreconciled；scheduled 是独立的 schedule token，不与在途 operation 混用。公开 snapshot 可以继续投影为现有 idle/scheduled/saving/failed。

- committing 保存完整不可变 proposal/request、operation ID 和提交时 draft/source 信息。后续编辑保留为待处理工作，不能改写已发送的 proposal。
- outcome-unknown 重试原 request 与 operation ID；不能为同一写入生成新的 ID 或用最新 draft 替换旧 request。
- rejected 明确未应用或版本冲突：刷新/协调后才能形成新 proposal。
- applied-unreconciled 表示写入已被确认，但本地 receipt 校验/replay/rebase 未完成。禁止再次提交该 operation，保留恢复信息，通过 authority refresh/reconciliation 恢复。
- 收到匹配 commit 回执后，即使当前 draft revision 已改变，仍确认 proposal 并重放后续编辑。authority version 是 opaque token，不能比较大小；保留 request-base/applied/因果后继的已有协议。
- source publication 与 commit receipt 的先后顺序、提交期间 authority 的暂存/协调、status-only publication、失败后的刷新与后续保存均有集成测试。

保存协议后续增加了显式 `afterOperationId` 因果证明、外部读取代次，以及确认写入后的读取失败回执。
`applied-unreconciled` 不能被普通 authority publication 清空；必须成功验证并重放保留回执后 acknowledgment。
完整链路与永久回归矩阵见 [保存一致性审计](../persistence-consistency.md) 及 `persistence-consistency.test.ts`。

| effect | 有效性依据 | 取消/过期 |
| --- | --- | --- |
| commit | operation ID + 原 proposal + 数据源实例 | draft revision 变化不作废；destroy 后不发布本地结果，不宣称撤销远端写入 |
| cell effect | cell revision + 所属 session + source owner | 编辑/目标变化后忽略旧结果，取消可取消资源 |
| refresh | refresh request identity + publication 因果协议 | 新请求替换旧请求，仍遵守 authority 顺序 |
| timer | schedule token | 调度失效时不触发保存 |
| external effect | 配置的 owner/concurrency | completion 经内部事件检查后执行返回的公开命令 |

Effect runner 只执行 I/O 并回传 typed event；machine 决定结果是否可应用。异步失败和恢复信息在 headless snapshot 仍可观察，保留现有错误消息与 UI 呈现。

## 实施顺序与验证门槛

### A. 协议和基线

- [x] 建立本方案，纳入 review 的六项修正。
- [x] 记录已有 check/test/lint 基线：28 个测试通过，typecheck/lint 通过。
- [x] 固化同步通知、reentrant callback、校验失败保留输入、commit-and-move、保存在途编辑的行为矩阵。

### B. Runtime 与完整编辑流程

- [x] 建立唯一 snapshot 提交点、busy/destroyed 协议、内部事件队列及 outbox；异步协调器的临时桥接已移除。
- [x] edit -> draft -> view -> selection/session -> persistence 的同步候选状态整合。
- [x] 测试一次通知、公开读取稳定、rejected error 更新、no-op、subscriber 异常/重入、destroy、准备异常及 callback 发布 authority。
- [x] 通过现有 React/browser 流程，验证 owned source 订阅可安全退出。

### C. 领域与 workflow

- [x] 抽离配置/初始 state、interaction/edit/view/session policy。
- [x] 抽离 transaction builder，统一普通本地 transaction，保留 history/recovery/reconciliation 的不同转移。
- [x] 抽离 source reconciliation，保留原始值无效、primitive rows、key remap 与 queued history。
- [x] feature 输入限定为所需状态/能力，跨域更新集中在 workflow。

### D. Persistence 与 effect/event

- [x] 用显式状态替代协调器隐含 flags，完整建模未知结果与已应用但未协调。
- [x] effect 描述/outbox、typed completion、clock/token、runner 资源销毁。
- [x] 保存期间继续编辑、receipt/publication 顺序、失败/重试/refresh、auto/manual/immediate、stale cell effect、destroy 集成测试。

### E. 最终验证与交付

- [x] 审查完整 diff，保留用户已有改动，移除迁移桥接/重复逻辑和未使用导出。
- [x] 加强运行时/领域 import boundary，验证 engine 不带 React。
- [x] `pnpm check`、`pnpm test`、`pnpm lint`。
- [x] `pnpm demo:build`、`pnpm test:browser`（仓库配置的三个浏览器）。
- [x] `pnpm check:package`，验证 declaration、typed consumer、headless bundle 和 CSS 资产。
- [x] 更新本文件记录完成状态、实际模块布局和验证证据。未通过或未执行的检查明确列出。

## 验收证据

最终检查于 2026-09-06 在当前工作区执行：

| 验收项 | 结果 |
| --- | --- |
| `pnpm check` | 通过；源码边界检查（含 9 个检查器自测）及 engine/demo typecheck |
| `pnpm test` | 13 个测试文件、102 个测试通过；基线为 28 个 |
| `pnpm lint` | 通过，无 warning |
| `pnpm demo:build` | 通过 |
| `pnpm test:browser` | 21 个通过，Chromium / Firefox / WebKit 各 7 个 |
| `pnpm check:package` | 通过；独立 headless runtime/declaration 图、类型消费者、CSS 资产、三个浏览器的 StrictMode/remote/locale 消费 |
| `git diff --check` | 通过 |

行为矩阵与测试位置：

| 协议 / 用户行为 | 主要证据 |
| --- | --- |
| 候选不可见、一次通知、no-op、错误反馈、重入、异常隔离、destroy、internal-only 提交 | `controller-runtime.test.ts` |
| edit → draft → filtered view → session → 保存状态原子发布；无效输入保留；commit-and-move | `controller-workflow.test.ts` |
| callback 发布 authority 延后到当前命令之后；原命令 revision 不被后续事件替换 | `controller-workflow.test.ts` |
| builder 一次执行、上下文关闭、异步/异常回滚、成本预检、transaction 错误协议 | `controller-workflow.test.ts` |
| 准备失败丢弃 persistence/effect 候选及 outbox，不 abort 先前有效请求 | `controller-workflow.test.ts` |
| manual/auto/immediate、连续编辑合并、auto → manual 取消、manual → immediate 保存 | `controller-workflow.test.ts` |
| authority rebase、receipt replay、primitive rows、key remap、编辑输入恢复 | `source-reconciliation.test.ts`、`remote-data-source.test.ts` |
| 未知结果 Save/Retry 复用 proposal；已应用但未协调禁止重发；乱序 publication/receipt | `persistence-machine.test.ts`、`remote-data-source.test.ts` |
| timer/refresh 替换、取消、迟到结果、destroy | `persistence-effects.test.ts` |
| cell effect 替换与一次提交、external 返回命令顺序、错误可观察且 effect ID 可复用 | `controller-workflow.test.ts` |
| 会话 owner、edit/filter/bulk 候选、query 校验、不同 Draft/history/recovery 语义 | `session-policy.test.ts`、`editing-transitions.test.ts`、`bulk-transitions.test.ts`、`view-transitions.test.ts`、`draft-commands.test.ts` |
| 用户编辑、校验、键盘选择/对话框、背景保存菜单焦点、owned source 切换 | `tests/browser/standard-registry.spec.ts`、`tests/browser/owned-source-switch.spec.ts` |

## 最终审查与边界

- 保留开始任务时已有的 primitive rows、remote authority、owned source 切换、locale、菜单焦点和 package consumer 改动；未恢复或覆盖用户工作。
- 公开 Controller/contracts 与 package exports 不新增内部架构 API。dispatch/applyTransaction 仍同步返回真实结果，transaction 准备异常保留 `transaction-exception`。
- 已移除通用 snapshot patch 桥接、workflow 内 Promise 执行、准备阶段 AbortController 取消和任意函数式发布入口。公开 snapshot 与 internal 控制状态由同一个 Runtime 原子提交。
- `controller-workflow.ts` 仍是较大的协调模块：保留 row/clipboard/conflict/session 的跨域顺序。此次不为缩短文件继续拆出共享整个闭包的 helper；它不拥有已提交状态、订阅或 I/O 资源。
- 检查器针对仓库现有 import/export 语法，并非通用 TypeScript parser；headless 传递依赖由真实打包图另行验证。
- 三浏览器测试验证仓库现有用户流程，不代表所有业务方 callback 或远端服务实现。callback 仍须遵守现有同步/输入保护契约；未开展独立性能基准，不作性能提升承诺。
- 本次没有提交、推送或发布包。多 Store、破坏性 API 变更和全局错误本地化仍不在范围内。
