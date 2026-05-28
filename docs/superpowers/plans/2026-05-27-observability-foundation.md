# 可观测性基础实施计划

> **给后续 AI 执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行本计划。步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 增加实用的诊断能力，让一次故障可以从用户操作一路追到接口、数据库、AI 调用和最终响应。

**架构：** 不引入新的日志依赖。新增一个小型后端日志模块，输出结构化 JSON 日志；把它接入 Express 请求中间件；再在关键流程节点中调用。同步创建两份维护文档：运行信息流文档和用户操作清单。

**技术栈：** Node.js、Express、Vite React、内置 `node:test`。

---

### 任务 1：日志工具

**文件：**
- 新建：`server/services/logger.js`
- 新建：`tests/logger.test.js`

- [x] **步骤 1：先写失败测试**

运行：`node --test tests/logger.test.js`
预期：失败，因为 `server/services/logger.js` 还不存在。

- [x] **步骤 2：实现最小可用日志工具**

创建辅助函数：敏感字段打码、长文本截断、生成请求 ID，并通过 `console.log`、`console.warn`、`console.error` 输出 JSON 日志。

- [x] **步骤 3：运行测试确认通过**

运行：`node --test tests/logger.test.js`
预期：通过。

### 任务 2：Express 请求日志

**文件：**
- 修改：`server/index.js`

- [x] **步骤 1：添加请求中间件**

挂载 `req.requestId` 和 `req.logStep`。每个 API 请求都记录 `request_started` 和 `request_finished`。

- [x] **步骤 2：添加结构化错误日志**

把原来的原始错误输出替换为结构化的 `request_failed` 记录，包含请求 ID、方法、路径、状态码、错误信息、堆栈、用户/访客 ID。

- [x] **步骤 3：添加关键流程日志点**

在上传、检索、出题、创建练习、批改、完成练习、错题本、埋点等接口附近添加简洁的 `req.logStep(...)`。

### 任务 3：运行信息流文档

**文件：**
- 新建：`docs/runtime-map.md`

- [x] **步骤 1：记录产品数据流**

说明登录鉴权、上传、文本提取、切块、向量、存储、生成题目、练习会话、批改、错题本、数据看板、埋点分别怎么流动。

- [x] **步骤 2：记录日志解读方法**

说明如何阅读 `requestId`，以及让 AI 排查前应该收集哪些日志事件。

### 任务 4：用户操作清单

**文件：**
- 新建：`docs/user-actions.md`

- [x] **步骤 1：列出用户操作**

把每个可见用户操作映射到页面、动作、接口调用、预期成功结果、失败状态和相关操作。

- [x] **步骤 2：添加维护规则**

要求新功能必须新增或更新对应操作项，并把它和相关流程连接起来。

### 任务 5：验证

**文件：**
- `tests/logger.test.js`
- `server/index.js`
- `docs/runtime-map.md`
- `docs/user-actions.md`

- [x] **步骤 1：运行日志测试**

运行：`node --test tests/logger.test.js`
预期：通过。

- [x] **步骤 2：运行生产构建**

运行：`npm.cmd run build`
预期：通过。
