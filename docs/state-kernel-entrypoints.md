# 状态内核入口接线清单

2026-09-13：M1–M5 代码已接通，四个原 demo 使用新数据协议与原产品界面。等待用户功能验收，尚未发布；现有旧协议测试的迁移与回归覆盖后置。

## 唯一状态所有者

`GridControllerRuntime` 同批发布内部 `KernelState`、只读 `GridReadModel`、原编辑/批量会话、交互、查询和布局。`data-backend.ts` 是无状态同步转换边界；没有另一个 Workspace，也没有可写的展示 rows。React 继续使用原组件和交互算法。

| 文件 | 已接入职责 |
| --- | --- |
| `src/controller/controller-state.ts`、`controller-protocol.ts` | 编译文档模型、校验来源协议，建立唯一内核事实与会话/任务所有权 |
| `src/data/grid-document.ts`、`runtime-columns.ts` | 完整行 codec、显式字段域、别名绑定、自定义写入计划和完整行校验 |
| `src/data/kernel-authoring.ts` | 固定 revision/实体/原始输入，隔离执行 setter，一次 action 接纳完整读写集合 |
| `src/data/kernel-projection.ts`、`kernel-read-model.ts` | 缓存解码行，派生原值、dirty、冲突、结构变化、保存计划和贡献式历史 |
| `src/controller/data-backend.ts` | action、authority、receipt、history、resolution、提交准备与冻结的同步入口 |
| `src/controller/kernel-persistence-effects.ts`、`src/kernel/gateway.ts` | 共享物理来源/scope 的写入许可，读取、摘要、提交、查询与精确结算 |
| `src/controller/effect-coordinator.ts`、`controller-effects.ts` | 任务身份、取消权限、运行中资源、结果事件与过期材料保留 |
| `src/controller/controller-lifecycle.ts`、`src/react/data-grid-lifecycle.ts` | 统一关闭阻塞查询、三种 React 接入的切换规则和自动实例保留/释放 |

`controller-interaction.ts` 中的 engine 交互 port 只代理同一个 Runtime；业务/交互类别在运行时检查，不增加独立状态。`index.ts`、`engine.ts`、`protocol.ts` 显式区分 React/业务、headless/交互和后端协议入口，不暴露整个内核模型。

## 所有产品入口的接线

以下工作流入口位于 `src/controller/controller-workflow.ts`。命令返回成功表示 Runtime 已本地接纳，远端保存另行完成。

| 入口 | 保留产品逻辑 | 当前数据路径 |
| --- | --- | --- |
| `commitEdit`、`cell/set-value`、`runCellAction` | 原 behavior、同步校验、composition、提交后移动 | 编译 `set-cell`，原始输入编码后与 action 一起接纳；拒绝保留输入 |
| `applyBulk` | 原标准/自定义 BulkEditor | 固定实体及文档依赖，全部目标一个 action；失败不清空整批原文 |
| `clearValues`、`fill` | 原范围、生成算法、只读与成本限制 | 原 planner 输出明确写集合，进入同一 authoring 边界 |
| `paste` | TSV、字节限制、越界创建与选择 | create/write/order 一次原子 action |
| `applyTransaction` | 原公开事务 DSL、工厂与失败结果 | staged commands 编译接纳，成功返回具体 `applicationId` |
| add/duplicate/delete/move | 原行能力、保护、排序/过滤目标规则 | create/delete/order 操作记录 |
| `revertCells`、`revertRows` | 原恢复菜单 | 明确基准值写入或贡献处置；多行还原同一次发布、同一个可撤销 application |
| `resolveConflict`、`order/resolve` | 原行/字段菜单；条件显示顺序决策 | 复核 revision/observation/issue IDs，写入明确决策；整行保留采用复核后的完整结果或删除，字段决策保留未复核依赖 |
| `history` | 按钮、快捷键与交互协调 | 具体 application 的贡献控制；已保存操作通过补偿撤销 |
| source 订阅、refresh、提交结果 | 原反馈与主键/会话协调 | 同一个 authority/receipt 接纳边界，权威证据决定先后 |
| save/recoverSave/set-mode | 原 manual/auto/immediate 入口 | 许可→读取→完整请求→摘要→冻结→发送/查询→精确覆盖结算；保存期间追加编辑保留 |
| `handleEffectEvent` | 图片与宿主 effect 的原 I/O | 稳定实体、目标文档、session/input 版本校验；过期/失败结果显式保留和复核 |
| `prepareInput`、`prepareEvent` | 原 Runtime 队列、同步重入和通知 | 同一次原子发布数据、会话、视图与 effects，I/O 在发布后执行 |

## 数据源、输入与边界

- `createRemoteGridDataSource` 接收真实 `PersistenceSource`、scope 和 document model。旧 `load/mutate/commit`、客户端版本号与 rows 缓存不再充当保存证据。
- demo 的 `demo-source.ts` 用 IndexedDB 事务原子保存 authority、版本和 operation outcomes；`demo-data-source.ts` 的 JSON/counter 是只读观测，不能写回 Controller 状态。
- 任意旧 setter 只在命令准备时运行一次，采用保守整行读取条件。列的 `validate(value)` 保留显式字段依赖，`validateWithRow(value, row)` 和行权限回调追加整行依赖。回放不会再次调用 setter。
- Date、自定义类/行、非标准 draft 需要对应 codec；标准单选的私有 origin 有明确 codec，避免复制丢失内部输入标记。
- 内部实体与字符串/数字业务 key 分离。来源必须提供 incarnation 或 epoch 内不复用 key 的保证；主键规范化不改变任务与历史的内部目标。
- 取消撤销结果应用权限，仍在运行的任务继续计入 pending work。未应用结果可在原菜单及空表仍可访问的页脚复核/重试/丢弃；宿主可通过 `effect/inspect-result` 读取保留材料。
- 多图导入在读取前保留原文件，过期/失败/卸载保留重试入口，明确取消才丢弃；一批成功接纳后释放文件。
- 跨表保留独立数据域、自动保存与历史。剪切失败补偿绑定目标创建的 `applicationId`，有后续修改时拒绝补偿并报告部分完成，不调用“最近一次 undo”。
- 本轮不启用 durable ingress、checkpoint 或崩溃恢复；页面硬刷新仍会丢失尚未保存的内存输入。具体 source 协议与迁移见 [保存一致性说明](persistence-consistency.md)。

## 退出的旧写入路径

已删除 `data/draft-transactions.ts`、`rebase-draft.ts`、`replay-after-commit.ts`、`change-set.ts` 和旧 `controller/persistence-machine.ts`、`persistence-coordinator.ts`、`persistence-effects.ts`。`source-reconciliation.ts` 只协调身份与原会话；`draft-commands.ts` 只派生展示/query/layout。旧 before/after rows 历史类型已经退出生产代码。

继续复用原 `grid-cells.tsx`、`grid-layers.tsx`、`grid-viewport.tsx`、`grid-surfaces.tsx` 和布局/范围算法；调用方已迁移到类型化命令、异步保存和低层交互 port。`data-grid.tsx` 接入生命周期、只读能力、新保存恢复状态和条件恢复菜单/页脚；样式沿用原产品结构，并支持保留结果与离开可见区域的编辑输入。四个 demo 保留原产品流程与保存默认值。

2026-09-23：binding 工厂拆到 `react/data-grid-binding.ts`，两套 React 生命周期合并到 `react/data-grid-lifecycle.ts`。组件、hook、显式 binding 视图都保留被阻塞的旧表；自动实例共用缓存，显式实例仍由宿主销毁。2026-10-05：第二阶段公开接口已落地，契约见[公开接口设计](public-api-contract.md)，当前代码与完整流程证据见[落地清单](public-api-progress.md)。

## 检查记录与未验收范围

没有新增单元测试或浏览器 spec，没有运行全量测试。集中浏览器检查使用独立 Chromium context 和实际 demo 数据库，未清理用户浏览器数据。

已通过的流程检查：

- 2026-09-23：临时浏览器脚本在 StrictMode 下核验三种入口的输入阻塞与最近目标切换、显式实例不自动销毁、自动实例干净释放、跨组件/hook 重新接回原始输入、任务回调归属及保留结果恢复、取消切换后保存、真实双击输入并保存确认后切换。还核验筛选/批量会话阻塞、保存过程中卸载并等待真实落库、重复所有者拒绝且保留原工作，以及新来源同步订阅引入旧工作时再次拒绝切换。
- 2026-09-22：删除冲突保留期间，其他行通过事务修改、新增、追加复制、删除并实际保存；真实界面新增不再被冲突展示行阻塞。显式移动和复制位置，以及已保存移动的撤销保持正确。
- 2026-09-22：动态删除条件的本地解锁、界面按钮状态、删除保存及已保存删除的撤销/重做；混合受保护行的事务原子拒绝、服务端拒绝后意图保留及恢复、远端锁定后的删除冲突确认拒绝，均已检查。
- 2026-09-22：临时浏览器脚本核验数据源切换后延迟/串联任务的回调归属、同源回调更新、订阅初始化失败重连、重复注册/取消和失效推送隔离；最后一行删除后的上传结果可明确放弃并继续切换来源，筛选隐藏行的保留结果可应用并实际保存，原文件可读取。未新增测试文件或运行全量测试。

- 四个页面加载，双击编辑、键盘选择、批量修改、单选/多选应用、无效数字原文保留，以及路由切换后重新接回未完成输入。
- 动态列编辑条件按本地行检查：解锁后编辑并共同保存、重新锁定拒绝新编辑、锁定前的修改继续保存；同一事务解锁/编辑及已保存事务撤销/重做、拒绝事务的原子性、远端条件变化的冲突保留、永久只读字段和列别名限制均已核验。
- 保存 A 时继续输入并提交 B：A 实际落库后界面继续显示 B，第二次保存才将 B 落库。
- 保存失败后重试、已保存修改撤销/重做及再次保存、重载后读取确认数据。
- 添加/复制/删除行、还原原行及撤销还原，整行冲突保留本地或采用远端结果；删除冲突保留本地后仍按删除保存。
- 单格图片上传、多图导入，实际数据库中核验保存内容。
- 跨表复制/剪切、保护行拒绝剪切、同表移动及已保存顺序撤销，另一张表保持独立历史。

生产库 TypeScript、demo 实际入口依赖图 TypeScript、lint、依赖边界、库 JS/声明/样式构建及四个 demo 的生产构建均已通过。现有测试及两个 demo 测试 fixture 仍引用旧协议，未迁移；不能将这些生产检查表述成全量 `pnpm check` 或发版检查通过。

尚未由用户验收；未穷举所有指针拖拽、剪贴板、第三方 codec、未知网络结果组合、浏览器与尺寸。上面的记录仅描述已实际检查的流程，不声明全部功能等价或可以发布。
