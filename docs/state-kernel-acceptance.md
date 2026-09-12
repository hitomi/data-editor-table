# 状态内核验收索引

核查日期：2026-09-12。目标仍是设计基线 M0–M6 全部完成；本文件不改变要求，也不宣告完成。

状态区分：**已核查**仅说明本行明确列出的事实；**待验收**表示已有实现或测试入口，但尚未逐条核对断言与当前运行结果；**缺项**表示目前证据不足以交付该要求。文件存在、测试总数和历史通过记录均不能代替语义验收。后续应在本索引更新证据，历史过程留在进展日志。

## 阶段与设计章节

| 基线要求 | 当前证据入口 | 结论及下一项证据 |
| --- | --- | --- |
| §1–3 单向事实来源；M5/M6 唯一生产入口 | `src/index.ts`、`src/engine.ts`、`scripts/check-kernel-boundaries.mjs` | 已核查根入口导出 Workspace DataGrid，engine 只导出新内核；旧目录已删除。仍须最终包构建和消费检查 |
| §4.1 稳定身份 | `entities.ts`、`protocol.ts`、`structure-model.test.ts` | 待验收创建回填、ABA、恢复 lineage 与任务的组合 |
| §4.2 编码值与 schema 版本 | `document.ts`、`schema.ts`、对应单元测试、`recovery.test.ts` | 待逐项核对 round-trip、missing/null、有损编码和旧格式保留 |
| §4.3 完整读写域 | `prepare.ts`、`journal.ts`、`schema.test.ts` | 待逐项核对隐藏字段、重叠路径、semantic-read 和整行 CAS |
| §5 原子转换与 authority 状态 | `transition.ts`、`state.ts`、`workspace.ts` | 待核对转换表、重入、初始失败与已有内容刷新失败 |
| §6–7 意图、合并与冲突 | `intent.ts`、`projection.ts`、`resolution.ts` | 已有定向变异覆盖丢失删除意图；全部三方/物化失败/决策历史仍待逐项验收 |
| §8 保存协议；M2 | `persistence.ts`、`gateway.ts`、`source.ts`、`source-fixture.ts` | 新保存链路已实现；必须分别核对 Source 承诺、真实服务器状态、读屏障、恢复和后继输入 |
| §9 条件 undo/redo；M3 | `history.ts`、`history-command.ts`、`redo-model.test.ts` | 模型比较预览、冲突、服务器写入及请求；混合动作覆盖边界仍待审计 |
| §10 顺序与查询 | `order.ts`、`view.ts`、`workspace-selection.ts` | 待验收结构依赖、完整顺序、固定目标、查询变化及分区 |
| §11 输入、任务；M4 | `session.ts`、`task.ts`、`ingress.ts`、恢复组件 | 会话/任务/决策输入与返回请求均有界面；全归宿模型和处置边界待核对 |
| §12 关闭、memory/durable 恢复 | `lifecycle.ts`、`checkpoint.ts`、`checkpoint-store.ts`、`durable-commit.ts` | clean/retain/discard、checkpoint 及独占恢复已有实现；不再列为“未实现”，但仍须逐条验收 |
| §13 转换表 | `transition.ts` 与各领域转换测试 | 待将每个事件的前置、拒绝、成功和副作用证据逐行对应 |
| §14 十五条性质 | 下表 | 尚未全部证明 |
| §15.1 模型、调度、生成与缩减；M0 | `tests/kernel/*model.ts`、`src/kernel/*model.test.ts` | 保存/字段历史/会话任务已有 seed 生成和同性质事件缩减，保存/历史还支持数值简化，会话任务支持文本/远端整数简化；单行结构历史已有 seed 调度及同性质事件删除缩减。多行结构/顺序组合、恢复及任务动作生成仍未完成 |
| §15.2 反例及定向变异 | `scripts/check-kernel-mutations.mjs`、进展日志变异检查点 | 十种故障均已触发具体失败；29 个反例仍需逐场景匹配断言，不能从变异结果推断全部通过 |
| §15.3/§16 公开 API、浏览器、包；M5 | `package.json`、`playwright.config.ts`、`tests/package-consumer/` | 三浏览器及 tarball 消费已有检查；最终同一工作树的全套验收待运行 |
| §17 旧格式退出；M6 | `recovery.ts`、迁移指南、旧代码备份记录、`old-root-recovery.spec.ts` | 旧实现已删除；同身份 format 1–9 拒绝后的真实下载/刷新保持原文、字节、root 和 record 已验证。用例从当前有效根修改版本标记，不冒充真实历史发布数据；旧 checkpoint、真实旧形状档案及归档转换仍需核对 |
| §18 性能、压缩、交付边界 | `projection-cost.test.ts`、`history-cost.test.ts`、`workspace-grid-viewport.tsx` | 独立行前驱查找有访问次数约束；同一行长日志、完整 DOM、引用压缩与公开历史保留/导出策略尚未闭环 |

上表内省略目录的生产文件在 `src/kernel/`，模型 fixture 在 `tests/kernel/`。路径仅定位证据，不充当完成结论。

## 十五条语义性质的验收入口

以下全部仍需最终逐断言审计。每行同时检查正向结果和不可发生的副作用；重放生产算法所得的期望值不能作为独立证据。

| §14 性质 | 首要证据 | 必须核查的断言 |
| --- | --- | --- |
| 输入守恒 | `session.test.ts`、`task.test.ts`、`durable-ingress.test.ts`、浏览器恢复测试 | 每份已接纳输入完整可追踪，失败/取消/迟到结果不能使唯一材料消失 |
| 覆盖精确 | `persistence.test.ts`、变异 settle-unsent-intents | ack 只结算冻结成员，保存期间的新编辑和无关删除仍在 |
| 投影纯净 | `data-workflow.test.ts`、`projection-cost.test.ts` | 原 journal/authority 不变，不重复业务回调；缓存与无缓存等价 |
| 刷新幂等 | `data-workflow.test.ts`、`reference-model.test.ts` | 重复观察及无关刷新不改变有效要求 |
| 冲突稳定 | `resolution.test.ts`、`data-workflow.test.ts` | 无 preview 时仍保留原目标和输入；不能靠值相等吞掉 |
| 删除收敛 | `reference-model.test.ts`、`structure-model.test.ts` | 远端缺失只满足删除，不合成创建 |
| 身份隔离 | `entities.test.ts`、`structure-model.test.ts`、`task.test.ts` | 同 key 新 incarnation 不接纳旧动作/任务；历史仅沿明确 lineage |
| 提交幂等 | `gateway.test.ts`、`durable-workspace.test.ts` | 重试逐字相同，重复结果无额外写，确认后只读取 |
| 因果正确 | `persistence.test.ts`、浏览器 `persistence-consistency.spec.ts` | exact canonical 与较新 authority 分离；旧读不释放屏障 |
| 撤销条件正确 | `redo-model.test.ts`、`history.test.ts` | unknown 两个真实分支分别补偿/抑制，未应用分支不写旧值 |
| 权限封闭 | `schema.test.ts`、`capabilities.test.ts`、浏览器 `review-regressions.spec.ts` | 完整写域、策略版本、只读隐藏字段和服务端原子拒绝 |
| 生命周期独立 | `workspace-react.test.ts`、浏览器 `workspace-react.spec.ts`、`owned-source-switch.spec.ts` | detach/remount/StrictMode 保留编辑且不重复写或任务 |
| 任务单次消费 | `task.test.ts`、`durable-task.test.ts`、浏览器 `owned-upload.spec.ts` | owner/generation 过滤、受阻结果重用、取消后迟到结果只保留 |
| 原子接纳 | `journal.ts` 测试调用方、`session.test.ts`、`task.test.ts` | 第二项失败时第一项也不写，完整输入束仍有归属 |
| 顺序完整 | `order.test.ts`、独立 `order-model.ts`、浏览器 `partition-transfer.spec.ts` | 每个实体恰一次，blocked 结构依赖不越过，独立写可保存 |

## 已识别的实质缺项

1. **生成与反例缩减**：保存域已有 64 个固定 seed 的可变长度事件序列，失败自动缩减并输出原序列、seed、journal/receipt 和失败性质。保存/历史现在交替执行事件删除与整数值简化，固定点仅保证单事件删除及所提供候选替换均不能保留同一失败，不承诺全局最短或全局数值最小；会话任务生成也支持按Unicode码点缩短输入文本和缩减远端整数值，仍保留同一失败属性；会话候选结果已生成空串/中文/emoji/控制字符，并逐事件比较原结果内容，支持结果文本缩减；结构化动作/文件结果仍未纳入该生成器。字段 undo/redo 和会话候选任务已加入生成时序；另有 64 个 seed 连续进行 3–8 次规范化保存，交错后继输入、unknown、历史控制和乱序读取，并持续检查历史冻结请求。另有64个seed的跨周期外部更新生成器，每轮在执行前可制造拒绝并显式撤销未提交要求，在执行后/回执前继续交错外部变化、当前/旧读；逐步对照独立模型的完整服务器/可见值/冲突成员/可提交集/原文及历史冻结请求。结构除固定枚举外已有 64 个 seed 的单行创建/删除历史调度，并支持保留失败属性的自动事件删除缩减（初始模板固定，不声称全局最短）；任务动作、多行结构/顺序、外部冲突与durable恢复的组合生成及相应值简化仍需补齐。
2. **交互完整性**：范围填值、矩阵粘贴、复制、清空、核心上下文菜单及矩形重复拖动/键盘填充已接通；任务面板已补齐 Escape 取消并验证与按钮/API 同义。custom fill/series 已接入捕获上下文和矩阵会话；其余自定义交互仍须逐项验收。
3. **长期状态成本**：viewport 当前遍历全部可见行；前驱索引测试只覆盖独立行两层写入。同一行 N 次同字段未保存编辑原先资源运算为 N(N+1)，共享后缀及增量前缀已将该负载的 operationResource 次数降到至多 2N；复杂域、全部日志扫描和长期历史成本仍待核查，详见 `projection-cost-investigation.md`。必须补同一实体的长期编辑/保存/撤销、有效历史保留与检查点/资源引用回收设计，不能静默截断输入或历史。
4. **恢复处置与旧格式**：现有材料查看/导出/重新应用不等于所有材料的终结和回收已证明。须核对结构化原文、returned archives、旧格式根及资源引用的完整处置路径。
5. **最终统一验收**：逐项完成设计第 13、15.2 节后，在同一最终工作树运行所有发布检查。当前仍保留 Goal active。

## §15.2 反例逐项台账

以下编号严格对应基线矩阵顺序。已核查仅关闭该具体反例；不会据此关闭整条泛化性质、所有 Source 实现或全部 M0–M6。待核查表示尚未完成断言审阅，不表示没有实现或测试。

| 编号与场景 | 核查结论 / 直接证据 |
| --- | --- |
| C01 删除 A→远端改 A→编辑/保存 B | 已核查：`persistence.test.ts` 的 actual partial server commit 用独立 ReferenceServer 执行真实请求，coverage/settlements 只有 B、服务器仅写一次，A 原 intent 和输入归属仍保留且 blocked；`reference-model.test.ts` 同场景独立要求清单结果一致 |
| C02 删除 A→远端改 A→远端删 A | 已核查：`data-workflow.test.ts` 明确断言零 changes/rows、原日志不变、externally-satisfied 证据与 retired 身份；独立模型明确拒绝再 freeze/create |
| C03 输入→物化失败→连续刷新 | 已核查生产定向断言：连续三次 profile=null 刷新仍保留原 intent、原文 B、intents 归属、零 settlement 和 materialization-blocked；模型中对应失败事件及其他变换失败分支仍待核查 |
| C04 部分保存与新增主键回填 | 已核查组合用例 creation-ownership.test.ts：冲突删除不在 coverage，独立 SourceFixture 实际分配不同 key 并规范化；原 EntityId、会话 target/input 与不可变 intents 保持，迟到任务只进入原会话，undo 后继回到 canonical 文档；服务器完整内容与仅一次写入有断言。durable 崩溃组合另属 C19 |
| C05 后继编辑与规范化回执 | 已核查：persistence 的 frozen display 用独立服务器规范化 x/hidden，覆盖 authority 前冻结显示、后继原 intent 不变、下一次请求 before/after 完整文档、实际第二次保存和两份输入结算；recovery 另断言随后远端删除仍能恢复 x=2/hidden=9 |
| C06 外部更新与迟到精确回执 | 已核查：较新 authority x=3/hidden=2 保留，冲突 base 只用 exact x=1.5；追加重复回执、版本 0/1 旧读及版本 2 重复读，每步仍只结算前驱、后继原文未变且不可保存；独立模型同场景断言 canonical base 与最新 authority 分离 |
| C07 unknown→undo 两个分支 | 已核查：redo-model 的 applied/earlyRedo/canonical 枚举对照独立模型与服务器；在 redo 前明确检查已应用分支的 canonical before/补偿 after，未应用分支零 changes、拒绝 freeze、零 writes，且每步服务器完整文档一致。history 定向用例另实际提交补偿，并验证远端 x=3 的未应用分支不被旧 x=0 覆盖 |
| C08 合并保存与连续 undo/redo | 已核查 history 的 coalesced 场景：两原始动作同属一个冻结 coverage，仅一份 canonical x=2.5/hidden=8；连续 undo 为 1→0，保存后 redo 为 1→2，再保存/连续 undo/保存，实际请求值仅 2/0/2/0、writes=4，完整隐藏字段与原 intent/原文保留。独立 reference-model 核对合并 coverage 和逐动作补偿，redo/generated-history 覆盖后续时序 |
| C09 部分行已保存后 undo | 已核查 history 的 combines suppression and compensation：第一请求只有 B:0→1，服务器 A=9/B=1；undo 后仅 B 可保存，补偿请求只有 B:1→0；实际服务器 A=9/B=0 且总计两次写入，未发送的 A 未被补偿覆盖 |
| C10 创建保存中后继编辑/删除/取消 | 已核查内核组合：creation-ownership 保留未发送后继编辑与会话；creation-outcome 的 delete/undo × applied/rejected/reused-key 六例核对 unknown 屏障、冻结请求不变、精确 assigned identity/canonical before 的实际删除、未应用零写入、复用 key 的新 incarnation 不被删除，以及创建/删除原文与原 intent 不变。durable/浏览器组合另行验收 |
| C11 同 key 新 incarnation | 已核查内核定向场景：task 的 session/field 两例先删除旧 a，再观察 key=a/life:2 的 replacement；旧 EntityId retired，旧 intent/原文及任务 owner/input/result 保留，task-consume 拒绝且 state 同对象、零 effects，新行 x=0/hidden=77 不变、零可提交 changes。creation-outcome 另核对独立服务器复用 key 不被旧删除补偿影响；durable 跨重开任务组合仍须单独验收 |
| C12 replace 隐藏/只读字段 | 已核查定向证据：schema 测试拒绝只读写入/替换，允许保留只读 null 的可写兄弟字段替换；replacement-atomicity 八例覆盖 schema/policy 约束下父域删除/置空、只读叶缺失/改值，第二行无效时整个动作无 journal/changes，完整原请求立即持久化并重开保留、服务器完整数据未变且零写入。服务端适配器权限实现须另行验证 |
| C13 order 依赖受阻结构变更 | 已核查 order 的 create/delete 两例：结构动作遇独立远端排序后受阻，无关 A 字段实际保存；请求只有 update，coverage/settlement 只有独立动作，完整服务器顺序 B/A/C 与成员保持，A=2，writes=1；再次读取后原结构 intents/原文仍保留且无可提交结构或 orderChange。结构生成模型另属 M0 未完成范围 |
| C14 上传遇刷新/目标/权限变化 | 已核对 task-workspace 的 memory executor：无关刷新后保存完整隐藏文档；权限撤销时保留完整结果/输入，恢复权限不会自动应用，明确 consume 后只执行一次写；原目标变化后旧结果受阻，旧 review 拒绝、新 review 可改投另一实体并保存，原结果/原文保留且 I/O 不重复。durable-task 新增真实 File 字节/中文文件名/元数据、权限撤销、响应丢失、lookup、连续 lease 接管重开、受阻消费、恢复后 Apply/Save 链路；RecoveryFixture 下原文件和精确结果全程保留，任务/服务器各执行一次。owned-upload 三浏览器另已核查真实 IndexedDB 的撤权、受阻重载、中文原文件下载、恢复编辑/显式使用结果/Apply/Save/再重开；完整目标与另一工作区文档、唯一权威版本推进和精确 execution 保持均断言。改投目标的 durable 组合已在 C28 核查；响应丢失与撤权同时发生的 UI 组合仍需核查 |
| C15 上传三种取消入口与迟到结果 | 已核查：见下方“任务取消入口”检查点；三入口均只有一次取消 revision，重开后 cancelled、原文件逐字可下载、服务器 version 不变，另一 owner 的原文不被结果覆盖 |
| C16 effect 第二项无效 | 已核查 task.test 的两行第二项 schema 失败，整份 input/journal 保持；durable-task 新例覆盖第一项有效更新、第二项非法创建，完整原 File/两项 result 持久保留，首项零 journal/服务器请求。重开后拒绝直接 consume；明确修正完整提案后一次请求提交两项，再重开保留原无效结果、文件字节和 settled-intents 归属。该 durable 证据使用 RecoveryFixture，不冒充真实 IndexedDB/UI |
| C17 bulk 与排序/过滤/远端变化 | 待逐项核查固定身份与明确拒绝 |
| C18 detach/remount/StrictMode | 待核查输入和执行次数断言 |
| C19 durable 失败及发送前后崩溃 | 待区分已耐久、未耐久与外部写入证据 |
| C20 receipt 缺失/404/旧读 | 已核查 gateway/persistence 定向场景：已实际应用但缺精确回执后，404/unknown/pending 各与旧读、当前读组合，仍 awaiting-receipt、零 settlement/rejection，retry 只 lookup，gateway 重复 submit 不再调用 Source。回执恢复后仅结算前驱、后继原文/intent 保留，服务器实际仅写一次且 canonical 完整文档正确。另有未执行 lookup 404 只能重试原 immutable operation 的用例 |
| C21 exact receipt 后刷新失败 | 已核查 reducer 定向场景：read-failed 和版本 0 旧读后仍显示 submitted x=1，committed-awaiting-authority、零 settlement，retry 唯一 effect 为 read-at-least；覆盖读后显示 canonical x=1.5，独立服务器仅写一次。durable-workspace 另已验证实际写入 canonical1.5 后 read 抛错、接纳后继2、重开及再次恢复失败仍保留输入/原意图/零结算；读恢复只结算第一笔，后继以1.5为基值保存并再次重开，第一笔不重发且不 lookup。commit-read-failure 三浏览器另验证实际 HTTP503、编辑后继、真实 IndexedDB 重载、再次失败恢复和后续成功恢复：DOM 保留 first/second，第一笔精确结算，第二笔 before FIRST/after second，最终 SECOND；原 intent、全部输入版本/原文/引用与第一笔请求保持，实际两次写且 lookup=0。toolbar 已按持久化阶段区分等待更新数据/等待保存明细，并由状态派生使重载后保留；三浏览器验证两种确认状态均不显示未知结果文案，回执暂不可用后恢复只查询且仅一次写入 |
| C22 qty 规范化与 total 语义依赖 | 已核查：生产与独立模型均阻止 qty=2 被规范化为 3 后继续提交 total=20；生产检查 semantic-read-changed、原输入仍属 intents、prepareSave 拒绝，实际服务器仍 qty=3/total=10 且仅一次写入 |
| C23 旧落盘回执/undo 后崩溃 | 已核查 durable-workspace 的 RecoveryFixture 链路：冻结提交收到更早语义提交的正回执时保持 storage unknown，重复查询旧回执不放行 I/O；精确存储查询恢复后只允许原 reservation 查询/显式重试，唯一实际写入且请求不变。保存发送中接受 undo 后 lease 接管重开，成功分支依据 canonical1.5/hidden canonical 补偿到0并再次重开；拒绝分支保留 remote9/hidden remote，零可提交变更、零补偿写。原 journal、完整输入 ref/原文及冻结请求均保持。该证据是独立存储模拟的接管恢复，不声明真实浏览器进程崩溃覆盖 |
| C24 checkpoint 导出竞态/双恢复 | 已核查 checkpoint 固定快照：原未知 token/输入完整，导出中后继键入使 ticket 过期，retain/clean-close/checkpoint-close/discard 四入口均拒绝，最新原文仍可见且没有 checkpoint 写入或 source 请求。workspace-checkpoint 新增同一未知保存归档的双 owner 恢复：首 owner 在 load 前被新 lease 栅栏拒绝，胜出 owner 完成自动 lookup，唯一原请求/一次实际写入、canonical 完整文档、原 journal/输入保持，再普通重开不回退。checkpoint-close 原任务用例核查一次 start/执行/lookup；双 owner 文件任务恢复另已核查：原执行响应丢失后导出，首恢复者在 load 时被接管，胜出者 lookup 原精确结果并消费；一次 start/执行/lookup，完整原输入、中文文件名/时间/字节、消费终态及结果在再重开后保持，业务 source 零写入。上述并发证据使用 RecoveryFixture，不代替真实浏览器双页面或进程崩溃验证 |
| C25 IME 与迟到 view 输入 | durable-ingress 已核查显式 composition 状态链 n/ni/你，恢复 detach 后为 idle；新 lease 输入新的输入后，旧 lease 的序号4/前驱3 envelope 迟到被持久保留，当前文字/composition/lease 不变，再重开保留旧事件及新文字。该证据是运行时输入协议，不冒充系统原生 IME 事件验证 |
| C26 首键落盘前连续键入 | durable-ingress 首笔存储受控暂停后连续入队三输入，明确断言序号1/2/3、published0→第一 ingress→第二 ingress、逐项文字/composition；此时 published 仍 original、输入投影为你。释放后各笔存储记录有序，重开全部输入记录相等、最终你且 editor detached；后续新编辑和旧事件后再重开原 ref/内容保留。该证据使用 RecoveryFixture，未覆盖首笔未完成就直接丢弃进程的未耐久输入 |
| C27 未落盘 close/存储回执丢失 | checkpoint-close 新增实际 Workspace 交错：存储提交暂停时 clean-close/checkpoint-close 均 blocked，生命周期 open、published/root 不变、最新原文可见且零 checkpoint/source 写；释放提交但丢失回执后 storage unknown，clean-close 仍 blocked，checkpoint-close 成功转交。重开仅查询原精确 semantic commit，原文输入恰一份，再重开完整输入一致、无新增查询，checkpoint 唯一写且 source 零写。已有 checkpoint receipt-loss 场景验证原 checkpoint token lookup。证据使用 RecoveryFixture，真实存储失败 UI 仍属 C19 的开放范围 |
| C28 blocked 结果换目标重用 | 已核查 task-workspace memory 链和 durable-task 多次接管：A 转换结果因远端A9受阻，重开保留完整结果；改投B的旧 revision拒绝且输入/journal不变，当前审阅成功后唯一请求仅B0→42并保留隐藏8，A9/隐藏7不变。再重开重复改投 ignored/state同对象，原 owner/input/execution/result 保持，服务一次执行、零 lookup、业务一次写。durable 证据为 RecoveryFixture |
| C29 恢复删除后撤销早期字段 | 已核查 history 的规范化/恢复 lineage 与 workspace 实际 gateway 保存路径；新增同链旧会话任务：字段保存→登记任务→删除保存→恢复删除→撤销早期字段→保存，新实体完整 x0/hidden7，旧 EntityId retired，原字段 intent 不变；迟到结果保留，task-consume 拒绝且零 effects/state 同对象，旧 owner/input/会话 target/原文保持，服务器仅三次预期写。durable-task 另验证删除保存后重开、恢复/早期字段撤销保存、迟到执行、再次接管 lookup、受阻消费和再重开：旧实体 retired，新实体 value0/hidden7，恢复请求引用精确删除 operation/item，原 intent/文件归属/中文文件名与内容/旧会话原文保持，业务三次写、任务一次执行且仅原请求 lookup。持久化证据使用 RecoveryFixture，不声明真实浏览器崩溃覆盖 |

以上 C01/C02 的测试源码已重新阅读，并在当前完整单元运行中通过；C03 没有被扩大表述为独立模型已完全覆盖。后续继续按此台账核查，而不是因文件名或历史绿色记录自动关闭条目。

## 验收命令

`package.json` 的发布前检查依次运行：

```sh
pnpm check
pnpm test
pnpm test:mutations
pnpm lint
pnpm demo:build
pnpm test:browser
pnpm check:package
```

`check:package` 包含实际构建、tarball 消费和浏览器验证。最终还须检查完整 diff（包括 untracked 文件）、文档链接与旧接口残留。命令通过仅证明各自覆盖的范围；M0–M6 退出条件仍逐条适用。

## 本次审计实际运行

2026-09-12：`pnpm test` 通过 51 个文件、625 个测试，日志为本机 `/tmp/kernel-acceptance-unit.log`。本轮只修改文档，另检查了六份修改文档的本地 Markdown 链接及 `git diff --check`，均通过。未在本轮重跑浏览器、构建、类型检查或包消费；这些仍是最终统一验收门槛。

## 保存时序生成检查点

`tests/kernel/generated-trace.ts` 提供确定性 uint32 seed 和异步事件删除缩减；`tests/kernel/save-trace.ts` 用独立 ReferenceEditor/ReferenceServer 比较两行字段写入、冻结、服务器执行/拒绝、规范化、结果未知、精确回执、当前读及缓存旧读。原文材料与冻结请求另行比较。每次 replay 都重新创建独立模型、生产内核及模拟服务器。

`src/kernel/generated-save-model.test.ts` 的失败报告包含 seed、original、缩减后的 trace、property、journal 和 receipts。可按测试名称重跑某 seed，例如：

```sh
pnpm test src/kernel/generated-save-model.test.ts -t 'seed 0$'
```

缩减器只接受同一 property 的语义失败；缺少前置事件的候选被标为 invalid，不能冒充更短反例。它遍历块删除并最终达到单事件删除固定点；基础设施异常继续抛出。单元测试验证确定性、不同失败性质过滤、前置依赖保留及异常传播。真实隔离变异 `settle-unsent-intents` 已触发生成模型差异，缩减出“write A → freeze → execute → write B → receipt → read”的六事件反例。

范围限制：当前生成域只含一次提交周期的两行标量字段写入，不以此证明条件历史、结构、任务、崩溃恢复和全输入归宿。既有对应单元/模型/浏览器测试继续保留；完整 Goal 仍 active。

本检查点最终验证：`pnpm test` 通过 53 文件、692 项；`pnpm check`、`pnpm lint` 及空白检查通过。更新后的变异基线 222 项通过，七种故障全部检出，工作树生产文件哈希未变。生成模型分别在 latest-as-normalization、settle-unsent-intents、accept-older-authority 变异中触发 16、34、64 个失败，报告中的代表序列分别缩减到 7、6、2 个事件。本轮没有修改生产/UI 行为，未重跑浏览器或发布包；最终统一验收仍待进行。

## 条件历史生成检查点

`generateHistoryTrace` 在保存生成器的合法步骤间按 seed 插入显式 undo/redo，并用独立栈维护原动作及各次 redo 的引用。`src/kernel/generated-history-model.test.ts` 覆盖 64 个 seed，另有两条固定的 unknown → undo → undo → applied/not-applied 分支：已执行分支实际保存撤销补偿，随后重做、输入与再次保存；未执行分支不生成补偿，重做与后继输入通过新请求保存。对不同原文贡献的撤销没有转成普通 set-old-value。

新生成时序首先暴露参考模型的错误：两个已提交编辑依次撤销时，预览按原编辑顺序处理控制，停在中间值。五步缩减序列为 write1 → write2 → freeze → undo → undo。按设计 A5 及用户动作顺序，预览应回初始值，生产内核在该例中正确。参考模型现把保留的提交贡献与发生于 undoPosition 的控制分成独立事件，以用户顺序解释；新增直接模型断言保留该反例。参考模型仍不导入生产比较、投影或历史助手。

生成器及 runner 属于测试编排层，可调用生产命令准备器，但不把其结果用作预期值。输出仍按同一失败 property 缩减。能力拒绝进入 history-acceptance 反例；缺少独立栈前置的候选属于 invalid，不能替代原失败。

每次 idle 都比较完整可提交写集合，而非仅在 freeze 时比较，因此未执行分支中的多余补写会被直接拒绝。

此检查点扩展字段历史的事件排列及固定多提交分支；尚不覆盖结构历史、任务、crash/reopen 和多个提交周期的生成组合，也不宣告 M0/M3 完成。

本历史检查点验证：完整单元 54 文件/759 项通过，类型/边界检查、lint、空白检查通过。隔离变异基线 289 项通过，七类错误全部检出，生产文件哈希保持不变；其中 26 个新增历史用例检出 suppress-unknown-undo，生成案例可缩减到 write → freeze → undo 的预览差异。最后补充 idle 可提交写集合断言后，131 项保存/历史生成用例及完整单元、类型检查再次通过。本轮只改测试模型、编排及验收工具/文档，未重跑浏览器或包发布检查。

## 会话任务输入所有权生成检查点

`tests/kernel/task-session-model.ts` 是无生产导入的独立模型，直接记录当前原文、输入版本、每份原文的归属、目标及其已审阅基值、附着状态、任务终态和候选结果。`task-session-trace.ts` 将显式事件送入生产 reducer，再与模型比较；生产命令、投影和输入记录不参与生成预期值。

初始条件固定为已打开的 a.x 会话和一笔已启动转换，分别持有 original text 和 original file。64 个 seed 交错键入、远端修改、目标重选、上下文确认、detach/attach、正确/错误 execution/session 的完成、取消、consume、当前及过期 review。缺少会话或 lease 的候选在独立模型中标为 invalid；合法但应拒绝/忽略的事件仍参与运行。

每步比较命令结论、任务状态、候选保留、会话版本、当前原文、整束输入的原文/版本/disposition，以及 session 保留的文件引用；拒绝和忽略必须保持同一 state 对象。另检查 journal 无新增写及服务器权威值不被任务候选修改。两条固定序列覆盖目标改变后的 blocked → retarget → detached reapply → consumed → session cancel，以及错误 execution、已取消任务与迟到完成。

隔离变异新增 ignore-session-input-owner 和 cancel-consumed-task。变异基线 371 项通过，九种错误全部检出，生产源文件哈希保持不变；新增任务套件分别有 30、21 个用例检出两类错误。缩减序列相对于上述已打开/已启动初始条件解释，不能省略此前输入接纳。失败报告保留 inputs、tasks、session、journal 与 receipts。

完整单元 55 文件/825 项通过，类型/边界及 lint 通过；最后补充拒绝原子性断言后，66 项任务模型用例再次通过。没有修改生产/UI 行为。本检查点覆盖 memory 会话候选所有权，不证明 durable 执行次数、物理 File/Blob、动作候选、多任务竞争或崩溃恢复；对应既有测试继续保留，生成组合仍待补齐。

## 键盘清空入口检查点

Viewport 的可选 `interaction.onClear` 只接受 gridcell 自身的无修饰 Delete/Backspace，忽略按键重复和 IME 组合事件；子控件保留原生编辑行为。DataGrid 使用按钮与键盘共用的 clearSelection：按焦点判断使用固定选区还是单格，检查完整可见目标、clearInput 与可审阅性，再打开普通/矩阵会话。活动会话、关闭状态、未决 ingress/storage/recovery 以及同 Workspace 中尚未完成的清空请求不能被此入口覆盖。

键盘清空没有直接产生字段值或提交；原文继续由 session/ingress 保留，经 Apply 与 Save 后才能成为服务器结果。测试覆盖两种按键的批量选择、排序后目标保持、重载后恢复、保存及重开；另覆盖不支持清空的字段、焦点与选择不同、输入框原生 Backspace、IME/重复/修饰键、已有编辑、失败重试和四种桌面宽度。

本检查点只关闭键盘清空入口的迁移；上下文菜单、拖动填充及其余 Goal 验收继续保留。

键盘清空检查点最终结果：清空、复制、完整网格三套浏览器测试在 Chromium/Firefox/WebKit 共 75 项通过（含 15 项清空流程）；完整单元 55 文件/825 项通过。类型/边界、lint、发布包构建与三浏览器实际消费、空白检查通过。此结果对应键盘清空工作树；整个项目的最终统一验收尚未完成。

## Workspace 上下文菜单检查点

`workspace-context-menu.tsx` 只持有菜单定位和焦点，使用 native Popover 保留样式继承并进入 top layer。Viewport 提供右键、Shift+F10 和 Context Menu 键入口，原生子控件的菜单不被接管。DataGrid 捕获原单元格/选区、WorkspaceSnapshot、列/编辑器定义及 view；变化即撤去菜单，执行前再次比较实际快照。

编辑/复制/粘贴/清空走现有原文和固定目标链路；工具栏将命令描述交给可选 renderAdditionalActions，因此菜单的 undo/redo/save/refresh/recovery 复用同一能力、执行和反馈。单格编辑格式化失败时禁用该入口，不打开有损输入。中文/英文菜单标签均由 locale 提供。

新增三条三浏览器流程：真实剪贴板复制与批量清空/保存/已保存撤销/重开；右键不同目标编辑、原生文本菜单、活动输入保护、失败重试与重载；四种桌面宽度下的 top-layer 边界、主题继承、键盘焦点和权威更新失效。首轮边界失败来自测试使用普通 Event 而未提供 MouseEvent 坐标，修正事件构造后 9 项通过。

本菜单提供新 Workspace 命令集。行结构与冲突仍经显式审阅处理；旧 snapshot revert 不作为兼容入口。拖动填充、长期状态成本、durable 生成和最终逐条验收仍待完成。

上下文菜单最终检查：菜单/清空/复制/完整网格联合三浏览器 84 项通过；完整单元 55 文件/825 项、类型/边界、lint、发布包构建和三浏览器消费、空白检查通过。公开菜单消息契约及迁移说明已更新。完整 Goal 尚未达到全部退出条件。

## 填充与被拒绝输入的持久化屏障

填充现有实现冻结来源文本、行身份、字段映射、可见顺序与语义 revision，完成后打开普通矩阵会话；拖动和键盘共用该入口。远端变化使旧 revision 被拒绝时保留原始矩阵。原生拖动提示曾改变布局，已移为 fixed 状态层；复制提示不再被取值过程修改。`workspace-fill.test.ts` 检查二维重复、反向扩展、空文本及不完整/非连续轴拒绝；`workspace-fill.spec.ts` 检查原生拖动、键盘取消/落点、外来 token、排序与重开、权威完整文档、已保存撤销、失败恢复、过期原文及桌面宽度。

浏览器回归发现：旧 DurableCommitBarrier 在 reducer 返回 rejected 时不写 root。输入虽然在内存 ingress 中保留，却依赖下一次成功命令落盘。旧 durable-ingress 部分测试恢复前 refresh，因此没有验证最后一次拒绝本身。现改为 format 9：terminal rejected/ignored 可以提交完整 ingress、零 effects、相同语义 revision，但必须推进带 parent CAS 的存储 token；裸 semantic barrier 仍不持久化无 ingress 的拒绝。完成结果必须等待精确存储回执，未知回执仍冻结原 token；当前语义对象不被无变化的序列化副本替换。

队列前驱阻塞与入口校验失败使用内部 ingress-declined 决定，通过同一屏障。决策准备失败等待其保留操作完成；任务准备失败与过期 discard 审阅也保存原 ingress。新增独立恢复用例不再借助刷新：直接过期输入、写入中不提前完成、回执丢失及 checkpoint 导出、被拒前驱之后的 blocked 原文、决策和任务准备原文。故障注入新增 drop-rejected-ingress，直接恢复原先的错误早返回。

边界：底层存储明确拒绝写入、尚在 queued 或尚未获得持久化完成回执的输入，不能据此声称已耐久。仍需完成这类故障的耐久状态/UI 证据审计及 durable 崩溃生成覆盖。填充的自定义 series 已迁移到列级同步纯回调；长期历史成本、模型生成与最终逐条验收也仍开放。

本检查点结果：56 文件/833 单元用例通过；三浏览器完整 306 项通过；类型/边界、lint、demo 构建、发布包构建及三浏览器消费检查通过。变异基线 389 项通过，10 种故障全部检出；drop-rejected-ingress 触发 6 条失败。报告移到 `kernel-mutation-results/summary.json`，避免 Playwright 清空它拥有的 test-results 目录。源文件哈希检查通过，空白检查通过。

浏览器测试现统一使用 `tests/browser/test.ts`，流程结束前检查 console.error/pageerror。测试主动注入的 503 与连接中断在注入点登记，按精确 URL、错误文本和次数消费；其他错误仍失败。首轮因此揭示原来的流程通过并不代表无运行时错误：一次 React 跨组件更新警告尚未定位来源；最近带全局检查的完整运行未复现。WebKit 还在取消后立即刷新时报告 Blob 读取访问错误；原用例只等 Apply 禁用（提交中也会禁用），已改为等待取消按钮消失这一持久化后的事实，再验证重开。**任意时刻刷新打断资源读取的异常仍需独立调查，不能将正常取消流程通过视为该异常已修复。** 此项与 React 警告保留为开放的恢复/渲染验收事项。

## 任务取消入口

§15.2 C15 核查发现此前缺少任务 Escape 入口。现在仅在任务面板本身或取消按钮获得焦点时接管 Escape，与按钮点击共用 task-cancelled 命令；执行前读取实际 Workspace 快照并核对 taskId/executionId、终态、生命周期及持久化占用。同步重复按键不会重复提交。其他预览控件、编辑框、IME、修饰键和自动重复按键保持各自语义；英文和中文帮助说明及 aria-keyshortcuts 已更新。

owned-upload 的 none/button/escape/api 四条路径在三个浏览器执行。取消路径核对恰好一次语义 revision、原 input 引用、切换 owner 后原文未被迟到结果覆盖、重开后的 cancelled 状态、原文件逐字下载，以及实际服务器完整文档和版本未被取消任务改变。multi-image 另覆盖取消按钮上的 Escape、动作候选迟到保留和预览确认控件不被 Escape 接管。取消不宣称终止已经发送的外部工作。

本轮完整浏览器 318 项、单元 56 文件/833 项、发布包构建及三浏览器消费通过。随后将键盘处理范围收紧至面板本身和取消按钮，相关上传/批量图片/填充三浏览器 36 项通过；最终加强重开与服务器版本断言后，上传/批量图片 27 项通过。最终类型/边界、lint、demo 构建和空白检查通过。完整 318 项运行发生在焦点范围收紧之前，不能当作最终工作树全量运行记录。

逐项台账关闭的是 C01、C02、C15 的上述具体行为证据；C03 已核查生产路径但参考模型覆盖仍不完整，其余未审阅的断言不因套件整体通过而自动关闭。整个 Goal 继续 active。

## 刷新中断资源读取：独立归因与恢复证据

后续调查对上一节的 Blob 异常完成了独立归因。`scripts/probe-webkit-blob-navigation.mjs` 不载入项目代码，在真实 WebKit 中逐次 catch Blob 读取失败。停止后续读取时观测到 1 次 caught、0 次原生诊断；继续发起读取时为 10 次 caught、9 次原生诊断；两者均无 window error/unhandledrejection。这些是该次探测的观测值，不承诺浏览器各版本都有固定诊断次数。

机制与源码一致：[WebKit ThreadableLoader::logError](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/loader/ThreadableLoader.cpp) 将资源加载失败写入 JS 来源的 error 日志；[Playwright WebKit 的控制台处理](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/webkit/wkPage.ts) 会把这种日志映射为 pageerror。本地安装的 Playwright 1.62.1 coreBundle 中已核对相同分支。因此不能仅凭该 pageerror 将失败认定为业务 Promise 未接管。常规错误和真实脚本事件的断言继续保留。

`resource-interruption.spec.ts` 显式在同一浏览器回合发出取消并刷新，不假设取消已经提交；等待新文档 load 后验证原文件的字节、文件名、服务器完整文档、顺序和版本，且没有应用图片。该场景三浏览器重复 30 项通过。`interruptResourceWork` 仅在这类明确注入的导航窗口内记录最多一条 WebKit 同源 Blob、资源读取调用栈匹配的原生诊断，作为测试附件保留；任何实际 error/unhandledrejection 仍失败。另一个已存在的丢失文件任务回执重载用例也使用这一显式中断边界。普通流程不获得该例外。

尝试用 pagehide 失效检查阻止诊断并未消除复现，相关生产改动已撤回；没有为浏览器日志增加新的 Workspace 生命周期状态或在可取消导航时丢弃所有权。此轮交付为独立探测、明确的中断恢复回归和更准确的浏览器错误证据。完整结果：56 文件/833 单元、309 三浏览器用例、类型/边界、lint、空白检查通过；生产实现未改变，不重复发布包检查。React 跨组件更新警告仍未定位，统一测试已补充 console.error 调用栈附件，后续复现即阻止验收。存储本身失败时的耐久边界、生成模型、custom fill、长期成本和逐项最终审计仍保持开放。
