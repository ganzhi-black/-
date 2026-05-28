# 运行信息流地图

这份文档是排查「期末刷」问题时用的运行地图。改代码前，先在这里定位出问题的流程，再收集同一个 `requestId` 下的日志。

## 日志规则

- 后端每个请求都会输出 `request_started` 和 `request_finished`。
- 每个请求的响应头里都有 `X-Request-Id`，日志里也会有 `requestId` 字段。
- `password`、`token`、`cookie`、`authorization`、`session`、API Key 等敏感字段会被打码。
- 很长的字符串会被截断，日志只保留内容形状和长度线索，不直接把完整资料或答案刷出来。
- 让 AI 帮你排查时，请提供：同一个 `requestId` 的所有日志、用户当时做了什么、页面地址、用户看到的错误提示。

## 主要信息流

### 1. 应用启动和登录状态

前端路由守卫在 `src/App.jsx` 中调用 `src/services/api.js` 的 `api.getCurrentUser()`。

后端流程：
- `GET /api/auth/me` 检查登录 Cookie。
- `resolveAuth` 读取 `qimoshua_session`，从存储中找到登录会话，然后设置 `req.user` 和 `req.visitorId`。
- 受保护的 `/api/*` 路由会经过 `requireAuth`。

关键日志：
- `request_started`
- `auth_login_requested`
- `auth_login_completed`
- `auth_login_rejected`
- `auth_register_requested`
- `auth_register_completed`
- `request_finished`
- `request_failed`

### 2. 上传资料

用户路径：
- 进入 `/upload`
- 选择文件、选择题型、选择题量、提交。

前端流程：
- `api.createSubject({ name, file })`
- `POST /api/subjects`
- `POST /api/documents/upload`
- `api.createSession(...)`
- 跳转到 `/quiz/:sessionId`

后端流程：
- 创建科目。
- Multer 在内存中接收上传文件。
- `extractTextFromFile` 从 txt、md、pdf、doc、docx 中提取文本。
- `chunkText` 把文本切成知识片段。
- `embedTexts` 创建向量；没有外部服务时使用本地兜底向量。
- 存储文档元信息和知识片段。

关键日志：
- `subject_created`
- `upload_received`
- `upload_text_extracted`
- `upload_text_chunked`
- `upload_embeddings_created`
- `upload_saved`
- `upload_completed`

### 3. 生成题目

用户路径：
- 上传资料后自动开始一套练习。
- 已有科目的设置页可以开始新练习。
- 科目历史页可以继续生成题目。

前端流程：
- `api.createSession({ subjectId, types, amount, mode })`
- `POST /api/sessions`

后端流程：
- `getPracticeSources` 读取该科目的知识片段。
- 名词解释题需要资料里存在类似“名词 + 解释”的内容。
- 加载历史题目，减少重复生成。
- `generateQuestionsFromSources` 调用配置好的 AI 服务。
- 生成的题目在后台保存。
- 练习会话会立即返回给前端。

关键日志：
- `session_create_requested`
- `questions_sources_loaded`
- `questions_history_loaded`
- `questions_ai_generated`
- `questions_generated`
- `session_create_completed`
- `background_save_failed`

### 4. 做题和批改

用户路径：
- 进入 `/quiz/:sessionId`
- 选择选项，或输入/语音回答。
- 提交答案。

前端流程：
- `api.getSession(sessionId)` 加载练习。
- `api.submitAnswer(...)` 调用 `POST /api/answers/grade`。
- 结果先保存到本地，再同步到后端。
- 跳转到 `/result/:sessionId/:questionIndex`。

后端流程：
- 选择题本地批改。
- 主观题调用 AI 批改，失败时可能使用本地兜底批改。
- 如果有 `sessionId`，答案会在后台保存。

关键日志：
- `session_loaded`
- `answer_graded`
- `grade_completed`
- `background_save_failed`

### 5. 结果页和总结页

用户路径：
- `/result/:sessionId/:questionIndex`
- 继续、重做、展开资料来源、完成练习。
- `/summary/:sessionId`

前端流程：
- 结果页从本地状态读取练习和答案。
- 完成练习时调用 `api.finishSession(sessionId)`。
- 总结页可以按相同设置再来一套练习。

后端流程：
- `POST /api/sessions/:sessionId/finish` 在存储支持时保存总结数据。

关键日志：
- `session_finished`

### 6. 错题本

用户路径：
- `/mistakes`
- `/mistakes/:subjectId`

前端流程：
- `api.getMistakes(subjectId)` 先请求后端，失败或无数据时回退到本地状态。
- 重练错题调用 `POST /api/sessions/retry`。
- 删除错题调用 `DELETE /api/mistakes/:mistakeId`。

后端流程：
- 按访客和可选科目读取错题。
- 重练会话按题目 ID 读取选中的错题。
- 删除接口移除一条错题记录。

关键日志：
- `mistakes_listed`
- `retry_session_created`
- `mistake_deleted`

### 7. 历史科目和历史题目

用户路径：
- `/subjects/history`
- `/subjects/:subjectId/history`

前端流程：
- 科目列表来自 `api.getDashboard()`。
- 历史题目调用 `GET /api/subjects/:subjectId/questions`。
- 删除历史题目调用 `DELETE /api/subjects/:subjectId/questions/:questionId`。
- 删除科目调用 `DELETE /api/subjects/:subjectId`。

后端流程：
- 存储层读取科目、读取已生成题目、删除单题或删除整个科目。

关键日志：
- `subjects_listed`
- `subject_loaded`
- `subject_questions_listed`
- `subject_question_deleted`
- `subject_deleted`

### 8. 数据看板和埋点

用户路径：
- `/admin/metrics`

前端流程：
- `api.getAdminMetrics()`
- `api.getAdminEvents(limit)`
- UI 埋点调用 `POST /api/analytics/events`。

后端流程：
- 管理员路由需要配置管理员邮箱；除非关闭了管理员鉴权。
- 埋点会保存访客、页面、会话、属性和浏览器信息。

关键日志：
- `admin_metrics_loaded`
- `admin_events_loaded`
- `analytics_event_saved`

## 排查清单

1. 先从 `docs/user-actions.md` 找到对应的用户操作。
2. 在本文档里找到对应页面、接口和后端流程。
3. 复现一次问题，复制同一个 `requestId` 下的所有后端日志。
4. 看最后一条是正常的 `request_finished`，还是错误的 `request_failed`。
5. 如果请求进入了 AI 或数据库逻辑，把附近的 `questions_*`、`upload_*`、`grade_*` 或存储相关 warning 一起带上。
6. 如果前端回退到了 mock 或本地状态，把浏览器控制台里来自 `src/services/api.js` 的 warning 一起带上。

## 维护规则

只要代码改动影响了路由、接口、数据流、存储行为、AI 行为、兜底逻辑或日志事件名，就必须同步更新这份文档。
