# 架构与协议边界

## 数据流

VS Code 的 `ZCodeViewProvider` 负责 webview 消息、编辑器上下文和宿主操作；`ZCodeClient` 通过 stdio RPC 与桌面 CLI 的 app-server 通信；`ConversationReplica` 对 v4 快照与增量进行对账，再投影为 webview 事件。页面通过 VS Code bridge 发送动作并渲染状态。

桌面索引与 CLI 会话持久化是不同层。索引里存在会话 ID 不等于它可被后端恢复，列表状态也可能落后于数据库。会话切换的串行化只覆盖提交和身份变更，不应阻塞整段生成或停止后台任务。

## 入口

| 模块 | 职责 |
|---|---|
| `src/extension.ts` | 扩展注册、provider、宿主消息、会话操作、恢复与诊断入口 |
| `src/zcodeClient.ts` | 进程与 RPC、会话生命周期、模型权限、发送队列、v4 订阅和投影 |
| `src/conversation.ts` | 帧解码、分片、副本、快照／增量一致性 |
| `src/taskIndex.ts`、`src/desktopProjects.ts`、`src/workspacePath.ts` | 索引／持久化写入、归档删除、跨平台路径语义 |
| `src/desktop.ts`、`src/credentials.ts`、`src/desktopJson.ts`、`src/serverPath.ts` | 桌面配置、登录、模型来源、运行时发现 |
| `src/webview/main.ts`、`src/webviewHtml.ts` | 页面状态、消息与工作过程、输入、导航、滚动、HTML／CSS／CSP |
| `src/webview/markdown.ts`、`fileMentions.ts`、`imageAttachments.ts` | 已分离的 Markdown、文件提及、图片辅助逻辑 |
| `src/imageAttachments.ts`、`src/draftImagePreview.ts` | 原生附件与未发送图片预览缓存 |
| `src/fileSearch.ts`、`src/fileContext.ts`、`src/promptContext.ts` | 工作区搜索与编辑器上下文 |
| `src/math.ts`、`esbuild.mjs`、`src/mathFonts.ts` | 公式识别、KaTeX、本地布局 CSS，以及按需下载的 WOFF2 |
| `src/i18n.ts`、`src/i18n.zhTW.ts`、`src/hostI18n.ts` | 三语页面与宿主文案 |
| `src/diffDocuments.ts`、`src/diagnostics.ts`、`src/errorGuidance.ts` | 只读 Diff、脱敏诊断、可操作错误指引 |

图标源文件为 `media/icon-zcode-vscode.svg`，运行时使用同名 PNG；新会话背景的主题色线稿在 `src/webview/emptyLogo.ts`。修改品牌图形时同步检查这三处，设计备份不属于公开源码或安装包。

## 修改必须守住的边界

1. 会话 ID、订阅代际与修订号来自协议；不可用当前 UI 的状态猜测旧异步事件的归属。
2. 计划开关与基础权限分别保存，缺省字段不能继承其他会话。编辑图片还需本次编辑身份，取消后迟到事件直接丢弃。
3. 最终正文与中间工作过程分开，历史重绘和实时增量应得到相同文本与顺序。不能按重订阅后重新排列的序号拼接旧文本。
4. 数据库写入集中管理，保留事务、WAL 与兼容性检查；Windows 路径比较忽略大小写，Linux 保留其语义。
5. Markdown／工具结果不可信；HTML 清理、转义、CSP 和附件授权不可因展示需求放宽。公式资源离线加载，禁止信任危险公式命令。

## SQLite 读取与回退

Linux、Windows 和 macOS 统一使用扩展宿主内置的 `node:sqlite`：查询以只读连接打开原库，修改操作只写原库。WAL 数据库因缺少 SHM 或无法初始化共享内存而打不开时，查询可复用包含已提交 WAL 记录的临时快照，再由原生 SQLite 只读打开；锁冲突与损坏不会触发快照回退。快照随原库或 WAL 的变化失效，在扩展停用时清理。

原生快照路径已在 Linux x64、Windows x64、macOS Intel／ARM64 的 VS Code 1.106.0 与 1.143.1 真实宿主中通过回归，随后统一启用；安装包不再携带 SQLite WASM。缺少 `node:sqlite` 的运行环境会明确报错并提示更新 VS Code。其他架构需单独验证。

## 套餐额度来源

`readPlanSelection` 根据桌面端当前的 BigModel／Z.ai OAuth 连接选择个人、团队或 Start Plan；API Key 模式不视为账号套餐。普通个人和团队 Coding Plan 读取各自供应商域名的 `/api/monitor/usage/quota/limit`，团队请求还要携带桌面选择的组织／项目 ID 和 `type=2`。Z.ai OAuth 在请求前交换业务令牌；BigModel OAuth 使用对应访问令牌。

Start Plan 使用独立的 ZCode JWT 查询 `/api/v1/zcode-plan/billing/balance`，并传入桌面端版本。余额按仍有效的 Start Plan 实例归属，剩余比例使用 `remaining_units / total_units`，重置时间来自 `expires_at`；`available_units` 会扣除进行中预留量，不能拿来替代用户可见的剩余额度。额度桶名称由服务端提供，可能按模型返回多条，因此页面不能把它们套成固定的 5 小时／每周两项。

第三方额度由 `src/quotaAdapters.ts` 的通用声明式适配层处理，DeepSeek 与 Kimi 使用同一套预置配置。用户可按供应商标识、认证方式、请求及字段映射添加配置；详细协议见 [额度适配器](quota-adapters.md)。请求只读，不包含聊天正文；不可用时回退 ZCode 套餐额度。

## 渐进拆分

`zcodeClient.ts` 和 `webview/main.ts` 仍较大，目前并未完成模块化。后续可按单模块迁移，保留公开 API：客户端先分离传输与 RPC，再处理交互与投影；页面按消息、输入、滚动、用量和设置拆分。跨模块的生命周期与串行化先留在门面中。

每一步先写清职责和输入输出，迁移后跑相关回归；协议状态或会话归属变更需全量检查。不要同时改变行为、目录和协议，也不要把重构前的私有成员测试机械复制到新的模块。

## 桌面端项目归属

同步任务索引时，支持项目目录表的桌面版本会在同一事务内补齐本地主机、根目录、项目关联和缺失的 CLI 会话事实。已有项目按根目录匹配（Windows 忽略大小写并兼容路径分隔符），未注册目录则创建项目；已有的非空任务归属和桌面端 CLI 事实保持不变。旧版没有项目表时沿用原有索引写入，不创建或迁移表结构。CLI session.project_id 与桌面任务索引的 project_id 属于两套独立模型，不混用。

任务索引复用已有的工作区键，避免 Windows 路径变体与 `(host_id, task_id)` 唯一约束冲突。占位记录补齐缺失的供应商与创建时间；活动页和归档页刷新都同步项目归属，保留 CLI 和索引中已有的归档状态。索引库内的任务／项目写入保持事务性；跨 CLI 库和索引库的修改可能部分成功，此时明确报告已保存的位置，并允许重复相同操作完成同步。
