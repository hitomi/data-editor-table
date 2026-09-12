# 同一实体长期投影成本调查

当前结论：同字段长链的资源求值已通过后缀计划及增量前缀降到线性次数，但这不等于完整投影或所有复杂域已经线性。其他日志扫描、历史、宽文档和复杂域成本保持开放，不能以资源计数测试关闭 §18。

第二步实施：`createNeutralPrefix` 在同一投影中逐 intent 更新 authoring roots 和目标。已覆盖的子域不重新建根；新增更宽域时才逆向还原其原始基准并替换子域根。根目标仅应用新步骤；失败根继续保留失败，不能由后续写入掩盖。只在完整 application 边界判断抵消；抵消后重建下一个前缀计划，原始 journal/input 保留。最终 16/32/64 次同字段编辑的 `operationResource` 调用已由原 N(N+1) 降至不超过 2N。该上界不包含全部路径比较、序列化、authority 和历史扫描成本。

后续实施：`resource-suffix.ts` 已替换 `projectThrough` 的逐 check 后缀重放。它按实体建立位置索引，再按比较资源域缓存从后向前编译的执行计划。无条件覆盖域的操作预先求值；依赖原 base 的嵌套 patch 保留为执行节点，包括可能抛错的节点。先发生的无效嵌套写不能被后来的 replace/set 掩盖。每次投影重新创建计划，不跨状态缓存，也不改 journal。

第一步后缀实现时，定向测试曾将 operationResource 上界从 N(N+1) 降至 N(N+1)/2，并检查最终完整文档与 N 份输入/intent 均保留。第二步前缀实现已进一步收紧上界。复杂嵌套域仍可能逐节点执行，额外路径比较和分配未包含在计数内；不能将该检查当作全部投影已线性化。

## 已测量的工作负载

用 KernelFixture 初始化 `{ a: { x: 0, hidden: 7 } }`，依次接纳 x=1 到 x=N 的普通单字段动作；接纳完成后才通过 Vitest spy 计数 `resources.operationResource`，执行一次 `fixture.project()`，随后恢复 spy。断言预览为 `{x:N,hidden:7}`，可提交项保留 N 个 intentId。没有通过截断日志或忽略输入改善结果。

| N | 单次投影 operationResource 调用 |
| --- | --- |
| 16 | 272 |
| 32 | 1056 |
| 64 | 4160 |

这是确定性运算次数，非耗时基准；该负载观测值为 N(N+1)。临时探测测试已删除，没有将当前平方增长固化为合格性能阈值。可用上述 fixture 和 `vi.spyOn(resources, 'operationResource')` 重现。

## 源码中的重复工作

`effectiveRowIntents` 每经过一个 application 边界调用 `neutralPrefix`，后者重新展开整个前缀、查找覆盖域、构造原始基准并逐操作计算目标。这一负载在 N 个前缀上重复计算 1+…+N 个操作。

`projectThrough` 对每个 write-base 从当前 step 扫描至末尾，再次求完整目标；同一负载另有 N+…+1 个操作。因此仅修复其中一个循环仍是平方增长。`steps.slice(...).filter(...)` 构造单 intent 前缀以及复杂覆盖域查找还有额外成本，本次计数未覆盖全部 CPU 工作。

## 重构必须保留的语义

下一步应将同一实体的域归并与前后缀求值作为一个整体设计，先建立按实体、application 边界和写域的临时投影计划。缓存只属于一次不可变状态投影，不跨 authority、policy、settlement 或 journal 变更复用。

不能直接使用最终 preview 判断前缀抵消。原始 authoring domain、exact canonical predecessor、semantic-read 的历史前缀、整实体 replace 与嵌套字段重叠、missing/null、结构变更和物化失败都必须保留。跨不同资源域的后缀共享需要明确组合规则；禁止仅为单字段数值加入特例然后宣称长期成本已解决。

实施后应增加真实接纳日志的访问次数/运算次数上界，覆盖单行长历史、多字段重叠、规范化后后继编辑以及抵消前缀被语义读取引用，再运行历史、恢复、结构、生成和变异套件。保留每份原文、全部 history 与恢复能力仍是硬要求。

## 当前意图局部前缀的延迟遍历

进一步定位到 projectThrough 的每个 expectation 都执行全局 steps.slice(0, step).filter(...).map(...)，即使 resolvedExpectation 随即返回原基值，也已先复制所有无关历史步骤。真实接纳 N=16/32/64 次单行编辑后，对一次投影的步骤数组 slice 复制量计数分别为 120/496/2016，即 N(N−1)/2；新增 projection-cost 测试的线性分配上界在旧实现上全部失败。

步骤计划现在记录每个意图的 intentStart；localOperations 只在 resolvedExpectation 实际消费时，从这个起点遍历当前组之前的组。所有组本来按完整 intent 连续展开，因此不需要过滤整个全局前缀，也不需要创建局部前缀数组。精确 canonical 基值之后仍按原顺序应用同一意图的更早组，其他 intent 的效果继续由原前驱解析负责。无跨投影缓存，不修改 journal、coverage 或输入。

定向三文件 13 项及类型/边界检查通过。分配测试同时核对完整隐藏文档、N 个可提交意图、N 份输入和整份状态不变。该计数只界定 slice 复制的步骤记录数量，不代表总内存分配、整个投影复杂度或耗时已经线性。resolvedExpectation 的 predecessor/frontier 扫描、历史和其他复杂域成本仍开放。

本次局部前缀实现最终验证：1005 单元、375 三浏览器、10 语义变异、类型/边界/lint/demo 构建及发布包三浏览器消费全部通过。

## 前驱解析的剩余查询成本

当前工作树再次对真实接纳的单行 x=1..N 历史测量一次 projectKernel，使用临时 Vitest 探针拦截 Map.prototype.get，只计 key 属于原 journal intent ID 集合的调用；finally 恢复原 get。每个样本同时断言完整 preview 为 x=N/hidden7。随后用调用栈包含 resolvedExpectation 分类同一组查询，得到：

| 动作数 N | intent ID 查询总数 | resolvedExpectation 内查询 | 其他查询 |
| --- | ---: | ---: | ---: |
| 16 | 376 | 240 | 136 |
| 32 | 1520 | 992 | 528 |
| 64 | 6112 | 4032 | 2080 |
| 128 | 24512 | 16256 | 8256 |

本负载中 resolvedExpectation 内计数为 N(N−1)，其余为 N(N+1)/2。解析中的每个 predecessor 分别查询 intents 与 settlements，故即使没有任何提交事实可提供 canonical 基值，也仍重复遍历历史前驱。其他查询不能据此直接归因，需继续定位调用路径。调用栈采样用于分类，不用于时间基准；总查询数亦不代表所有 CPU/内存开销。

仅加“没有 committed settlement 就提前返回”并不完整：本地 create 同样能建立新基值，undo/redo 中恢复 create 也可能参与；而存在一个旧提交后仍会回到同样的重复扫描。下一步需要按资源和前驱链组织可共享的解析结果，并明确其对本地 create、exact canonical、未结算后继、不同 frontier 和同意图局部组前缀的语义，而非把无提交场景当作完整优化。原 immutable journal/inputs 不得截断。

临时探针四例两次测量通过，输出记录于 /tmp/projection-map-metrics.jsonl；探针已从生产测试目录移除，避免将无复杂度上界的诊断作为回归门禁。这一检查点确认剩余问题，没有宣称修复或再次运行完整门禁。

## 无阻塞种子时的依赖闭包

对 N=32 的其余528次查询按调用栈进一步分类：32次来自读域准备，496次来自 projection.ts 的 dependencyBlocked 遍历。原闭包循环无条件执行一次，即使所有行的 issues 都为空，也遍历全部历史 dependencies。该传播规则只能从已有 issues 产生新的 dependency-blocked；空种子集合的闭包必为空。因此循环现在以是否存在初始 issues 决定启动，有种子时沿用原有跨行依赖与 transaction 固定点传播。

新增 projection-cost 三例在 Map.get 返回依赖 owner WorkingRow 时计数，同时核对完整预览和所有可提交 intent。旧实现 N=16/32/64 分别120/496/2016次 owner 查询，三例均失败；新实现均为0。已有 data-workflow 的跨行依赖和事务阻塞用例继续通过。该优化不改变原日志、依赖边或输入，也不声明解决 resolvedExpectation 的 N(N−1) 查询或有阻塞历史的总体成本。

空种子闭包优化最终验证：1090单元、384三浏览器、10语义变异、类型/边界/lint、demo构建与发布包三浏览器消费通过。
