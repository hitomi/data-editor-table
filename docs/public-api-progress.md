# 新接口落地与功能保留清单

2026-10-05。新接口代码、demo/文档迁移及下述代表性功能核验已完成，等待用户功能验收。允许 API 和旧持久化格式 breaking change；不要求数据格式兼容，不删除既有产品能力。沿现有 Controller、Runtime、内核和原 UI 实现收敛接口。

设计依据：[公开接口契约](public-api-contract.md)。生命周期依据：[生命周期规则](lifecycle-api-design.md)。本文件区分代码落地与实际验证；通过编译不等于完成用户验收。

2026-11-18 更新。单测、浏览器 fixture 和打包消费者已迁移到当前公开接口。操作目标、版本证据与保存状态重构后，`pnpm run prepublishOnly` 完整通过，覆盖单元测试、三个浏览器的端到端测试，以及独立安装包在 Chromium、Firefox 和 WebKit 下的验证。八个反例的预期结果见[公开验收契约](public-acceptance-contract.md)，宿主接入规则见[持久化与同步](persistence-consistency.md)。下文的待迁移事项记录的是 10 月核验时的状态。

## 实施批次

| 批次 | 交付内容 | 当前状态 |
| --- | --- | --- |
| 1 | `initial` / `view`、统一 `updateEffects`、`GridAttachment`、接入失败与阻塞状态、demo 迁移 | 已落地，通过下述当前批次检查；整体功能验收仍待后续批次 |
| 2 | 类型化业务命令和值、错误从拒绝源头分类、专用关闭结果及清理失败语义 | 已落地；真实编辑、保存、任务整组回滚、复核及关闭失败链路通过临时浏览器核验 |
| 3 | 可等待的 `save` / `recoverSave` / `refresh`，对应原操作、权威回执与读屏障 | 已落地；下面记录真实持久化、恢复、并发、自动模式与刷新核验；完整功能清单仍待最终批次 |
| 4 | 保留结果的类型化复核接口、低层交互入口、显式公开导出和协议子入口 | 已落地；命令/交互运行时隔离、原交互、保留结果及打包后 root/engine/protocol 均通过当前批次核验 |
| 5 | 全部示例、声明、文档和功能链路核验，修复相关遗漏后供用户验收 | 代码迁移、文档、代表性产品流程及最终构建/打包核验已完成，可供用户验收；未发布 |

普通 save 不排队，不吸收新的恢复提交；保存范围按实际冻结请求判定。未知结果的恢复必须指定原 operationId。不能靠全局 idle 判断某次操作成功。

## 功能保留清单

以下各行是最终核验要求，继续沿用原实现；已完成的工作流证据记录在下方，不代表每一项组合行为都已验收。任何接口调整都需迁移对应调用方，不能以删功能解决类型或状态问题。

| 能力 | 现有实现入口 | 最终必须核验的行为 |
| --- | --- | --- |
| 选择与命中 | interaction transitions、grid cells / viewport / layers | 单格、矩形、多选、行列选择、全选、Shift/Ctrl、原选区框与锚点、层级 |
| 键盘与指针 | Controller intents、原 viewport | 拖选、键盘移动、扩展选区、快捷键、滚动、双击编辑、IME |
| 单格编辑 | editing transitions、registry editors | 字符串、数字、日期、布尔、单选、多选、图片、显式编辑器提交/取消 |
| 校验与原输入 | edit sessions、input codec、kernel inputs | 无效输入可见且可修正，拒绝不清空原文，隐藏/删除目标仍可处理输入 |
| 批量编辑 | bulk transitions、原 bulk dialog | 多格应用、混合值、校验、会话保护、取消 |
| 复制粘贴 | clipboard matrix、DOM clipboard adapter | 矩阵编码、粘贴、权限失败、行列范围和限制 |
| 清空和填充 | command planner、selection commands | 可编辑性、空值语义、拖锚点填充、范围限制 |
| 排序和筛选 | view / filter transitions、原 filter dialog | 多字段排序、全局/列筛选、条件组合、会话保护、隐藏编辑目标 |
| 行结构操作 | row capabilities、transaction builder、kernel authoring | 新建、复制、删除、移动、排序后的插入锚点、删除权限、顺序冲突 |
| dirty 与还原 | read model、draft commands | 原值、dirty 标记、单格/选区/行还原、新建/删除/顺序的 dirty |
| 冲突 | authority reconciliation、resolution | 单格、整行、删除、身份变更和顺序冲突，明确保留本地或接受远端 |
| 撤销重做 | kernel history、original commands | 未保存与已保存操作、结构操作、补偿、后续编辑不被旧确认覆盖 |
| 持久化模式 | kernel persistence gateway / runner | 手动保存、自动保存、即时写入、debounce、失败、并发编辑、确认与读屏障 |
| 恢复 | persistence tickets、operation lookup | 未知提交、不重复发送、原操作查询、刷新复核、精确回执失败保留工作 |
| 异步与图片 | effect coordinator / runner、image cell、multi-image demo | 上传、取消、替换、过期结果保留、复核重试/放弃、多图导入 |
| 跨表流转 | cross-grid demo、transaction DSL | 复制、剪切、拖放、插入位置、源补偿、失败后保留输入 |
| 自定义单元格 | column helper、registry、value/input codecs | 自定义类型、codec、动作、编辑器、effect、bulk、显示和行为分离 |
| React 生命周期 | binding lifecycle、DataGrid | 自动、hook、显式实例一致；StrictMode、卸载重接、阻塞切换、最新目标、候选失败 |
| Headless | createGridController、transaction DSL、selectors | 无 React 编辑和事务、读取、订阅、保存、关闭、定制交互层 |
| 国际化与界面扩展 | locale、surfaceRenderers、row header/drop zone、styles | 语言、主题、图标、原 DOM/CSS、工具栏/菜单/反馈扩展、实时文案 |

## 核验边界

2026-10-05 当前批次证据：

- 生产库与 demo TypeScript、oxlint、导入边界、库声明与 demo 构建通过。
- 临时浏览器脚本核验：StrictMode 同源只持有一个 source 订阅；inline initial 包装不导致重建或重复通知；改行高保留 Controller、编辑原文和历史；实际单元格高度及 Shift 矩形选区正确。
- 配置变更返回 invalid-configuration 并保留旧实例；非法限制在订阅之前拒绝；新 source 订阅失败保留旧表，不因报告错误而循环重试；真实点击旧表页脚的重新打开按钮恢复连接。
- 切换阻塞随编辑取消更新；最新目标生效；等待切换的端口不写入旧 source；提交后从 IndexedDB authority 核对数据，再切换目标。
- 显式 binding 通过统一端口更新；接纳后、执行微任务前更新或移除端口不转移任务；缺少端口明确拒绝新任务。
- 自动组件与 hook 重接保留原编辑器输入；干净卸载释放自动实例；显式实例卸载仍归宿主；重复自动所有者和已关闭 binding 返回结构化错误，未发生 pageerror。
- 候选订阅同步引入旧实例无效输入时，第二次关闭检查保留旧编辑器，候选释放后能再次连接。
- 四个真实 demo 均核验双击编辑、Escape 取消和选区边框；跨表 demo 保留 72px 行头和拖动按钮。
- 同步命令按类型返回 value；真实数字编辑提交失败保留原文，关闭受阻；编辑提交并移动、真实 Ctrl+C 复制、撤销重做、重复事务写入的原子拒绝、通知重入的 busy 和关闭阻塞均核验。临时类型检查从源码及构建声明核对命令和值的关联、宿主 effect 泛型和旧字段移除。
- 宿主任务预先声明读写目标，第二个值校验失败时整组拒绝；inspect 保留原请求与 completed 标签，手动重应用拒绝仍保留材料；丢弃后的过期 ID 返回 stale-target。
- 源 unsubscribe 抛出时返回 cleanup-failed，Controller 已关闭；重复 destroy 保留同一结果且不重复清理，清理期间重入被拒绝。自动入口重接同源展示清理失败，不能静默创建新实例。
- await save 区分 no-changes、blocked、confirmed、partial、failed 和 recovery-required；原文无效时不提交，已有保存时不提交另一编辑器；冻结后同格的新编辑保留。原保存返回相同 operationId，IndexedDB 保存原冻结值，后续编辑另行保存。
- 写入成功后读取屏障失败返回 applied/refresh；原 operationId 的 refresh 不发送新写入、不吸收后续编辑。丢失响应返回 unknown/confirm；查询原操作确认成功。未知查询在源的 fenced identity 保证下至多重发一次同一 ID/hash/bytes，后续编辑不加入。
- 明确未应用证明返回 failed，原文保留，后续新 save 使用新 operationId；准备读失败时 operationId 为 null，确认没有发出 submit。没有恢复工作、过期恢复目标、错误动作、busy 和 closed 均返回结构化结果。
- partial 的 excluded 在实际 freeze 捕获，包含 cell 或 row/order 目标；独立可保存编辑写入 IndexedDB，冲突保留；全部冲突返回 blocked/conflict，不能返回 no-changes。
- applied-without-receipt 自动查询一次，查询未知仍保留 applied，之后通过原查询补确切回执，不重发写入；畸形回执要求 review，不能形成自动查询循环。复核后显式 confirm 可取得正确回执。其他 operation 的回执不能确认当前请求，也不能让 Promise 永久等待。
- 手动 save 的 Promise 可在下一笔即时保存仍运行时完成；即时和 debounce 模式均从 IndexedDB 核对后续修改。重复 refresh 立即 supersede 旧调用；返回的旧 authority 不回退新数据；刷新失败保留行与编辑原文；干净关闭结算等待中的 read Promise。
- 业务 dispatch 和 engine 的 getGridInteractionPort 共用一个 Runtime；无类型调用方混用命令类别或旧同步保存/复核别名返回 invalid-input。宿主整组结果夹带低层事件时全部回滚，inspect/apply/discard 保留并处理原材料。关闭后原 port 返回 closed。
- 当前浏览器真实核验 Shift 键盘扩选、Ctrl 多选、指针拖选、行列快捷键和原选区覆盖层。原编辑器 compositionstart/end 回调经新 port 生效，组合输入期间提交拒绝且原文保留；输入完成、快捷键撤销/重做、保存后从 IndexedDB 核对中文原文。此核验是合成浏览器 composition 事件，不声称已覆盖所有 OS 输入法。
- 从 pnpm pack 的实际包在仓库外导入 root/engine/protocol，核对 JS 边界和最终声明的命令值关联及负向类型约束。engine/protocol 的完整运行时与声明依赖图没有 React 或其他外部依赖。库/demo 构建、生产类型检查、lint 和导入边界通过；未运行旧 consumer fixture 或全量测试。
- 两个独立 Controller 共享同一物理 source/scope 时，复现 A 的读验证完成、B 推进共享版本、A 发布结算的竞态。原逻辑显示 confirmed、关闭 ready，却因要求覆盖变化中的共享 frontier 而不释放许可，下一次 save 永久等待。现在释放检查工作区已接受证据和原 submission/receipt 的屏障；下一位写入者仍读取共享 frontier。重复同一返回顺序，A 的后续保存确认成功，IndexedDB 同时保留后续本地值与 B 已观察的远端更新。关闭检查也读取实际 gateway reservation，不只依据内核 idle。
- 真实 Playground 工具栏保存、页脚失败重试和整页重新打开通过浏览器核验：失败时 IndexedDB 保持旧值，界面保留输入，重试后权威值更新，刷新页面读回新值，原选区框仍可见。
- 当前真实 Playground 核验字符串、数字、日期、单选、多选、布尔和图片编辑；数字拒绝保留原文并可修正，disabled 选项不可选，多选编辑器外部点击保留显式 Apply 的草稿。图片通过实际 file input/FileReader 上传，七类值一起保存后检查 IndexedDB 完整文档，再整页打开核对行与图片。
- 真实批量数字编辑拒绝无效值并保留 dialog 原文；点击 modal 外部保留会话，修正后原子应用两格。保存后的 Undo/Redo 各自保存补偿并从 IndexedDB 核对具体值；全局搜索、排序循环和列筛选应用/清除通过原工具栏、表头和 dialog 核验。
- 真实行新增、保存后的 Undo/Redo 重建、复制、删除均从 IndexedDB 核对数量并重新打开核对。跨表 Copy 保留源行、Cut 新增目标后删除源行，核对两边 authority；删除保护拒绝 Cut，原行移动控件更新实际顺序并保存。
- 真实多图 file input 导入四张图片，超出原有三行时原子创建第四行；核对完整图片 data URL、按文件顺序去扩展名的名称与 authority 顺序，再重新打开核对四张图片。
- 真实 Ctrl+V/C 使用含嵌入 tab/newline 的 quoted TSV，按矩阵解析和完整编码；原锚点通过实际指针拖动将 41、42 填充为 43，Delete 清空后快捷键 Undo 还原。粘贴越界创建第四行；无效矩阵、字节与修改数量限制均原子拒绝。保存后逐格检查 IndexedDB 值。
- 原 HTML 拖放通过真实 DataTransfer 进行跨表 Copy/Cut，核对插入前后位置及两个 authority；同表 Cut 移动保留原身份。目标插入后宿主同步打开源编辑器，源删除拒绝时只补偿那次具体插入，保留源原文与两边 authority。此故障注入只在临时脚本中读取 React fiber 定位原 binding，再调用公开 Controller；未添加生产测试入口。
- 发现公共布局转换将完整旧 layout 展开为尺寸配置，覆盖新 viewport/scroll，导致可见单元格被判定为视口外。现在明确投影 rowHeight/headerHeight/rowIndicatorWidth。核对 1440/1920/2560/3840 宽度下实际 DOM 测量与原位编辑器矩形；滚出时编辑器脱离显示仍保留原文，滚回时回到单元格，保存与刷新保留几何，重新打开读回权威值。
- 远端修改使活动行被既有筛选隐藏时，脱离显示的原编辑器仍可修正并 Apply，保存原实体；远端删除时恢复界面保留无效原文且提交/保存拒绝。同键新 incarnation 不能继承旧编辑器，修正原文仍保留，旧会话提交返回 stale-target，新实体的权威值未被覆盖。
- 实际 authority 冲突阻止保存；整行保留本地与接受远端分别产生已确认修改或 no-changes。单格/整行还原只去掉对应本地贡献。远端删除后保留本地明确重建新实体；本地删除遇远端修改可接受当前远端行。不同完整行顺序的竞争分别核验 keep-local 保存和 accept-remote 去掉本地顺序，逐项核对 authority。
- 修复不存在的复核列名被误当作整行决策的问题；字段无法单独复核时明确返回 conflict，未知列返回 stale-target。数据/顺序的非法 resolution 返回 invalid-input，不默认保留本地。拒绝前后完整只读数据和冲突材料相同，正确的整行和顺序复核继续可用。
- 自定义 Date 业务值配合完整 row/value codec；自定义类实例的未解析草稿配合 editor/bulk input codec。实际自定义编辑器拒绝时保留完整原文及类实例，可修正并保存；原菜单中的自定义动作、已保存 Undo/Redo、两格批量 Apply 均核对编码后的 authority。zh-CN、工具栏/页脚和 bulkDialog surface callbacks 保持可用。engine Controller 无 React 视图执行自定义行为、事务、订阅、保存和关闭，再从真实来源读回原自定义 UI。
- 原图片 file input 与可控异步上传核验：目标远端改变后的结果保留可复核，原 File、结果及目标可 inspect；实际页脚 reapply 后保存。替换和取消撤销自动应用权限，迟到结果保留供明确 discard。失败上传从原 File 重试并落库。同键新实体不会继承旧图片结果，默认 reapply 返回 stale-target；明确指定另一有效目标后才能应用并保存。
- 真实表头核验 Ctrl 多列排序、列筛选 any/all 组合、空结果后的恢复、移除条件与清除筛选；原 corner 和 Ctrl+A 按当前完整排序视图全选并显示原边框。
- 同一显式 binding 实时更新 messages、主题 class、工具栏 surface 和行高，保留原 Controller、自定义类草稿及输入；修正后通过实时宿主保存按钮写入准确的编码值。主题 class 的接入与保留已核验，不将此记录表述成逐个主题 token 的视觉验收。
- 最终生产构建在本地预览核验四个真实页面的编辑/取消/选区和原行头拖动几何；Playground 七类编辑一起保存并重新打开，Cross-grid 原生 Copy/Cut/同表移动及源拒绝的精确补偿均通过。实际 pnpm pack 后在仓库外检查 root/engine/protocol JS 导出和声明，engine/protocol 完整运行时与声明依赖图无 React 或其他外部依赖。生产库/demo TypeScript、lint、边界、构建、声明和 diff whitespace 检查通过。

## 交付与后续验收

2026-10-05，用户核验补充：Quick start 的 boolean `Edit cell` 原先不显示编辑器，而是 begin 时取反、不可见 Editor 在挂载时提交。此前七类编辑核验对 boolean 只覆盖直接点击、保存和批量流程，遗漏了菜单入口的交互含义。现在 begin 保留当前值，Edit cell/Enter/F2/Space 打开明确的 checkbox 编辑弹层，草稿只有 Apply 生效，Cancel/Escape 不改值，外部点击保留草稿；直接点击表内 checkbox 继续切换。另修复 Shift/Ctrl/Cmd 选区操作误切换 checkbox 的问题，混合值批量编辑保持明确选择后才 Apply。临时 Playwright 从真实菜单核对 true/false 初值、无修改 Apply、草稿与 authority 分离、取消、键盘、四种宽度、保存和重新打开，以及多选批量只修改目标行；生产类型/lint/边界和构建通过，未新增仓库测试或运行全量测试。

代码与原产品流程的适配工作已完成，验收入口为本地生产预览 `http://127.0.0.1:4179/`；开发服务仍为 `http://127.0.0.1:4178/`。两个页面按各自 origin 使用浏览器 authority，不迁移或清空用户旧数据。正式 npm 包和 GitHub Pages 尚未更新，package version 仍是恢复的 0.3.1。

本次核验使用的临时脚本留在 `/tmp`，未增加仓库测试。旧测试/fixture 仍待用户确认功能后按最终契约审阅迁移，不能将本次交付等同于通过 prepublishOnly 或允许发版。

这些证据覆盖批次 1–4 和批次 5 的代表性功能链路，**不表示用户已验收，也不声称穷举所有组合**。浏览器证据使用 Chromium；系统输入法、其他浏览器、所有第三方 codec 和真实服务端实现仍需宿主自己的核验。不能把接口代码完成、编译通过或一次正常保存等同于全部产品效果已被用户确认。

按用户要求，功能验收前不新增测试文件，不运行全量测试。使用生产 TypeScript 检查、lint、导入边界、库/demo 构建和 `/tmp` 临时 Playwright 脚本。真实提交须检查 demo 的 IndexedDB authority，而非只检查 dirty 清空或界面提示。

旧协议测试和 fixture 仍需在接口落地后按最终契约审阅；当前不能宣称 `pnpm check` 或完整测试集通过。未新增磁盘 journal，刷新页面仍不保证恢复未保存输入。未获授权前不提交、推送、发布、bump version 或清空用户旧浏览器数据。
