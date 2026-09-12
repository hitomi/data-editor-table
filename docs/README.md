# 文档索引 — 0.4.0

0.4.0 使用 Workspace API。旧 controller、data-source constructor 和 cell-type registry API 已删除，旧代码示例不能直接用于当前版本。

## 接入与迁移

| 文档 | 用途 |
| --- | --- |
| [项目 README](../README.md) | 安装、React 渲染、样式和公开入口 |
| [迁移指南](workspace-migration.md) | Workspace、Source、输入、任务、交互、关闭与恢复契约 |
| [API 导航](workspace-api.md) | 当前公开方法、返回结果和类型定义入口 |
| [保存一致性](persistence-consistency.md) | 保存、精确回执、旧读取与后继输入的关系 |
| [Quick start](../demo/src/quick-start.tsx) | 在 React 外持有 durable Workspace 的完整示例 |
| [Playground](../demo/src/playground.tsx) | 编辑、保存模式、行操作和文件任务组合 |

demo 的数据与任务服务存储在浏览器中；它们不是可直接复用的远端服务协议实现。

## 设计、证据和限制

| 文档 | 性质 |
| --- | --- |
| [状态内核设计](state-kernel-redesign.md) | 设计目标及约束，不代表全部目标已实现 |
| [验收索引](state-kernel-acceptance.md) | 要求与证据对应，明确待完成工作 |
| [测试审计](test-suite-audit.md) | 测试删减依据、异常修复及后续回归证据 |
| [工作流测量](workflow-cost-baseline.md) | 指定测试环境的成本测量，不是浏览器性能承诺 |
| [依赖前缀设计](causal-frontier-cost-design.md) | 因果引用与成本优化的设计和过程 |
| [投影成本调查](projection-cost-investigation.md) | 特定负载的分析和优化记录 |
| [实施进展](state-kernel-progress.md) | 按时间追加的历史日志；旧计数和阶段结论不代表当前状态 |

当前已验证的功能不等于全部设计验收完成。未完成的大数据渲染、长期历史成本和恢复组合等要求以验收索引为准。测试覆盖率仅统计 Vitest，浏览器测试另行执行。

## 历史资料

以下仅用于理解旧设计，不能作为 0.4.0 接入说明：

- [旧 native grid 计划](archive/native-grid-v2-plan.md)
- [旧 controller 重构](archive/grid-controller-refactor.md)
- [旧 draft 模型](archive/draft-state-model.md)
- [旧保存一致性审计](archive/persistence-consistency-legacy.md)
- [0.3.1 接入指南](archive/llms-v0.3.1.txt)

旧文档地址保留跳转说明，方便已有链接继续找到历史资料。
