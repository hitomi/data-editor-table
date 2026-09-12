# 状态内核重构进展

本文是按时间追加的实施日志，包含已被后续实现替代的阶段方案和测试计数，不是当前 API 参考。接入从 [文档索引](README.md) 开始，最新测试增删及恢复验证见 [测试审计](test-suite-audit.md)，未完成要求见 [验收索引](state-kernel-acceptance.md)。

设计基线：[state-kernel-redesign.md](state-kernel-redesign.md)。允许 breaking change。
更新日期：2026-09-12。Goal 保持 active。

## 完成标准

生产 DataGrid 和公开 API 使用新内核，旧 draft/rebase/replay/history 实现已删除；协议适配器、
输入所有权、历史补偿、恢复和生命周期通过设计中的反例矩阵与独立模型比较；类型、lint、
构建、三浏览器实际工作流及发布包消费验证通过。设计完成或基础模块测试通过均不代表完成。

## 阶段状态

当前状态以 [验收索引](state-kernel-acceptance.md) 为准。下文按日期保留历史检查点，其中“尚未迁移”等结论只适用于当时，不代表当前状态。

| 阶段 | 当前事实 | 未关闭的验收 |
| --- | --- | --- |
| M0 | 编译协议、独立字段/结构/顺序模型及七类定向变异已有实现 | 保存域之外的 seed 生成、值缩减和完整输入/任务/恢复模型覆盖 |
| M1 | 文档、身份、完整写域及纯投影已接入生产 | 设计性质逐条核对 |
| M2 | memory/durable 保存、exact receipt、读屏障与冷恢复已接通 | 完整故障组合及 Source 保证验收 |
| M3 | 条件 undo/redo、恢复 lineage、结构与顺序已接通 | 混合动作和完整反例矩阵 |
| M4 | 会话、任务、ingress、关闭/交接/checkpoint、恢复界面已接通 | 输入归宿、旧格式和材料终结/回收审计 |
| M5 | DataGrid、标准类型、locale、全部示例和公开入口已迁移 | 剩余交互入口及最终三浏览器/包验收 |
| M6 | 旧 draft/controller/rebase/replay/history 实现及旧辅助入口已删除 | 长日志/渲染/引用压缩、完整需求验收 |

## 当前代码证据

- `src/kernel/model.ts`：独立的身份、文档资源、操作锚点、journal、提交覆盖、精确回执、会话/任务和持久恢复协议类型。
- `src/kernel/document.ts`：深度拥有并冻结编码值，显式区分 missing/null，拒绝有损序列化，支持完整路径写与确定序列化。
- `src/kernel/protocol.ts`：以顺序证据判断权威新旧，保留不可比较 frontier；校验提交项、完整写集合、coverage、回执身份及排序成员完整性。
- `src/kernel/entities.ts`：分离本地 EntityId 与服务器 key/incarnation；退休身份不复用，新增必须凭精确回执绑定，禁止刷新猜测绑定；恢复创建同样使用新 EntityId 并禁止旧 incarnation 复活。
- `src/kernel/intent.ts`：以 exact commit 或未决 reservation 决定 undo 的补偿/等待/抑制分支；原请求和原意图不改写，控制贡献用自己的 ID 接受 coverage。明确未应用时原贡献与抑制控制原子结算；selector 只归一化，没有写权限。新生成的历史命令可以沿显式 restoration lineage 找到当前实体，旧记录、任务身份和 receipt 永不重绑。
- `src/kernel/history.ts`：从 journal 索引导航栈；按原始写域编译条件逆操作，捕获当前完整因果前沿；redo 按原始 intent 顺序编译，复用动作模板、创建新的 application/intent 和写组，保留 sourceIntentId、semantic-read 与显式跨行/排序依赖。撤销未提交或被别人满足的要求不会生成对权威的补写。
- `src/kernel/order.ts`：独立持久顺序域，捕获完整逻辑顺序、权威基线与结构前驱；按精确 canonicalOrder/结构提交解析后继基线。一次有序归约同时提供顺序投影和各意图的读取上下文；顺序冲突与创建/删除依赖双向阻止部分提交，独立字段仍可保存；冲突预览保留新远端行。本地抵消排序保留为可逆 neutral 历史。
- `src/kernel/resolution.ts`：以revision/observation/issue IDs绑定用户审阅，编译use-authority、keep-local、merge、recreate及adopt-existing；原子撤回旧贡献并接纳新的意图/输入，拒绝修改reservation。新写入不复用旧coverage。
- `src/kernel/recovery.ts`：保留并验证完整恢复文档，按观察/receipt版本选择可靠材料；决策undo复制原始输入到新InputRef和RecoveryEntry，旧证明不回退。
- `src/kernel/session.ts`：单活动会话、不可复用SessionId和单调EditorLease；固定字段与显式读取值检查、输入版本superseded链、IME/detach保护、相关上下文显式确认，以及完整恢复输入束转交。字段应用原子移交journal，失败保留会话，明确取消记录输入终态。
- `src/kernel/view.ts`：版本化筛选表达式与显示排序、严格字段/操作符验证、保留查询历史作为输入终点证据；可见行从完整投影派生，不影响保存成员与持久顺序。Workspace分别暴露完整getProjection与getView。
- `src/kernel/task.ts`：明确session/field/workspace owner、任务与执行身份、独立输入归宿、相关字段generation、纯结果接纳及原子消费；superseded保留成功结果，cancelled阻止迟到消费，显式reapply绑定新审阅上下文。旧action重准备验证原比较值和semantic-read，不执行回调。
- `src/kernel/durable-task.ts`：固定版本的执行定义与幂等start/确切lookup契约；冻结Workspace/Task/Execution/definition/原owner/input及资源manifest的请求摘要；恢复使用同一个请求，资源字节在I/O前再次验证。网络错误只产生unknown，确切failed与成功证明均单独持久保留。
- `src/kernel/resource-ownership.ts` / `resource-store.ts`：内核资源登记/释放墓碑与完整历史引用检查，Runtime独立File/Blob内容仓库、读取副本、元数据及SHA-256资源包、固定revision导出和隔离恢复验证；拒绝输入也阻止释放和不完整导出。
- `src/kernel/ingress.ts`：Runtime 在语义接纳前拥有输入、命令和任务结果；按 EditorLease 的前驱链解析输入版本，拒绝/受阻材料保留，未知提交冻结队头。重试以新调度序号入队，明确归还/丢弃校验 generation 与完整后继链；联合投影提供当前编辑器原文，资源释放也检查队列引用。
- `src/kernel/recovery-store.ts` / `durable-commit.ts`：持久候选绑定完整workspace、lease epoch、attempt sequence、父root、event、transition和资源manifest的SHA-256；接纳回执必须完整匹配。写入未知时保留候选并查询原token，确定失败不发布，成功后一次发布state/result/effects。恢复校验完整记录和资源字节且要求新lease；不自行执行恢复后的effect。
- `src/kernel/indexeddb-recovery.ts`：真实浏览器RecoveryStore，origin Web Lock持有整个会话，IndexedDB事务再次核对epoch；严格持久事务中原子写根指针、语义记录、资源字节和确切结果。资源存为ArrayBuffer，manifest保存File元数据；缺失token查询写入永久否定证明，迟到写入不能越过它。释放先fence Runtime，等待已开始的存储工作结束后交还锁。
- `src/kernel/state.ts`：拥有不可变的数据事实与版本化权限，记录 observation/version、policy、权威 frontier、精确提交/拒绝及协议争议证据。
- `src/kernel/prepare.ts`：一次性运行显式业务写计划、在计算当时捕获 semantic-read 的资源和值（延迟接纳不能重读 expected）、生成路径或完整实体 write-base；准备结果绑定本地 revision、远端 observation 和 policyVersion。
- `src/kernel/journal.ts`：验证完整动作的 ID、因果依赖、写域和输入归宿，原子接纳 journal、批量输入所有权及本地实体注册；只有全部贡献结算才终结整份输入；结算求有限闭包，删除和依赖排序可在同一权威转换中完成，不要求额外刷新。
- `src/kernel/projection.ts` / `resources.ts`：从原始意图生成行、冲突、可保存行和满足证据建议；保留 missing/完整行比较语义，处理组原子性和跨行依赖，selector 无写入权。冲突携带 base/local/remote 及绑定当前 frontier 的标识。本地零净效果前缀由捕获的写域归一化为 neutralIntentIds，保留所有权与历史，不把局部抵消误记为每个动作的终态。
- `src/kernel/schema.ts`：固定版本的纯文档规则与字段写域；显式 codec 的独立复制、确定编码、无损 round-trip 和隐藏字段保留检查。自定义 copy/equals 的完整性是 codec 契约的一部分，不能对任意不守约的宿主回调作安全保证。
- `src/kernel/submission.ts`：从当前可保存意图生成请求，冻结前重验 revision、完整计划与精确 coverage；拒绝重复使用终态 OperationId。恢复创建必须携带已落账删除的 operation/item/identity 证明，源端再次校验；undo 使用冻结删除项实际的 before 文档，保留先前写的规范化与隐藏字段。
- `src/kernel/persistence.ts`：接纳精确提交/拒绝事实；在覆盖全部 frontier 的完整快照上原子更新身份、authority、coverage 和输入归宿。unknown 仅允许原请求重试；已应用只查询/读取；矛盾结果保留为协议争议。
- `src/kernel/transition.ts`：统一数据动作、条件 undo/redo、权限、读取、冻结、精确回执与不确定结果的原子转换，并返回可序列化 effects。memory Workspace 已接入这些 effects；等待 gateway 有显式 ticket，旧 ticket 完成不能清除新的状态。durable 生命周期尚未实现。
- `src/kernel/source.ts`：原始服务器身份/完整快照边界、基于精确 receipt 的 EntityId 绑定、真实 SHA-256 payload 摘要；所有 scope 包含物理 sourceId，冻结请求额外绑定 WorkspaceId。source 必须保证原子写、精确结果恢复及 scope epoch 内永不重复执行 OperationId。
- `src/kernel/gateway.ts`：同一 JavaScript realm 内按物理 sourceId 共享 scope FIFO 许可；拥有请求字节与摘要、结果查询、共享单调读取 frontier、精确结算后释放。超时、404 和缺项 receipt 均不释放或授权新写。持久Workspace的lease约束获取许可、摘要后及调用source前的执行；新epoch只能凭恢复state中的确切submission/commit/rejection证据接管同Workspace旧holder，保留原in-flight job和frontier。不同Workspace跨realm的scope排他仍需最终适配器/后端协议验收。
- `src/kernel/workspace.ts`：统一 `Workspace` 固定持有 schema/source/scope，memory/durable共享异步ingress命令和I/O流程；openDurable显式新建/恢复，已有root拒绝作为空工作区新建，恢复旧editor先durable detach。所有内部#commit消费者等待接纳；保存与任务启动/结果均通过持久屏障。runDurableTask先将完整原文交给ingress再计算摘要；recoverTask默认lookup，显式retry使用原请求，start与lookup独立去重使挂起调用不阻塞结果查询。旧lease不能发布迟到数据；close及完整checkpoint尚未实现。
- `tests/kernel/source-fixture.ts`：独立异步服务器模拟，自己实现完整版本/身份 CAS、原子变更、请求幂等和 exact receipt，支持响应丢失与读取/查询故障；没有导入生产比较器或 reducer。
- `tests/kernel/recovery-fixture.ts`：独立存储事务oracle，自己验证候选/资源摘要、父root CAS、epoch和永久token结果；可延迟事务、丢失回执或返回错误回执，没有导入生产存储验证器。
- `tests/kernel/durable-task-fixture.ts`：独立外部执行服务，验证请求/资源摘要，按Workspace和execution身份持有原请求及终态，支持启动前延迟、实际成功后响应丢失及失败证明，不使用生产任务或摘要实现。
- `tests/kernel/reference-model.ts`：不导入任何生产辅助函数的有限标量业务规格。它使用服务器字典、用户要求和请求/回执记录表达期望语义，尚不是完整的 M0 模型。
- `tests/kernel/causal-read-model.ts`：独立的持有表达式模型，抵消当前要求不改写已有消费者持有的表达式；27组嵌套中性前缀与远端变化组合对照实际kernel。
- `tests/kernel/order-model.ts`：独立的完整排列语义模型，以捕获的要求和权威顺序表达本地抵消、外部满足和冲突；另有基于实际服务器写入的单动作条件补偿 oracle；不替代完整结构变更/历史/网络模型。
- `scripts/check-controller-boundaries.mjs`：将新 kernel 纳入无 React、无旧 controller 依赖的检查。

新增的参考时序涵盖：删除冲突穿过部分保存、双方删除、回执先到但完整权威迟到、
精确规范化与后来的远端更新分离、派生值 semantic-read 不被规范化重写、unknown 撤销两分支、
主键复用、请求原子性/幂等、合并保存后的连续 undo、远端满足最终合并目标。

新内核的数据链路覆盖：删除冲突与无关行规划/满足、双方删除、物化失败后连续刷新、
整行 CAS 的隐藏字段、原子字段组、业务计划只运行一次、权限撤销与恢复、批量输入的部分
结算、事务/依赖传播、取消未提交新增、主键冲突、无效第二项导致整动作拒绝、
同 observation 下迟到本地准备和刷新失败。独立模型对照发现并修正了 oracle 对
`0→1→2，remote=1` 的错误宽容：未分段结算的链必须比较 base=0、target=2，不能把
中间显示值当作提交证明。这是规范明确要求的结果，现已成为独立反例。

保存 reducer 的 20 个案例使用独立标量服务器执行实际请求，涵盖：部分保存后的删除冲突、
规范化与后继输入、延迟 receipt 与更新权威、semantic-read、刷新失败屏障、同 ID 重试、
可信 not-applied 的逻辑 fallback、仅成功通知仍等待 exact receipt、缺项回执恢复、
重复/矛盾回执、伪造 coverage、主键回填、读取先于创建回执、创建后远端删除、
同提交版本的矛盾快照、因果不可比较 frontier、顺序字段组及批量输入的部分提交。
这些案例已运行 reducer 和模拟服务器，并非仅比较保存计划。新增 gateway 和 memory Workspace
测试进一步执行完整异步 source 接口；尚未连接真实网络后端或生产 DataGrid。

gateway/source 的 17 个案例覆盖物理 source 和 Workspace 隔离、两个 adapter 共享排他许可、
许可在异步摘要期间被取消、原子拒绝证据、跨请求共享读取屏障、创建精确身份和请求摘要。
Workspace（memory模式） 的 19 个案例覆盖发送前已发布 reservation、部分提交后的后继输入、
保存期间规范化与 detach、旧缓存读取阻塞、丢失结果后 lookup、同请求显式重试、
等待许可期间继续编辑、后端确定拒绝、错误回执不产生无限查询，以及拒绝输入保留。
其中异步 digest 期间继续编辑的用例验证旧候选不会发送，重新保存会提交完整新计划；
新增用例执行了保存中 undo、补偿保存、redo 再保存，以及未决创建撤销后明确拒绝时补全
此前因身份不明而保留的读取屏障。

条件历史的 59 个测试包含 24 组标量时序、168 组排序补偿和27组嵌套读取独立模型比较，覆盖应用/拒绝、规范化、后来的远端
变化及 undo 时机。实际模拟服务器案例验证合并保存的连续撤销、部分行保存、missing/null、
原请求未知时 undo/redo/再 undo、精确创建 incarnation 的删除、重做创建的新 EntityId、
跨行依赖和原始 semantic-read 不丢失。redo 的动作 ID 指回模板，但 application、intent
和写组均为新身份；放弃 redo 分支不会删除旧请求或输入证据。

删除恢复现已穿过 kernel、共享 gateway、独立 source 和 memory Workspace：source 明确
允许从完整删除文档创建新 incarnation，当前 create/replace 权限持续约束恢复；不支持的
source 对已应用删除的 undo 明确拒绝。测试覆盖旧字段动作继续 undo、两代恢复、
恢复规范化后的远端冲突、原删除结果未知/拒绝、替换权限撤销和错误旧 incarnation 回执。

本轮直接复现了两个原模型缺口：`create→delete→undo delete` 没有恢复新增行，
`0→1→0→undo` 仍显示0。原因是本地抵消被逐项终态结算，破坏了前序要求的 provenance。
现已改为可逆的中性前缀：没有网络写，但 journal/input 继续拥有材料；刷新和新编辑
不会复活已抵消的前缀，只有历史导航改变前缀后才重新投影。独立标量模型同步区分
neutral 与真正的外部满足，测试覆盖撤销前序、后续刷新、无关行保存以及宽窄写域组合。
保存结果将 neutral 历史与 remaining 待写贡献分开返回，后续 close/durable 必须保留其
恢复材料，而不能把“无需写入”解释成服务器提交证明。

持久 order 的 23 个测试包含一项 252 组独立排列比较，并实际执行只改排序、一次中间
插入 server-assigned 创建、删除并重排、行/排序事务闭包、原子失败、规范化后继、
新远端成员保留和创建前驱的比较基线。Workspace 测试验证 ordered commit 后旧读取
不会回退展示，恢复只读取而不重发。

新增的条件排序历史覆盖未知请求的应用/拒绝分支、canonical 顺序比较、远端后续重排、
合并动作的连续 undo/redo、中性前缀在刷新后的导航，以及行/排序独立部分补偿。
创建加插入位置、删除加重排都已执行保存→撤销→再保存→重做，恢复使用新实体身份；
Workspace（memory模式） 同样执行了有序创建的完整往返。

重做已从“每行一条合并记录”改为每个原始意图一个控制，保留原 sequence 和 sourceIntentId。
跨行反复写、插入 order、依赖前一个中间值的 semantic-read、创建后的 write/replace
均以原序列编译，映射到新贡献和新创建身份；不再因按行压缩而拒绝这些动作。
逆操作补齐 write/replace 混合动作、同一动作写后删除，以及整实体比较域的保留。
删除恢复以实际冻结 before 为基底，只重放该删除项精确 coverage 中目标动作之前的
贡献；测试验证此前的本地目标不会丢失，迟到的 canonical/隐藏字段也不会回退。

跨资源顺序读取现已使用同一有序归约提供的逐意图逻辑顺序，policy-guard仍读取
原始authority。测试覆盖排序后计算一次保存、创建后的顺序读取、后继排序不提前执行、
规范化使旧读取阻塞、重做时order读取值映射新实体。另一个直接复现的问题是：行在排序
依赖传播前已生成外部满足建议，导致目标相同的计算输入提前结算；现已把满足证据限制在
完整行/排序依赖闭包之后，失败回归验证原输入仍由journal拥有。

中性前缀的最终写入与历史读取已经分开：早先消费者通过自己捕获的因果前缀验证中间结果，
抵消之后的新输入读取当前authority。前缀只用于纯验证，不发布、不提交、不结算；缓存按
严格递减的sequence共享。独立表达式模型比较27组双层读取与远端值组合，实际source测试
确认只提交消费者，A/B的零净效果写入不会复活。完整schema仍在最终候选上运行。

无显式order的删除恢复现在也还原原位置。动作保存原始authority顺序及其因果前沿，
条件order引用同一批恢复控制；一部分删除已应用、另一部分未知后被拒绝时，旧实体保留，
只有实际删除的实体映射到新的恢复身份。测试覆盖中间位置、两代恢复、远端重排冲突、
部分应用/拒绝，以及临时恢复行上的新编辑：原删除被拒绝后，新编辑保留为已失去目标的
输入，不自动附着到旧行。顺序冲突仍阻止恢复创建偷偷按默认追加保存。

冲突决策新增13个测试，实际source覆盖五种选择、再次远端变化、semantic-read拒绝、
只读隐藏字段、完整排序成员、新身份重建、过期/篡改拒绝、同一行只丢弃未知请求的后继，
以及决策保存后的undo/redo。控制记录和旧目标discard、新payload及新输入身份在同一
转换接纳；原请求bytes与reservation保持不变。Workspace（memory模式）实际执行决策保存、
补偿、重做和过期merge原文保留。

恢复材料新增4个测试：动作保留完整开始文档与observation，远端删除之后仍保有隐藏
字段及missing/null语义；迟到canonical可以补全更早捕获的文档，更晚捕获的远端材料
不会被旧receipt覆盖。恢复材料篡改在普通动作边界被拒绝，读取材料不生成数据写入。

决策undo现在创建明确RecoveryEntry，输入取得全新InputRef并指向recovery归宿；
数据部分独立执行条件补偿。redo成功接纳时归档对应条目及其输入，失败时不转移所有权。
未知结果应用/拒绝、当前权限拒绝redo均已验证。条目现可整束转交Session，随后原子送入
Intent或随明确会话取消记录终态；资源manifest及durable语义保存已接通。直接丢弃
available条目、关闭blockers和完整checkpoint仍属于接下来的M4工作。

会话新增9个测试：输入版本重复/乱序、IME期间拒绝应用、detach/remount释放composition
并隔离旧lease、无关刷新与相关值变化、删除/权限阻塞、批量缺项/越界/原文篡改/过期准备
原子拒绝、SessionId不复用、两份恢复原文完整转交及取消。普通prepared-action入口仍拒绝
直接拿走session输入。Workspace新增实际source流程，验证卸载保留、接管后应用、保存
canonical值及隐藏字段、重新打开时捕获新的权威值；这不是浏览器端到端验收。

会话再新增4个测试：删除后明确缩小批量目标、重选失败保留旧上下文与恢复材料、筛选输入
转交确切ViewQuery版本、无效表达式及同列并发筛选后的重新审阅。重选目标更新输入版本
及editor generation；重新审阅上下文更新输入版本，迟到准备和回调不能套用新上下文。
4个view测试验证missing/null/类型区分、组合表达式、稳定显示排序、查询版本与成员校验，
以及筛选隐藏的修改仍进入保存计划。Workspace实际source用例同时验证筛选隐藏该行时
仍保存canonical值，重新打开从权威读取新值。查询历史保留已应用输入的原始版本证明。

当前session支持字段编辑、恢复输入、显式目标重选、filter→ViewQuery和typed task输入
接管。任务新增14个内核测试，验证candidate一次性消费、迟到成功保留/明确重新应用、
会话取消及完整输入束终态、detach/无关刷新、field generation、权限恢复、两行操作中
第二行失败的原子拒绝，以及旧semantic-read不能被重准备改写。错误会话目标的有效
成功结果也保留为blocked，普通consume不能绕过目标审阅。

另有6个Workspace异步测试：queued/running在I/O前发布，cancelled在Abort监听器前
发布；微任务启动前取消不执行executor；输入改变后迟到成功保留且重新应用不重复I/O；
无关刷新后的完整任务动作穿过真实source保存；权限恢复后消费原结果；执行失败保留输入，
外部不能注入task transport事件。Task执行与保存通道分开，Task consumed不等于服务器
已保存。

资源新增6个测试，使用真实File/Blob验证字节/元数据独立持有、读取对象不共享可变属性、
未知输入引用拒绝、取消后历史保留、暂存资源完整导出、Blob-only内容恢复File元数据、
缺项/重复/截断/摘要不符/错误工作区版本拒绝，以及导出期间释放暂存仍保留原快照。
Workspace异步测试再新增4个：File输入穿过任务、exact save和资源恢复；受阻任务的
文件结果在取消后仍由历史持有；拒绝动作在InputLedger之外持有资源；不存在字节的
拒绝输入会阻塞资源导出。当前task-workspace共10个测试，资源登记/释放对外仅由
Workspace拥有物理内容后发起，外部不能注入资源事实。

ingress 新增9个测试：异步提交期间连续输入、前驱失败整链恢复、禁止跨应用合并、
失败输入阻塞旧文本应用、序号/分叉/整链归还校验、提交后回执丢失冻结及精确恢复、
同revision重试仍隔离旧token、旧lease保留输入不阻塞新编辑器，以及旧应用命令重试
不能越过较新的保留输入。原始sequence作为身份审计保留，retry推进scheduledAt和
generation，以当前调度顺序检查前驱。已接纳receipt只保存必要元数据，避免长期持有
完整旧状态快照。

Workspace另新增3个测试：成功任务结果被前序输入阻塞时仍由ingress持有，修复后消费
且不重复执行I/O；明确会话取消同时处置未接纳原文和任务结果；Abort监听器重入的
程序化命令现在进入统一队列，Promise在实际接纳后返回accepted，不再同步报告busy再丢掉命令。
当前task-workspace共13个测试。
成功结果待接纳时，语义Task可能仍是running；物理执行已结束，恢复入口必须同时
查询ingress，不能把该状态解释为执行失败或自动重跑许可。

IngressQueue和DurableCommitBarrier现在接入统一异步Workspace。memory模式仍立即
发布内存转换，Promise表达真实完成；durable模式先验证存储回执再发布。内部资源登记、
读取、gateway等待、请求冻结、回执、任务启动/结果消费者均等待#commit；重入命令排队。
typed task的普通callback入口仅用于memory；durable模式通过runDurableTask使用明确的
版本化执行定义，拒绝把任意callback当作可恢复外部动作。

新增8个durable Workspace测试：实际source规范化保存后重开与再编辑；冻结落盘回执
丢失后不发送，存储查询后先协调原OperationId，再显式原请求重试；丢失确定失败回执
仅解除未使用许可；source已写但receipt落盘失败时保留并重试接纳；新lease接管仍在
进行中的请求且旧Runtime迟到结果不发布；完整权威已落盘但回执丢失、恢复state已idle
时仍凭commit证据完成旧gateway结算；资源登记被拒绝后字节仍可重试；旧editor持久
detach和不可恢复任务回调拒绝；已有durable root禁止作为新空Workspace打开。

gateway再新增3个回归：摘要等待期间失去lease不调用source；恢复state漏掉旧请求时
拒绝接管且保留原许可；在收到快照时预分配的实体ID不覆盖先接纳的精确创建回执绑定。
新的server-authority-received事件在队头按当时的完整state绑定身份，不在网络回调
尚有持久候选排队时提前决定身份。

新增2个Workspace浏览器流程在三引擎共6项通过：真实IndexedDB加fetch到独立source
模拟器，编辑/应用/保存canonical值/重载恢复后拒绝旧读取；source已写但网络响应丢失，
页面重开后只lookup原请求，输入完成精确结算且没有重复写入。这些流程使用新Workspace，
仍不是生产DataGrid界面的迁移验收。

持久任务新增14个测试：登记及running落盘前不执行；成功结果与完整输入束原子交给
会话并保存；实际成功但响应丢失后重开仅lookup原执行；结果落盘未知/确定失败保留并
恢复；原调用挂起时独立lookup可取回结果，迟到重复成功不再次增加输入版本；登记后
尚未启动时重开先lookup，明确retry复用原请求；确切失败与网络unknown分开；superseded
保留结果供显式reapply，cancelled只记录迟到终态；新lease阻止旧结果发布；File元数据/
字节摘要与定义版本在恢复后不变；错误执行ref的成功留在ingress；取消后的File结果仍
由执行证据持有，矛盾终态被拒绝；摘要计算前ingress已拥有原文并阻止释放文件；登记
尚在落盘时排队的会话取消阻止随后启动外部工作。

另有2个真实持久任务浏览器流程，三引擎共6项通过：File请求在实际执行前丢失时，
重开查询unknown且不自动启动，显式重试原身份后只执行一次；实际执行后响应丢失时，
重开查询原成功且不再次start。两条路径均把结果及File原输入交给会话、应用并保存到
独立source，隐藏字段保留。存储/Workspace/任务三个浏览器文件现在共24项。

执行取消只停止本地等待和自动消费，不是远端未执行证明。Task已cancelled但execution
outcome仍未知时，后续close/checkpoint必须保留它的协调材料，不能仅按Task.kind清理。
恢复扫描已接入；恢复UI、完整checkpoint转交和生成守恒模型仍需后续阶段验收。

durable新增13个测试：落盘前不发布、连续键入顺序、确定失败后换新attempt而保留父root、
成功/失败回执丢失后仅查询原token、错误世代的正/负回执均保留unknown、resource原子恢复、
event/state/effects篡改拒绝、冻结请求的send effect在持久成功后才交付、后继本地事件后
恢复仍保留原submission、失去lease后迟到成功不发布，以及确切父root CAS和查询否定
证明阻断迟到写入。同epoch恢复被明确拒绝，避免已拒绝attempt的序号与旧root序号混淆。

新增4个真实存储浏览器流程在Chromium/Firefox/WebKit共12项通过：连续输入与File历史
经过页面重载恢复；第二标签页不能取得活跃Workspace；显式释放fence旧Runtime后新实例
取得新epoch；回执丢失后原token协调且重载不重复输入；缺失token的永久否定结果阻止
稍后到达的写入。WebKit最初在Blob写入IndexedDB时中止事务，最小复现证明ArrayBuffer
写入成功；现统一使用原始字节持久格式，三浏览器均以manifest重建File元数据。

持久层当前保存完整语义根记录并保留最小确切结果历史；资源按身份与摘要保存。尚未完成
大型authority分块、内容去重写入优化、资源GC或quota/强制进程崩溃矩阵。页面reload验证
不代替操作系统掉电保证。恢复读取的是受信任事务存储中的记录，摘要验证完整性，不把
任意宿主构造的JSON当作合法语义历史。已登记的持久Task请求/定义ref/执行证明已在语义
根记录中；尚未接纳的ingress仍需后续完整checkpoint纳入。恢复定义实现由宿主按相同
id/version重新提供，不能序列化或恢复一个正在运行的JavaScript Promise。

恢复不能只重放最后一条记录的effects：冻结请求后仍可能发生本地编辑，最新记录因此
没有submit effect，但完整state仍持有sending reservation。Workspace恢复现在从
该state协调原OperationId/hash，先lookup，不能从“没有effect”推断无需恢复或新建请求。

完整checkpoint、生产恢复入口、引用压缩/资源GC、完整守恒生成模型及
UI桥接仍需后续M4/M5补齐。ResourceBundle只验证资源部分，不能据此关闭工作区或
恢复运行中Promise。旧列筛选回调尚未生产迁移。

M3尚未达到退出条件：尚需源/权限/历史能力投影、更多结构/因果生成模型，以及前缀
投影的大规模复杂度审计。当前通过的手工和有限模型案例不能代替这些退出检查。

这些证据验证基础协议与参考模型的局部行为，**尚未证明生产保存链路使用新设计后正确**。
当前模型限制包括固定的有限标量场景，尚无完整的 redo、restore capability、order、
输入归宿/任务/会话/durable 模型及故障调度生成器；不能以当前案例数量代替 M0 退出条件。

## 2026-09-11 关闭协议检查点

新增lifecycle投影和Workspace.requestClose()/close()，首批支持clean-close/retain。
关闭ticket绑定Workspace、语义revision、ingress generation、runtime generation和
实例/租约epoch；刷新/保存刚进入异步队列时就使旧ticket过期。关闭同步封住所有输入
接纳入口后才异步释放租约；失败保留closing，原票据可重试，不能误报closed。

blockers覆盖隐藏行中的未提交意图、原文会话、task结果、取消后尚无终态的外部执行、
未处理recovery、未使用File、未接纳ingress、未知存储和仍在运行的memory回调。
neutral历史单独返回，不制造网络请求或settlement。原runtime可能保留共享gateway
reservation，即使恢复根已idle；关闭仍须先通过原操作协调释放它。

新增11个针对性关闭测试。真实浏览器新增关闭释放Web Lock、拒绝旧实例后续命令、另一
标签页获取新租约并恢复已保存输入的流程；原保存/任务恢复矩阵继续通过。
尚未实现完整checkpoint、discard及恢复管理器移交，关闭功能不能替代这些M4退出项。

## 2026-09-11 保存调度检查点

新增save-schedule模块：模式、delay、token和pending随语义状态持久化。默认manual，
可显式切换immediate/debounced；journal authoring触发，原文和view不触发。Workspace
统一定时器经durable/ingress/source屏障进入原SaveRequested协议，旧token不能执行。
Unknown不自动重试；后继动作等原操作完成coverage/authority后再保存。fresh authority/
policy只在新增可保存贡献时重新触发，重复刷新不产生失败重试循环。

13个测试覆盖模式切换、旧token拒绝、防抖、隐藏/阻塞部分保存、规范化后继、未知请求、
网络失败、存储回执丢失、旧timer fence、新租约恢复，以及旧恢复格式拒绝且根不变。
SaveRequested本地回执丢失而尚无submission的情况新增明确not-started恢复结果，避免
永久卡在waiting-for-gateway。恢复文件格式为2；格式1保留在存储中但不自动兼容恢复。

首次浏览器测试暴露“无工作时自动空转换使session-opened过期”，在内核消除无工作/
neutral/全阻塞触发后复测通过；没有在UI增加重试。新增两个三浏览器流程：pending
防抖随页面重载恢复并保存canonical数据；立即保存Unknown重载后只协调原操作，再自动
保存后继输入。尚未迁移生产DataGrid，不能把这些fixture流程当作生产UI验收。

## 2026-09-11 恢复扫描检查点

新增RecoveryPlan、recoverPendingWork和逐项进度；从完整语义根及gateway reservation
收集存储、保存和durable任务，而非仅重放最后一条effects。openDurable可选择lookup
启动扫描；manual为默认协调时机。扫描先协调未知存储，再独立查询原source操作及各
任务，所有结果仍经统一输入/存储屏障。恢复的Task登记不会自动start未知外部动作。

缺少原定义版本、未知结果、未接纳输入和待重新应用结果仍完整可见。扫描completed是
有限查询遍历完成，不等同clean-close或所有输入已终结。扫描调用合并，挂起的source
请求不妨碍Task交付；租约丢失后旧实例不能发布。多任务争用同session时，一个接纳、
另一个保留superseded结果，原输入不会被覆盖或遗失。

新增9个单元测试和一个三浏览器恢复流程；保存与File任务的原响应均丢失后按原身份
协调，分别保持settled-intents与applied-to-view归属，重载仍保持canonical数据。
这仍是内部fixture，生产恢复UI与完整checkpoint/discard转交尚未完成。

## 2026-09-11 Ingress checkpoint 子格式检查点

新增同步ingress导出、结构验证和暂停恢复。保留原sequence/scheduledAt/generation、
完整receipt及前驱输入链，重建head与待处理队列；committing恢复为原attempt的uncertain，
只能通过外层确切存储结果继续。即使语义状态已发布但receipt还没登记，也不重放输入。
恢复默认暂停，新输入不会触发旧队列，外层租约/协调准备完成后显式resume。

7个针对性测试覆盖已接纳前缀与失败后继、未知active、publication/receipt窗口、退回
输入序列、故意被拒绝的前驱、恢复暂停，以及根/receipt/sequence篡改拒绝。验证索引按
输入ref和lease建立，避免逐receipt扫描完整InputLedger或逐队列项扫描pending。

尚未接入Workspace完整checkpoint：暂存资源（尤其被拒绝的File登记）、未知存储token、
摘要、导出/导入和关闭转交仍需统一实现。这里不把IngressCheckpoint当作可关闭工作区
的持久化证明；生产入口和公开恢复API仍未迁移。

## 2026-09-11 完整物理资源清单检查点

ResourceStore新增完整物理导出/恢复：包含未发布/存储拒绝的File登记、标准元数据与
字节摘要，以及retired身份。普通语义ResourceBundle保持原有严格available成员约束，
两条路径共享字节捕获与摘要校验，未通过物理恢复伪造语义资源状态。

5个新增测试覆盖导出中释放/新增资源、未发布身份的退役记录、语义release与物理清理
之间窗口、资源与ingress组合恢复后按原身份重试登记、缺失/损坏字节及重复身份拒绝。
新资源清单尚未接入Workspace完整checkpoint或checkpoint-close；外层语义根、存储
attempt、完整摘要、租约转交及关闭票据核验仍需实现。

## 2026-09-11 完整checkpoint导出与校验检查点

Workspace.exportCheckpoint已组合语义state、close ticket、ingress、完整物理资源、
原source reservation和durable已发布/未知record。统一摘要覆盖所有元数据与字节摘要，
校验父root、state、attempt、epoch和File引用之间的对应关系；validator只返回独立
资源及元数据，不执行事件或激活新实例。

7个新增测试覆盖被拒绝File登记、未知输入与导出后新键入、异步编译的Task登记、
重新生成外层摘要仍被拒绝的组件错配、进行中存储写入、不可恢复memory回调/缺失字节，
以及原source操作身份。三浏览器恢复流程新增了完整checkpoint的structuredClone、
验证和File读取，确认unknown source/task及文件原文都被完整捕获。

尚未完成导入后的Workspace激活、持久checkpoint根、文件传输编码、租约移交与
checkpoint-close/discard。因此导出成功不能用于释放当前工作区；生产迁移仍未开始。

## 2026-09-11 新租约 checkpoint 存储屏障恢复检查点

DurableCommitBarrier.restoreCheckpoint接入完整校验、当前存储根核对和新epoch恢复。
只接受捕获根或原未知candidate的精确后继；拒绝旧checkpoint覆盖较新根、同epoch激活、
向不相关空存储安装，以及读取期间丢失租约。保留暂存File字节和原未知commit token，
通过确切结果完成原ingress attempt；publication/receipt窗口不重复提交或执行effects。

新增7个测试验证以上分支，包含原未知提交成功/失败两种结果。尚未接入可写Workspace，
后续必须把完整ingress/暂存资源随根持续保存，并核验关闭ticket，避免恢复后再次重载
丢失输入。完整checkpoint关闭与租约转交仍未完成。

## 2026-09-11 普通持久根的物理资源库存检查点

RecoveryRecord升级为format 3，普通提交的manifest包含未发布暂存文件，并将
retiredResources纳入候选摘要。恢复和后续提交保留暂存资源及身份；已发布release
在该根中排除字节并保留退役身份，不依赖运行时清理时序。格式1/2拒绝恢复且不覆盖原根。

5个新增单元测试覆盖登记被拒绝后连续提交/两次恢复、释放前清理窗口、未登记即退役、
库存摘要/字节损坏和旧格式拒绝。三浏览器新增真实IndexedDB测试：暂存File及未登记
退役身份跨两次页面重载、detach/attach提交后保持不变，未伪造语义登记。

仍须持久化完整ingress及checkpoint head；当前只证明成功提交捕获到的物理库存可恢复，
不证明尚无后续成功提交的暂存文件已落盘，也不证明被拒绝登记的原命令已恢复。

## 2026-09-11 Workspace ingress 随根恢复检查点

RecoveryRecord升级为format 4。Workspace提交包含推导后的完整ingress快照；接受回执
和会话/任务取消的队列处置与语义状态、资源库存一起原子落盘，运行队列不提前成功。
恢复保留原输入身份、失败前驱链、全部receipt及暂存File；queued后继转待审阅，不自动
执行任务。旧editor持久detach后，新lease输入与旧恢复原文分离。

clean-close会先持久化仅改变ingress的归还/丢弃等处置，再核验完整关闭ticket，防止
关闭后重开又出现已归还输入。失败/未知保持实例并保留原attempt，期间新输入使关闭
失效。无效原始资源引用仍作为失败材料保存，不阻止独立结果提交，也不伪造缺失字节。

10个新增单元测试覆盖存储前不可见回执、失败输入链/新lease/再次恢复、原File登记
重试、未知task登记与queued后继、原子取消处置、缺失资源、摘要损坏、关闭刷写及
并发/失败/迟到输入。浏览器新增两条三浏览器流程：File登记失败后多次恢复并原ID
重试，以及归还命令后直接clean-close再重开。

本阶段尚无独立checkpoint head或完整checkpoint-close/discard。未进入后续成功
候选的队列变化仍只有运行时所有权；这不是任意时刻崩溃都能恢复全部尚未接纳输入的
承诺，也不是完整Workspace checkpoint导入/转交已经完成。

## 2026-09-12 完整 checkpoint 激活与字节传输检查点

Workspace.openCheckpoint接入durable完整快照，原未知存储token先查询、旧effect不重放，
普通恢复与checkpoint激活共用租约、输入队列、资源、旧editor detach及可选lookup扫描。
有editor时以detach写入导入内容，无editor则显式安装checkpoint根，后续普通重载仍能
找到原失败输入及File。安装失败/未知保留在返回实例的runtime issue和ingress中；
原未知存储结果不明确则尚不激活，调用者保留原checkpoint和session。

encodeCheckpoint/decodeCheckpoint提供ArrayBuffer传输，验证摘要及元数据，decode
同步复制所有外部buffer，避免调用者在异步验证期间修改恢复内容。9个激活测试和3个
编码测试覆盖File、原unknown输入、任务effect不重放、原freeze未提交、安装失败重试、
字节损坏及并发修改。保存响应丢失后导入、继续编辑、协调原保存、再次保存和重开，
证明后继编辑及canonical数据不被旧保存覆盖，也不重复执行原写入。

三浏览器新增完整跨页面流程：尚未进入普通根的File/ingress通过独立测试archive传输，
导入后再次普通重载仍可按原ID重试。该archive只是测试传输载体，不是生产checkpoint
head、关闭ticket校验或租约移交。memory checkpoint恢复及checkpoint-close/discard
仍未完成，生产DataGrid仍未迁移。

## 2026-09-12 持久 checkpoint head 存储契约检查点

新增CheckpointCommit/Token、完整快照校验、确切回执及CheckpointRecoverySession。
IndexedDB适配器在同一排他租约下原子比较checkpoint父头与语义根，写入完整快照、
文件字节、新头和结果；不推进语义状态。缺失token lookup形成永久否定证明，响应
丢失按原commit查询，同epoch/id不能换父头或快照复用。数据库结构升级到2，保留
现有语义记录、资源及outcomes。load返回经过完整校验的原始快照。

7个独立存储oracle测试覆盖完整File/输入、双CAS、丢失响应、永久否定证明、租约丢失、
元数据/字节绑定和未知语义commit的精确后继。三浏览器新增实际存储头跨租约恢复与
旧数据库升级流程，确认旧语义根、文件名、时间及字节未受新增对象仓库影响。

尚未把checkpoint头接入Workspace关闭、普通启动选择和原子消费。当前明确调用
checkpoints.load后通过openCheckpoint恢复的流程已验证；它不能代替checkpoint-close。
下一步须将消费头与新语义根提交原子绑定，并复核完整关闭ticket，再释放租约。

## 2026-09-12 checkpoint head 选择与原子消费检查点

RecoveryRecord升级为format 5，将checkpointParent纳入完整候选摘要。普通恢复优先
选择未消费头，裸barrier恢复拒绝绕过头，显式旧归档不得替代当前头。语义写入同时
比较语义父根及checkpoint父头；新根和清除头原子提交，较早准备的候选不能越过
后来存储的checkpoint。安装失败保留头，响应丢失后仍可从头或新完整根恢复。

消费校验完整ingress身份、旧receipt、调度序列、原输入/lease接纳证明和物理资源
库存。6个新增测试覆盖普通启动选择、安装失败/失去响应、迟到写入、旧归档误选和
丢失输入/回执/字节的候选拒绝。三浏览器新增真正挂起语义候选、先提交checkpoint
再释放候选的事务竞争；已有存储头恢复流程改用普通启动，并断言头被原子消费。

尚未完成checkpoint-close、活跃实例存储新头后的接纳与关闭票据复核。存储头与
原子消费已经可供协调器使用，但尚不能把低层stored结果直接当作可释放实例的证明。

## 2026-09-12 durable checkpoint-close 检查点

Workspace接通checkpoint-close，保存完整原文、失败ingress与File，再移交租约。
准备快照及确认确切回执后两次核验完整ticket；并发新输入或retain使关闭过期。
成功保存但关闭过期时，活跃barrier接纳新头，后续写入可原子消费，避免卡在旧父头。
未知及不匹配回执保留原token，重复关闭只查询原操作。租约释放失败保持closing，
输入入口继续关闭，重试不会重复写checkpoint。外部任务只中止本地等待，不推断取消成功。

替换checkpoint头同时验证所有权守恒，拒绝持有最新parent却携带旧输入快照的写入。
11个关闭测试覆盖输入/文件、未保存编辑、丢失或错误回执、确定失败、并发输入、retain、
释放失败、未知语义提交及运行中任务。新增三浏览器流程验证跨页面失败文件转交、
丢失回执按原token查询、未知保存重开后恢复canonical且不重复源写入。
这些仍是内部fixture；memory恢复、显式discard和生产DataGrid迁移未完成。

## 2026-09-12 memory 同进程独占交接检查点

新增Workspace.transferMemory，以活跃原实例和完整ticket作为所有权证明。
完整快照与资源恢复验证成功后，同步撤销旧写入口，移交新实例并解除旧editor绑定。
并发输入、retain及第二次交接不能产生陈旧恢复或双写实例。保留原ingress身份、
失败原文、意图、File元数据/字节及自动保存已尝试token。运行中源操作、未知源请求
和memory callback留在原实例，先完成或协调，不自动重放。

9项测试覆盖原文/File、意图保存一次、并发输入/retain、双交接竞争、失败ingress、
未知源保存协调、callback完成后转交、缺失文件与运行中刷新/源替换。
这是同进程memory交接，不是任意归档导入或跨页面持久恢复。

## 2026-09-12 显式 discard 与恢复历史边界检查点

接通memory/durable的close(ticket, 'discard')。原子记录workspace-discarded意图/输入
终态、资源处置和历史边界，保留既有提交证明、原始输入、任务结果和审计文件。
较早的失败ingress与语义根一同终结，后来到达的输入保持所有权并阻止关闭。
未知存储结果只协调原候选；源操作和未决外部任务必须先得到确切结果。
旧discard命令的重试不能绕过新票据审阅。恢复后只能撤销discard之后的新动作。

资源处置与物理回收分开：丢弃提交期间到达的新输入仍可能引用原File，因而不在
discard候选中删除文件。新增竞态测试验证后续刷新落盘、重新打开时原File字节与
失败输入一起保留。RecoveryRecord升级为6，旧1–5格式明确拒绝，数据库布局仍为2。

12项单元测试覆盖memory/durable关闭、提交事实保留、恢复历史边界、失败ingress、
File资源处置和迟到引用、存储失败/未知回执、并发输入/retain、旧票据重试、未知源保存、
本地取消后的未知外部任务及checkpoint验证。三浏览器新增真实关闭并重开流程，
验证已丢弃编辑不复活、未知保存必须协调且canonical结果仍保留。

## 2026-09-12 命令能力投影检查点

新增getCapabilities/projectCapabilities和共享history命令准备，实际undo/redo及能力
读取使用同一套准备/校验。save提供精确可提交成员、剩余活跃意图和不可恢复删除警告；
history区分不可用、受阻和可记录的条件操作。能力读取不预留ID、不改状态、不执行I/O。
语义缓存与实时runtime阻塞分开，避免源活动、未知checkpoint或关闭后仍显示可执行。

7项测试覆盖缓存/无副作用、部分保存权限、删除能力、未知源条件undo、runtime变化、
未知存储/discard历史边界和未应用原文。既有checkpoint未知回执测试补充能力断言。
三浏览器关闭与重开fixture补充能力检查；生产按钮尚未迁移到新API。

## 2026-09-12 独立字段 redo 模型检查点

ReferenceEditor新增字段redo的独立业务语义：创建新的应用，保留原undo/settlement，
使用当前比较基线但保留原计算读取值。模型记录用户顺序，使未知保存回执后来产生的
补偿仍位于原undo位置，不会覆盖在它之后发生的redo；用户控制暴露的当前权威满足
也不再产生重复源写入。这些调整修复参考模型的遗漏，本轮未修改生产内核行为。

新增86条逐步对照轨迹：72组原动作/undo提交时机、远端修改时机和值、重复undo/redo；
8组未知结果、确切成功/失败及canonical规范化；6组原业务读取前提在redo前后变化。
每步比较可见数据、受阻实体、实际提交文档和源写入次数；未知结果还核验原请求不变、
不重复发送。读取前提在redo之前失效则拒绝接纳，之后失效则保留输入并阻止保存。
模型不导入生产代码。已有独立undo和持久化模型对照也全部重跑通过。

本模型redo范围是字段写入；create/delete的新incarnation、结构模板和复杂跨动作依赖
仍不能仅凭这86条轨迹宣称模型验收完成。

## 2026-09-12 独立结构身份模型检查点

新增不导入生产代码的ReferenceStructure，以整数表示逻辑实体生命周期，独立计算
create/delete模板的可见文档、结构提交及源写入次数。32组轨迹覆盖原操作及undo是否
提交、源是否支持恢复、canonical规范化以及三轮undo/redo。未提交删除撤销保留原身份；
已提交删除恢复创建新身份；重做创建也使用新身份；不支持恢复时拒绝并保留原状态。
比较每次提交文档、实体身份的复用/隔离、旧server binding不可改写及所有生命周期的
server identity唯一性。

另有2组业务键复用轨迹：旧实体删除后，另一incarnation使用同一key，旧删除的undo
恢复和redo只影响新恢复身份，不删除或修改复用该key的其他实体。分别覆盖恢复已提交
和仍为本地创建时重做删除。当前34组轨迹通过，未发现其覆盖范围内的生产内核缺陷。

这是单行结构模板的独立模型，不代替create/write/order混合动作及迟到Task/Session
引用的全部组合验证。本轮没有修改生产代码，也未重新运行浏览器。

## 2026-09-12 历史读取与前缀索引复杂度检查点

确定性元素访问计数复现projectHistory逐action查找intent的二次扫描：256个应用读取
32896个元素，512个应用读取131328个元素。现改为单次intent身份索引，计数测试约束
分别不超过512/1024次访问；discard后没有新历史时验证零次旧intent访问。保留所有
journal及导航规则，不通过截断历史限制成本。

projectKernel已有前缀投影缓存，新增每个前缀的文档、可见顺序和行身份索引，避免同一
前缀的多个semantic-read重复构造整份Map和逐行find。索引仅属于本次投影调用，随调用
释放；固定authority和exact facts的因果读取语义不变。全部独立模型及15项关闭/恢复
三浏览器fixture通过。未进行wall-clock基准声明。

这不是全投影线性复杂度证明：不同因果前缀仍可能各自计算完整投影，其数量、依赖密度
及递归深度仍需继续测量和收敛。生产DataGrid迁移仍未完成。

## 2026-09-12 因果前缀显式求值栈检查点

将projectThrough的历史读取改为可暂停计算，evaluatePrefixes使用显式frame栈调度
严格更早的前缀。父计算暂停后保留本地变量，子结果完成后原位继续，不重复启动父计算；
同前缀的结果及文档/顺序/行索引仍共享。子计算异常回到父层原读取位置，保留原有
逐行错误处理语义；失败的未完成前缀不进入成功缓存。

9项测试覆盖30000层合成依赖调度、共享分支/重复读取、错误传播及重试、非法方向，
另用真实内核13行中性提供者链与独立表达式模型对照，验证最早authority变化仍影响
最后读者的显示、阻塞和可提交值。30000层测试验证的是调度器，不代表30000行完整
真实投影的时间或内存验收。既有独立语义模型和15项三浏览器关闭/恢复fixture通过。

该路径不再按因果深度嵌套JavaScript调用栈。不同前缀的完整计算、缓存总内存、其他
历史模板/依赖递归以及生产端到端性能仍需分别审计；未设置截断日志或丢弃输入的上限。

## 2026-09-12 React 外部状态订阅边界检查点

Workspace新增稳定getSnapshot：同一观察包含semantic state、ingress、editorInput联合
投影、存储/ checkpoint状态、运行时错误、保存调度结果及命令能力。通知合并之前就
使旧快照失效，同步读取后续输入不会继续返回旧对象；旧观察本身保持不变。

新增useWorkspaceSnapshot，以useSyncExternalStore订阅宿主持有的Workspace，不复制
输入到React state，不在卸载时关闭实例或释放租约。SSR必须显式传入对应初始观察，
不能偷偷使用较新的实时状态。3项内核快照测试和2项React SSR测试验证稳定身份、
同步失效、未知存储联合显示、订阅解绑、关闭及SSR无I/O。

新增真实React StrictMode浏览器fixture：通过IndexedDB实际提交后丢失回执，输入框
仍显示原文，published input保留旧值；卸载/重挂载保留同一owner，原token协调成功
后继续输入。Chromium/Firefox/WebKit全部通过且无控制台错误。该fixture验证新订阅
入口，不是完整生产DataGrid迁移验收。

生产替换边界已确认：data-grid.tsx仍创建GridController并管理binding/ownership，
工具栏、反馈和bulk界面仍使用useGridSelector；grid-cells.tsx及grid-viewport.tsx依赖
GridControllerSnapshot的编辑、选择和手势。下一步应按这些真实消费路径接入Workspace
及视图状态，不能用旧draft快照到新内核的双向同步适配器作为最终设计。

## 2026-09-12 React selector 与工作区切换检查点

新增useWorkspaceSelector，以Workspace/selector/isEqual为依赖建立独立读取闭包，
不用render期间共享可变ref改写其他render的选择函数。相同快照复用选择结果；不同
快照的结果相等时保留对象身份。SSR使用独立的显式serverSnapshot读取缓存，不混用
客户端实时观察。该缓存只是派生结果，不接管原输入或语义写权限。

真实StrictMode fixture验证对象selector和自定义相等判断：未知存储仅改变ingress时，
published-input组件的渲染计数保持不变。新增A/B两个durable Workspace共用同一React
组件的切换流程，验证立即显示对应输入、A后续更新不覆盖B、切回A仍保留其新原文。
fixture计数包装真实subscribe，确认切换后旧实例订阅数为0、新实例两处订阅仍在；
卸载时订阅归零而owner保持open。未通过key强制重建组件规避切换语义。

新增selector SSR测试及三浏览器切换流程全部通过。生产DataGrid仍使用旧controller，
本检查点只完成迁移所需的选择订阅边界和验证，不宣称生产入口已替换。

## 2026-09-12 完整行与显示查询的快照边界

WorkspaceSnapshot增加projection和view，视图可在同一次订阅观察中读取完整行、
筛选排序结果以及query。Workspace按不可变KernelState引用缓存两种投影；view
直接使用同一份projection，避免独立计算后消费者再自行拼接。仅运行时状态改变
（包括存储回执未知、ingress原文保留）时复用这两份对象；语义状态变化则重新计算。
缓存只保留当前状态，不以丢弃历史或截断行数据换取成本降低。

本检查点针对性验证：`pnpm check`、`pnpm lint`、`git diff --check`通过；
workspace-snapshot、view、workspace-react三个测试文件共11项通过。新增测试覆盖
查询与行同一版本、筛选后完整数据仍在、显示行引用完整投影、旧观察不被改写；
未知存储测试增加语义投影复用断言。未在本检查点重跑完整测试或浏览器测试，
下列完整结果仍对应之前的selector检查点。生产DataGrid迁移尚未完成。

## 2026-09-12 Workspace 行视图迁移检查点

新增src/react/workspace-grid-viewport.tsx，直接订阅Workspace行查询与authority，
并定义显示列id/存储fieldId分离的列协议。列渲染读取不可变文档及ResourceValue，
不借用旧GridControllerSnapshot或业务主键查找。未知字段、重复显示列id在配置边界
拒绝；相同字段可被不同显示列呈现。原生table使用entityId/columnId保持DOM身份。

真实浏览器fixture验证未加载、首次加载/失败、刷新/失败保留行、排序保留单元格DOM、
筛选不丢完整行、真实空数据及卸载不关闭owner。另验证规范化保存后迟到旧快照不
覆盖新值、页面重载durable恢复后仍显示新值、隐藏字段保留且源仅写一次。
首次测试初始化错误地请求从新数据库恢复，内核按契约拒绝；fixture现允许创建后
暂不刷新，后续由测试显式触发首读，没有改变内核恢复契约。

`pnpm check`、`pnpm lint`、`git diff --check`通过。
`pnpm test:browser tests/browser/workspace-grid.spec.ts tests/browser/workspace-react.spec.ts`
共12项三浏览器测试通过。未重跑完整单元测试集；此前各检查点结果不扩称为本次完整验收。
新组件目前只完成行读取边界：编辑/选择/工具栏、虚拟滚动、标准类型及locale等迁移
仍待完成，包公开DataGrid仍是旧入口。保存测试由fixture发起命令，不代表用户编辑
交互已完成。下一步将字段session与编辑器接入这份行观察，不创建新的React原文草稿。

## 2026-09-12 Workspace 字段编辑组件检查点

新增src/react/workspace-field-editor.tsx，通过Workspace session-opened、typeInput、
session-apply、session-cancelled/attached接入现有内核。组件接收固定FieldRef/ViewId
及文本format/parse协议；没有React原文草稿。应用使用同一快照的revision与完整
session输入束准备字段set/remove，迟到命令仍由内核拒绝。校验错误留在原输入旁；
blur/Escape不取消，组合输入期间应用禁用。非open owner的原文只读。

workspace-grid的保存用例已从直接调用editAndSaveWorkspace改为真实点击编辑、
填写、应用及保存。覆盖空白校验失败、Escape/失焦保留、回执丢失时应用禁用、
卸载重挂保留原文、确切协调后继续、组合输入事件、显式丢弃以及保存规范化、
迟到旧读取和durable重载。源仅写一次且隐藏字段保留。fixture保存按钮仍是临时宿主
控制，新生产工具栏、字段冲突恢复/重选、资源与bulk编辑尚未迁入。

`pnpm check`、`pnpm lint`、`git diff --check`通过；
`pnpm test:browser tests/browser/workspace-grid.spec.ts tests/browser/workspace-react.spec.ts`
12项三浏览器验证通过。未重跑完整单元测试集或发布包验收。包公开DataGrid仍使用
旧controller，Goal继续active；本检查点不代表M5/M6完成。

## 2026-09-12 Workspace 工具栏与结果协调检查点

新增src/react/workspace-toolbar.tsx，替换编辑fixture的临时保存按钮。按钮读取
Workspace能力并调用保存、撤销、重做、刷新；确切结果协调使用recoverPendingWork
有限扫描，不直接重发未知请求。WorkspaceSnapshot新增recovery计划和running状态，
组件不额外读取另一时刻的实时恢复计划。异步反馈按尝试身份/owner隔离，过时状态
反馈不继续显示。工具栏没有另一个数据草稿或恢复日志。

原字段编辑用例现在通过工具栏协调未知输入、执行undo/redo再保存。新增保存响应
丢失后重载、点击查询原结果的流程，验证只lookup一次、源只写入一次、冻结请求
未重发，规范化值与隐藏字段保留。初次undo测试因新旧demo工具栏同名导致定位
歧义，已按Workspace actions范围定位，未改变行为或放宽验证。

`pnpm check`、`pnpm lint`、`git diff --check`通过；workspace-snapshot与workspace-react
两个文件7项单元测试通过，包括恢复running同步观察和候选消失。
`pnpm test:browser tests/browser/workspace-grid.spec.ts tests/browser/workspace-react.spec.ts`
15项三浏览器检查通过。未重跑完整单元集或最终包验收。新组件仍需通过完整DataGrid
组合并迁入稳定身份选择、批量操作、标准类型、locale及完整恢复入口；包入口未切换，
Goal保持active。

## 2026-09-12 WorkspaceDataGrid 组合与身份选择检查点

新增src/react/workspace-data-grid.tsx，组合工具栏、行视图与字段编辑器，替换
fixture按projection.rows[0]决定编辑目标的临时组合。活动session决定编辑目标，
选择是单独按Workspace对象/ViewId隔离的EntityId/ColumnId。筛选隐藏仅取消可见
选中态，保留身份；重新显式选择时才改变该视图选择。编辑定义按FieldId唯一，
显示列可重复引用同一字段；未知编辑定义的编码原文以只读文本保留展示。

交互viewport使用grid/gridcell、aria-selected、单一Tab入口和方向键/Home/End
导航，不把任意自定义渲染内容包进button，也不拦截嵌套交互控件的方向键。
新增三浏览器用例覆盖排序保持DOM/选择、键盘焦点移动、隐藏行保留输入、删除
原行及同业务键新实体不能接管旧会话，明确丢弃后才能打开替代实体。
测试最初在填写后立即取semantic input版本，Firefox/WebKit捕获到持久提交前版本；
现先等Apply可用再记录基线，没有把可见原文误当作已发布输入或放松身份断言。

`pnpm check`、`pnpm lint`、`git diff --check`通过。
`pnpm test:browser tests/browser/workspace-grid.spec.ts tests/browser/workspace-react.spec.ts`
18项三浏览器检查通过。本次未改内核语义、未重跑完整单元集/发布包验收。
仍缺范围/批量操作、标准类型、完整冲突/资源恢复、虚拟滚动和公开入口迁移；
WorkspaceDataGrid尚为内部组合，旧生产DataGrid仍在使用，Goal保持active。

## 2026-09-12 字段上下文确认与显式改投检查点

WorkspaceFieldEditor新增重新确认当前字段上下文，以及保留原文改投明确选择的
字段。界面展示当前字段值/所选目标位置和值；改投携带所选目标观察revision，并
交由现有session-reconfirmed/retargeted协议校验输入版本和lease。只有当前字段
路径依赖的文本会话允许通用确认，额外业务依赖不能在此被默默清掉。格式化失败
时保留原编辑原文，不提供不可审阅目标的确认。未接受输入/未知存储/组合输入期间
禁用确认，与应用采用相同接纳边界。

新增真实浏览器流程：远端更新后校验受阻，显示新值并确认；确认回执丢失后通过
工具栏查询原结果；原目标删除后选中另一行并明确改投，验证session身份/原文保留、
input版本递增、editor代际更新，最后只写入所选目标并保留其隐藏字段。

`pnpm test:browser tests/browser/workspace-grid.spec.ts`15项三浏览器检查通过；
`pnpm check`、`pnpm lint`、`git diff --check`通过。本次未重跑独立React订阅浏览器集
或完整单元/包验收。下一步需要统一ingress恢复面板：被拒绝命令仍被保留，不能
通过放宽ready判断自动绕过。范围/批量、标准类型、资源恢复、虚拟滚动和公开包
入口迁移仍未完成，Goal保持active。

## 2026-09-12 ingress 恢复面板与暂存文件读取检查点

新增WorkspaceIngressRecovery，逐项展示明确拒绝/受阻请求的完整编码输入、
资源下载和无新输入的命令说明。处置按钮绑定审阅generation及全部列出请求；
存在未决请求/存储或非open owner时不能处置。处置不会取消仍由session拥有的输入。
文件URL按owner/请求/资源隔离，卸载释放URL，准备下载与不可用状态分开显示。

浏览器文件用例发现普通getResource只允许已发布资源，导致保留但拒绝注册的暂存
文件无法下载。新增getIngressResource，校验请求仍被保留且确实引用该资源后导出
副本；普通语义资源入口未放宽。单元验证未发布资源仍不能用于普通读取、异请求/
异资源拒绝、处置后请求不再能读取、导出副本保留文件名/字节/lastModified。

`pnpm check`、`pnpm lint`通过；新增workspace-resource-recovery单元测试通过。
`pnpm test:browser tests/browser/workspace-grid.spec.ts`21项通过，包括丢弃拒绝命令
后继续原编辑/保存，以及真实下载保留文件验证文件名与字节。下载准备状态细化后
另外重跑对应三浏览器文件用例，3项通过。未重跑完整单元集或发布包验收。

新面板仍沿用disposeIngress的运行时处置，随后续持久根/checkpoint记录落盘；
独立处置后立即重载的持久确认是下一需要补齐的协议边界，不能宣称durable丢弃
已完成。范围/批量、标准类型、完整恢复和公开入口迁移也未完成，Goal保持active。

## 2026-09-12 ingress 独立原子处置与返回材料检查点

disposeIngress改为必须await的异步提交，新增ingress-disposed事件，统一审阅
revision/generation、完整依赖链及处置回执。持久候选使用与live完成相同的归一化
逻辑，回执确认后才从live队列移除。未知回执保留原请求并查询原token；失败重试
不能复用旧审阅，提交期间到达的输入继续保留。界面与全部Workspace调用点已await。

替换此前仅测试关闭时flush的用例，改为直接处置后立即恢复、失败后重新审阅、
未知回执查询、写入期间新命令/依赖输入到达、完整输入链校验和持久回执缺失拒绝。
浏览器验证未知处置期间面板仍在、协调后立即重载无旧请求，原编辑可重新绑定继续。

进一步发现returned不能只记录标记：落盘成功而Promise回执丢失时，调用方尚未
拿到原文。现returned回执保存原IngressPayload，getReturnedIngress可在新owner
取回，getIngressResource可导出返回档案的文件；普通getResource仍要求语义发布。
档案纳入资源保留及checkpoint完整性，不能因返回请求已退出pending而删除字节。
RecoveryRecord升级为7，旧1–6拒绝且不改写，数据库布局仍为2。

最终运行：`pnpm check`、`pnpm test`（65文件769项）、`pnpm lint`、`git diff --check`
通过；`pnpm test:browser tests/browser/workspace-grid.spec.ts tests/browser/durable-ingress.spec.ts tests/browser/checkpoint-close.spec.ts`
42项三浏览器检查通过。未运行最终包消费/构建验收。公开DataGrid仍为旧入口，
范围/批量、标准类型、完整恢复等迁移继续进行，Goal保持active。

## 范围选择身份检查点

WorkspaceDataGrid现在捕获不可变实体/显示列轴，支持Shift点击和Shift方向键扩选。
成员不会随排序、筛选或插入重算；活动编辑目标仍由session决定。移除焦点事件的
隐式选中操作，防止Shift扩选后的程序化focus把范围折叠。成员占用O(R+C)空间；
此处不声称整个网格渲染或后续批量命令具有同样复杂度。

新增3项单元测试验证方向、快照隔离、锚点失效及非法轴；三浏览器用例验证重复字段
显示列的二维范围、扩选/收缩、排序、区间内插入及筛选恢复，同时保留编辑原文。
`pnpm check`、`pnpm lint`、全量单元66文件772项通过。网格浏览器套件24项通过；
进一步加强区间内插入断言后，范围用例三浏览器3项重跑通过。
范围批量命令、生产入口替换和最终包验收尚未完成，Goal保持active。

## 范围批量填值检查点

将内部WorkspaceFieldEditor重构为WorkspaceTextEditor，cell/bulk共享输入所有权、
composition、完整input证据、准备/应用、错误保留及attach流程。批量范围按显示列
去重到FieldId，缺失列不静默截断；会话打开后目标固定，新的选择和筛选不改变它。
按不同字段解析一次原文、按实体归组写入，完整目标一次session-apply；源保存保留
row原子性，不宣称跨行事务。重复显示列不会形成重复写入。

新增浏览器流程覆盖批量验证失败后保留输入、隐藏目标、改变选择、完整应用、
undo/redo、源保存和重载；另验证删除目标、同键重建后禁止整批应用，原目标及原文
重载恢复，存活行不被静默部分应用。修正新测试中的同名Undo定位及保存期间disabled
误作完成的问题，最终等待源写入和工具栏空闲。

最终`pnpm check`、`pnpm lint`、全量单元66文件773项及网格三浏览器30项通过。
生产入口仍未切换；矩阵粘贴、批量复核/改投、标准类型、资源编辑与最终包验收继续
进行。此检查点不代表M5/M6完成，Goal保持active。

## 批量复核与改投检查点

WorkspaceTextEditor统一使用完整目标复核对象：cell/bulk目标、逐字段可见位置和值、
观察revision。批量依赖仅限原目标字段路径时允许重新确认；额外业务读取不能由通用
编辑器静默重置。缺失、隐藏或不能格式化任一字段时不提供整批复核。
改投使用明确选择后的完整新目标，保留原文，继续由session的lease/inputVersion及
revision约束。目标位置与值逐项换行展示；预建字段、行、显示列索引避免每个目标
重复扫描整个视图。

扩展三浏览器用例验证源字段改变后展示两行当前值、确认后原文保留，以及删除目标、
同键重建、重载后仍禁止应用；显式选择完整新目标并改投后才允许应用和源保存。
新断言曾匹配到同名section与output，已改用带名称的status角色准确定位。
最终`pnpm check`、`pnpm lint`、全量单元66文件773项和网格三浏览器30项通过。
生产入口、标准类型、filter/矩阵粘贴、资源编辑和最终包验收仍需继续；Goal保持active。

## 筛选编辑接入检查点

新增WorkspaceFilterEditor和按显示列唯一注册的WorkspaceGridFilter。筛选文本由
Workspace session/ingress持有，codec只编译ViewPredicate；session-query-apply只更新
版本化查询，保留其他列筛选和排序，不进入数据journal。同列筛选冲突需显示当前值
并显式复核，额外业务读取不能被通用编辑器重置。支持composition、显式取消及重载
后的attach；移除定义时回退保留原文。

三浏览器新增完整流程覆盖非法文本、Escape/失焦保留、外部同列查询更新、重载恢复、
显式复核、composition阻止应用、查询应用及清空，确认完整行集仍在且源写入为0。
网格套件33项通过。生产入口替换、矩阵粘贴、标准类型、资源/任务编辑、公开locale
与最终包验收尚未完成，Goal保持active。

## 基础值类型编写契约检查点

将WorkspaceTextCodec移到不依赖React的value-codecs模块，新增string/number/boolean/
ISO日期codec。显式空输入策略区分缺失字段与null；数字拒绝空白、十六进制、非有限值、
不安全整数及非零下溢，支持上下界/整数约束；日期直接校验公历，不使用Date自动修正。
非法既有值format拒绝而非强制转换。错误文本由调用方提供，后续locale可以统一提供。

新增5项单元测试覆盖往返、边界、空策略、布尔标记和闰年；三浏览器数字流程验证
无效原文保留、指数文本保存为真实number、重载类型不变，以及显式空输入保存为null，
隐藏字段保持不变。三项数字浏览器检查通过，尚未重跑整个网格套件。
标准选择/资源控件、公开locale、生产入口迁移及最终包验收仍未完成，Goal保持active。

## 单选与布尔选择控件检查点

value-codecs新增不可变choices描述、display协议、单选与布尔选择工厂。单选token
区分数字1、字符串1和空字符串，标签不参与身份；目录复制冻结、未知值拒绝。
WorkspaceTextEditor对共享同一codec的目标使用原生select，仍经typeInput进入
Workspace所有权链路。当前原文不在目录时保留文本，不默认选首项；复核显示友好标签。

新增单元测试验证目录隔离、值类型、空策略及布尔标签。真实浏览器验证选择文本1后
本地回执丢失、查询恢复、重载、应用和源保存，以及选择数字1后取消不会更改源值。
最终类型检查、lint、全量单元67文件780项及网格三浏览器39项通过。
多选、矩阵粘贴、资源/任务控件、locale、生产入口替换与最终包验收仍未完成，Goal保持active。

## 多选控件检查点

新增createMultiChoiceCodec与原生multiple select：以有序typed token数组持有输入，
数字/字符串不会混淆；格式化和解析都拒绝重复、未知成员，空选择明确写为空数组。
选择变化保留仍存在项的原顺序，新成员追加；无效原文不转为空选择。共享同codec
的批量目标支持完整替换，并沿用已有session输入/应用链路。

新增单元测试验证类型、顺序、空数组和拒绝边界。三浏览器流程覆盖增加选项、重载
恢复、保存保持原顺序，以及批量替换两行且隐藏字段不变。最终类型检查、lint、
全量单元67文件781项、网格三浏览器42项和diff whitespace检查通过。
矩阵粘贴、资源/任务编辑、locale、生产入口迁移和最终包验收仍需推进；Goal保持active。

## Workspace中英文locale检查点

新增WorkspaceLocale契约及workspaceEn/workspaceZhCN。新DataGrid默认采用英文locale，
接受完整locale以及显式消息覆盖；筛选消息可使用locale默认值。示例删除内联重复提示，
基础codec错误提示从locale注入，业务列名/编辑标签/选项标签仍由宿主提供。

三浏览器中文用例验证数量输入的中文校验、保留无效原文、本地结果未知查询恢复及源端
保存，隐藏字段不变；既有英文测试改由默认locale驱动。网格套件45项通过，类型检查和
lint通过。旧公开locale及生产入口仍未替换；矩阵粘贴、资源/任务编辑和最终包验收继续。
Goal保持active。

## 矩阵解析与固定目标绑定检查点

新增clipboard模块，严格解码TSV引号、内嵌换行及显式空行，拒绝含糊格式。
bindMatrix只使用捕获的实体/显示列身份，要求完整尺寸；拒绝截断、非矩形输入和
同字段别名列的冲突原文。parseMatrixValues按字段codec解析完整矩阵，任一失败仅
返回错误位置/原文，不暴露部分写入值。旧生产剪贴板路径尚未替换。

新增4项测试覆盖往返、严格格式、固定身份、尺寸/别名拒绝及混合数字/字符串解析。
本轮未修改UI，未运行浏览器；矩阵原文和布局的会话恢复及粘贴交互仍需接通。
生产迁移与最终包验收未完成，Goal保持active。

## 矩阵会话与粘贴区域检查点

新DataGrid提供“粘贴到选区”入口，捕获显示列/实体布局和完整目标，创建编码矩阵
会话输入。WorkspaceTextEditor识别版本化矩阵原文，使用textarea；输入变化保留布局，
应用先完整解析并校验字段集合，再按实体/字段产生不同值的写入。布局与原文共同进入
ingress和checkpoint，恢复不依赖当前排序。普通填值改投按钮不对矩阵开放，避免
不经位置映射复核改变布局；后续仍需矩阵改投和直接网格粘贴手势。

三浏览器流程验证尺寸失败保留原文、修正输入、过滤/排序变化、重载恢复、应用后准确
写回原实体并源保存，隐藏字段保持。新增输入版本/布局守卫单元测试。
网格三浏览器48项通过；生产入口、资源/任务编辑和最终包验收仍未完成，Goal保持active。

## 直接网格粘贴检查点

Viewport接入单元格text/plain paste事件；嵌套输入控件保留原有行为。按钮与事件共享
openMatrix，按事件单元格是否属于原范围决定使用固定范围或单个实际目标。已有会话
时新粘贴进入ingress拒绝保留，不覆盖正在编辑的矩阵；列绑定丢失时不静默截断范围。

浏览器用例验证第一次粘贴打开矩阵、第二次被拒绝并保留完整新原文、当前原文不变，
显式处置第二请求后应用并源保存第一矩阵。完整网格回归50项通过、Firefox新增用例
因合成ClipboardEvent数据构造失败；调整测试事件的数据注入后该用例三浏览器3项通过。
验证的是浏览器DOM事件处理链，不是操作系统剪贴板权限。类型检查、lint及全量单元
68文件786项通过。矩阵布局改投、资源/任务编辑、生产切换和最终包验收仍未完成。
Goal保持active。

## 文件输入与任务编辑检查点

新增WorkspaceResourceInput并接入单字段编辑定义的resourceTask，可选durable定义或
memory执行器。选择文件时捕获原会话输入版本；先登记字节，再注册任务，不在await后
换绑当前输入。只有任务注册接纳才清空同一DOM文件选择，卸载不取消/释放。
任务状态来自Workspace；异步本地反馈按owner/会话及尝试对象隔离。

三浏览器真实文件输入流程验证文件名/字节、外部执行后丢失响应、重载lookup恢复、
应用并保存，第一次文件任务只执行一次。随后挂起第二任务、修改文本、完成旧任务并
查询，确认结果保留为superseded且新输入不变。曾过早读取查询状态的断言改为等待结果
发布后通过。最终类型检查、lint、全量单元68文件786项和网格三浏览器54项通过。
结果查看/重应用、资源展示、生产迁移和最终包验收仍需完成，Goal保持active。

## 保留文件结果复核与重新应用检查点

文件编辑器展示同会话的superseded/blocked/result-ready编码候选及当前原文，字符串
候选可由用户明确重新应用。task-reapply使用当前revision/session/input版本；结果
不重新执行上传，原文按内核输入历史保留。未知存储结果继续保留旧可见输入。

扩展三浏览器文件用例：用户修改文本后旧结果仅保留，界面展示候选和当前输入；重新
应用回执丢失时输入不变，查询确认后才更新，旧手工输入仍在superseded记录中，任务
执行次数不增加。该用例三浏览器3项通过；本轮未重跑完整网格套件。
跨会话任务恢复、资源结果导出、独立恢复入口和生产迁移仍未完成，Goal保持active。

## 独立任务材料恢复区域检查点

将任务结果复核从WorkspaceResourceInput移到WorkspaceTaskRecovery，直接读取工作区
尚未消费的任务。原始编码输入、文件下载、候选编码/资源及action结果均可独立展示；
取消任务不提供重新应用。字符串候选必须有当前可复核编辑目标，展示目标值与待替换
输入后才可使用task-reapply；无需原文件编辑定义仍然存在。

扩展文件三浏览器用例：移除resourceTask配置后下载second.txt，核对文件名和字节，
再复核并重新应用保留结果。类型检查、lint和全量单元68文件786项通过。
完整action结果重应用、跨会话组合验收、生产切换及最终包验收仍需推进，Goal保持active。

## 任务状态与显式取消检查点

恢复区域增加完整任务状态文案及取消按钮；取消不依赖编辑器仍存在，也不取消当前
会话输入。明确说明远端已发送工作可能完成。已取消任务的迟到结果从durable outcome
展示，只保留材料，不提供重应用；原文件仍可下载。

扩展三浏览器用例：挂起任务、取消回执丢失、查询确认取消、释放远端结果并查询，确认
原文不变、迟到结果可见但不能应用、文件字节可下载且源未多写。首次Firefox/WebKit
测试与前一次仍运行的恢复扫描竞争，等待扫描结束后再释放任务，三浏览器3项通过。
类型检查、lint及全量单元68文件786项通过；未重跑完整网格套件。生产迁移和最终包验收
仍未完成，Goal保持active。

## 取消任务材料重载验收检查点

进一步验证取消后的迟到成功结果、当前会话原文和原文件跨重载恢复：无需重新挂载
文件编辑器，结果仍可见且不能重应用，下载字节一致，没有新增外部执行或源写入。
资源引用实现已包含execution.outcome中的成功结果，取消不会绕过资源保留约束。
同时修正任务文件下载读取前错误显示“不可用”的状态，区分准备下载与实际读取失败。

修改后文件恢复用例三浏览器3项通过，类型检查、lint及diff检查通过；本轮未重跑全量
单元和网格套件。生产入口、完整恢复交互和最终包验收仍需完成，Goal保持active。

## 显式关闭交互检查点

新增 `WorkspaceCloseControls`，由宿主显式组合，组件卸载仍不释放 Workspace。
关闭评估按未保存改动、会话、任务、请求、存储等类别展示，所有关闭命令携带用户复核时的
原始 ticket；新输入使复核失效，并要求重新确认丢弃。清洁关闭、保留检查点关闭、显式丢弃
和继续编辑直接调用既有内核协议，不另建业务状态。英文和中文文案纳入 WorkspaceLocale。
宿主只有在收到 closed 结果后才获得带原 Workspace 身份的回调；重复点击不重复通知。
宿主需据此匹配仍在展示的 Workspace，再决定导航，checkpoint 按钮仅在宿主具备重开能力时提供。

新增真实界面测试覆盖复核过期、继续编辑、检查点回执未知时不离开、查询原检查点后关闭、
重开保留原始输入、清洁关闭后另一页面取得所有权，以及丢弃同意过期和重开不复活输入。
`workspace-close-controls.spec.ts` 与既有 `checkpoint-close.spec.ts` 三浏览器共24项通过，
类型检查、lint、diff 检查通过。本轮未重跑全量单元测试和完整网格套件。
关闭控件目前用于内部组合 fixture；公开生产入口仍待切换，不能据此声称完成 M5/M6。

## 公开入口切换检查点

`src/index.ts` 的 DataGrid 现指向 WorkspaceDataGrid，`src/engine.ts` 改为导出 Workspace、
schema/source、文档、命令准备、持久恢复及值 codec API。旧 controller/data-source/binding
构造器不再从根入口或 engine 导出；中文子入口改为 WorkspaceLocale，manifest 类型路径同步。
新增 `docs/workspace-migration.md` 说明 breaking API、宿主生命周期和 source 的真实保证要求。

为使切换可运行，尚未迁移的旧 demo/历史回归 fixture 改为直接引用原内部模块；未新增兼容入口。
这些路由目前仍是旧语义，需要后续迁移并最终删除旧模块，不能作为新 API 示例。
Workspace 网格 fixture 改为经公开入口导入 DataGrid、toolbar/close 相关组合和标准 codec。
公开入口下完整网格与关闭套件三浏览器共63项通过，源码/demo 类型检查、lint、库构建、
demo 构建均通过；headless 依赖图检查覆盖2个运行时模块和39个声明模块且无外部依赖。
对构建产物的运行时导出检查确认 Workspace/恢复 API 存在，旧构造器不存在。

发布包消费测试仍编写在旧 API 上，本轮未将其视为通过；它必须与示例一并迁移。
旧声明文件目前仍由全 src 声明构建生成，M6 删除旧模块后才完成清理。
因此这里只证明公开入口已切换，不代表 M5 或完整 Goal 完成。

## 发布包消费迁移检查点

包消费类型样例改用 Workspace、schema/source 能力、EntityId/FieldId、codec、React
订阅及关闭 API，并验证旧 dataSource prop、混用身份及不支持 exact lookup 的能力声明被拒绝。
脚本继续在仓库外解包真实 tarball；engine 独立消费目录不安装 React，声明图及运行时图均检查。
中文入口的 manifest、声明存在性和消费导入统一为 workspaceZhCN。

打包后的浏览器消费页使用真实 IndexedDB Workspace，并经 HTTP adapter 连接独立 SourceFixture
测试权威。`pnpm check:package` 已通过：三个浏览器分别验证默认样式与 structure.css 自定义主题，
编辑后模拟权威已写入但返回 unknown，只查询原操作、显示 canonical 大写值、保留隐藏嵌套字段，
整页刷新及显式关闭后重开均保持确认数据，服务端仅写一次。布局覆盖1440/1920/2560/3840宽度。

为使新入口样式生效，补齐 Workspace 容器的结构样式、主题变量和 className 接入。
旧包消费页的 controller binding/portal context menu 断言不适用于新入口，现由 Workspace
订阅与显式关闭流程接替包集成验收；这不证明旧 context menu/drag 等交互已迁移，
它们和旧 demo/旧内核删除仍待后续处理。包消费通过只对应当前公开切片，不是完整 Goal 退出条件。
本检查点另运行完整单元集：68个文件、786项通过；源码/demo类型检查、lint及diff检查通过。

## Quick start 生产示例迁移检查点

QuickStartPage 已经通过公开入口创建 durable Workspace，使用 schema/标准字符串、数值、
单选和布尔 codec，显式手动保存。页面宿主持有稳定打开 Promise，StrictMode/切换路由仅
detach，重载通过持久根恢复。失败时不清空存储，并提供重试；打开失败释放未交接的存储租约。

新增示例 product-source：IndexedDB 单事务提交完整文档和精确操作回执，完整版本 CAS
隔离并发写入，lookup 缺失时持久化否定凭据，重复身份必须匹配 payload hash。
示例仅允许编辑已有商品，policy 与源端均拒绝结构操作，不把浏览器缓存冒充远程后端保证。
独立浏览器用例验证两源实例并发仅一个 accepted、重复提交/查询原回执、否定凭据阻止迟到写、
digest 身份隔离、隐藏字段保留及重载后回执/权威不变。

Quick start 页面用例改为验证布尔编辑保存、无效数值原文重载恢复、更正后保存和四种桌面宽度。
页面与源及网格编辑回归的9项三浏览器测试通过，类型检查、lint、demo构建通过。
新示例与内部网格fixture同名控件曾导致定位冲突，fixture现在显式隐藏背景示例，
维持真实Workspace链路断言，不改变生产组件或缩小定位到第一个按钮。
随后完整运行 standard-registry、workspace-grid、workspace-close-controls 和 product-source
四个套件，三浏览器共84项通过（其中其他旧demo的交互用例仍只证明旧路由行为）。
其余示例仍需迁移，旧模块尚不可删除；完整 Goal 保持 active。

## 查询排序入口迁移检查点

公开 WorkspaceGridColumn 新增 sortable，DataGrid 列标题通过带 expectedVersion 的
view-query-set 切换升序/降序/无序，Shift 保留多字段优先级；重复显示列按 FieldId 共用一项。
原 filters 同命令保留，排序不调用 source.submit、不记录数据 undo，也不改变会话的固定目标。
存储 pending/unknown、未处置请求、关闭及恢复期间的按钮状态来自同一 Workspace 观察。
异步反馈按 Workspace 和查询版本隔离，并防止同一 owner 的重复派发。

列标题提供主排序 aria-sort、多字段方向/优先级描述和中英文文案。Quick start 开启列排序。
新增浏览器用例验证 unknown 本地发布前保留原顺序、exact 恢复后切换顺序、重复列不重复排序项、
原始输入与确切 EntityId 目标跨排序/刷新不变、多字段升降序与取消排序恢复权威顺序。
初次6项三浏览器测试通过；本检查点尚未迁移 Playground 路由本身，排序入口是该迁移的前置能力。
完整回归首次59/60通过，一次Chromium旧用例在点击刷新后立即派发查询时报告
`Resulting promise was garbage collected`。该身份恢复用例现等待刷新完成再进入下一步；
另增确定性并发用例，显式挂起权威读取、期间发布排序，Chromium再强制GC后释放读取，
确认两个操作均完成、顺序不倒退。最终排序与完整网格套件三浏览器63项通过，类型检查、lint、
diff检查通过。单次原始GC异常的具体原因尚未证明，未据此修改内核或声称修复了内核队列缺陷。

## 示例结构事务与故障模拟检查点

原 product-source 整理为 demo-source，固定 source scope 对应显式的 schema 校验回调
和 structure 能力。Quick start 继续声明 structure=false/restoreDeleted=false，防止已持久化
工作区因能力变化无法打开；后续 Playground 可显式选择结构支持。

同一 IndexedDB 事务现支持创建、完整顺序、删除和基于精确删除证明的恢复。恢复保留文档，
分配新的 incarnation；重排必须覆盖每个存活身份一次。一个批次里任意后续校验失败均拒绝
整批，数据和权威位置保持不变，并保存确定拒绝回执。新增 failNextSave 与按完整身份的
changeDocument，供 Playground 演示故障和外部更新；迟到旧 incarnation 不可修改恢复后的记录。
结构原子性、精确回执/重载及 Quick start 页面回归共9项三浏览器测试通过；类型检查、lint、
demo构建和diff检查通过。迁移过程中修正了测试fixture重命名后的旧调用名，未保留兼容别名。

本检查点尚未替换 Playground 页面。结构数据源及故障模拟是保留其原功能的迁移前置条件，
不能据此声称完成该示例或 M5/M6。

## 2026-09-12 Playground 持久 Workspace 与图片服务检查点

Playground 已移除旧 controller/registry/binding 导入，36 行原始数据单独保留。
页面宿主持有唯一 durable Workspace；行创建、复制、删除、撤销恢复和完整排序
通过 prepareRowAction 及同一个持久命令入口，自动保存模式由 Workspace 持有。
删除确认绑定 EntityId 与审阅 revision，排序/筛选视图禁用直接物理行移动。
共享 demo source 处理保存拒绝、精确回执及外部变更；没有第二份 React 业务草稿。

原图片回调不能在 durable Workspace 中使用，因此替换为独立持久执行服务。
三浏览器检查进一步定位 WebKit 在该服务存入 File/Blob 时抛出
`UnknownError: Error preparing Blob/File data to be stored in object store`，
此时执行记录未建立、输入仍被保留。服务改为持久化已校验 ArrayBuffer 字节，
转换时按原请求 mediaType 构造 Blob；保留请求身份检查、原结果查询及 unknown 语义。
测试模拟接受后、结果写入前中断，重开服务通过 lookup 完成原转换；验证字节内容、
重复查询一致、不同请求拒绝、缺失执行保持 unknown。已删除临时诊断日志。

键盘选择接通 Ctrl+A、Shift+Space、Ctrl+Space，保持稳定实体和显示列轴。
编辑器初次持有会话时聚焦输入；校验错误暴露 aria-invalid。自动保存期间排序按钮
使用 aria-disabled 与事件入口检查保持焦点，避免 native disabled 导致焦点丢失。
单/多选目录支持 disabled 选项，仍能表示现存已停用值。

验证：类型检查通过；Playground、标准编辑器、Workspace grid 和排序四组测试
三浏览器 84/84 通过，含保存拒绝后重试、删除后保存及 undo、图片保存重开、
外部变更、任务中断恢复。demo 构建通过。补充的行新增、完整顺序、immediate mode、刷新重开及
1440/1920/2560/3840 px 无页面横向溢出检查三浏览器 6/6 通过。本轮早先完整单测 68 文件 / 786 通过、lint 与发布包
三浏览器消费通过；ArrayBuffer 服务变更后未重复发布包检查（示例不在包入口中）。

仍未完成：两个旧示例、多种过滤器、上下文菜单、复制清空/拖动交互、完整恢复界面、
旧内核删除以及最终全量审计。上述迁移不代表 M5/M6 或 Goal 完成。

## 2026-09-12 Workspace 剪贴板导出检查点

DataGrid 的复制事件现在从同一个 Workspace projection 读取完整捕获选区，
保留实体/显示列顺序、别名列以及被筛选隐藏的成员。每个字段使用 codec.format
生成可重新解析的作者输入，再统一 TSV 引号编码；不从 DOM 文本或本地草稿读取。
成员已删除、绑定缺失或值不能表示时拒绝整次复制，并提供中英文错误反馈。
复制没有数据写入，编辑器内部文本仍使用原生复制行为。
进一步真实快捷键验证发现仅监听合成 copy 事件不足以证明 Firefox/WebKit 的
Ctrl+C 路径。网格快捷键现在捕获 Ctrl/Cmd+C 并明确调用 clipboard.writeText；
写入完成前显示处理中，被拒绝显示错误，只有成功后显示已复制。异步反馈绑定
复制尝试，旧结果不能覆盖后一次复制的状态。保留 copy 事件入口供浏览器菜单使用。

三浏览器复制/粘贴回归验证了制表符、换行、引号、别名列、筛选后成员守恒、
删除后拒绝部分导出、重新选择后恢复，以及复制→保留粘贴会话→权威保存→重开，
完整保留未显示字段。相关 grid/sort 测试 63/63 通过，复制测试 6/6 通过；
类型检查、lint、发布包三浏览器消费通过。真实 Ctrl+C→普通 textarea Ctrl+V
也已通过，Chromium 测试显式授予 clipboard-write，未申请 clipboard-read。
另外覆盖写入拒绝、没有提前成功反馈以及用户重试。最终合并 grid/sort/copy
回归三浏览器 69/69 通过；最后快捷键与反馈变更后的发布包消费三浏览器再次通过。

本检查点只完成网格复制入口；清空、上下文菜单、拖动、两个旧示例迁移、
完整恢复入口与旧状态模块删除仍在 Goal 内，未标记完成。

## 2026-09-12 显式清空输入检查点

WorkspaceGridEditor 增加可选 clearInput；清空不猜测 null/0/missing，不绕过 codec
和 schema。未配置清空的字段使混合选区清空不可用；完全未启用该能力的网格
不显示清空入口。Playground 的图片、名称与标签分别配置对应的空输入。

“清空选区…”通过同一个 session-opened 入口保存待审阅输入，单字段使用原生
文本框/多选框，批量使用捕获实体与列轴的矩阵。应用、保存、未知结果与条件 undo
复用现有链路，没有新增直接写权威、删除字段或绕过输入账本的捷径。

新增三浏览器测试：未配置数值与混合选区禁止清空；清空待审阅时原文档不变；
空数组输入刷新恢复；空字符串与空数组各自保存重开；保存后撤销并再次保存重开；
批量清空时排序改变显示位置但原两个实体保持不变。六组相关浏览器测试联合
99/99 通过，类型检查、lint、demo 构建以及发布包三浏览器消费通过。

此检查点完成清空按钮链路；上下文菜单/快捷键入口、拖动、多图片导入与跨表迁移、
完整恢复入口、旧内核删除和最终要求矩阵审计仍未完成。Goal 保持 active。

## 2026-09-12 多图片输入封装检查点

检查旧 multi-image-import 发现文件读取由 React ref/AbortController 持有，卸载会中止；
文件选择器在 importFiles 尚未接纳前已经清空。其事务目标通过旧 revision 与可见行
序列比较，不能直接接到新 Workspace 的任务/输入所有权上。

新增 demo/src/image-batch.ts：在任何异步转换前同步构造一个可逆 File 资源，包含
版本魔数、长度限定的 UTF-8 manifest、冻结目标计划、原文件名称/MIME/lastModified
以及按原顺序拼接的完整二进制字节。该文件可直接交给现有 registerResource，避免
为每个文件建立脱离批次目标的 React 状态。解码检查版本、元数据、单文件/批次限制、
完整内容长度；拒绝截断和尾随内容。保留原 24 文件、8 MiB 单文件、48 MiB 批次上限。

新三浏览器测试 6/6 通过：经真实 Workspace 持久注册与刷新恢复后，原始二进制、
Unicode/引号文件名、时间、MIME、顺序和捕获目标不变；调用方之后倒序数组不影响
资源；截断、额外字节、非图片 MIME、空批次、超量文件与超大目标计划被拒绝。
类型检查通过。尚未替换旧示例入口，不能据此声称多图片导入迁移完成。

下一步需要贯通批次转换结果与结构动作：现有 session-apply 只允许固定字段写入，
不能用普通 bulk session 偷渡溢出文件对应的新建行；现有 durable task action 结果
要求 PreparedAction 与输入归属。迁移必须明确转换结果的持有、显式审阅、原目标
前提和原子追加行，不把转换回调中的当前可见行当成原导入计划。

## 2026-09-12 待审阅动作候选协议检查点

TaskResult 新增 action-candidate/OwnedInput，把纯转换输出与客户端 PreparedAction
编译分离。候选到达后保留 result-ready，不自动执行、不允许 task-consume 偷渡写入。
显式 task-reapply 必须带当前审阅 revision 和完整提案，仍验证 cause=task、全部输入
束、当前 owner、session/field 写域和 schema/policy；可以原子覆盖旧行并创建新行。
公开 engine/root 导出 taskInputRecords，供宿主在审阅后准备完整输入移交。

资源引用扫描与 ingress 对候选输入一并计账，取消后保留输出字节；React 任务材料
面板显示候选数据，但不显示仅适用于 session-candidate 的字段重应用按钮。
RecoveryRecord 升级 format 8，旧 1–7 明确拒绝且不改写，存储布局仍 version 2；
设计基线和迁移说明同步更新。

完整单测 68 文件 / 789 通过。新增用例验证不自动写入、拒绝过期/缺提案/不完整
输入移交、取消资源仍可恢复、混合写入与创建原子接纳、丢响应原请求 lookup、
保存及重开。浏览器用真实批次资源，经断响应、刷新查询、显示候选、显式准备、
保存、再次重开验证，源端只执行一次任务且未丢隐藏字段。与 durable task、恢复扫描、
checkpoint、grid 联合三浏览器 99/99 通过；类型检查、lint、发布包消费三浏览器通过。

这补齐的是迁移需要的任务协议与公开准备入口。多图片和跨表旧示例尚未切换，
候选的领域审阅界面、原目标计划校验、上下文菜单/拖动和旧内核删除仍在 Goal 内。

## 2026-09-12 真实批次转换服务检查点

从单图片任务抽取 durable-conversion 持久执行边界，两个实际转换定义共同使用
同一套接受记录、请求身份、字节哈希、终态 CAS 和原请求 lookup。转换定义版本
必须精确匹配；重新完成已接纳任务前再次核对持久字节哈希。单图片服务保持原
定义与 session-candidate 结果；新增 image-batch-task 解包原批次，顺序转换文件，
返回带原计划、原文件名、名称与 data URL 的 image-import-result:1 动作候选。
没有读取当前行位置、没有自动应用，也没有远端上传副作用。

真实 IndexedDB/Workspace 三浏览器验证：丢响应后重开查询原候选；模拟接受后、
终态写入前中断后恢复；故意损坏服务字节后拒绝转换。候选再次重开内容不变、
原行与 action 数未被转换改变。批次服务 9/9 通过；此前合并批次封装与 Playground
单图片保存/重开回归 18/18 通过；类型检查、demo 构建通过。本轮未修改发布库，
未重复发布包 gate。

下一步仍是替换旧多图片页面的目标捕获、领域审阅与原子应用界面；仅服务接通
不代表页面迁移完成。跨表交互、其余恢复入口、旧实现删除和最终验收仍在 Goal 内。

## 2026-09-12 多图片页面迁移检查点

multi-image-import.tsx 已移除旧 controller/binding/registry 与本地保存源，改用
宿主持有的 durable Workspace、共享事务源、批次资源和真实批次转换服务。
新增 image-import-plan 捕获原 EntityId、name/image 比较值与溢出新 EntityId；
应用前要求审阅 revision 当前、原值一致、目标完整，随后以一条 cause=task、
saveAtomicity=transaction 的动作移交全部输入，覆盖旧行并追加新行。

原目标变化时不会自动换成当前行；页面显示阻止原因，用户显式选择起始行并
“Review new targets”后重新确认。单个原始文件可从候选链接下载；取消后及
迟到结果仍保留材料。路由卸载只移除视图，不中止批次所有者。文件选择仅在
任务注册确切接纳后清空，未确认时原选择保留。

DataGrid 增加可选 renderActionCandidate(task,input)，把领域图片/目标审阅嵌入
统一任务材料面板；面板仍提供原始资源、状态和取消。替换了该页面上重复的
协议 JSON 展示，未引入第二份业务草稿。主示例剩余 cross-grid-drag 使用旧实现。

验证：多图片真实流程最终三浏览器 12/12 通过，含候选刷新恢复、超出初始三行
的原子追加、保存拒绝重试、保存后 undo、目标变更重新审阅、丢到页面后立即
切换路由、取消后真实下载原字节、取消后迟到候选恢复及四档桌面无横向溢出。
标准编辑器与最初多图片用例联合 24/24 通过；随后候选/批次服务/标准编辑器
联合回归中 36 项通过，3 项因测试误用 /quick-start 路由失败，改为真实 / 路由后
已纳入上述 12/12。类型检查、lint、demo 构建及发布包消费三浏览器通过。

Goal 继续 active。跨表迁移、上下文菜单/其他拖动交互、完整恢复入口、旧内核
与旧测试/示例辅助实现的清理，以及最终需求矩阵审计仍未完成。

## 2026-09-12 跨表迁移的共享分区读取检查点

审查旧 cross-grid-drag 确认 cut 先接纳目标插入，再删除源草稿，失败时通过目标
history/undo 尝试补偿；两个独立保存源不能提供一次权威事务。迁移决定是同一
权威数据集、一个 Workspace、两个分区视图，移动改为成员归属与完整顺序的原子
动作。不同后端之间的转移需要后端协调，不能将本地 undo 当作跨源事务。

DataGrid/Viewport 增加 rowScope: ViewPredicate，复用纯查询比较器，完整 projection
和输入账本不被裁剪。分区 total 独立计算以区分空分区与查询无匹配。选择缓存绑定
scope 内容，改变分区时重置新选择；活动编辑仍保留原实体/输入。新编辑入口要求
完整选区当前可见，防止空面板用旧隐藏选择打开其他分区的字段。

单测验证分区计数、未知字段拒绝及完整投影不变。三浏览器两个分区共享一个
Workspace，在切换分区后原输入仍写回原实体，随后新编辑指向新可见实体；一次
保存保留双方隐藏字段。联合分区/grid/copy/clear/sort 78/78 通过；完整单测
69 文件 / 790 通过，类型检查、lint、发布包消费三浏览器通过。

此检查点尚未替换 cross-grid-drag.tsx。后续要完成成员字段、保护行、复制/移动与
定位、拖动/键盘操作及其保存恢复验证，再删除旧入口与内核。Goal 保持 active。

## 2026-09-12 跨表页面迁移检查点

cross-grid-drag 已使用单一持久 Workspace 和单一 IndexedDB 权威事务，两个
rowScope 面板共享保存与撤销。移动保留实体身份，以一个事务动作更新归属和
完整顺序；复制分配新实体及业务 id。原始文档随手势捕获，可信拖动在接纳前
检查文档未变；外部载荷仅复制。保护行的跨分区限制同时进入 schema 校验。
新增可选 rowHeader 放置选择框与原生拖动控件；目标列表和插入位置控件提供
键盘操作路径。成功转移后清除临时选择与插入位置。

跨表端到端 6/6（三浏览器）通过：定位移动、保存拒绝、刷新恢复、重试、
保存后重新打开、撤销已保存移动，以及保护行复制、原生拖动和四个桌面宽度。
分区与公共 DataGrid 联合回归 57/57 通过；类型检查、lint、发布包三浏览器
消费及 diff 空白检查通过。尚未补齐跨表 stale/外部载荷/权威身份的专门断言，
不把上述可见行为验证当作全部协议验收。旧内部实现清理、剩余交互、完整恢复
入口和最终需求矩阵仍未完成，Goal 保持 active。

## 2026-09-12 跨表权威断言与旧测试入口迁移

跨表测试补齐权威文档、实体 incarnation、业务 id、完整顺序与版本断言。
拒绝保存不改变任何权威行/顺序/版本；成功移动保留原实体身份及隐藏字段，
保存后撤销恢复原始行和顺序。外部声称 move 的载荷仅创建新身份副本，源行
不变；拖动开始后原字段被编辑，则过期拖动拒绝，不覆盖新输入。三浏览器
9/9 通过。初版误将每次读取的新 observation id 纳入相等比较，导致 3 项
失败；改为比较实际权威状态后通过，未修改源协议。

owned-source-switch 辅助入口已替换为公开 Workspace/DataGrid/CloseControls：
宿主仅收到确认关闭结果后开启目标 owner，保留关闭生成的 checkpoint 支持
返回原数据集。字段原始输入保留、A→B→A 重新打开继续编辑保存、未完成筛选
阻止直接关闭、Escape 不丢输入、丢弃筛选后重新审查关闭均经三浏览器验证。
联合关闭入口回归 15/15 通过；首次 fixture 漏写列 render 的类型错误已修复，
类型检查通过。现有旧生产 API 的 demo 直接引用剩 owned-upload、
persistence-consistency、review-regressions 三个辅助入口。

依赖检查补充迁移代码的禁入边界：kernel、workspace React/locale 和公开入口
不能引用旧 controller/data/model/layout/cell-types/React/locale，包括类型
导入；正反边界自测随 pnpm check 执行。旧测试仍依赖旧模块，不提前删除或
排除检查。下一步迁移三个剩余辅助入口，再清理旧图；Goal 仍 active。

## 2026-09-12 保存一致性测试迁移及冷启动回执恢复修复

persistence-consistency 辅助入口迁到公开 DataGrid，服务端时序移到独立
SourceFixture。覆盖规范化回执、回执后旧版本读取、后续服务端编辑、回执后
HTTP 503、重载后恢复、旧读拒绝和再次重新打开；隐藏字段与只提交一次均有
明确断言。旧 remote-data-source 的 publish/cache 接口已不再参与此回归。

新增时序查出实际冷启动缺陷：持久 root 已保存精确回执，但新进程 gateway
没有 job。Workspace 正确跳过重复 lookup，只做权威读取，随后 releaseSettled
因缺少 terminal job 拒绝释放，结果界面已有规范化值但 submission 一直未结束。
acquireRecovery 现在通过原有 reserve/hash/result 校验路径从持久 commit/rejection
恢复 job 终态，同时恢复权威 frontier。未删除 releaseSettled 的任何屏障或
settlement 检查，也不重发 mutation。网关单测明确从未创建过 gateway 的已提交
状态恢复，旧读仍拒绝，完整权威接纳后释放，无额外查询/写入。

调试中最初怀疑测试在 React 渲染前跳过恢复按钮；改成等待按钮后仍有相同失败，
据此追到上述 job 重建缺失。不能将这次六项失败记录解释为仅测试时序问题。
修复后历史一致性 9/9、联合持久恢复/关闭浏览器 48/48 通过；原有完整单测
69 文件/790 通过，新增冷启动用例后 gateway 单测 21/21 通过。类型检查、lint、
发布包三浏览器消费与 diff 空白检查通过。

demo 的旧 API 直接引用剩 owned-upload 与 review-regressions 两个辅助入口。
旧内核尚未删除，完整交互/恢复入口及最终矩阵审计仍未完成，Goal 保持 active。

## 2026-09-12 上传任务旧入口迁移

owned-upload 辅助入口已不再使用旧 DataGrid/remote-data-source/registry。
现在使用两个独立持久 Workspace、公开 DataGrid 和已有版本化图片转换服务。
切换视图显式选择 retain，宿主保留两端 owner；不是销毁旧数据源或假称其已
关闭。拖放先捕获当前 session/input 身份，再注册 File，任务始终归原 Workspace。
文件选择使用公开 resourceTask 编辑器入口。原先“取消即释放一切”的测试约定
已替换为取消写回、保留文件与迟到结果，符合新的输入守恒协议。

三浏览器覆盖文件选择及拖放、转换中离开 A、在 B 输入文本、A 的迟到成功结果
不覆盖 B、回到 A 应用/保存、重载后权威与隐藏字段一致。取消分支不产生行写入，
重载后 Download photo.svg 的真实下载字节与原文件完全一致；B 未保存输入也
保留，A 只存在一个任务。独立 6/6，联合多图导入和数据源切换 24/24 通过，
类型/边界及 diff 空白检查通过。联合首跑 23/24，一项合成 drop 早于编辑会话
建立；改为等待文件输入 enabled 后重跑通过，未改变运行时接纳规则。

旧 API 直接引用仅剩 review-regressions 辅助入口。权限撤销、创建碰撞显式接管、
碰撞后删除/撤销及末尾空行剪贴板场景仍需迁到新模型，然后才能删除旧模块。
完整恢复入口、交互矩阵和最终验收仍未完成，Goal 继续 active。

## 2026-09-12 最后旧回归入口迁移与旧实现删除

review-regressions 全部改为新 Workspace，保留四个历史业务场景：权限撤销后
输入经重载仍在；创建键碰撞经重载后显式 adopt-existing 保留隐藏本地输入；
接管后删除/撤销/重做提交确切既有 incarnation；DOM 复制粘贴保留末尾空行，
经撤销、重做、保存和重载仍一致。独立服务端断言接管保存只有 update/delete，
不伪造 create 或按业务 key 重新分配身份。三浏览器 12/12 通过。

删除 86 个旧文件：controller、data（draft/rebase/replay）、model、layout、
cell-types、旧 React 表格/控制器/副作用适配、旧 locale 及仅测试这些实现的
单测。删除前保存所有实际工作区字节（含既有未提交修改）并逐项 SHA-256 核验：
.git/codex-backups/legacy-state-20260912-052208.tar.gz 与同名 JSON manifest。
备份只用于本地恢复，不参与构建、导出或兼容执行。新版边界脚本改名为
check-kernel-boundaries.mjs，继续禁止旧模块与 headless→React 依赖。

README 改为新 Workspace 接入、确切 source 协议、owner 生命周期、任务与限制，
删除失效旧 API 示例。原 README 工作区副本保留在
.git/codex-backups/README-before-workspace.md。迁移指南同步注明旧实现已移除。

删除后完整验证：50 文件/621 单测、267 三浏览器测试、pnpm check、lint、
demo 构建与发布包三浏览器消费全部通过。旧专属单测减少 170 项；这不是新模型
全矩阵覆盖的证明，仍需最终逐条验收。dist 未包含旧 controller/rebase/replay/
cell-types/model-grid 声明，git diff --check 通过。

M6 的旧代码删除已落实，但整个 Goal 尚未完成：剩余上下文菜单/拖动等交互、
完整恢复入口、性能/虚拟化或规模边界、历史文档整合与设计第 15 节逐项审计仍在
范围内。不能以本轮完整现有测试通过替代这些缺失能力。

## 2026-09-12 未分配文件的恢复入口

公开 DataGrid 新增 WorkspaceStoredFiles：展示已注册但不被当前/历史输入、
任务结果、待处理 ingress 或 returned archive 引用的文件。原字节可下载，
单文件移除需显式确认且绑定 Workspace 实例/状态 revision；新编辑使确认失效。
移除调用已有资源释放协议，引用竞态仍由内核最终拒绝。英文和中文 locale
增加 grid.files，迁移文档记录其范围。

三浏览器验证 registerResource 后无任务的孤立文件跨重载下载字节完全一致，
新编辑使移除确认失效，重新确认释放后重载不再出现，无源写入。联合 durable
input/上传 15/15；另对已消费与已取消任务增加“不进入未使用文件列表”断言，
6/6 通过。类型/边界、lint、发布包三浏览器消费、diff 空白检查通过。

本检查点只补齐未分配资源的查看/释放路径；撤销决策产生的 recovery bundle
及 returned ingress archive 的完整查看/重应用/处置入口仍待完成。其余交互、
性能及最终逐条设计验收继续在 Goal 范围内，Goal active。

## 2026-09-12 returned ingress 归档查看与导出

DataGrid 的拒绝请求面板接入已有 returned disposition，允许将完整被拒绝/阻塞
请求组转入持久归档，沿用精确 ingress generation 与依赖完整性检查。归档中
可查看原始文本、下载完整请求 JSON 及原 File/Blob 字节。无输入的命令也可下载
完整请求；不执行重试、不自动转成新的编辑。归档文件仍被 ingress 引用，不能
进入未使用文件释放面板。locale 与迁移文档同步更新。

三浏览器测试真实文件请求被拒绝→点击归档→重载→下载并比较原请求和文件字节；
确认无 session/task/源写入且归档保持引用。专测 3/3，联合 Workspace 编辑、
持久 ingress、未分配文件 66/66 通过；类型/边界、lint、发布包三浏览器与
空白检查通过。

本次没有增加归档 JSON 执行/导入协议或单独删除历史回执的能力。决策撤销产生的
recovery bundle 查看、目标审查与重新接纳，以及完整恢复处置审计仍待完成；
其他交互与性能验收仍在 Goal 中，保持 active。

## 2026-09-12 决策恢复包的审查与会话接纳

公开 DataGrid 接入 decision recovery：显示完整原材料，可选择原始文本或新建
编辑内容，在当前可见选择上审查目标/原值，确认后通过 session-opened.recoveryId
原子转移整包输入。目标选择或 revision 变化使审查失效。转移不写行，原材料在
会话期间仍显示，重载后可恢复；应用与取消继续使用现有整包守恒协议。
任务与恢复包共用 WorkspaceInputMaterial，保持文件下载与原始文本显示一致。
新增中英 locale 和迁移说明。

三浏览器验证两个历史输入→远端冲突→采用权威→撤销决策→恢复包重载→目标
变更使旧审查失效→选择第二份文本在另一个实体重开编辑→整包随会话重载→应用
保存或取消。应用只写目标且保留双方隐藏字段，取消无源写入；整包 dispositions
分别成为 settled-intents/cancelled-session。另注入会话转移已落盘但确认丢失，
检查原结果后继续，无材料丢失。专测 6/6，联合任务候选/上传 15/15 通过；类型、
边界、lint、发布包三浏览器及空白检查通过。首次回归在刷新未完成时处理冲突被
拒绝；测试改为等待权威刷新后通过，未放宽内核版本检查。

尚未把任意结构化恢复输入自动映射为当前字段值；原材料可查看，用户可选择
新编辑，专用结构编辑器与逐项恢复处置仍需审计。其余交互/性能与完整设计验收
仍在范围内，Goal active。

## 2026-09-12 前驱事实查找的投影成本

性能审计发现 resolvedExpectation 对每个前驱 ID 线性扫描 journal、settlements、
commits/results。有效两轮独立行编辑的代理数组访问计数：32 行/64 intents 为
656 次，64 行/128 intents 为 2336 次；线性预算测试在旧实现失败。

现改为单次 projectKernel 内按需建立 intent/settlement/exact-item-result 索引，
所有因果 prefix 共用；没有逻辑前驱时不建立索引。索引不跨 state、authority、
policy 或 settlement 变化保存。未改变前驱顺序、canonical receipt 选择、semantic
read、局部分组补丁语义或任何输入/日志保留。

规模测试覆盖 32/64/128/256 独立行两轮编辑，要求日志元素访问不超过 intents
数量的 8 倍，并校验全部行、隐藏字段、change 数量及投影一致。最终完整单测
51 文件/625 通过；保存一致性、决策恢复、历史回归、跨表三浏览器联合 36/36、
类型/边界、lint、发布包三浏览器及空白检查通过。

这证明的是独立前驱 ID 查找消除了已观测重复扫描，不是整体投影已线性化。
同一行长活跃日志的 neutral-prefix、条件 undo 的提交查找、全量 DOM、日志
保留/压缩边界与最终设计矩阵仍待审计。其余交互与恢复处置继续在 Goal 内。

## 2026-09-12 定向语义变异验收

实现 pnpm test:mutations，已加入 prepublishOnly。runner 将当前 src 与独立
kernel fixture 复制到系统临时目录，先跑正常基线，再逐一精确替换语义分支；
不改工作区生产文件。每个锚点必须唯一，基线必须全绿，变异必须导致具体测试
用例失败；只有加载/工具错误不能算检出。每轮恢复临时源文件，结束核对工作区
目标源码未变并清理临时目录。报告包含源码 SHA-256、变异差异、失败用例与日志，
输出 test-results/kernel-mutations/summary.json，失败运行也写当前摘要。

最终基线为 155 个通过用例。七种定向错误全部检出：丢弃未确认删除 37 个失败
用例、把 latest 当 normalization 8、忽略 incarnation 8、结算未提交意图 64、
未知结果下提前 suppress undo 11、接受旧 attempt 1、接受过期 authority 114。
这些为实际断言/语义失败，不以故意编译失败代替。覆盖设计 15.2 要求的输入
守恒、coverage、旧事件过滤、undo 分支及身份/规范化风险；不等同于任意变异
或完整系统均已证明正确。README 记录命令与报告位置。

本轮增加验收工具，不改变生产行为。后续继续设计逐条证据矩阵、剩余交互/恢复
处置、同一行长日志及渲染规模审计；Goal 保持 active。

## 2026-09-12 当前状态与历史文档分离

复核公开入口、Source 契约、模型测试和 viewport 后，修正了本页首尾、设计首页及旧草稿模型中的过期“生产尚未迁移”结论。旧保存协议全文保留为历史存档；原入口改为 Workspace 当前链路说明，防止接入者继续使用已删除的 adapter/controller API。

新增 `state-kernel-acceptance.md`，覆盖设计章节、M0–M6、十五条性质、证据入口与未关闭要求。核查发现模型已有固定枚举与 trace，但没有 seed 驱动的事件生成和自动缩减；该项继续列为缺项，不能用现有模型测试通过替代。

## 2026-09-12 保存时序生成与语义反例缩减

新增可重放 uint32 seed 生成器、保存时序模型 runner 与失败序列缩减器。每步比较生产预览、允许发送的完整行内容、独立服务器实际状态和写入次数，并检查原文仍被持有以及冻结 payload 不变。64 个 seed 交错写入、外部修改、服务器执行/拒绝、规范化、精确回执、未知结果和当前/旧快照；结算后另核对剩余冲突成员。

首轮 16 个差异缩减后均为独立行提交项的枚举顺序差异；按实体比较完整内容修正了测试的错误假设，没有修改生产行为或移除事件。真实隔离变异验证生成模型检出未发送输入被结算，并保留六步反例及 journal/receipt 诊断。旧读导致的错误拒绝也转换为可缩减的语义失败。

缩减为同一 property 的单事件删除最小，不声称全局最短；invalid 调度不能作为失败，其他基础设施异常继续抛出。新套件加入 `pnpm test:mutations`。最终单元 53 文件/692 项、check、lint、空白检查通过；变异基线 222 项通过，七类故障全部检出。生成模型检出规范化来源、未发送 coverage 和旧权威三类错误，并输出同性质缩减序列。完整 Goal 的任务/历史/恢复生成和其余验收仍待继续。

## 2026-09-12 条件 undo/redo 生成时序

在保存生成器上加入显式历史事件和独立导航栈，64 个 seed 交错 undo/redo 与保存、外部更新及回执；另有两条固定 unknown 连续撤销的 applied/not-applied 分支，继续实际保存补偿、重做与后继输入；每次 idle 比较完整可提交写集合。真实差异缩减为五步，确认是参考模型按原动作顺序预览两个撤销的问题；按用户控制时间修正模型，并增加不依赖生产结果的回归断言。生产逻辑未修改。

新历史生成套件加入隔离变异验收。完整单元 54 文件/759 项、类型/边界、lint 和空白检查通过；变异基线 289 项，七类错误全部检出，其中 26 个新增历史用例检出错误的未知撤销分支。具体结果见验收索引；任务、结构、多提交周期和崩溃恢复生成仍待继续，Goal 保持 active。

## 2026-09-12 会话任务输入守恒生成模型

新增不导入生产模块的会话任务模型及 64 个 seed 事件编排。逐步核对当前原文和历史原文、输入版本及归属、会话目标/附着、候选保留、任务状态和拒绝原子性；结果只能进入会话，不能写数据。两条固定链路覆盖目标变化后的审阅改投、分离时重新应用、取消及迟到结果。

完整单元 55 文件/825 项、类型/边界、lint 通过；66 项新任务用例通过。变异基线 371 项，九类错误全部检出；30/21 个新增任务用例分别检出会话输入 owner 版本与 consumed 终态保护被移除。生产代码未修改，没有将故障注入的失败当成实际产品缺陷。

仍需任务动作、多任务、资源和 durable 崩溃恢复的生成覆盖；其他交互、性能、恢复处置及完整验收仍在原 Goal 内。

## 2026-09-12 键盘清空接入统一会话

Delete/Backspace 通过可选 Viewport onClear 进入 DataGrid 既有输入准备链路。按钮和键盘共用目标/codec 审查和单次请求保护；焦点在选区内清空固定选区，选区外仅清空焦点单元格。原生输入控件、修饰键、IME、按键重复与已有会话不被清空入口接管。

新增两种按键的批量排序/保存/重开测试，以及焦点身份、原文保护、重载、保存失败重试及四种桌面宽度检查。首轮三个失败均为测试将失败尝试计入成功 saves 的断言错误，已按实际未保存反馈修正；没有改变生产成功定义。

清空/复制/网格联合三浏览器 75 项、完整单元 825 项、类型/边界、lint、发布包三浏览器与空白检查通过。具体验证结果见验收索引。上下文菜单/拖动填充、长期状态成本、恢复与最终完整审计仍在 Goal 内。

## 2026-09-12 Workspace 上下文菜单

右键/键盘菜单接入编辑、复制、保留粘贴、清空与 Workspace 命令。工具栏与菜单共享能力/执行/反馈；菜单只保存可失效的视图上下文，任何快照/选区/定义变化及执行前复核都阻止过期动作。native Popover 保留主题继承与视口内定位，菜单关闭不处置编辑会话。

三条三浏览器流程已覆盖真实复制、保存与已保存撤销、当前输入保护、保存失败重试、重载、键盘焦点及四种桌面宽度。边界测试的合成事件已改为携带坐标的 MouseEvent。最终菜单/清空/复制/网格联合三浏览器 84 项、完整单元 825 项、类型/边界、lint、发布包三浏览器与空白检查通过；结果见验收索引，其余原 Goal 仍 active。

## 验证记录的解释

每个历史检查点中的运行结果只适用于当时的工作树，不是当前完整验收证明。删除旧模块后测试数量变化不等于覆盖增强或减少，必须按行为要求核对。最新统一验收结果应记录在验收索引；整个 Goal 仍未完成。

## 下一检查点

补齐模型生成/缩减能力，继续剩余交互、长期状态成本与恢复处置审计，按验收索引逐项关闭证据缺口。最终运行所有发布检查并完成完整工作树审查后，才可标记 Goal complete。

## 填充与拒绝结果持久化检查点

新增原生拖动和键盘矩形重复填充，共用固定来源/目标与矩阵编辑会话。真实拖动首轮暴露布局偏移，提示已脱离文档布局。随后三浏览器均复现过期填充被拒绝后刷新丢失原文；根因在 durable barrier 只提交 accepted，非填充特例。format 9 将持久化存储 token 与语义 revision 区分，允许没有语义变化的完整拒绝/忽略 ingress 回执；前驱阻塞、决策准备、任务准备失败纳入该屏障。新增测试恢复前不再 refresh，避免其他成功命令掩盖尾部输入未落盘。

此检查点不证明存储自身失败/未完成输入的耐久性，未关闭旧 custom fill/series 迁移与其余验收缺口。详见 state-kernel-acceptance.md 最新检查点。

最新验证为 833 单元、306 三浏览器流程、10 项变异全部检出（基线 389），类型/边界/lint/demo 构建/发布包三浏览器消费通过。浏览器共享 fixture 检查实际运行时错误，并精确登记故障用例注入的网络错误。历史日志的一次 React 跨组件更新警告、刷新打断 Blob 读取时的 WebKit 异常仍是待定位事项；正常取消测试已等待持久化后的取消事实，未宣称解决任意时刻中断。整个 Goal 保持进行中。

## 刷新中断资源读取调查

独立浏览器探测（无项目代码）确认 WebKit 原生 Blob 加载日志也能被 Playwright 映射为 pageerror，虽然每次读取都已 catch 且无真实脚本异常。保留探测脚本及源码依据，未保留无效的 pagehide 生产实验。新增“取消与刷新同回合”的恢复用例，验证新文档中的原始文件字节与服务器完整状态；明确中断窗口中的原生诊断被记录为附件，脚本异常及正常流程错误仍失败。

三浏览器重复中断 30 项通过，完整浏览器 309 项、833 单元、类型/边界/lint/空白检查通过。React 警告仍缺稳定复现，已增加调用栈附件。验收结论与剩余边界见 acceptance 最新小节；本轮不将整个 Goal 标记完成。

## 任务取消入口与逐项断言核查

回到设计 §15.2 建立 C01–C29 台账，逐断言核查实际部分提交、删除收敛和失败 materialization 的原文守恒。发现任务 Escape 入口缺失，已接入按钮/API 使用的同一个取消命令；只处理获得焦点的任务面板和取消按钮，执行时复核真实所有权与持久化状态。重复事件、IME、修饰键以及编辑/预览控件不被误处理。

三浏览器验证取消的单次转换、迟到结果隔离、重开后取消事实、原文件下载和实际服务器版本不变。完整浏览器 318 项、833 单元和发布包三浏览器消费通过；随后收紧焦点处理范围的相关 36 项通过，最终加强断言后的上传/批量图片 27 项通过，类型/边界/lint/demo 构建通过。完整浏览器运行与最终局部验证的区别详见 acceptance“任务取消入口”。C01/C02/C15 有具体审阅证据，C03 模型和其余逐项核查仍待完成；不缩减原 Goal。

## 迟到回执与后继输入验收

沿 persistence 的 completeCommit、observeAuthority、acceptExactReceipt 复核：只有冻结 coverage 被结算，较新完整 authority 不被回执 canonical 覆盖；同版本 canonical 一致性与前沿屏障分开校验。核对独立服务器和业务模型后，将 C05/C06/C21/C22 的具体定向证据写入台账，不扩展为全部异步运行时或恢复验收。

加强迟到回执场景：重复 exact receipt 不改变 state，随后旧读和重复当前读仍保留较新隐藏字段、精确冲突 base、未发送后继的完整原文和不可保存状态；只结算前驱且服务器只写一次。语义读取规范化场景补上 prepareSave 拒绝和实际服务器文档/写次数断言。生产代码未改动。persistence/recovery/generated-save 三文件 88 项通过，类型/边界、lint 和空白检查通过。其他未关闭设计项继续保留在完整 Goal 中。

## 部分保存、主键回填与输入归属组合

新增 creation-ownership.test.ts，将冲突删除、创建保存、未发送后继编辑、活动会话、迟到上传候选和条件撤销放在同一条链路。独立 SourceFixture 实际分配不同服务器 key 并规范化 x/hidden；断言冻结 coverage 只有创建、原 EntityId 与会话目标不变、所有原 intent 不变、任务仅消费到原会话、撤销后继回到 canonical 值、冲突删除原文仍待处理，以及服务器完整文档和一次写入。此证据关闭 C04 的内核组合反例，不代替 durable 崩溃或浏览器验收。

创建归属、persistence、结构模型、session、task、history 六文件共 143 项通过。生产代码本轮未改变，完整 Goal 的其他缺项继续保留。

## unknown 撤销与部分提交补偿验收

审阅发现 unknown/undo 模型枚举在接纳最终证据后、核对结果前执行 redo，单独撤销阶段的错误可能被后续操作遮盖。新增 redo 之前的分支断言：实际已应用时只允许 canonical before→原目标的补偿且保留隐藏字段；确定未应用时零 changes、freeze 拒绝、零服务器写入。模型比较同时核对实际服务器完整文档，不再只有 writes 数量。

部分提交后撤销的定向测试补上两次请求的精确行成员和 before/after、两次实际服务器完整文档：冲突 A 始终为远端 9，只有已提交 B 被补偿。C07/C09 已写入具体证据，C08 连续历史的全部要求仍待逐项核对。history/redo/generated-history 共 212 项通过；随后加强部分提交断言的 history 59 项通过。没有修改生产实现或宣称整个 Goal 完成。

## 连续规范化保存生成时序

新增 generateRepeatedSaveTrace，64 个可重放 seed 各连续保存 3–8 次，在同一 Workspace 历史中交错双行编辑、保存期间后继输入、unknown、undo/redo、回执前读取和旧读。沿用独立业务模型/服务器，每步核对预览、完整服务器文档、可提交集合、输入原文和请求不可变性；新增所有历史冻结请求持续检查，避免检查只覆盖最后一笔请求。失败沿用同性质事件删除缩减。

该生成器保证后续 freeze 有输入，未加入跨周期外部冲突；单周期冲突生成仍保留。结构、动作候选、多任务、durable 崩溃恢复和数值缩减仍开放，不能将连续周期通过扩大为这些组合完成。新增 64 项及原有历史生成共 131 项通过，已纳入既有变异门禁选择的 generated-history-model 套件。

最终全量 57 文件/898 单元、类型/边界、lint、空白检查通过；10 种语义变异全部检出。新增连续周期的 64 条序列分别全部检出 settle-unsent-intents 与 suppress-unknown-undo，报告保留同性质缩减反例；工作树生产文件未被变异运行修改。此次仅测试和文档变更，未重复浏览器/发布包运行，也不声称这些最终门禁已在当前完整工作树重新完成。

## 数值反例简化

minimizeTrace 支持可选的候选生成和非负安全整数 rank，候选必须严格降低 rank，避免循环。整数保存输入尝试 0、同号 1 和向零折半；只保留相同 property 的失败，invalid、另一种失败或基础设施异常不能被当成成功缩减。每次接受数值简化后重做事件删除，直到两类操作共同达到固定点。保存和历史生成器已接入；任务值简化仍未提供。

新增测试覆盖数值简化后原先必需的 read 可删除、0 触发另一缺陷时不接受、原始 trace 不变、同 rank 循环被拒绝、候选重放基础设施错误继续抛出。相关生成三文件 200 项、类型/边界/lint 通过。这里只主张相对于提供候选的局部最小性，未声称全局最短。

最终全量 57 文件/900 单元通过，10 项语义变异全部检出。实际 settle-unsent-intents 的连续保存 seed 0 从 79 步缩减至 6 步，两次写入均简化为 1，保留 visible-values 性质；报告含原序列、seed、最终 trace 与 single-event-deletion-and-value-candidates 声明。未修改生产代码，其他重构验收仍待继续。

## 同一行长期投影成本证据

实际接纳 16/32/64 次同字段编辑后，仅对一次投影计数 operationResource，得到 272/1056/4160 次。源码确认前缀抵消和每个写基准的后缀目标计算分别重复扫描。该证据否定“独立行索引已解决长期投影成本”的假设；§18 继续开放。调查记录见 projection-cost-investigation.md，临时探测已删除，未保留调试代码或把平方成本设为通过阈值。本轮不声称性能已修复，下一步需共同设计域归并与前后缀求值，保护完整历史和输入。

## 比较域后缀计划

新增投影局部 resource-suffix 计划，按实体索引操作位置、按域共享后缀。无条件覆盖比较域的操作提前求值，其他嵌套 patch 保留执行及失败顺序；不借用最新 preview，不跨不可变状态复用缓存。projectThrough 使用此计划求每个 authored base 的完整目标。独立实体不再为每个域保留全局操作长度的数组。

定向测试对照原顺序求值算法，覆盖不同起点/base、父子域、缺失/null、删除/创建、跨实体写入、无效嵌套操作后再覆盖。真实接纳 16/32/64 个同字段 intent 的计数测试确认后缀重复调用被移除，完整预览、intent 与 input 数量保留；前缀抵消仍为平方成本，§18 不关闭。首轮类型检查暴露测试协议字段和 nullable program 标注错误，已修正，未放宽检查。

最终 58 文件/904 单元、完整三浏览器 318 项、类型/边界/lint、demo 构建、发布包构建和三浏览器消费通过；10 种语义变异全部检出。浏览器运行期间未修改生产代码。该结果验证本次后缀计划的交付，不关闭前缀抵消、复杂域、长期历史和其他 Goal 验收缺口。

## 增量 authoring 前缀

createNeutralPrefix 逐 intent 维护比较根及其目标。已有覆盖域复用；首次扩展到宽域时逆向还原原 authoring base，之后只应用新增步骤。失败目标保留失败；create/delete 终止规则和完整 application 边界保持。抵消时只重建临时计划，输入与 journal 不被清理。避免原先每个前缀都展开和重放完整历史。

新增语义测试覆盖嵌套字段到整行的根扩展、删除 nullable 字段后恢复、远端 profile=null 后抵消不复活、后继新输入，以及同 application 中先抵消再修改不能提前切段。同字段真实接纳 16/32/64 个 intent 的资源运算检查由平方上界收紧为 2N，仍核对完整文档及输入/intent 数量。此计数不能证明所有复杂域或整个投影总成本为线性。

最终 59 文件/906 单元、完整三浏览器 318 项、类型/边界/lint、demo 构建、发布包构建与三浏览器消费通过；10 种语义变异全部检出。旧前缀实现已替换，无生产兼容分支；浏览器验证期间未改生产源码。§18 的完整成本、历史保留/回收以及其余 Goal 项仍保持开放。

## 旧格式只读数据库归档入口

核查发现旧格式拒绝测试不能证明用户能够取回数据。新增 exportIndexedDbRecoveryDatabase，从单个 readonly 事务捕获指定数据库所有存储的键值，独立于当前 schema/lease；返回带类型标签的 JSON Blob，保留 undefined/null、数字、二进制和 Blob/File 元数据，不将旧根转换为当前格式，也不删除或重写数据。明确它包含指定数据库内所有 Workspace，且当前为内存归档，不是 checkpoint 导入或流式数据库备份。

三浏览器 6 项验证旧 layout 1、format 1/8、中文原文、undefined、复合键和二进制字节、原 lease/root 和数据库版本不变，以及不存在的库不会因导出被创建。最终类型/边界/lint、空白检查及发布包构建和三浏览器消费通过。加载失败 UI 仍需接入此 API；旧格式实际拒绝到用户下载的完整流程尚未关闭 §17。接口限制与标签格式已写入迁移指南。

## 加载失败后的原始归档下载

四个 durable 示例共用 WorkspaceOpenError，在原有重试入口旁提供显式准备下载和下载链接。准备期间禁用重复入口，失败可重试，不显示未准备好的链接；卸载释放 object URL，并通过 generation 拒绝迟到结果。该组件属于宿主打开 Workspace 的错误处理，没有建立第二份编辑状态。

三浏览器四路由 12 项测试真实注入旧 schema/codec/scope 的存储头及 format 1 原文/文件，确认打开失败、没有空网格冒充恢复成功、键盘准备、四种桌面宽度、下载文件名及归档全文与原始存储一致；刷新和重新打开仍保留原数据。另注入一次只读事务失败验证反馈和重试下载。此链路验证身份/版本不兼容的打开失败；同身份旧根内容格式、旧 checkpoint 等其他拒绝分支仍需补齐，§17 不据此整体关闭。

最终完整三浏览器 336 项、类型/边界/lint、demo 构建与空白检查通过。此次只改示例加载失败界面和浏览器测试，未重复未变更的内核单元/变异及发布包检查；历史绿色记录不等于所有 Goal 退出条件已完成。

## 同身份旧根格式与下载恢复

新增 old-root-recovery 三浏览器 format 1–8 共 24 项：先经真实 Quick Start 编辑框接纳中文原文，等待输入落盘；卸载文档释放 owner 后才修改根的 format 标记，保留实际 identity/commit/manifest，另保留原文件字节。重新打开实际走旧根内容拒绝，并通过用户下载入口连续下载、刷新。每次检查下载全文与当前只读归档一致，原文/文件字节存在，原 record、root 和 workspace identity 与注入前基线完全相等。新打开会获取新 lease epoch，因此没有把 epoch 不变作为这个场景的错误要求。

24 项通过，空白检查通过；此次仅新增浏览器验证与验收记录，生产实现未修改。用例验证受控旧格式拒绝，不证明对真实历史发布对象形状的迁移兼容；真实旧档案、旧 checkpoint 和转换工具仍是独立验收范围，完整 Goal 继续 active。

## 创建 unknown 后的删除与撤销

新增 creation-outcome 六种组合，独立 SourceFixture 实际执行创建成功/版本 CAS 拒绝/成功后删除并复用主键。unknown 时删除或撤销不能产生后继写，冻结请求逐字不变；成功分支随后实际提交的 delete 必须携带原 assigned identity 与完整 canonical before；拒绝分支零写入；复用 key 分支保留新 incarnation 的完整文档，只退役旧 EntityId。原创建 intent、创建原文和显式删除原文一直保留。

创建结果/归属、persistence、history、结构模型、entities 六文件 126 项、类型/边界/lint 和空白检查通过。C10 的内核定向组合已记录；旧任务面对身份复用的 C11 仍需单独核查，不能从创建删除保护推断任务链路也已验收。生产代码未改动，完整 Goal 继续进行。

## 主键复用后的迟到任务

补齐 task 的 session/field 两条定向路径：旧行有未保存 intent，任务启动后该行消失，再出现同服务端 key、不同 incarnation/EntityId 的完整新行。旧任务结果必须留在原 owner/input 上；旧行 retired，旧 intent 和原文不变，新行隐藏字段与值不被覆盖。显式 task-consume 被拒绝，state 保持同对象且没有 effects，投影无可提交 changes；会话原目标及原文也保持。C11 记录的是这些内核证据，不推断所有 durable 重开组合已完成。

task/entities/creation-outcome/generated-task/durable-task 五文件 111 项通过，生产代码未修改。完整 Goal 继续按其余台账推进。

## 整行替换权限与拒绝持久化

新增 replacement-atomicity 八种 schema/policy × 父域删除/置空、只读叶缺失/改值组合。第一行合法、第二行违法时，整个替换请求拒绝，语义 state 同对象、零 journal/changes；完整两行原文作为 rejected ingress 落盘，未借助后续成功命令立即重新打开，仍逐字保留。独立 SourceFixture 的完整服务器文档未变且 writes=0。schema 另补允许修改可写兄弟字段并删除不受保护字段的正向用例，避免把整行替换全部禁用当作权限保护。

替换/schema/session/task/durable-ingress 五文件 64 项通过；追加正向用例后 schema 单独复验。本轮生产实现未修改，C12 更新为上述具体内核/恢复证据，未声称所有服务端适配器权限已证明。其余原 Goal 范围继续保留。

## 排序冲突与结构依赖的精确部分保存

将 order 的结构依赖场景扩展为 create/delete 两条链，并补实际请求 coverage、完整服务器顺序/成员/文档、写入次数和保存后再次读取的保留断言。排序冲突只能让无关 A 字段更新进入请求；结构 intent/原文不被此保存结算，服务器 B/A/C 顺序不变。此证据关闭 C13 的定向用例，不替代尚未完成的结构生成模型或其他发布验收。

order/structure-model/history 三文件 117 项通过；生产代码未改变。完整 Goal 持续进行。

## 缺失精确回执的查询屏障

新增 gateway 三种 404/unknown/pending 查询组合：独立 SourceFixture 已实际执行并规范化，客户端仅收到 applied-without-receipt；分别观察旧快照与最新完整快照都不能结算或生成 not-applied。retry 只允许 lookup，重复 gateway.submit 返回已有应用证据，不增加 Source 请求。真实精确回执恢复后只结算前驱，后继原文/intent 保留，完整服务端 canonical 文档与写入次数独立核对。C20 更新为这组具体链路证据。

gateway/persistence 两文件 44 项通过；生产代码未修改，其他原 Goal 要求继续保留。

## 合并提交后的连续历史导航

加强 history 的 coalesced 场景：两个原动作共享冻结 coverage，只收到一份规范化 canonical；随后连续 undo、保存、连续 redo、保存、连续 undo、保存，逐步断言用户动作中间值及规范化隐藏字段。独立 SourceFixture 实际收到的四次目标仅为 2/0/2/0，不出现历史浏览中的中间值 1；最终完整服务器文档、writes=4、两个原 intent 和原文保持。另审阅独立 reference-model 的同场景 coverage/补偿断言，C08 更新为具体证据。

history/reference-model/redo-model/generated-history 四文件 290 项、类型/边界/lint/空白检查通过。生产代码未修改，其余完整 Goal 范围继续保留。

## 单行结构历史生成调度

structure-model 在原固定枚举外新增 64 个可重放 seed，生成 8–31 个 save/undo/redo 事件并追加最终 save，交错创建/删除模板、规范化和恢复能力。每步继续对照不导入生产代码的 ReferenceStructure，核对可见完整文档、逻辑 lifetime 到 EntityId 的稳定/新生映射、实际服务器完整内容和 writes；每次保存还核对精确结构变更，以及旧绑定不能改成另一服务端 identity。无可撤销/重做动作和不支持恢复时的拒绝也保留为调度事件，不通过跳过失败隐藏它们。

结构套件 98 项通过。当前只有单行模板的生成调度，未实现结构反例自动缩减、字段/顺序组合或 crash/reopen 生成；这些仍在原 Goal 内，不能以新增 seed 数量宣称 M0 完成。

最终全量 61 文件/991 单元、类型/边界/lint/空白检查通过；10 项语义变异全部检出。报告中新增结构 seed 用例分别有 32 条检出 drop-unconfirmed-deletion、31 条检出 settle-unsent-intents。此次未修改生产实现，也未重复浏览器/发布包验证；整个 Goal 保持进行中。


## 单行结构反例缩减与回放边界

抽出 tests/kernel/structure-trace.ts，使固定枚举和 64 个生成 seed 使用同一个新建状态回放器；ReferenceStructure 仍独立于生产实现。失败按完整文档、生命周期、服务端身份、写集合、历史拒绝和保存结算分别标记 property，生成序列仅接受保留同一 property 的事件删除。输出原 scenario、缩减事件、失败实际/期望值及尝试次数；初始创建/删除模板不参与删除，最小性只限单个后续事件删除。

回放仅将显式比较失败转成可缩减结果，源传输异常直接抛出；新增回归证明这一点。历史准备只承认没有可操作历史和不支持删除恢复这两类明确的预期拒绝，其他异常传播。真实变异显示保存后缺少结算断言会让失败拖到下一次 freeze；已补上每次 exact receipt 和 authority read 后的 idle 检查，避免以流程异常替代原语义失败。

本轮不改变生产实现；多行结构/字段/顺序、跨周期外部冲突、任务动作和恢复生成仍待完成。

最终当前树全量 61 文件/992 单元、类型/边界/lint/空白检查通过；10 项语义变异全部检出，变异脚本确认工作区生产源码未变。drop-unconfirmed-deletion 的 seed=1 原 14 事件缩成空后续序列，visible-documents 在 begin 即失败；settle-unsent-intents 同 seed 缩成 save → undo → save，保持 save-settled 性质，actual=receipt-blocked、expected=idle。未重复浏览器和发布包验证（本轮仅测试及文档改动），整个 Goal 继续进行。

## 自定义填充迁移到捕获上下文与矩阵会话

新增列级 WorkspaceFill / WorkspaceFillContext，替代旧 cell-type fill callback。源序列经捕获的目标 codec 转换；回调获得完整捕获文档、实体/字段/显示列身份、方向及有符号序列索引，且上下文深度拥有并冻结。只计算源矩形以外的新单元格；横向采用源行序列、纵向及对角扩展采用源列序列。结果先格式化为矩阵会话原文，完整 Apply、权威 Save 和历史控制复用新内核，不从回调直接提交。失败不返回部分矩阵，不改动源数据。Quantity 示例支持数值序列。

单元验证四方向、隐藏文档、不可变上下文、跨列目标解析、源转换失败和中途回调异常。初轮浏览器新增用例因 has 定位包含外层 grid 而超时；修正测试定位后通过。最终填充 18 项三浏览器用例覆盖原 literal 工作流、自定义序列的 reload/Apply/Save/saved undo、不兼容填充后重试，以及手势期间源值 12→99 时仍保留 12/13 并进入 stale ingress、重载不丢失。全量 61 文件/994 单元、类型/边界/lint/demo 构建通过，发布包三浏览器消费通过。完整浏览器套件正在另行验证。

原 Goal 仍有多行/恢复组合生成、长期历史/渲染成本及逐项最终审计等剩余范围；本轮只关闭自定义 fill/series 的迁移缺口，不声称整个交互或重构完成。


沿数据链继续审计发现：仅固定手势 revision 不足以保护回调读取的隐藏字段。补齐 callback 目标整文档 → session.dependencies → prepared write semantic-read 的传递；Apply 前变化阻止 Apply，Apply 后变化阻止 Save，两者重载后继续保留。新增两条三浏览器用例均直接更改独立权威存储的隐藏字段并核对完整服务器文档。最终填充 24 用例、994 单元、类型/边界/lint/demo 构建通过；前一版本全量 369 浏览器通过，加入依赖链保护后的当前树全量浏览器及发布包正重新验证。

本轮当前生产树首次全量浏览器为 374 通过/1 失败：旧格式恢复测试在临时 Playground 页面切回首页时触发 WebKit page.goto internal error；重复该组 3 次为 22 通过/2 次同位置失败。临时页尚未完成异步 Workspace 初始化便被再次导航，属于测试准备阶段存在的竞态窗口。增加 Inventory grid 就绪断言后同组 WebKit 连续 5 次共 40 项通过；未增加错误忽略、自动重试或延时。该证据说明等待真实就绪消除了当前复现，但不宣称已定位 WebKit 内部错误的引擎根因。完整浏览器套件据此再次验证，其他恢复内容/下载/原文断言保持不变。

最终当前树完整三浏览器 375 项通过；发布包 Chromium/Firefox/WebKit 消费、994 单元、类型/边界/lint/demo 构建和空白检查通过。标准 scalar codec 的 format 已拒绝不可表示值，missing/null/empty 按显式 empty 策略区分，本轮未增加隐式值转换。变异套件本轮未重跑（内核语义实现未改）；此前 10 项变异证据仍保留。完整 Goal 不标记完成。

## 会话上下文与提交计算依赖的角色审计

继续检查 session-opened → session-apply → authority-observed 边界。按设计 §4/§6，会话依赖是编辑阶段的上下文检查；业务计算必须在准备 WritePlan 时明确声明 semantic-read，不能把普通目标字段的比较基值一律当计算依赖。上一轮自定义填充将实际暴露给回调的整文档依赖显式传入 WritePlan，符合这一边界；不能据此在内核中把所有会话观察统一升级为 semantic-read。

session.test.ts 新增 8 种组合：是否声明跨行 b.x 计算依赖、依赖是否变化、远端 a.x 是否已等于目标。每种均经真实 session-apply、两次 authority-observed，核对完整写目标及隐藏字段、原 journal、原输入与归宿。计算前提变化始终 semantic-read-changed、零候选写、零结算，即使远端目标相等；无计算依赖或依赖稳定时允许写入或外部满足，并只保留第一次观察的精确 externally-satisfied 证明。最初测试错误地要求已外部满足的输入继续由 intents 持有；按既定 settled-intents 归宿修正期望，并增加证明内容/观察身份断言，没有修改生产行为。

本轮属于角色边界证据补齐，不声称任务/会话全部语义或完整重构已完成。

全量 61 文件/1002 单元通过；补齐测试 ResourceRef 的非空路径类型后，类型/边界、session/task 39 项、lint 与空白检查通过。本轮仅测试和文档改动，未重复浏览器、变异或发布包验证；生产行为未修改，Goal 继续进行。

## 移除每项检查的全局步骤前缀复制

本轮在真实长日志上先建立分配计数反例：N=16/32/64 时单投影复制步骤 120/496/2016，三个线性上界断言均失败。步骤计划增加 intentStart，以可迭代局部前缀取代 steps.slice/filter/map；仅在 exact canonical 前驱解析确实需要时访问当前 intent 的早期组。原始输入、完整状态和可提交 coverage 均保留，定向 13 项与类型/边界通过。已有 persistence 有序多组 canonical 场景继续作为语义保护；完整单元、变异、三浏览器及发布包检查正在运行。

此项不关闭 §18：前驱集合扫描、历史保留/压缩与完整 DOM 等原要求保持开放。

最终当前树全量 61 文件/1005 单元、375 三浏览器、10 项语义变异、类型/边界/lint/demo 构建及发布包三浏览器消费全部通过。变异检查在隔离副本执行，未改变工作区生产源码。空白检查通过。该优化完成局部前缀分配热点的处理，不替代剩余性能和完整 M0–M6 验收；Goal 保持进行中。


## 任务运行期间刷新、权限和目标变化的运行时验收

补强 task-workspace 两条既有测试：刷新场景核对完整服务端 a{x:8,hidden:11}/b{x:5}、writes=1、原输入及 execute=1；权限场景核对撤销期间 consume 拒绝、零 journal/服务器写、完整结果与输入保持，权限恢复本身不自动应用，显式 consume/save 后完整文档正确且原输入转入 settled-intents。

新增运行时改投目标链：执行前已准备写 A 的结果；执行中 A 被权威更新为 x2/hidden9；迟到结果受阻，原请求和完整输出保留。旧 revision 的 reapply 拒绝且零副作用；当前审核明确改投 B 后，唯一实际请求只更新 B 为 x8，A 保持完整远端文档，原任务结果及输入仍可追溯，executor 只运行一次。测试最初错误地使用注册前 generation=0 比较任务 owner；注册会推进 generation，已改为比较实际注册并完成后的 task.owner，没有修改生产实现。

C14 记录这三个 memory runtime 路径的确切证据，仍保留真实文件字节、durable 重开和 UI 组合审计，不能由此推断全部上传恢复能力已验收。

最终全量 61 文件/1006 单元、类型/边界/lint/空白检查通过。本轮仅测试及验收文档改动，未重复浏览器、变异和发布包检查。完整 Goal 仍在进行。


## durable 文件任务在撤权和响应丢失后的恢复

新增 durable-task 场景，使用真实 File（中文名称、二进制 0/255/128 字节及固定时间/MIME）、独立 DurableTaskFixture 外部服务和 RecoveryFixture 事务存储。外部执行被 gate 控制，先撤销目标写权限再完成并丢失响应；旧实例仅持有 unknown。新 lease 接管重开后通过 exact lookup 恢复成功结果，但保持 blocked，原编辑文字及文件任务归属不变；逐字节读取原文件并验证 releaseResource 与 consume 均拒绝，journal 和服务器写入仍为零。

再次接管重开保留完整受阻 TaskState、原文件字节。恢复权限本身不改输入或写数据，明确 consume 后候选进入会话，原文件转为 retainedInputs；完整 Apply/Save 后再重开，服务器完整文档为 value42/hidden7，file input 进入 settled-intents，文件字节和精确 task outcome 仍完整。任务请求原字节、文件描述、服务端独立资源 hash 验证、lookup 请求、执行次数和实际服务器写入均核对，服务仅执行一次、服务器仅写一次。这里是 lease 接管并 fence 旧实例，不冒充主动 clean close。

全量 61 文件/1007 单元、类型/边界/lint/空白检查通过。本轮未改生产实现；该测试使用 RecoveryFixture，不替代真实 IndexedDB/UI 的组合验收，改投目标的 durable 场景仍待审计。C14 已按此证据收窄剩余范围，完整 Goal 继续进行。


## 真实 IndexedDB 与界面的撤权文件恢复

在 owned-upload fixture 增加仅供测试注入的权限观察入口，生产内核/组件未修改。新三浏览器用例实际选择中文文件名的 SVG，暂停 FileReader 转换，撤销权限后释放转换；结果 blocked、原编辑文字和任务输入归属保留，完整服务器 scope/version/rows/order 不变。重载并通过 IndexedDB 重开后，任务结果和 execution 保持，界面原文件下载的名称与字节完全一致。恢复权限后必须 Resume editing → Use result in this edit → Apply → Save；再重载显示正确图片，完整目标和另一工作区文档正确，权威版本只增加一次，原 file input 进入 settled-intents。

初轮断言误把每次 read 的新 observation ID 当作服务器写入变化，已改为比较完整语义内容及版本；第二次误认为未恢复编辑的界面存在 disabled Apply，已按实际流程断言该按钮不存在，再恢复编辑并执行后续动作。均为测试期望修正，没有放宽数据/下载/错误日志检查。

最终 owned-upload 与 durable-task 合计 21 项三浏览器、类型/边界/lint/空白检查通过。本轮仅测试、fixture 注入入口和验收文档改动，未重复全量单元/浏览器、变异或发布包检查。真实浏览器中“响应丢失与撤权同时发生”尚未组合，改投目标的 durable 路径也仍待审计；完整 Goal 继续进行。


## 批量任务第二项无效的 durable 原子性

审阅既有 task.test 的两行 schema 失败及完整 ownership bundle 拒绝测试，再补 durable-task 端到端场景。真实二进制 File 作为整批共同输入，任务输出明确包含有效首项 value42 更新和非法第二项 value−1 创建。结果保持 blocked，完整两项原提案与文件输入持有关系落入 durable root；零 journal、零候选变更、零源请求/写入，完整服务器初始文档未变。RecoveryFixture 新 lease 接管重开后 TaskState 和输入记录相等，文件逐字节相等，直接 consume 仍拒绝。

显式准备修正后的完整两项提案并 reapply/save，独立 SourceFixture 只收到一次含两项的请求，完整输出为原行 value42/hidden7 与新行 value9。再次重开仍保留原非法 task result 和 exact execution outcome、原文件字节及 settled-intents 归属；外部任务仅执行一次。C16 已记录这组具体证据，不把该事务 fixture 当作真实浏览器存储证据。

全量 61 文件/1008 单元、类型/边界/lint/空白检查通过。生产代码未修改，本轮不重复浏览器、变异与发布包验证；完整 Goal 保持进行中。


## 已消费任务的迟到取消与精确提交后的读取失败

扩展 durable 文件撤权恢复场景：任务消费并保存后，同一实体打开新的中文未提交输入；旧 task-cancelled 返回 ignored，内核 state 同一引用，任务、所有输入和文件字节不变。再接管重开后重复旧取消仍 ignored，新输入身份/原文保留，服务器与任务执行次数均保持一。此处验证消费终态不能因旧取消伤及下一轮编辑。

新增 durable-workspace 实际 Source 写入 + 精确回执 + 后续 read 抛错场景。首次服务器 canonical 为 value1.5/hidden canonical，客户端 awaiting-authority 保留 submitted1/旧隐藏字段、零结算；此时接纳后继2。重开和再次 recover/read 失败都显示2、保留完整 commits/journal/inputs，Source 请求/写入仍各一且 lookup=0。恢复 read 后只结算第一 intent，后继显示2并带 canonical 隐藏字段；第二次实际提交 before1.5/after2，服务器规范化2.5，再重开完整文档与意图保持。没有从失败 read 重发第一笔或把后继提前结算。C21 记录运行时/durable 证据，浏览器该组合保持待验收。

两文件26项、类型/边界/lint通过；本轮只测试和验收文档变化，生产实现未改。

全量61文件/1009单元通过，空白检查通过。本轮未重复浏览器、变异或发布包验证。完整 Goal 保持进行中。


## 精确回执后读取失败的三浏览器链路

新增 commit-read-failure.spec.ts：真实 HTTP adapter 收到精确回执后，后续 read 以明确注入的 HTTP503 失败，独立 SourceFixture 已保存 FIRST/hidden9。用户界面仍显示 first，继续通过编辑器输入 second 并 Apply；真实 reload + IndexedDB 重开后显示 second。再次点击恢复并等待新503请求结束，原 intent、完整输入版本及原文保持、零结算、第一笔请求字节不变、source 只写一次且无 lookup。读恢复后只结算第一笔，后继保留 second 并使用 canonical FIRST/hidden9 为下一次写入基值；第二次 Save 与重载显示 SECOND，全部原意图和输入内容/引用保持，总实际写入两次。

首轮测试把真实编辑器的 superseded 输入遗漏在预期外，Firefox 还可能生成不同数量的中间版本；改为从恢复前完整输入快照按第一笔 intent 的归属逐项推导唯一允许的归宿变化，并逐项比较全部 ref/input。去掉 reload 后冗余 goto，避免在尚未完成初始化的同页再导航；所有数据、输入、503和浏览器错误检查保留。

与 durable-workspace 浏览器组共18项通过，最终补强保存后原意图/输入及首请求不变断言后，新场景3项再次通过，空白检查通过。本轮仅测试及验收文档变化，未重复其他门禁。C21 数据/恢复链已有浏览器证据；toolbar 对 unresolved 的统一文案是否准确区分已确认写入与未知结果，仍需进一步核对。完整 Goal 保持进行中。

## 已确认写入的持久化反馈

WorkspaceToolbar 从 persistence 直接派生 committed-awaiting-authority 与 committed-awaiting-receipt 的 status，分别提示等待更新数据与等待保存明细；不再把这两种已确认写入显示为保存结果未知。状态在继续编辑和重载后保留。操作 pending 仍显示工作中，其他操作失败反馈单独保留，仅抑制已确认阶段的 unresolved 文案。英文/中文 locale 和自定义 toolbar 迁移契约同步增加两项。

commit-read-failure 浏览器验证 exact receipt 后 HTTP503 的显示与重载；新增 applied-without-receipt 场景，首次自动 lookup 暂无明细，重载后仍显示等待明细，显式恢复取得回执后显示 FIRST，服务器只写一次，两次 lookup。首轮新测试错误地让首次自动 lookup 立即取得完整回执，导致断言时已无等待状态；改为真实延迟回执可用性，不改变生产恢复调度。

定向三浏览器21项、61文件/1009单元、类型/边界/lint通过。完整 Goal 保持进行中。

本检查点全量384浏览器、demo构建、发布包构建及 Chromium/Firefox/WebKit 实际消费全部通过，空白检查通过。本轮未修改 reducer，未重复变异测试；不以这些结果替代其余逐项验收。

## C23：保存中的已接纳 undo 与旧存储回执

新增 durable-workspace 三条链路。冻结提交时注入更早语义提交的正存储回执，save blocked、storage unknown；旧回执查询仍不放行 source I/O，恢复精确存储查询后仅查询原 operation，明确 retry 才执行唯一原请求。注入位置限定 freeze-submission，避免把更早 save-requested 的存储失败误作 reservation 已创建。

保存仍在发送时接纳并持久化 undo，然后 RecoveryFixture 新 lease 接管重开。原保存成功分支返回 canonical1.5/隐藏 canonical，恢复后的可见撤销值0，实际补偿 before1.5/after0，第二次重开仍0且两次写入；旧 fenced runtime 的迟到结果不发布。原保存拒绝分支在完成前发生 remote9/隐藏 remote，恢复拒绝证明后刷新仍9，零 changes，save 明确因无可保存意图 blocked，零补偿写，重开不回退。两分支均逐项保持原 journal、输入引用/原文与第一笔冻结请求。

首轮拒绝分支将无可保存意图误写为 no-changes 返回；核对 Workspace 的实际阻止契约后改为精确 blocked issue，并继续断言零 changes/写入及完整服务器状态。首轮旧回执测试在 save-requested 就注入，尚无 reservation；现按事件边界注入冻结提交。未改变生产行为或放宽存储/业务断言。C23 台账限定为 RecoveryFixture 接管恢复证据。

定向两文件25项、全量61文件/1012单元、类型/边界/lint及空白检查通过。本轮仅增加测试与验收文档，未重复浏览器、变异和发布包验证。完整 Goal 继续进行。

## C24：checkpoint 导出过期与双 owner 激活

强化 checkpoint 的导出/键入交错测试：捕获原未知 storage token 和第一输入后，后继键入不混入固定归档；旧 ticket 对 retain、clean-close、checkpoint-close、discard 均返回 stale，生命周期 open、最新原文仍可见，checkpointWrites/source.requests 均为空。随后精确存储协调仍接纳完整后继输入，原归档独立校验通过。

新增 workspace-checkpoint 双 owner 恢复同一未知保存归档。第一个新 lease 在 load 前受控暂停，第二个 lease 接管并完成 checkpoint 安装和 lookup 恢复；释放首个暂停后，其激活以错误结束。胜出 owner 显示 canonical x1.5/隐藏 canonical，原 journal 和完整输入引用/原文保持，source 只有原请求/一次写入/一次 lookup；再普通重开与完整实际服务器文档一致。首轮误将 openCheckpoint 返回视作自动恢复扫描结束；已显式等待同一 recoverPendingWork 完成，不增加重复请求或人为延时。

该轮是存储 oracle 的确定性交错验证，不冒充浏览器双页面/进程崩溃。C24 台账保留双 owner 任务恢复组合未核查的范围。

全量61文件/1013单元、类型/边界/lint、空白检查通过。本轮未改生产实现，未重复浏览器、变异或发布包验证。完整 Goal 保持 active。

## C24：双 owner 文件任务恢复

新增 workspace-checkpoint 的确定性交错：持久化原始二进制 File（中文文件名、lastModified、0/255/高位字节），外部任务执行成功但响应丢失后导出。首恢复 owner 在读取根前暂停，第二 owner 接管并完成自动恢复扫描；首 owner 激活失败，胜出 owner 只 lookup 原执行并进入 consumed，会话结果42。服务端任务完整请求与 lookup 相同、只一次 start/执行，原输入 ref/内容均存在；再普通重开完整任务终态相等，会话结果、文件元数据/字节不变。业务 Source 零请求/写入且完整初始文档不变。

与上一轮同属 RecoveryFixture 的租约接管范围，不声称真实浏览器或进程故障已经覆盖。未修改生产内核。

全量61文件/1014单元、类型/边界/lint及空白检查通过。本轮仅测试/验收文档，未重复浏览器、变异或发布包。完整 Goal 继续 active。

## C29：恢复 lineage 与旧任务身份隔离

复核 history 的规范化字段撤销/删除恢复及 workspace 实际 gateway 路径后，新增两者组合的旧任务断言。字段写入保存后打开旧实体中文原文会话、登记并启动任务；删除保存，再 undo 删除、undo 早期字段并保存。历史补偿指向恢复新 EntityId，服务器完整 x0/hidden7，旧实体仍 retired，原字段 intent 不变。此时迟到 session-candidate 结果被保留，但 task-consume rejected、零 effects、state 同对象；旧 owner/input/会话 target/原文均保持，原上传输入仍存在，新实体零待保存 changes，实际服务器只三次预期写入。

测试使用 reducer 和独立 SourceFixture，不作为 durable 跨重开证明。未修改生产行为；C29 按此范围更新台账。

全量61文件/1015单元、类型/边界/lint及空白检查通过。本轮仅测试和验收记录，未重复浏览器、变异或发布包验证。完整 Goal 继续 active。

## C29：删除恢复与旧文件任务的持久化组合

durable-task setup 增加默认关闭的 SourceFixture restoreDeleted 能力参数，现有测试配置保持。新增真实 Workspace 流程：字段1保存，打开旧实体中文原文会话并登记 File 任务，暂停外部执行；删除保存后 lease 接管重开，undo 删除、undo 早期字段并保存到恢复新实体。恢复 create 请求绑定精确删除 operation/item。释放旧任务后再次接管并 lookup 原执行，结果保持 blocked，直接 consume 拒绝；再重开完整任务结果/owner/input 保持，旧实体 retired、新实体 value0/hidden7、零待保存 changes，原字段 intent 不变，文件中文名/内容和 task 输入归属保留。业务实际三笔写，任务一次 start/执行/lookup，完整原任务请求不变。

证据范围为独立 RecoveryFixture 的多次租约接管和独立 Source/任务服务执行，不代替浏览器进程故障。未修改生产代码。

全量61文件/1016单元、类型/边界/lint、空白检查通过。本轮仅测试和验收文档，未重复浏览器、变异或发布包。完整 Goal 继续 active。

## C25/C26：连续 composition 输入与旧视图事件

新增 durable-ingress 组合，首笔存储暂停时入队 n(composing)、ni(composing)、你(idle)。逐项核对 inputSequence 1/2/3 和 published0→first→second 前驱，published 原文未提前改变，最新投影为你；释放后逐笔存储的完整文字/composition 一致，接管重开完整输入记录相等、最后原文你/editor null。新视图获得新 lease 并写入新的输入后，旧 lease 已捕获的序号4/前驱third envelope 迟到，原文和 composing 状态持久保留在 ingress，但当前文字/composition 不受影响；再重开仍保留新文字、旧事件及全部原输入 ref/内容。

首轮测试误用 predecessor.ingressId，改为实际协议 id；随后 typeInput 对失效 lease 立即抛错，说明不能在过期后新建 envelope。按真实迟到消息边界改用 enqueueInput 提交已捕获的旧 lease/序号/前驱。没有调整生产行为。该测试使用显式 composition 标志，不声称系统原生 IME 或未耐久输入在进程丢弃时可恢复。

全量61文件/1017单元、类型/边界/lint及空白检查通过。本轮仅测试/验收文档，未重复浏览器、变异、发布包验证。完整 Goal 继续 active。

## C27：未确认输入关闭与原 token 恢复

新增 checkpoint-close 完整交错：暂停中文输入的存储提交，clean-close 和 checkpoint-close 都 blocked；生命周期 open、published state 同对象、durable root 不变，最新输入投影仍可见，checkpoint/source 未写。释放存储但丢失确认后保持 unknown；普通关闭仍 blocked，显式 checkpoint-close 转交完整未知状态并成功关闭，旧 runtime 不假装发布输入。恢复只查询原精确 PreparedStorageCommit，原文在 inputs 恰一份；第二次普通重开完整 inputs 相等，查询仍只有原 token 一次、checkpoint 写一次、业务 Source 零写。

该证据限定独立 RecoveryFixture 的存储/回执交错；不覆盖底层 IndexedDB 真实故障的用户界面。未修改生产代码。

全量61文件/1018单元、类型/边界/lint及空白检查通过。本轮仅测试/验收文档，未重复浏览器、变异或发布包。完整 Goal 保持 active。

## C28：受阻结果改投的持久化链

新增 durable-task 字段任务：A 的原转换提案42完成前，独立远端把 A 改9，结果受阻。重开完整 task 相同，准备B的新提案；过期 review 拒绝且完整 inputs/journal 不变，当前 review 明确改投成功，实际唯一请求仅 B0→42/隐藏8，A9/隐藏7保持。再重开重复 task-reapply ignored、state 同对象；完整原 owner/input/execution/result 不变，服务只执行一次、无额外 lookup，业务只写一次。

测试首轮使用登记前 field generation，按生产所有权规则改用登记后当前 generation；终态重复改投返回 ignored 而非 rejected，修正为精确终态契约并保留 state 同对象/次数断言。未修改生产行为。证据使用 RecoveryFixture，C14/C28 台账同步更新此范围。

全量61文件/1019单元、类型/边界/lint和空白检查通过。本轮只测试/验收文档，未重复浏览器、变异、发布包验证。完整 Goal 保持 active。

## 跨保存周期的外部冲突生成

新增 generateRepeatedExternalSaveTrace，64个固定seed、每条3–8周期。每周期先外部更新/读，再写两行冻结；可注入 unknown，以及执行前外部冲突导致真实服务器拒绝；执行后/回执前再外部更新并随机插入当前/旧读，最后精确回执和读。拒绝周期明确 undo 两个未提交要求，再进入下一周期。复用独立 ReferenceEditor/ReferenceServer 与 SourceFixture 对照器，每事件比较完整预览、冲突成员、可提交集、实际服务器文档/写次数、所有原文和全部历史冻结请求；失败自动按相同属性删除事件及缩减整数值。

首次加入拒绝后没有处理旧冲突要求，下一 freeze 被独立模型判为 invalid；增加真实用户历史操作 undo 清理未提交要求，保留拒绝场景，不把 invalid 当作通过。最终128个保存生成场景（原64+新64）通过。新增范围不包括多行结构和durable崩溃生成，不替代这些剩余工作。

全量61文件/1083单元、类型/边界/lint及空白检查通过。本轮仅测试生成与验收文档，未重复浏览器、变异、发布包验证。完整 Goal 保持 active。

## 任务反例的值缩减

新增 taskValueShrinker 并接入64seed会话任务失败路径。type 文本按 Unicode 码点生成空/首码点/半前缀，remote 整数生成0/符号/半值；rank 必须严格下降，复用既有同属性事件删除和值替换固定点。任务完成结果仍固定，不宣称支持任意结果内容生成。

新增缩减器行为测试：包含emoji中文文本、负远端值及必要 consume 的模拟失败，自动缩为单emoji/-1/consume，保留原 task-ownership 属性而不接受空文本/0引起的另一属性，原输入数组未变。此测试验证缩减器机制，不冒充生产故障复现。全量61文件/1084单元、类型/边界/lint、空白检查通过；本轮未改生产，未重复浏览器、变异、发布包。完整 Goal 保持 active。

## 会话任务结果内容生成

TaskSessionEvent.complete 增加可选 text，既有手写序列默认值保留。独立模型记录首次有效 resultText，消费使用原结果；生产适配器语义快照也直接提取完整候选输入，每事件比较原文而非仅比较 result 布尔值。64seed现在生成空串、中文、emoji、制表符/换行及不同晚到内容；taskValueShrinker 同时缩减显式结果文本。

新增三条文本变体序列，覆盖远端变化受阻、不同内容的重复 task-completed、改投B、detach后reapply以及后续取消。既有 task-completed 的重复事件按终态/已有结果规则忽略；此测试不将其等同于 durable exact outcome 矛盾证明处理。结构化动作和文件结果生成仍未涵盖。

全量61文件/1087单元、类型/边界/lint及空白检查通过。本轮仅模型/测试和验收文档，未重复浏览器、变异、发布包。完整 Goal 保持 active。

## 投影前驱查询的重新量化

临时 Map.get 探针在真实接纳16/32/64/128个单行动作后测量一次投影，总 intent ID 查询376/1520/6112/24512；按栈分类 resolvedExpectation 为240/992/4032/16256，其余136/528/2080/8256。完整 preview/隐藏字段断言通过，两轮四样本诊断完成。探针已移出源码树，数据和方法记录在 projection-cost-investigation.md。

确认原局部前缀数组优化没有解决前驱查询平方增长；此处不加入仅覆盖无提交/无创建的特例。后续需定位其他查询并设计按前驱链/资源共享的 exact base 解析，同时保留创建和条件历史语义。本轮为调查证据进展，未改生产实现，未重复完整门禁。完整 Goal 保持 active。

## 空阻塞闭包不再遍历历史依赖

继续前轮查询分类：32动作的额外528次中，32是读域准备，496是 dependencyBlocked 全部依赖扫描。闭包传播没有任何初始 issues 时不可能产生新阻塞，因此将循环启动条件改为存在初始 issues；存在种子时原跨行/事务固定点规则保持。

新增三条计数回归，旧实现16/32/64动作 owner 查询120/496/2016，新实现0，同时核对完整预览与提交意图数量。旧版本受控运行三例失败后已恢复新实现；1090全量单元及类型/边界/lint通过。前驱基值解析的平方查询仍开放，不以这一独立传播优化代替完整长期成本目标。

本轮生产改动最终门禁：1090单元、384三浏览器、10语义变异、类型/边界/lint、demo构建和发布包三浏览器消费全部通过，空白检查通过。临时诊断探针已移出源码树。完整 Goal 继续 active，前驱基值解析等未完成项不因门禁通过关闭。

## 前驱解析的表示约束与实施设计

复核 FrontierRef/prepare/journal/history 后确认：列表唯一性与因果引用已校验，但不保证顺序是 journal 连续前缀；数组本身在同域连续编辑中复制所有前驱，dependencies 也重复，因此不能把 Map 优化或末尾ID缓存当作根本解决。新增 causal-frontier-cost-design.md，定义有序共享前沿与独立依赖集合、精确 item 去重状态、资源域缓存键、未解析基值、localPrefix隔离、迭代计算和恢复格式迁移顺序及验收性质。

该文件是待实现方案，不改变当前生产协议，也不关闭性能验收。本轮为源码约束核实和可执行设计进展，未运行代码门禁；空白检查通过。完整 Goal 保持 active。

## 共享前驱的数据结构原型

新增测试专用 SharedFrontiers：有序parent链与(parent,intent)复用；成员判重用固定32层持久ordinal trie，避免复制完整集合；跨arena/伪造parent/重复intent拒绝，展开迭代执行。18项覆盖重排分支、原节点不变、失败无分配、10000节点追加的32倍索引节点上界与16seed分支数组模型。

原型目前固定inventory，不作为生产journal或恢复协议。全量62文件/1108单元、类型/边界/lint及空白检查通过；未重复浏览器、变异、发布包。生产前驱解析仍未接入共享表示，完整 Goal 保持 active。

## 共享前驱归档原型

增加scope绑定的完整节点表/根引用导出，以及新arena中的拓扑、长度、身份、重复和格式校验。JSON往返保持共享前缀与重复根引用；九类损坏拒绝且原arena不变。此格式1仅属测试原型，不改变生产RecoveryRecord，完整journal因果绑定校验仍待接入。

全量62文件/1118单元、类型/边界/lint及空白检查通过。本轮未改生产入口，未重复浏览器、变异、发布包。完整 Goal 保持 active。

## 共享前驱基值折叠原型

实现测试专用 sharedBaseResolver，迭代缓存各共享父链、以持久成员集合去重精确提交项，保持未解析/显式missing区别及局部前缀隔离。三条覆盖创建null、删除missing、重排、重复item夹杂未结算编辑和5000前缀累计5000次求值。事实需预编译到同一实体；生产接入与嵌套域差分尚未完成。

全量63文件/1121单元、类型/边界/lint及空白检查通过。本轮仅原型/测试和文档，未重复浏览器、变异或发布包。完整 Goal 保持 active。

## 共享基值的嵌套域差分

新增 shared-base-differential：32seed分支、四种资源域、canonical/create/replace/嵌套set/remove、missing/null、重复精确item和局部前缀，逐步与原有数组折叠语义比较，并重查父分支。显式比较两种已知物化失败，不吞基础设施异常；首轮异常白名单文本错误已核对并修正。

全量64文件/1153单元、类型/边界/lint与空白检查通过。本轮测试原型差分共用文档操作，不冒充独立业务模型或生产性能收益；未重复浏览器、变异或发布包。完整 Goal 保持 active。

## KernelState 到共享基值的事实编译

新增测试适配器从完整journal/settlements/精确receipt按实体编译事实，固定状态/资源内共享求值。实际独立Source合并a1/a2保存并规范化2.5，后继a3基值精确迁移，外部a9不替代canonical；原缓存保持2，semantic-read/policy-guard和其他实体隔离，原intent不变，服务器只写一次。初始KernelState类型导入路径错误已修正，随后全量65文件/1154单元及类型/边界/lint、空白检查通过。

适配器仍展开数组，尚未接入生产或改变恢复格式；不声明性能收益。本轮未重复浏览器、变异、发布包。完整 Goal 保持 active。

## 真实条件历史的共享解析对照

新增数组解析特征对照器（直接检索事实）与trace只读检查回调。16seed分别运行历史与跨周期外部冲突序列，每个状态比较日志所有行expectation/局部组前缀的新旧基值；原独立业务/服务器断言保持。字段undo/redo和拒绝撤销通过，结构恢复生成不在该范围。

全量65文件/1170单元、类型/边界/lint及空白检查通过。本轮仅测试/原型特征对照，未重复浏览器、变异或发布包；尚无生产性能收益，完整 Goal 保持 active。

## 共享解析的结构历史对照

提取统一compareStateBases，字段生成对照保持；结构trace增加只读检查回调，在32种create/delete、保存时机、规范化及restoreDeleted组合中比较全部行基值。既有ReferenceStructure的完整文档/生命周期/实际写次数断言同时保留。定向49项通过；这一证据不扩展为多行结构生成或生产接入。

全量65文件/1202单元、类型/边界/lint和空白检查通过。本轮仅测试原型对照，未重复浏览器、变异、发布包。完整 Goal 保持 active，生产共享前沿迁移尚未完成。

## 共享基值接入生产投影

将shared-frontier/shared-base/shared-state-bases从测试目录迁入src/kernel并更新所有消费者；projectKernel改用共享解析，旧前驱折叠循环删除。事实读取改为惰性节点访问，维持无关事实不提前报错；localPrefix仍惰性遍历。生产lint发现原型的new Array(length)规则问题，改为明确长度初始化后通过。

新增16/32/64真实编辑的事实读取线性上界，核对完整隐藏文档、全部提交意图及原state不变；全量1205单元与类型/边界/lint通过。此阶段数组到共享节点转换仍存在重复前缀成本，不声称整体线性或完成性能重构。RecoveryRecord格式未变。

最终门禁：384项三浏览器测试、发布包三浏览器编辑/精确恢复/重开消费验证、示例构建通过。变异脚本首轮因旧解析循环删除而找不到latest-as-normalization锚点中止；将同一“最新权威值替代精确回执”故障迁到shared-state-bases后，10种语义变异全部检出（该项44个失败），源文件保持不变。全量单元65文件/1205项，类型/边界/lint及空白检查通过。日志为/tmp/shared-production-{unit,browser,mutations,package,demo}.log。

完整Goal保持active：本轮完成共享计算生产接入；共享journal/依赖表示、恢复格式迁移、整体成本与剩余端到端验收仍未完成。

## 回执成员索引改由投影上下文持有

沿持久前沿构建链路核对时发现，每个资源解析器都会复制全部精确item库存。新增真实多行保存/后继编辑/规范化场景，8/16/32行、每行两个字段的原实现登记128/512/2048个item序号，三条成本回归先失败。将item arena提升到固定KernelState的事实上下文；资源只保留自己的Fold和seen根，成员节点可共享。修复后登记8/16/32，完整文档/隐藏字段、无冲突、原state不变及Source单次写入同时通过。嵌套域32seed差分也改为共享同一item arena，继续验证各域与分支隔离。

门禁完成：定向100项、全量65文件/1208单元、384三浏览器测试、10种语义变异、类型/边界/lint、示例构建及发布包三浏览器消费验证全部通过，空白检查通过。原失败证据/tmp/shared-items-before.log；其余日志/tmp/shared-items-{targeted,check,lint,unit,browser,mutations,package,demo}.log。

同时确认ownEncodedValue在准备、接纳、恢复时递归复制对象，因此持久共享前沿必须使用平铺节点表/显式引用；当前对象arena不能直接用作journal持久协议。该同步迁移仍开放，未修改RecoveryRecord格式，未声明整体成本线性。完整Goal保持active。

## Journal前沿与依赖切换为平铺节点表

已完成本轮表示迁移：FrontierRef由数组变为number|null，IntentJournal.frontiers持有作用域限定的追加节点表；所有anchor、undo/undo-order、action.orderBase和IntentRecord.dependencies引用同一表。PreparedAction/Undo/Redo/Resolution携带候选表；普通接纳校验精确旧前缀，历史/决策重编译比较，随意图原子安装。初始state、prepare/journal、history、order、resolution、task重新准备及projection消费者一起迁移，删除逐expectation数组intern路径。计划输入与服务器FrozenSubmission仍按各自边界使用显式列表，不构成另一份可写journal事实。

RecoveryRecord现在为10，完整checkpoint metadata为2，IndexedDB布局仍2。写入/恢复及checkpoint导入检查完整节点和引用闭包（含历史、fallback、依赖因果顺序）；拒绝旧RecoveryRecord 1–9与checkpoint 1，保留原始数据库归档导出，不提供未经验证的自动转换。gateway夹具直接覆盖workspace导致21项失败，改为createKernelState初始化对应身份后通过。13项节点表测试覆盖线性前缀存储、JSON/ownEncodedValue复制、分支重排和坏候选；64次双字段编辑只存63节点，依赖与字段anchor共用节点。

复查发现submission-output备用前沿在接纳时漏检，可能直到durable恢复校验才失败。新增缺失索引/非依赖两个反例先证明错误accepted；接纳现在同时校验主前沿与fallback，拒绝且原state不变。红测证据/tmp/frontier-fallback-before.log。

最终同树门禁：66文件/1222单元、387三浏览器测试、10种语义变异检出、类型/边界/lint、示例构建和发布包三浏览器编辑/精确保存恢复/重开全部通过；git diff --check通过。日志/tmp/frontier-final-{check,lint,unit,browser,mutations,package,demo}.log。首次1220/387门禁后因上述接纳补充再次运行；最终数字以1222为准。

完整Goal保持active。共享journal/依赖表示及新格式生产接入已完成这一阶段，但prepare活跃前驱构建、表恢复/校验和依赖展开的整体成本仍未验收；长历史/压缩、完整生成与其他M0–M6开放项也未完成。不能把节点数的线性结果当作整体性能或完整重构完成。

## 恢复校验复用共享前缀

真实16/32/64次双字段编辑的旧assertJournalFrontiers反复展开前沿并查询sequence，计数391/1551/6175；三条8N上界回归先失败。现按平铺节点计算最大sequence，逐消费者验证因果顺序；成员关系通过SharedFrontiers.isSubset比较持久trie、跳过相同子树，并在同次校验缓存成功引用对，删除逐前沿数组展开和依赖Set复制。ordered anchor身份不因成员集合相同而合并。

补充未来成员藏在较早尾节点之前、缺失成员与依赖重排三例；16seed现有分支生成逐步比较双向subset和数组参考成员关系，另检查空集/跨arena边界。原state不变，三条成本上界通过。该计数不能推广成全部不同集合比较、存储I/O或整个恢复过程的线性证明。

完整门禁通过：66文件/1228单元、387三浏览器、10种语义变异、类型/边界/lint、示例构建、发布包三浏览器消费验证及空白检查。失败证据/tmp/frontier-validation-before.log，最终日志/tmp/frontier-validation-{check,lint,unit,browser,mutations,package,demo}.log。RecoveryRecord 10、checkpoint metadata 2保持不变。完整Goal保持active；准备动作的活跃前沿构建、整体成本、长历史与其余验收仍未完成。

## 准备动作以实体游标推进前沿

旧prepare在每个字段重建完整前沿，16/32/64条既有意图后准备16字段写入时arena.append调用302/606/1214次，三条8N上界先失败。现按实体索引活跃ID，读取时推进游标，当前动作的后续命令继续追加；order游标按需初始化并接收create/delete/order，policy-guard仍只用authority。frontier-table提供直接append和保留左侧顺序的去重union，依赖复用现有根，删除逐字段拼接/过滤整个前驱数组及再次intern依赖Set的路径。初次类型检查发现append返回类型过宽，改为其真实的number返回契约后通过。

16seed/80步union对照独立数组Set；新增排序/创建/中间顺序读取/删除/再次排序/后继字段写组合，完整顺序和隐藏字段保持。三个同动作16/32/64命令场景生成15/31/63节点，append≤2N、单份输入仍覆盖全部intent。既有历史16字段准备满足≤8N调用；不将这些计数冒充整个prepare、接纳、编码和保存链路线性。

最终门禁：67文件/1251单元、387三浏览器、10语义变异、类型/边界/lint、示例构建、发布包三浏览器消费验证和空白检查全部通过。红测/tmp/prepare-frontiers-before.log；最终/tmp/prepare-frontiers-{check,lint,unit,browser,mutations,package,demo}.log。恢复格式保持10/checkpoint2。完整Goal保持active；全链路成本、长历史/压缩和其余M0–M6验收继续开放。

## 接纳与恢复共用因果校验

接纳此前按字段展开anchor与dependencies并复制Set，16/32/64前驱、16字段分别展开528/1056/2112个ID；三条≤2N回归先失败。将最大sequence/共享成员子集/fallback校验提取为frontier-checks，由journal接纳和journal-frontiers恢复入口共用，避免两套因果规则及重复展开。表编译继续校验链唯一性；精确item coverage和order上下文仍保留独立完整性检查。

新增自引用、前向引用、伪造后续序号三例，拒绝整个候选而不发布半个动作，原state和调用方input不变。新增完整/缺失成员/跨实体submission anchor三例；完整项经真实Source规范化回执后保留后继x3/hidden7，服务端一次写入，错误覆盖拒绝。原fallback反例和恢复成员/因果检查保持。

最终门禁：68文件/1260单元、387三浏览器、10语义变异、类型/边界/lint、示例构建、发布包三浏览器消费及空白检查全部通过。红测/tmp/admission-frontiers-before.log，最终/tmp/admission-frontiers-{check,lint,unit,browser,mutations,package,demo}.log。恢复格式10/checkpoint2不变。完整Goal保持active；该计数只约束前沿展开，全链路成本、长历史及其余验收仍开放。

## 完整保存与重开的工作流测量

新增workflow-measurement：32/128/512命令batch及32/128个独立持久动作history，均在请求冻结后接纳后继、接收服务器规范化回执、重开pending、保存后继并再次重开/导出。核对完整文档/隐藏字段、原输入与journal、两个各自精确coverage、冻结请求不变和Source两次写入。可选报告写入由测试专用Node模块承担；初版直接在内核测试中导入Node文件I/O被types限制拒绝，隔离后没有添加Node全局类型或产品依赖。默认测试不写测量文件。

最终样本保存为docs/workflow-cost-baseline.json，解释与复现命令见docs/workflow-cost-baseline.md。512命令batch准备11.40ms、持久接纳183.46ms；128独立动作累计准备342.46ms、接纳2818.70ms，存储写147次。样本表明接下来应拆分真实持久化成本；内存oracle的复制/校验开销包含其中，不能把这些数字称为IndexedDB延迟或整体复杂度证明。

定向5项、全量69文件/1265单元、类型/边界/lint和空白检查通过。日志/tmp/workflow-measurement-{report,check,lint,unit}.log；报告原件/tmp/kernel-workflow-measurement/workflow-{batch,history}-*.json。本轮仅测试/测量与文档，无生产修改，未重跑浏览器/变异/发布包。完整Goal保持active，真实存储剖析、长历史/压缩及其他验收继续开放。
