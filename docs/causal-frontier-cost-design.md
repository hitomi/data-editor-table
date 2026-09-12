# 前驱表示与解析成本：实施设计

状态：共享解析、journal前沿与依赖节点表已接入生产；RecoveryRecord 10及checkpoint metadata 2已切换。整体构建/校验成本与完整M0–M6验收仍未完成。

下方“原型检查点”保留实施时的证据范围；最新生产状态见文末。

## 已核实的约束

`model.ts` 的 FrontierRef 是 IntentId 数组；`prepare.ts` 为每个写域从全部未结算/未抵消的较早同实体意图生成前驱，并将其加入 dependencies。连续 N 次同域编辑产生 N(N−1)/2 个前驱引用，dependencies 还有对应的重复引用。换成 Map 不能消除持久化表示本身的体积。

`journal.ts/validateExpectation` 校验前驱唯一、已存在、属于 dependencies；没有要求按 intent.sequence 排序。submission-output 校验 complete item coverage 的成员，不规定列表顺序。因此优化不能假定所有传入列表是 journal 连续前缀。history 的 undo/redo 还持有条件前沿；恢复 create 和本地 create 都能成为解析新基值。

`resolvedExpectation` 的可观察语义是按列表顺序折叠：精确 committed item 覆盖当前资源值，同一 operation/item 首次出现才覆盖；首次可用 create 建立基值；之后的未结算操作继续作用于资源；其他 settlement 不重放；最后才作用同一 intent 的较早组。semantic-read 与 policy-guard 不使用这套 canonical 重定位。

## 共享表示

将有序前驱与无序依赖集合分开建模。不得把顺序有意义的 anchor 简化为末尾 intent ID。

有序前驱采用不可变持久链节点：`{id, parent: FrontierId | null, intentId, length}`。节点身份由受校验的 `(parent, intentId)` 唯一决定；同一对只保存一次，不把 hash 碰撞视作内容相同。空链使用 null。同一父链扩展一个意图只增加一个节点。分支与任意合法顺序通过不同父链表达，保持原输入顺序。重复 intent、未知节点、环、错误 length 和跨 workspace 引用在接纳/恢复时拒绝。

编译器在准备动作时维护每实体的当前逻辑前沿，多个字段共享同一节点引用。同一动作的后继命令可以引用已准备的前驱；整个候选一次接纳，不提前把临时节点暴露为权威状态。显式业务依赖仍独立保留，不允许在表示压缩时删除非前驱依赖。是否将依赖集合也改为共享集合，须以边数量与遍历计数决定；只压缩 anchor 不足以宣称完整日志线性。

外部提交的精确 coverage 仍是可独立验证的显式 ID 列表。仅在 freeze/导出等要求列表的边界展开共享前沿；冻结后请求字节不变，不引用运行时可变表。保存后历史原前沿节点仍可达，不能因 settlement 而删除。

## 一次投影内的解析

索引生命周期绑定同一 KernelState 输入；本阶段不跨状态缓存结果。以 `(frontier node, resource kind/entity/path)` 为键，自父节点到子节点增量求值，保留：

- 是否已存在精确或 create 基值；未解析不能与显式 missing 混为一谈。
- 当前 ResourceValue；每个资源独立按 operationResource 语义计算，不能把局部字段值当作完整文档。
- 已消费的 operation/item 集合，用于保持原列表中重复覆盖项只生效一次的规则；该集合也需持久共享，不能每个节点复制全部集合。

基值未解析时返回该 expectation 自己的 expected，不能缓存某个 expectation 的 fallback 为共享节点结果。同意图 localPrefix 在读取共享解析结果后单独折叠，不能写入共享缓存。失败也必须绑定相同资源/前沿，不能让一个字段的物化失败污染另一个字段。

迭代遍历代替递归，避免长链栈溢出。复杂度按不同节点数、资源域数和实际操作数报告；不同长列表完全不共享时仍需读取其信息，不承诺所有输入相对 intent 数均线性。

## 接纳、存储与迁移顺序

1. 先实现独立前沿数据结构与校验、展开、分支和完整性测试；用现行数组折叠作为行为对照，不修改生产入口。
2. 用真实接纳历史验证节点共享，并建立相对节点/边数的访问与分配上界；覆盖字段重叠、整行 replace、missing/null、create 和恢复 create。
3. 同步迁移 PreparedAction、journal 接纳、history、order、persistence、checkpoint/recovery validator 与参考模型适配。不得出现数组和节点两种可写权威来源。
4. 仅在新恢复记录确实写入时升级格式。旧记录继续提供原始归档导出；未经完整迁移校验，不把旧格式当新格式打开，也不能静默清空。
5. 切换公开接口和示例，删除临时数组适配，再运行全部协议/模型/浏览器/变异/发布包门禁。

不在本设计中预先指定新格式数字，避免与其他恢复变更冲突。格式升级和旧数据处理必须在实施差异中明确记录。

## 必须证明的性质

- 数组前沿顺序不同但末尾相同，仍解析为各自原结果；成员相同的重排不得误用缓存。
- 多个 intent 由同一精确 item 结算时只覆盖一次；其间未结算操作不能因重复 item 被擦除。
- 无精确基值、显式 missing、本地创建基值、已删除基值四者分开。
- localPrefix 不跨 intent 或 expectation 泄漏。
- authority/policy/settlement/undo 分支变化使用新投影索引。
- 共享存储不丢输入、历史、资源可达性或精确 coverage；恢复导入验证完整引用闭包。
- 真实长历史计数不再随重复前缀产生平方解析；同时报告原始依赖集合的边数，不能将成本转移到构建或序列化后隐去。

本设计尚未实现；当前数组协议和前驱解析保持现状。后续实施若采用不同表示，须用上述完整语义与成本证据说明取舍。

## 数据结构原型检查点

`src/kernel/shared-frontier.ts`（最初位于测试目录） 实现测试专用 arena。节点以对象身份限定 owner，`(parent,intent)` intern 保留顺序和前缀共享；已知 intent 分配 uint32 ordinal，成员集合采用32层持久二叉 trie，每次追加最多复制32个索引节点，不复制全部祖先集合。展开用迭代写入数组，不消耗链深度调用栈。原型 inventory 在构造时固定，仅用于验证表示与单次投影内结构；它还不是可持续写入的生产 journal 格式。

18个用例验证重排且末尾相同的分支、重复 intent/未知 intent/跨 arena/伪造 node 拒绝、失败无节点分配、重复追加复用、10000节点长链与固定32倍成员节点数量，以及16seed的200次分支操作逐步对照独立数组。计数只包括成员 trie 节点，未声称是字节内存或整个 Workspace 分配上界。

后续仍需完成归档节点编号/完整性校验与恢复、基值折叠、依赖集合表示及所有生产调用链迁移；当前原型不改变数组协议。固定32层索引的常数成本需在实际多域负载评估，不能只凭渐近上界决定最终存储结构。

## 归档原型检查点

arena 现在可导出独立格式1归档（仅原型，不是 RecoveryRecord 版本）：scope、按父节点先于子节点编号的完整节点表和根引用。重复根/共享前缀保持共享，不展开成重复意图数组；节点表包含arena所有节点，未按当前根静默丢弃历史分支。

restore 在独立新arena内逐项验证作用域、格式、节点数组、严格较早的父引用、长度、已知意图、链内判重及规范节点唯一性；父引用必须较早，循环及前向引用都拒绝。失败不返回半安装arena，不改变原arena。恢复使用调用方提供的意图inventory，本阶段尚未校验这些意图在完整生产journal中的sequence/实体/依赖关联，故不能将原型验证称为生产恢复校验。

10项归档用例验证JSON往返、共享身份和九类损坏拒绝；完整门禁62文件/1118单元、类型/边界/lint通过。

## 共享基值折叠原型检查点

`src/kernel/shared-base.ts`（最初位于测试目录） 在一个固定资源/不可变事实上下文中逐父节点缓存折叠结果；事实须由调用方预先按资源实体筛选，原型不代替生产 fact 编译/校验。精确 item 的已消费集合复用持久成员结构，避免每个前沿复制整份 Set。无基值用 null 标记，显式 ResourceValue.missing 不混同；fallback 和同意图局部前缀不进入共享缓存。迭代求值只展开尚未计算的父链。

三条测试覆盖同 item 在未结算编辑之后重复出现、不同顺序但同尾节点、局部前缀不污染缓存、fallback差异、删除missing、创建null，以及5000次创建后字段编辑的全部前缀。后者完整文档/隐藏字段每步正确，累计只求值5000节点。此计数不包括从现行数组构建共享节点的成本，也不是生产性能改进证明。

仍需完整事实编译、不同资源/嵌套域及故障对照、与当前生产解析差分，再迁移journal/恢复。当前生产前驱协议未变。

## 嵌套域差分检查点

新增32seed、每seed150次候选分支扩展的差分。事实含精确canonical（null/空文档/父null/完整嵌套）、重复item、跳过的settlement、未结算create/replace/嵌套set/remove；资源分别为整实体、profile、profile.x、hidden，另交错局部前缀与不同fallback。共享折叠和逐项数组折叠逐步比较值或两种明确物化错误，并复查父分支防止子分支污染。

数组对照独立枚举全部祖先，但有意共用 production resourceAtDocument/operationResource；这是重构差分，不是独立业务参考模型。只接管两种预期物化异常，其余基础设施异常继续抛出。首轮误写了底层异常文本，核对 document.ts 后修正精确白名单，没有广泛吞掉异常。

64文件/1153全量单元、类型/边界/lint通过；生产事实编译、完整journal接入及恢复格式迁移仍未实施。

## 真实 KernelState 事实编译原型

`src/kernel/shared-state-bases.ts`（最初位于测试目录） 从同一已验证 KernelState 的 journal、settlements 和 exact receipt 编译按实体隔离的事实，并按资源复用解析器。semantic-read/policy-guard/authority anchor 不做基值重定位。条件历史操作通过 rowOperationForIntent 编译；尚未扩展对应完整历史差分。

定向实际 SourceFixture 场景：a1/a2合并冻结后接纳a3，保存前基值2；服务器规范化2.5/hidden9，精确结算后基值2.5；随后外部a9/hidden10不会变成后继基值。旧状态解析器仍返回2，业务/策略读取维持原 expected，另一实体不会借用A的精确结果，原后继intent保持，实际只写一次。

适配器还将数组逐项intern，并对一个实体的事实集中编译；它仅接受已验证状态。任意损坏状态中的无关事实异常是否延迟到读取时，尚未作为行为保持契约证明。没有将此原型直接接入生产，不能以减少求值次数掩盖数组构建成本。生产迁移仍需完成上述条件历史差分、故障边界、共享journal表示及恢复校验。

## 条件历史逐状态对照

保存 trace runner 新增只读检查回调，不改变事件调度或独立业务模型断言。16seed各重放历史序列与跨周期外部冲突序列，每一步对当前journal的行操作全部 expectation 及同意图组前缀，比较真实state事实编译的共享求值与迁移前数组解析特征实现。

数组特征实现直接检索journal/settlements/receipts，不复用候选事实编译缓存；但仍共用条件rowOperation及文档运算，作为算法迁移对照，不宣称独立业务证明。原trace的ReferenceEditor/ReferenceServer对完整数据、输入、写次数检查同时执行。该批次覆盖已有生成器的字段条件undo/redo与拒绝后撤销，不包含删除恢复create的生成或任意结构历史。

65文件/1170单元及类型/边界/lint通过。生产数组协议、恢复格式与依赖集合尚未迁移。

## 结构历史事实编译对照

迁移阶段曾将 compareStateBases 特征断言接入结构 trace 的每个可见比较点。32组合枚举 create/delete、原动作是否保存、undo是否保存、规范化开关及restoreDeleted能力；覆盖既有三轮undo/redo与最终恢复。2026-09-12 测试审计已移除这层旧解析器对照及辅助文件；独立ReferenceStructure的可见文档、生命周期、服务器身份与写次数检查保留。当前依据见 [测试审计](./test-suite-audit.md)。

这补齐了当前结构runner的恢复create路径，但不是多行/排序/外部冲突的结构生成。生产journal和恢复格式仍未切换。

## 生产投影接入

三个模块已迁入src/kernel，projectKernel使用同一KernelState内共享的事实/前沿/资源求值上下文，替换并删除旧resolvedExpectation循环。生产事实按当前节点惰性读取，避免集中预编译同实体无关意图导致错误时机前移；精确结果缺失继续在实际读取时失败。localPrefix继续为惰性Iterable，不重新引入全局前缀复制。

原数组特征对照保留在tests中；生产不依赖测试模块。增加三条真实接纳日志的intent事实读取上界：16/32/64动作每次投影最多2N次，完整文档、全部可提交意图与原state不变同时检查。当前1205全量单元和类型/边界/lint通过。

本接入只共享解析计算。FrontierRef仍为数组，数组到arena的转换仍读取原列表；成员trie和缓存也增加常数分配。不能据此声称整体投影线性或整体耗时下降。共享journal存储、依赖边表示、恢复格式迁移与端到端成本测量继续开放。arena归档方法不是Workspace恢复格式，未提升RecoveryRecord版本。

生产接入验收：1205单元、384三浏览器测试、10种语义变异检出、类型/边界/lint、示例构建和发布包三浏览器消费验证通过。latest-as-normalization故障注入位置随旧循环删除迁至新事实读取处，仍注入最新权威值替代精确回执，44项测试检出；没有删减此门禁。

## 回执成员索引的所有权修正

生产接入后沿构建链路发现：每个资源调用sharedBaseResolver时都将全部results.keys复制到新的SharedFrontiers。N行、每行x/y两个域、N个精确item时，投影登记2N²个item序号。真实SourceFixture先冻结多行写入，再编辑后继、返回规范化回执并观察对应权威；新增8/16/32行成本回归在原实现分别得到128/512/2048，三项均失败。

item inventory及不可变成员节点改由compileSharedStateBases的同一KernelState上下文持有，只构建一次并传给所有资源。每个资源的Fold仍单独持有seen根和值；共享索引不代表一个字段已消费item就替其他字段消费。四资源嵌套域/分支差分也改用同一个item arena，检查此边界。修复后登记次数为8/16/32；真实场景同时核对完整隐藏字段、无冲突、原state不变以及服务端只写一次。此计数不是总内存或端到端耗时。

进一步追踪确认，prepareRowAction和appendAction都会调用ownEncodedValue，durable/checkpoint也会再次拥有编码值；该函数按结构递归复制，不保留共享对象身份。因此不能直接把运行时parent对象放进journal就宣称共享存储完成。持久journal必须使用显式平铺节点表和节点ID，准备动作携带待接纳节点并原子提交；同时迁移history的undo/redo构造与orderBase、resolution的控制日志、初始journal以及恢复校验。FrozenSubmission的精确coverage/frontier仍保留独立显式列表。该迁移尚未实施。

## 平铺journal节点表生产迁移

FrontierRef现为节点索引或null；IntentJournal.frontiers保存workspace/scope/epoch/schema/codec限定的节点表，节点包含parent、intent及length。anchor、undo/undo-order、action.orderBase及IntentRecord.dependencies全部改用引用。依赖保留原有成员顺序以复用规范节点，但业务仍按成员关系解释；显式业务依赖不被裁掉。普通动作、undo/redo、resolution候选各自持有完整候选表，接纳时与意图一起安装；普通动作校验已接纳表为候选的精确前缀，历史/决策仍重新编译并比较完整候选。

frontier-table负责作用域、节点拓扑、唯一性、已知intent及索引读取；journal-frontiers在durable写入和恢复、checkpoint导入时验证完整引用闭包，包括非活动历史、依赖的因果顺序和fallback anchor。旧记录不按新格式解释。RecoveryRecord升级10，checkpoint metadata升级2，IndexedDB布局仍为2；旧RecoveryRecord 1–9和checkpoint 1拒绝，原始归档导出路径保留。服务器FrozenSubmission的coverage/frontier继续为显式ID数组。

投影直接从平铺表恢复节点，不再从每个expectation的完整前驱数组重新intern。任务中保存的PreparedAction使用自身节点表展开依赖，重新准备时校验其作用域及inventory，不借用最新状态的同编号节点。

新增11项表测试：16/32/64次双字段编辑分别持久化15/31/63个节点；编码复制和JSON往返后保持数量及完整文档；七类错误候选拒绝且原state/raw不变；同尾重排分支在克隆/扩展后仍独立。新增旧checkpoint格式拒绝并保持原输入的回归。网关夹具过去直接换workspace字段，新作用域校验拒绝了21项；改用createKernelState构造对应workspace后通过。当前全量66文件/1220单元及类型/边界/lint通过。

该迁移消除了这些journal字段的重复前缀存储，尚不构成整个系统线性成本证明：prepare仍从活跃意图计算前沿，接纳/恢复会遍历依赖，构建器会校验并恢复已有表，候选表拥有与编码也有成本。后续应按完整动作、保存、重开及长历史计数审计；不能只依据节点数量宣布性能验收完成。

接纳/恢复边界复查另发现submission-output的fallback前沿未在普通动作接纳时校验。新增缺失引用和非依赖引用两例，原代码均错误accepted；随后接纳校验同时检查主前沿与fallback，并将依赖展开为同一Set，两个反例变为rejected且原state不变。当前66文件/1222单元、类型/边界/lint通过；表测试共13项。恢复闭包验证不得成为比接纳更晚才发现此类坏引用的唯一入口。

最终同树验收：1222单元、387三浏览器、10语义变异、类型/边界/lint、示例构建与发布包三浏览器消费验证全部通过。浏览器增加format 9拒绝后的原始归档下载/刷新保留检查；它仍是从当前合法记录修改格式标记的版本边界测试，不冒充真实历史发布格式的转换证明。

## 共享前缀的恢复闭包校验

平铺表示接入后的assertJournalFrontiers仍为每个intent和expectation展开完整前驱，重复查询sequence并构造依赖Set。真实16/32/64次双字段编辑的序号/ordinal查询分别为391/1551/6175，新增上界回归在旧实现全部失败。

现在按节点表父在先顺序计算每个前沿的最大intent.sequence；消费者逐次核对这个最大值，不能只检查尾节点。成员包含关系复用arena的持久trie，迭代比较并跳过相同子树，同一引用对的成功结果在本次校验内复用。无序依赖的成员关系与有序anchor身份保持分离；字段资源值不参与这个索引，也不跨state缓存。三条成本回归满足8N查询上界，同时原state保持不变。

增加“未来成员在较早尾节点之前”“缺失成员”“成员重排”三条恢复校验测试；16seed前沿分支模型逐步与数组成员关系比较双向subset，并核对跨arena拒绝。该证据约束序号查询与共享前缀，不能外推成所有不同集合的包含比较或整个恢复I/O都线性。当前66文件/1228单元及类型/边界/lint通过。

同树最终门禁：1228单元、387三浏览器、10语义变异、类型/边界/lint、示例构建及发布包三浏览器消费验证全部通过；未变更恢复格式。

## 准备动作直接推进节点引用

旧prepare对每个字段重新拼接earlier/intents、过滤同实体记录、intern完整数组，再从dependencies Set重新intern。16/32/64条既有意图之后准备一次16字段写入，实际arena.append调用302/606/1214次；新增8N上界回归先失败。

现在一次索引活跃实体记录，实体游标仅在读取时将尚未编译的ID追加到当前根；同一动作新增命令进入对应游标，最后没有消费者的命令不提前写入无用节点。order游标首次需要时生成，后续create/delete/order命令继续推进。policy-guard保持authority锚点。原虚拟文档、分组局部读取及完整恢复材料捕获不变。

frontier-table增加append和有序去重union：依赖先保留显式左侧次序，再追加右侧尚未包含的成员；空集和已经包含的前沿复用原根，包含判断使用持久trie。该union只用于依赖，不替换有顺序语义的anchor。16seed/80步与独立数组Set合并对照，检查原根不变及未知引用拒绝。

新增同动作排序→创建→中间order读取→删除→再次排序→同实体后继编辑组合，逐项检查依赖ID、最终顺序和隐藏字段。16/32/64个同动作连续命令只保存15/31/63前缀节点，append调用≤2N；单份输入仍覆盖全部意图。既有历史的16字段准备满足≤8N调用（包括两份arena恢复），不以机器耗时作断言。当前67文件/1251单元及类型/边界/lint通过。完整动作的projection、接纳验证、编码与持久化成本仍需独立审计，不能把append计数称为整个prepare/保存过程的线性证明。

最终同树门禁：1251单元、387三浏览器、10语义变异、类型/边界/lint、示例构建与发布包三浏览器消费全部通过。

## 接纳与恢复共用因果检查器

接纳的validateExpectation此前仍逐字段展开主前沿、依赖并构造Set。16/32/64条前驱、16字段的真实接纳分别展开528/1056/2112个ID，三条≤2N回归先失败。提取frontier-checks供普通接纳与journal恢复共同使用：一次校验平铺表、计算最大sequence，依赖与主/fallback anchor都以引用做因果顺序及成员包含检查，同一候选内复用结果。原来的逐字段数组去重由表恢复时的链唯一性保证代替。

提交item的完整coverage和order上下文仍在其协议边界展开核对；没有将“是依赖子集”当作“完整覆盖该item”。新增自引用、前向引用和伪造后续sequence三例，均拒绝整个候选，原state和调用方原始input不变。新增submission-output完整/缺失成员/另一实体item三例，完整场景实际执行规范化保存，后继x3和hidden7保留且只写一次；错误覆盖拒绝。既有fallback坏引用与恢复校验测试同时继续运行。

当前68文件/1260单元及类型/边界/lint通过。计数针对实际前沿展开，不代表接纳中的文档比较、projection、order规划、编码及存储总成本；恢复格式保持10/checkpoint2。

同树最终门禁：1260单元、387三浏览器、10语义变异、类型/边界/lint、示例构建及发布包三浏览器消费全部通过。
