# 公开 API 详细设计

三个公开保证及八条验收场景见[公开验收契约](public-acceptance-contract.md)。

2026-09-23 设计，2026-10-05 落地。接入契约、类型化业务命令、undo/redo、保留结果复核、专用关闭结果、可等待的 save/recoverSave/refresh、低层交互 port 及显式公开导出已实现。代码、demo 和文档迁移完成，代表性功能链路、生产构建和打包消费者核验通过；等待用户功能验收，尚未发布。具体证据和功能保留要求见[落地清单](public-api-progress.md)。接续[生命周期规则](lifecycle-api-design.md#一第一阶段统一生命周期已实现)。

设计目标：接入者能够知道当前编辑哪份数据、修改是否被接纳、哪次保存已经确认、为什么不能离开，以及接下来可以做什么。继续复用现有 Controller 和内核，不增加另一个 Workspace、状态仓库或通用任务系统。

## 1. 决定保留与调整什么

保留 `DataSource → Binding → Controller` 的现有关系，保留列 helper、cell registry、事务 DSL、只读快照和选择器。Binding 持有 Controller 及 React 所需资源，不再给它添加一套重复的编辑/保存方法。

| 使用者 | 主要入口 | 必须理解的内容 |
| --- | --- | --- |
| 普通页面 | `DataGrid` | 稳定的数据源、列、布局 |
| 自定义工具栏/导航的页面 | `useDataGridBinding`、`binding.controller` | 实际活动实例、命令结果、保存结果 |
| 跨路由持有编辑实例的宿主 | `createDataGridBinding` | 明确的持有、卸载、关闭责任 |
| 后端适配作者 | `data-editor-table/protocol` | authority、版本、身份、精确回执和操作查询 |
| 自定义交互层作者 | `data-editor-table/engine` | 无 React Controller，以及显式的低层交互入口 |

当前 DataSource 同时携带 columns/model 与来源配置，本轮不拆成更多运行时对象。普通页面复用项目提供的数据源工厂；服务端协议复杂度由适配层封装，但不能伪造服务端保证。

## 2. 接入与配置

### 2.1 三种入口保持相同概念

目标用法：

```tsx
// 简单页面：组件持有自动生命周期。
<DataGrid
  ariaLabel="Products"
  dataSource={products}
  initial={{ registry, locale: zhCN, limits: { maxMutations: 10_000 } }}
  view={{ rowHeight: 40, headerHeight: 36, rowIndicatorWidth: 48 }}
  effects={effects}
/>

// 宿主需要控制器：hook 使用相同选项及生命周期。
const attachment = useDataGridBinding({
  dataSource: products,
  initial: { registry, locale: zhCN },
  effects,
})

if (!attachment.binding) {
  return attachment.status === 'error'
    ? <ErrorView issue={attachment.issue} retry={attachment.retry} />
    : <LoadingView />
}

// 标题、保存按钮和业务操作均跟随 attachment.binding.dataSource。
return <DataGrid ariaLabel="Products" binding={attachment.binding} view={{ rowHeight: 40 }} />

// 显式持有：在 React render 之外创建。
const binding = createDataGridBinding({
  dataSource: products,
  initial: { registry, locale: zhCN },
  effects,
})
```

示例中的 ErrorView/LoadingView 是宿主组件，不新增库内公共组件。`initial` 和 `view` 的内联对象无需 memo；比较它们的具体字段，不将包装对象的引用变化当成重建请求。dataSource 和自定义 registry 必须是稳定实例。

### 2.2 参数何时生效

| 参数 | 生命周期 | 修改后的行为 |
| --- | --- | --- |
| `dataSource` | 编辑实例的身份 | 按已实现的规则等待旧工作解决后切换 |
| `initial.registry` | 创建时 | 不静默替换行为、取消会话或丢弃历史 |
| `initial.locale` | 创建时 | 包含解析/编辑行为的语言配置固定；纯文案使用 messages |
| `initial.limits` | 创建时 | 包含 `maxMutations`、`maxClipboardBytes` |
| `view` | 当前视图 | 更新几何信息，不重建 Controller，不清空历史/输入/选区 |
| `messages`、className、ariaLabel、surfaceRenderers | 当前视图 | 延续已有实时更新行为 |
| `effects` | 当前实例的宿主端口 | commit 后更新，只影响该实例之后启动的任务 |

`initial` 发生实质变化时返回 `invalid-configuration`，保留原 binding 并说明旧配置仍有效；不自动销毁并重建干净实例，因为干净实例仍可能有撤销历史。要更换创建配置，宿主显式提供新的稳定 dataSource 对象或新的 binding，并经过相同切换检查；同一后端的 source/scope 标识保持不变。

视图尺寸更新沿现有布局转换更新命中区域、滚动几何和选区覆盖层，不能只改 CSS。默认值固定为当前默认值；headless Controller 保留合理的默认几何，定制交互层通过低层 viewport 入口更新。

显式绑定更新任务端口统一使用 `controller.updateEffects(port | undefined)`；React 入口也只在 commit 后调用这个入口。每个任务在接纳时捕获端口，即使尚在等待执行微任务也不转移。移除端口后新宿主任务明确拒绝，已有任务仍有归属。等待切换时不能把新来源的端口传给旧 Controller。

### 2.3 Hook 返回实际连接状态

```ts
type GridAttachmentTarget<B, S> =
  | Readonly<{ kind: 'source'; dataSource: S }>
  | Readonly<{ kind: 'binding'; binding: B }>

type GridAttachment<B, S> = Readonly<{
  requested: GridAttachmentTarget<B, S>
}> & (
  | Readonly<{ status: 'initializing'; binding: null }>
  | Readonly<{ status: 'ready'; binding: B }>
  | Readonly<{
      status: 'switch-blocked'
      binding: B
      blockers: readonly [GridCloseBlocker, ...GridCloseBlocker[]]
    }>
  | Readonly<{
      status: 'error'
      binding: B | null
      issue: GridIssue
      retry: (() => void) | null
    }>
)
```

- `ready` 仅表示 binding 已连接；数据是否加载、加载失败仍读取 `snapshot.source`，不把两套状态混在一起。
- 不额外复制 `activeSource`；`binding.dataSource` 始终是唯一的实际活动来源。
- `switch-blocked` 仍可以编辑、保存或取消旧实例；`requested` 是最新目标。
- 新实例初始化失败时旧实例保留。可以恢复的连接失败提供 retry；配置错误通过改正选项恢复，不提供无效重试按钮。
- `error.binding` 非空时继续显示旧表和错误；为空时显示初始化失败界面。
- 返回状态按实际变化保持稳定，不因父组件传入新的包装对象而持续发通知。blockers 应跟随控制器变化更新；不把通知中的短暂 `command-running` 永久显示成业务阻塞。
- 增加组件侧 `onAttachmentChange(attachment)`，只在 commit 后实际变化时通知，不在 render 中调用。复杂宿主优先用 hook，避免再维护一份“当前 Controller”状态。
- 切换前先验证/创建候选实例，再重新检查旧实例；候选初始化失败或旧实例新增工作时，不替换旧实例。

## 3. 同步命令与错误

同步命令返回“本地接纳”，保存返回“权威确认”。两种结果保留不同的命名，避免把同一个 `success` 用于两种含义。

```ts
type GridCommandResult<T> =
  | Readonly<{ accepted: true; revision: number; value: T }>
  | Readonly<{ accepted: false; revision: number; issue: GridIssue }>

type GridIssueCode =
  | 'busy' | 'closed' | 'invalid-input' | 'session-open'
  | 'permission-denied' | 'conflict' | 'stale-target'
  | 'source-unavailable' | 'save-in-progress' | 'save-unresolved'
  | 'no-recovery' | 'invalid-configuration' | 'limit-exceeded'
  | 'adapter-error'

type GridIssue = Readonly<{
  code: GridIssueCode
  message: string
  cell?: GridPoint<GridRowKey>
  target?: { kind: 'row'; rowKey: GridRowKey } | { kind: 'order' }
  domainCode?: string
}>
```

以上为公共代码的初始封闭集合。领域校验的自定义代码放在 domainCode，不用 `string` 扩大 code 后又失去可穷举性。不要解析 message 做流程判断，也不通过匹配已有英文错误文案生成 code；在拒绝发生的领域分支产生代码，再透传到 UI。

保留 `applyTransaction` 现有多 issue、原子接纳结果，不为了形式统一损失批量错误信息；只统一 issue 的基础语义。列值类型继续由 schema 推导，不能把事务 set 改成 any。

命令结果的关联类型已落地为 `GridIntentValue<RowKey, Effect, Intent>`：copy 返回 text，paste 返回 changedCells/createdRows，clear 返回 changedCells/skippedCells，写入命令返回 changedCells/applicationId，启动任务返回 effectId，inspect 返回 GridRetainedResult；无额外值的命令返回 void。旧 reason/payload 不作为兼容字段保留。调用方包装 dispatch 时必须保留泛型关联，不能用 Parameters 提取全部 intent 后使每个返回值退化为所有命令的联合。

公开的 `dispatch` 只接受业务命令，按命令类型返回对应的 `GridCommandResult<T>`。选择、查询、编辑、冲突和任务操作可继续通过它表达，不机械地为所有 intent 增加一套同名方法。常用的 save、recoverSave、refresh、undo、redo 提供直接入口；前三者的异步完成语义单独定义。

冲突复核必须指定真实范围：`columnKey: null` 明确复核整行，列名仅复核该列对应的字段。不存在的列返回 stale-target，不能退化成整行决策；当前冲突要求整行复核时，字段请求返回 conflict 并保留材料。自定义 setter 和列的 `validateWithRow(value, row)` 声明整行依赖，纯值 `validate(value)` 保留字段级依赖，调用方应按 `snapshot.draft.conflicts` 的目标选择复核范围。数据与顺序复核都要求明确的 accept-remote 或 keep-local，拼写错误不能被默认为保留本地。

pointer、viewport、composition 等事件经 engine 提供的低层交互 port 进入现有 Runtime。这个 port 只代理现有控制器，不持有独立状态；普通业务入口不暴露这些事件，宿主 effect 也不能返回任意 pointer/viewport 事件。

```ts
import { getGridInteractionPort } from 'data-editor-table/engine'
const interaction = getGridInteractionPort(controller)
interaction.send({ type: 'viewport/resized', width: 800, height: 400 })
interaction.send({ type: 'keyboard/command', command: 'select-all' })
```

业务 dispatch 和 port.send 在运行时也检查命令类别。宿主任务只能返回发起时声明的单格值或多格值。原目标或读依赖失效时整组拒绝并保留材料。关闭后的 port 返回 closed，通知重入时返回 busy。旧 source/refresh、persistence/save、persistence/retry 同步命令删除，不作为兼容别名。

自定义适配器保留跨渲染回调时，在呈现控件时捕获目标。业务 `dispatch(intent, target)` 和交互 `send(input, target)` 都接收 `GridCommandTarget`。编辑、批量与筛选控件分别传对应的 `edit`、`bulk`、`filter` 会话目标。每次重开都产生新的会话 ID。行控件从当时的 `snapshot.draft.entityAt(rowKey)` 取得实体身份，传 `{ kind: 'row', rowKey, entityId }`。目标过期返回 `stale-target`，后来的会话保留自己的输入。内置 React 视图已经绑定这些回调。

预期的业务拒绝、校验失败与网络结果通过结果类型表达。无效的静态构造参数可以抛出配置异常；hook 捕获它并显示 attachment error。不可预料的程序异常不伪装成“已保存”或普通业务拒绝。

## 4. 保存：采用现有冻结边界，不增加自动排队

### 4.1 修正上一版草案的范围承诺

现有路径是 `requestSave → gateway/ready → prepareSaveHash → freezeSave`。取得写入许可与读取远端数据之后，才能确定最终请求。哈希期间模型变化也会重新准备。

因此第一版定义为：**本次保存覆盖实际冻结请求中的修改，保存后续结果只归属于这一个请求。** 冻结前的新修改可能包含在本次请求中；冻结后的修改保留为后续工作。这与现有行为一致。

不承诺“调用瞬间固定修改集合”，也不承诺并发 save 自动排队。要增加这两项能力，需要另外设计前沿固定、后续编辑的依赖与撤销关系；不能用一层 Promise 包装假装已经实现。

### 4.2 签名与结果

```ts
save(target?: GridSaveTarget): Promise<GridSaveResult>
recoverSave(recovery: GridSaveRecovery): Promise<GridSaveResult>

type GridSaveRecovery = Readonly<{
  operationId: string
  action: 'confirm' | 'refresh' | 'review'
}>

type GridSaveResult = Readonly<{
  // 返回时的其他未处理工作；排除命令通知的瞬时 busy 状态。
  remaining: readonly Exclude<GridCloseBlocker, 'command-running'>[]
}> & (
  | Readonly<{ status: 'no-changes' }>
  | Readonly<{ status: 'confirmed'; operationId: string }>
  | Readonly<{
      status: 'partial'
      operationId: string
      excluded: readonly [GridIssue, ...GridIssue[]]
    }>
  | Readonly<{ status: 'blocked'; issue: GridIssue }>
  | Readonly<{
      status: 'failed'
      operationId: string | null
      issue: GridIssue
    }>
  | Readonly<{
      status: 'recovery-required'
      write: 'unknown' | 'applied'
      recovery: GridSaveRecovery
      issue: GridIssue
    }>
)
```

| 结果 | 精确含义 |
| --- | --- |
| no-changes | 没有待保存修改，也没有未结算提交；存在冲突而无可提交内容时不能返回它 |
| confirmed | 本次请求有被内核接受的精确回执，所需读取屏障也已完成；不表示调用后的新修改已保存 |
| partial | 本次请求已确认，但准备该请求时已有一部分本地修改因冲突/校验等原因被排除；excluded 指出被排除的目标和原因 |
| blocked | 未开始新的写入；当前会话、冲突、正在进行的保存等条件阻止开始 |
| failed | 已知此次尝试尚未提交，或有服务端明确未应用证明；普通网络异常不足以返回这个结论 |
| recovery-required | 有尚待查询、同步或人工复核的操作；write 保留已知事实，绝不将已知 applied 降为失败 |

`confirmed` 与 `partial` 区分的是本次准备时是否排除了修改。冻结后新产生的修改体现在 remaining，不能把所有后续编辑都误叫“本次部分成功”。partial 的 excluded 必须从实际保存计划取得，不能在返回时根据最新全局 dirty 猜测。

### 4.3 会话、并发与恢复

1. 新 save 调用在开始阶段立即接纳/拒绝。可隐式提交的普通编辑器先按既有规则提交；无效输入保持原文。明确 Apply/Cancel 的编辑器、bulk、filter 会话仍先返回 session-open，不替用户点击 Apply。
2. 已有保存进行中，新的 save 返回 `blocked/save-in-progress`，不提交另一份活动编辑输入，不自动重排调用。
3. 已有未知/待同步的提交，新的 save 返回 `blocked/save-unresolved`。各入口用 `selectGridActions(snapshot)` 取得 save、retrySave 和 recoverSave。展示 enabled 及 issue，异步回调传回原 target；作用域争议在隐式提交编辑器之前阻止新保存。
4. recoverSave 同时核对当前操作与允许的动作。目标已被另一操作取代时返回 stale-target，原操作已结算时返回 no-recovery。同一操作上过期或手工更换的动作也会被拒绝。
5. 畸形回执先展示 review，执行后重读 `selectGridActions(snapshot).recoverSave` 并展示下一步。confirm 查询原操作，仍为 unknown 且服务端保证 operation ID 围栏时才允许原样重发一次。refresh 只补读取屏障。已接纳事实相互矛盾时没有可执行的恢复动作，操作保留供调查。准备失败或有明确未应用证明时，页脚根据 retrySave.enabled 展示重新保存。新的本地修改按自己的调度代次触发自动保存。
6. recoverSave 不创建新提交、不包含后续编辑。收到明确未应用证明后返回 failed；宿主复核后再调用 save 才能创建新请求。
7. 已发出的查询跟踪到返回，与原请求关联。冲突证据使当前物理作用域封写。宿主使用适配器的 `subscribeDisputes`、`getDispute(id?)` 查看证据，从服务端核验后执行 `resolveDispute(id, verifiedResult)`。普通刷新、重挂载和另一笔操作的确认都不能解除该争议。追踪保留至进程结束。
8. 自动保存与手动保存使用同一套开始/冻结/确认事实。不能让新的 Promise API 与旧 toolbar dispatch 各跑一套保存流程。
8. Promise 关联本次 ticket/operation；不订阅全局 idle 后随便完成。一次 save 最多驱动一笔新提交；后台后续自动保存不能成为完成本次 Promise 的必要条件。
9. 第一版不增加保存任务句柄仓库、自动排队或取消写入 API。传输适配层负责有限的请求超时，并将超时映射为 unknown/读取失败等真实结果；超时不能生成“肯定未应用”证明。
10. 关闭/卸载不取消远端已发出的写入。结果完成前仍由现有实例持有操作，Promise 完成后相关订阅必须释放。

`operationId` 在这里仅用于结果关联与恢复选择；不要求普通页面处理 payload hash、coverage 或 frontier。

### 4.4 保存后导航示例

```ts
const result = await binding.controller.save()
if (result.status === 'confirmed' || result.status === 'no-changes') {
  const close = binding.controller.getCloseState()
  if (close.status === 'ready') {
    // 在同一段同步宿主流程中发起导航；不要在检查后再 await 其他操作。
    navigateAway()
  }
} else {
  showSaveOutcome(result)
}
```

remaining 是结果时刻的提示，不是关闭许可；导航守卫仍在实际退出时调用关闭检查。partial、recovery-required 或新输入未处理时不自动离开。不提供一个会偷偷丢弃输入的 `saveAndClose()`。

## 5. 刷新、任务结果与关闭

### 5.1 刷新

```ts
refresh(): Promise<
  | { status: 'refreshed' }
  | { status: 'superseded' }
  | { status: 'blocked'; issue: GridIssue }
  | { status: 'failed'; issue: GridIssue }
>
```

refreshed 表示本次读取结果已通过版本检查并进入当前实例；不覆盖新版本，不清除本地输入。后一次读取取代当前请求，或当前结果已落后于接受的新 authority/回执时，旧调用返回 superseded；控制器已关闭/忙碌时 blocked。未知创建的服务端身份尚不能归属原实体时，返回 blocked/save-unresolved，要求先确认原写入。读取失败保留已有数据。读取成功不能被当作未知写入已完成的证明；需要保存恢复时用 recoverSave。

### 5.2 保留结果

通过公开业务命令提供有类型的结果复核，不新增另一套 task store：

| 业务命令 | 返回/行为 |
| --- | --- |
| effect/inspect-result | `GridCommandResult<GridRetainedResult<RowKey, Effect>>`，结果标明 cell 或 external |
| effect/reapply-cell-result | 原实体或明确指定的替代目标；重新进行权限、校验和会话检查 |
| effect/apply-host-result | 仅复核后的 completed host result；原声明的读写目标全部通过复核后，原子接纳返回值 |
| effect/discard-result | 明确释放该项材料，不影响其他任务 |

inspect 的 cell 分支含原输入、目标及成功/失败值；external 分支含原请求和 completed/failed 标签。动态自定义 cell 的 input/value 仍可为 unknown，由对应 codec/registry 解释；不能为了声称“完全类型安全”强行断言调用方未证明的业务类型。宿主 Effect 请求继续由其泛型约束。

结果 ID 失效时返回 stale-target。取消正在执行的任务只撤销自动应用权限，不保证外部写入撤回；不自动清除保留输入。

### 5.3 关闭

保留已有 getCloseState，将 destroy 从通用 dispatch 返回类型改为专用类型：

```ts
type GridCloseResult =
  | Readonly<{ status: 'closed' }>
  | Readonly<{ status: 'blocked'; blockers: readonly [GridCloseBlocker, ...GridCloseBlocker[]] }>
  | Readonly<{
      status: 'cleanup-failed'
      closed: true
      issues: readonly [GridIssue, ...GridIssue[]]
    }>
```

正常 closed 幂等；blocked 不改变实例。cleanup-failed 表示 Controller 已不可用，但外部订阅等资源清理失败，宿主需要报告它，不能尝试继续编辑这个实例或重复提交原保存。实现时要保留清理失败信息，重复 destroy 不能把未处理的清理失败静默变成干净的 closed。

Binding.destroy 只委托同一个 Controller 关闭入口。显式宿主先解除视图再销毁；自动生命周期也使用同一个结果，不能不检查结果就从保留缓存移除。

## 6. 导出与迁移

### 6.1 显式导出

| 入口 | 导出 |
| --- | --- |
| 主入口 | DataGrid、binding/hook、列 helper、标准及自定义 cell 扩展契约、业务 Controller/结果类型、业务 selectors |
| engine | 无 React Controller、业务类型、显式低层交互 port；为自定义渲染器提供完整但分层的入口 |
| protocol（新增子路径） | PersistenceSource、ServerAuthority、FrozenSubmission、ExactReceipt、操作查询及必需的版本/身份类型、hash/编码工具、文档模型适配类型 |
| locales/styles | 保持现有子路径 |

主入口仍导出 createRemoteGridDataSource、createFieldGridDocumentModel 及它们的业务接入类型，普通使用者无需为每个类型访问 protocol。只有实现协议时才需读其底层类型。去掉主入口对 engine/kernel 的通配转出；保留真实的跨边界类型引用，不复制一份同名替代类型。

暂未接入的 checkpoint、durable ingress、内部 journal/session 等不作为稳定公共 API 发布。新增 package subpath 时同时更新构建、声明、package exports 与消费者示例。

### 6.2 Breaking change 清单

| 当前用法 | 目标用法 |
| --- | --- |
| hook 返回 Binding/null | 返回 GridAttachment，通过 attachment.binding 取得实际实例 |
| locale、registry、limits 与尺寸混在创建参数 | initial 固定创建配置，view 放到 DataGrid；effects 单独可更新 |
| 修改 initial 后仅 toast 提示 | 返回可见的配置错误，旧实例保持可用 |
| await dispatch(persistence/save) 或轮询 idle | await controller.save()，检查结果及关闭阻塞 |
| persistence/retry 混合新保存与旧操作恢复 | save 与 recoverSave(recovery) 分开 |
| 所有 dispatch 共用 payload: unknown | 按业务命令映射返回类型，底层交互单独入口 |
| destroy 返回 accepted/reason | 返回 GridCloseResult |
| 从主入口导入整套内核类型 | 协议类型移到 protocol，内部类型停止导出 |

不新增长期双轨兼容实现，不保留两套保存状态。版本在实际迁移和功能验收完成后再决定；本文不 bump 版本、不改变现有发布物。

## 7. 设计推演与实现边界

以下是设计必须满足的场景，尚不是实现已通过的测试记录：

| 场景 | 必须得到的结果 |
| --- | --- |
| A 输入无效，父组件请求 B | attachment 为 switch-blocked，仍显示 A 的原文，标题/按钮使用实际 binding |
| 改 rowHeight | 保留实例、历史和编辑输入，几何与选区同步更新 |
| 原实例有历史，修改 initial.registry | 明确配置错误，不以自动重建偷偷丢弃历史 |
| 保存 A 冻结后又编辑 B | save 只确认 A；remaining 提示 B；关闭仍被阻止 |
| A 保存中再次 save | 返回 save-in-progress，不自动排队或提前提交第二份编辑器输入 |
| 一个字段冲突，另一个字段可保存 | 提交可保存内容；返回 partial 与被排除的字段问题 |
| 服务端写入成功，读取失败 | recovery-required，write=applied，action=refresh；不重发写入 |
| 请求超时、服务端是否写入不明 | recovery-required，write=unknown；查询原 operation |
| 旧恢复按钮对应的 operation 已结束 | no-recovery 或 stale-target，绝不操作新提交 |
| 应用保留结果时原实体已删除 | 拒绝并保留材料；明确指定新目标后再校验 |
| 源订阅释放抛错 | cleanup-failed，实例已关闭，不能假称资源全部释放 |

建议按三个可独立验收的代码批次实施：

1. **接入契约**：GridAttachment、initial/view 参数、同源端口更新；迁移四个 demo。先核验切换、尺寸和原交互。
2. **操作结果**：业务 issue 代码、save/recoverSave/refresh、任务结果及 close 专用返回类型。先确定真实结果关联，再写公共 facade。
3. **公开边界**：收窄 dispatch、增加低层交互 port 和 protocol 子路径、更新完整接入示例与迁移文档。

保存 facade 必须接到现有 workflow/Runtime 的 ticket、冻结、精确回执和失败事件；允许做局部结果通知及关联改造，不复制保存状态机，也不从展示 rows 重建 coverage。partial 需要在准备时保留被排除目标的诊断，属于明确的新增工作。

维持此前约定：先完成功能并核验，再安排必要测试迁移。现已开始代码实施，验收前不新增测试文件或运行全量测试；使用生产检查和临时浏览器脚本核验当前批次。
