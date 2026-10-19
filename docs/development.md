# 开发环境与验证

## 环境

使用 Node.js 22.13+ 和 npm（建议 Node.js 24 LTS）。测试使用 `node:sqlite`；VS Code 内实际运行由 VS Code 的扩展宿主负责，`@types/node` 版本不代表本地测试运行时版本。

```bash
npm ci
npm run verify
```

`verify` 依次检查宿主及 webview 类型、运行单元测试、生产构建，并审计待打包文件。普通构建不需要桌面登录。真实聊天需要安装、登录 ZCode 桌面端；兼容范围和运行时设置见 [README](../README.md)。

`npm test` 为测试子进程设置临时 HOME、USERPROFILE、AppData 和 XDG 目录，并移除继承的 `ZCODE_CREDENTIAL_SECRET`，结束后清理临时文件，不修改调用者环境。涉及桌面配置、凭据、默认模型和会话库的用例必须显式创建隔离夹具或提供模拟状态；协议用例应在模拟快照中提供所需模型。检查事件时按目标类型筛选，避免无关事件的有无或顺序影响断言。

`npm test` 同时执行 CHANGELOG 门禁（`src/changelogGuard.ts`），因此 `verify` 和打包都会自动检查最新段落：中文与 English 分组各出现一次且都有条目，不能包含明确的测试覆盖、测试数量、本地测试包约定或作者实测过程。允许“测试连接按钮”等用户功能描述。日常开发允许首段使用 `未发布 / Unreleased`；已标明版本的段落必须与 `package.json` 一致，并使用有效的 `YYYY-MM-DD` 日期。`npm run package` 会额外要求首段为正式的版本与日期，拒绝尚未整理的 Unreleased。历史段落不追溯检查，中英文是否准确对应仍由人工评审；报错附带条目行号和原因。

`npm run watch` 持续构建；`npm run package` 按 `package.json` 的版本生成 VSIX，不修改源码或自动推进版本。VS Code 使用 “Install from VSIX” 安装，完成后由使用者 Reload Window。打包与发布见 [发布说明](releasing.md)。

## 测试层次

| 命令 | 作用与前提 |
|---|---|
| `npm run check` | 宿主与 webview TypeScript；不连接后端 |
| `npm test` | 状态机、协议、存储、界面辅助逻辑；使用隔离夹具 |
| `npm run build` | esbuild 生产构建，复制 SQLite WASM 与离线公式资源 |
| `npm run check:package` | 对构建后的 VSCE 文件清单检查必需资产、白名单与公式字体引用 |
| `npm run test:browser` | 真实页面与模拟 VS Code bridge；需要 Chrome |
| `npm run test:themes` | 四种内置深浅色主题、两种宽度、多种状态；需要 Chrome 和 VS Code 主题文件 |
| `npm run test:desktop-sessions` | 实际 CLI 后端与客户端组合，使用临时存储和 localhost 假模型 |
| `npm run test:desktop-attachments` | 原生图片上传、发送、读取；同样使用隔离存储 |

浏览器／主题脚本目前主要在 Linux 上使用。可用 `CHROME_BIN` 指定 Chrome 可执行文件；主题脚本可用 `VSCODE_THEME_DIR` 指定 VS Code 的 `theme-defaults/themes` 目录，`ZCODE_AUDIT_DIR` 指定报告输出位置。这些环境变量并不代表脚本已在 Windows／macOS 完整验证。

原生测试默认寻找 `/opt/ZCode/resources/glm/zcode.cjs`；其他安装位置使用 `ZCODE_BINARY`，供应商配置可用 `ZCODE_TEST_BUILTIN_CONFIG` 指定。它们不使用真实账号或会话库，但需要实际桌面运行时和兼容的配置结构。

## 按改动选择验证

- 文档：检查链接、版本与事实一致，不需要浏览器回归。
- UI：类型、相关浏览器用例，深浅色／窄栏截图；不要只检查深色。
- 会话、模型、权限、队列、恢复：类型、单元、浏览器与隔离原生会话；对新建、切走切回、停止后重发、编辑后重发补行为用例。
- 图片：额外检查真实 FileReader、解码、会话切换迟到事件及原生附件。
- 发布：完整测试集合、包清单与身份检查，记录未实测的平台。已完成的同一代码测试无需无理由重复，打包仍须通过门禁。

测试超时先查阶段和日志。浏览器启动超时不是断言通过；报告应完整检查失败项。涉及最终文本时使用明确预期或持久化记录比较，不能只凭“看起来正常”。

## 仓库文件

源码在 `src/`，行为测试与模块相邻，浏览器和原生集成检查在 `scripts/`。`dist/`、`node_modules/`、VSIX、个人配置及临时会话均不提交。文本换行由 `.gitattributes` 统一为 LF，位图及二进制资产保持原样。项目开发、发布和贡献规则见 `CONTRIBUTING.md` 与 `docs/`。

## 启动耗时排查

输出面板的 `session timing` 记录一次打开／切换。`totalMs` 是整个流程耗时；登录、进程启动和 RPC 可能重叠，不能把各阶段直接相加。

- `sessionAttachedMs`：宿主得到会话身份并准备发送附加事件。
- `historyPostedMs`：宿主第一次发送历史，不代表浏览器已经完成绘制。
- `metadataReadyMs`：本次流程的列表、模型与控制项发布完成。
- `spawnToFirstRpc`、`session/resume`、`session/subscribe`、`conversationSubscribe`：定位启动、恢复和订阅的主要等待。
- `sessionListCount`、`historyPosts`、`loginReuse`：核对重复查询、历史重画与登录复用次数。
- `questionIndex`、`questionIndexCacheHits`：问题导航索引的数据库查询耗时与缓存命中次数；索引只在送达页面的提问行变化时重新读取。
- `resumeSnapshotReuse`／`resumeSnapshotRefresh`：恢复快照是否复用。订阅仍重放交互事件；事件序号或状态修订变化时，读取最新的单条消息快照，旧协议缺少必要字段则保留完整订阅快照。

比较同一运行时、工作区和会话的冷／热启动，多次取样。隔离假模型测试验证流程正确性，不能替代真实账号的网络耗时；不要为了采样操作维护者的真实会话或凭据。历史去重需要核对发送页面的副本版本，不能只按会话 ID 去重；失效密钥刷新失败时不得回退旧缓存。

连接慢时还可查看 `runtimePreferencesRequestedMs`（启动后的首次运行偏好请求）、`runtimeHeadersMs` 和认证缓存命中次数，以及 `resumeReplyBytes`／`resumeReplyParseMs`／`notificationHandlingMs`。这些只记录数字，不记录正文或凭据；异步回调保留原计时归属。后端日志位于 CLI 的 `log/zcode-YYYY-MM-DD.jsonl`，以会话归属和 UTC 时间与扩展日志对齐；`zcode_protocol.session.resume_completed` 是内部恢复结束，不能等同整个 `session/resume` RPC 结束。MCP 初始化可能并行，不能直接把其耗时归入恢复。

宿主阻塞也会延迟读取后端响应。`hostEventLoopDelayMaxMs` 记录当前扩展宿主在本次打开／切换期间的最大事件循环延迟（正常值约采样间隔20ms）；`hostEventLoopActiveMs`／`hostEventLoopIdleMs` 是共享进程的活动与空闲时间，不能据此归责某个扩展。监测在流程结束时停止。应同时检查 VS Code renderer.log 的 unresponsive／responsive 记录，不将 RPC 等待全部等同于后端执行时间。

后端进程使用扩展全局存储下的 `runtime-compile-cache` 保存 Node 编译缓存。缓存只用于静态运行时代码，首次生成可能稍慢；已有 `NODE_COMPILE_CACHE` 或 `NODE_DISABLE_COMPILE_CACHE=1` 优先，旧运行时／无法写缓存时仍正常启动。`runtimeCompileCacheRequested` 表示请求启用，不代表运行时已成功建立缓存；隔离性能结果不能替代真实启动采样。目录不在仓库或 VSIX 中。

部分 Electron 宿主的 eventLoopUtilization 返回全零，此时只记录 `hostEventLoopUtilizationAvailable:false`，省略活动／空闲字段；全零不代表宿主空闲。最大延迟监测仍有效。

## 发送与首段输出耗时

`send timing` 是本地日志，只记录数字和阶段，不记录问题、回复、会话或账号身份。普通发送分别记录 `webviewToHostMs`（页面发出至宿主接收）、`promptPreparedMs`（宿主完成待切换模型与文件上下文准备）、`admittedMs`（发送命令返回）、`runningStatusPostedMs`（首次发送运行状态）、`firstOutputPostedMs`（宿主收到首段非空实时正文／思考并准备转发）。除页面到宿主耗时外，各阶段均从宿主接收发送动作起算，不能相加；输出可以早于命令返回。

页面在更新首段文字后，用两次 animation frame 回调确认一次绘制机会，记录 `firstOutputPaintAckMs` 与 `webviewFrameWaitMs`。这不是物理屏幕或远程桌面显示时间，隐藏页面也可能延迟回调。切换页面、停止或重启会结束原探针，旧回调不能进入新会话；监测最多保留三分钟。队列插入、编辑重发和仅工具输出不在这项普通发送计时范围内。

模型日志中的整次请求 `durationMs` 不能当作首字时间；持久化 part 的创建时间可能早于实际收到文字，也不能这样使用。用同一会话／轮次把扩展日志与 CLI 的 `turn.started`、`model.request.started` 对齐，再判断准备、后端等待、宿主阻塞或页面绘制的主要耗时。不要为性能采样向真实账号自动发送请求。

## 无桌面环境与自动化验证

容器、持续集成（CI）和远程开发环境均使用 Node.js 22.13+，执行 `npm ci` 和 `npm run verify`。这两步不需要账号、API Key 或 ZCode 桌面端。仓库不附带桌面运行时；没有 Chrome／VS Code 主题资源时不运行对应浏览器／主题检查，没有桌面运行时则不运行原生集成检查，并在交付中说明未覆盖范围。不要把个人凭据、会话数据库或桌面配置上传到仓库来补齐测试环境。
