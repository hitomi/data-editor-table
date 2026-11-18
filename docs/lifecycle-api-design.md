# 生命周期与公开 API 收敛方案

2026-09-23，2026-10-05 更新。统一生命周期、接入配置、异步操作、低层交互及公开导出契约已落地。完整功能核验仍在进行。保留现有 Controller、状态内核和产品 UI，不新增 Workspace 或第二个状态所有者。具体进度见[功能保留清单](public-api-progress.md)。

## 一、第一阶段：统一生命周期（已实现）

### 1. 所有者与视图

Binding 包含 Controller、数据源和单元格注册表。Controller 持有编辑、历史、任务和保存状态；视图挂载不是数据实例的生命周期。

| 入口 | Binding 的所有者 | 视图卸载后 |
| --- | --- | --- |
| `<DataGrid dataSource={source} />` | React 生命周期管理器 | 无待处理工作则释放；否则保留，等待同一 source 对象重新连接 |
| `useDataGridBinding({ dataSource })` | 同一个 React 生命周期管理器 | 与直接组件完全相同；可以跨两种入口重新连接 |
| `createDataGridBinding(...)` + `<DataGrid binding={binding} />` | 创建它的宿主 | 只解除视图连接；宿主保持引用，永久退出时检查 `destroy()` 结果 |
| `createGridController(...)` | 创建它的宿主 | 与显式 binding 使用相同关闭判定，由宿主管理资源 |

显式 binding 的销毁责任不会因为传给 React 而转移。一个 binding 只驱动一个 viewport。对同一 data-source 对象，React 同时只接受一个自动生命周期所有者；重复申请会明确拒绝，避免两个 Controller 的未完成工作相互覆盖。需要独立编辑实例时使用各自稳定的 data-source 对象；是否共享物理后端仍由 source/scope 标识决定。

### 2. 切换规则

三种 React 入口都遵守：

1. 旧实例存在关闭阻塞时继续显示旧实例，不创建新的自动管理实例，也不将新数据源的 effect 回调写入旧实例。
2. 原输入、任务、保留结果和保存仍可在旧表中处理。阻塞解除后切换到最近一次请求的目标。
3. 用户将目标改回当前实例时，取消待切换请求及等待订阅。
4. 切换或卸载自动管理实例时先解除连接，再于命令完成后的微任务中重新检查是否可销毁。重新挂载与 StrictMode 的模拟卸载可以收回同一实例。
5. 显式 binding 的切换也会等待旧工作处理完成，但不销毁旧 binding；其宿主可稍后重新显示它。

`useDataGridBinding` 返回 `GridAttachment`：首次自动连接为 initializing；已连接为 ready；切换受阻为 switch-blocked，包含旧 binding 和当前 blockers；失败为 error，保留旧 binding，并在可以恢复时提供 retry。宿主通过 `attachment.binding.dataSource` 判断实际活动数据源，不能假定它已经等于 requested。

这是相较旧 hook 的有意行为改变：不再先隐藏尚未处理的旧表，再返回新表。

### 3. 关闭查询

已提供：

```ts
const close = binding.controller.getCloseState()
// { status: 'ready', blockers: [] }
// { status: 'blocked', blockers: [...] }
// { status: 'closed', blockers: [] }
```

阻塞原因是稳定代码：

| blocker | 含义 | 恢复动作 |
| --- | --- | --- |
| `command-running` | Runtime 正在处理命令或通知 | 当前命令退出后重新检查 |
| `unsaved-changes` | 尚有本地数据或顺序修改 | 保存，或通过现有撤销/还原操作处理 |
| `conflicts` | 数据或顺序冲突待复核 | 显式选择冲突解决方案 |
| `editing` | 单格编辑会话仍打开 | 提交或取消输入 |
| `bulk-editing` | 批量编辑会话仍打开 | 应用或取消批量输入 |
| `filter-editing` | 筛选编辑会话仍打开 | 应用或取消筛选条件 |
| `running-effects` | 异步任务尚未结束 | 等待任务结束并处理结果；取消应用权限不代表任务已结束 |
| `retained-results` | 任务输入/结果待处理 | 复核应用、重试或明确放弃 |
| `unsettled-save` | 保存运行中、结果未知或错误尚待恢复 | 查询、刷新或重试，遵守原操作的证据 |

`getCloseState()` 是即时查询，不是关闭许可，也不提供引用稳定的 React snapshot。`destroy()` 会重新检查；在 Controller 通知回调中查询可能包含 `command-running`，最终释放须在命令退出后进行。普通源读取失败不单独阻止关闭，未结算写入会阻止关闭。

关闭拒绝保留整个实例。`destroy()` 返回专用 `GridCloseResult`：closed、blocked，或 cleanup-failed。后者含 closed: true 与非空 issues，表示 Controller 已关闭但外部资源释放失败；所有资源均尝试清理，重复调用返回同一失败结果，不再次释放资源，也不隐藏证据。清理期间重入返回 command-running 阻塞。自动管理缓存保留失败证据，再次接入同源报告错误而不静默替换。

关闭成功幂等；已销毁的显式 binding 不能重新挂载。卸载不会清空输入，也不会把未知提交转换成失败或未提交。

这仍是内存生命周期：整页刷新/进程退出不保证恢复未保存工作。没有增加磁盘 journal 或崩溃恢复。

### 4. 目前保留的配置约束

`initial.registry`、`initial.locale` 和 `initial.limits` 固定创建配置，按具体字段比较；改变时返回 invalid-configuration，保留输入与历史。`DataGrid.view` 通过现有 Runtime 更新布局尺寸，其他布局重算也读取当前 layout，保留编辑会话和选区。

effect 端口统一通过 `controller.updateEffects` 更新；自动入口仅在同源 React commit 后更新。每个被接纳任务捕获端口，随后更新或移除端口不转移原任务，移除后拒绝新任务。等待中的新来源不会影响旧来源。显式 binding 由宿主直接调用同一更新入口。

### 5. 实现边界

- `src/controller/controller-lifecycle.ts`：关闭阻塞的领域规则与公开类型。
- `src/controller/grid-controller.ts`：合并 Runtime 忙碌状态、实际保存状态，统一关闭查询和最终销毁检查。
- `src/react/data-grid-binding.ts`：创建显式 binding；不承接 React 挂载状态。
- `src/react/data-grid-lifecycle.ts`：唯一 React 连接、待切换、卸载与保留缓存实现。
- `src/react/data-grid.tsx`：使用同一个生命周期入口，继续渲染原表格组件。

## 二、第二阶段：公开接口设计（接口已落地，完整功能待核验）

详细签名、结果联合、参数生效时机、并发与恢复行为、迁移表及实施批次已经移到[公开 API 详细设计](public-api-contract.md)，以后以该文档为准。

本轮确定的方向：

- 保留 DataSource、Binding、Controller，不新增状态所有者。
- hook 返回明确的连接状态；实际活动来源始终从 binding 读取。
- initial 明确固定创建配置，view 接受不重建实例的几何更新，effect 端口更新统一。
- 同步命令返回本地接纳，保存返回权威结果，关闭返回专用结果。
- save 和 recoverSave 分开；未知操作不能通过普通 save 重新发送。
- 主入口、engine 和协议入口采用显式导出，不公开整个内核模型。

相较上一版草案有一处有意收敛：保存范围采用**实际冻结请求**，不承诺在调用瞬间固定范围，也不自动排队并发 save。当前实现会在取得写入许可、读取 authority、准备哈希之后冻结请求；强行改变这个边界会扩大为内核设计变更。并发 save 明确返回 save-in-progress，确认后通过 remaining 和关闭检查判断是否还有新工作。

接入签名、类型化业务命令结果、undo/redo、保留结果复核类型、专用关闭结果和可等待的 save/recoverSave/refresh 已经落地。异步结果由现有 Runtime 发布 ticket/operation 完成通知；不轮询全局 idle，不另建保存状态机。engine 的 getGridInteractionPort 和 protocol 子路径已落地。业务 dispatch 不接收低层事件或旧同步保存命令；视图 port 仍只代理同一个 Runtime。完整产品链路验收见落地清单。
