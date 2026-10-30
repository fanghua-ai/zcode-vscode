# 更新日志 / Changelog

## 2.1.6 — 2026-10-30

### 中文
- 会话重启或切换后正确恢复保存的权限和计划模式；新建会话的默认权限及空会话中的手动调整也会保留。
- 新建会话优先使用创建响应中的标识，避免后台请求使其误关联到旧会话。
- 自动恢复和切换会话前核对 CLI 归档状态，避免重新打开已归档的会话。
- 会话列表支持继续加载更早的记录，避免较早的活动会话被归档记录挤出；搜索和引用随已加载记录更新。
- 同时拖入图片和普通文件时保留整批附件，避免遗漏或重复上传。
- 连接或切换会话期间添加附件时显示提示，避免粘贴图片后没有反馈。
- 通用错误优先提供重新连接，模型不可用时仍提供切换模型；协议错误提供对应的处理提示，启动排查操作失败时显示反馈。
- 未标注有效语言的代码块按纯文本显示，减少恢复长代码历史时的卡顿；保留明确语言的语法高亮。
- 恢复尚未选定模型的会话时复用有效的模型目录，减少初始化等待。

### English
- Restore saved permissions and Plan mode after restarts and session switches, including defaults and manual permission changes in empty conversations.
- Use the identity returned by session creation so background requests cannot attach a new chat to the previous one.
- Check CLI archive state before automatic session selection to avoid reopening archived conversations.
- Load older session records on demand so archived records do not hide earlier active chats; search and references update with loaded records.
- Preserve mixed image and file drops without missing files or duplicate uploads.
- Explain when attachments cannot be added during connection or session switching.
- Offer reconnect for generic errors and model selection for unavailable models, provide relevant protocol error guidance, and report failed startup guidance actions.
- Keep code without a supported language label as plain text to reduce history-rendering stalls, while retaining explicit-language highlighting.
- Reuse a current model catalog when restoring a session without a selected model, reducing initialization waits.

## 2.1.5 — 2026-10-28

### 中文
- 修复图片分析结果在截断、嵌套编码或单独到达时露出 JSON 包装和转义字符的问题；保留参数和结果中引用的工具标题、Output 标签等文字，并提示结果不完整。
- 问答卡片定位到最下方的操作区，并避开浮动输入框；多个待处理请求时优先查看最新一张，自动跟随尊重手动浏览和折叠。
- 使用方向键浏览较长的命令与能力菜单时，高亮项始终保持可见。
- 查看归档页后仍可选择和发送正常会话引用；工作区切换与会话重命名及时更新引用候选。
- 避免连续点击重试重复发送；重试保留 Plan 模式，正确处理恢复草稿及后来新增的输入和附件。
- 修复代码中的反引号产生多余代码块、代码示例被误识别为工具调用的问题。
- 已停止的工具不再因迟到更新重新显示为运行中；会话同步失败时提供重新连接指引。
- 调整问题跳转数字和选中边框的居中对齐。
- 统一工作过程图标、文字和展开箭头的垂直对齐，减少不同系统字体和显示缩放下的偏移，并保留折叠标题的完整高度。
- 修复消息中技能和子智能体标签与正文的文字基线不齐。
- 整理 MIT 许可证和第三方图标声明，便于自动识别项目许可证，并完整保留第三方署名与许可。

### English
- Decode truncated, nested, and standalone image-analysis results instead of showing JSON envelopes and escape sequences; preserve quoted tool headings and Output labels in parameters and results, and identify incomplete results.
- Reveal the bottom actions of question cards above the floating composer, open the newest pending request first, and respect manual reading and folding.
- Keep the highlighted entry visible while navigating long command and capability menus with the arrow keys.
- Keep active conversation references available after viewing archives, and update suggestions when the workspace or session title changes.
- Prevent repeated retry clicks from sending duplicate messages; retain Plan mode and handle recovered drafts without discarding or duplicating newer input and attachments.
- Preserve literal backticks without extra code blocks, and keep tool examples inside code from becoming real tool calls.
- Keep stopped tools from returning to a running state after late updates, and offer reconnect guidance for session synchronization failures.
- Center question navigation numbers and their active outline.
- Center work-step icons, labels, and expand arrows consistently across system fonts and display scales, and preserve the full height of collapsed thought headers.
- Align inline skill and subagent labels with the surrounding message text.
- Separate the MIT license from third-party icon notices for license detection while preserving all third-party attribution and license text.

## 2.1.4 — 2026-10-27

### 中文
- 修复工作耗时信息晚到后仍只显示“已工作”的问题。
- 修复图片分析结果显示为转义 JSON 文本的问题。
- 在输入 `/` 时提供技能和子智能体建议；可选择多个引用，并在输入区管理。

### English
- Refresh completed work durations when turn timing arrives after the initial transcript.
- Render image-analysis results as readable text instead of escaped JSON.
- Show ZCode skills and subagents in the slash menu and manage multiple references in the composer.

## 2.1.3 — 2026-10-26

### 中文
- 修复选中回复后 Ctrl+C 或右键复制无效、或只能复制一次的问题。

### English
- Fix selected reply text failing to copy with Ctrl+C or the context menu, including copies failing after the first attempt.

## 2.1.2 — 2026-10-26

### 中文
- 修复个人与团队套餐并发认证时相互干扰、导致偶发登录失败的问题。
- 遇到 ZCode 服务端请求或参数不兼容时，提示检查桌面端与扩展版本，并提供重新连接和诊断反馈指引，避免误判为登录或额度问题。
- 插件市场页的输入区示意图继续使用已发布的 GitHub 图片。图片无法显示时，说明通常是访问 GitHub 的网络连接异常，并保留分区文字说明。
- 启动时区分“正在启动服务”和“正在恢复上次会话”。等待较久时显示已等待时间，并说明草稿会保留。
- 会话列表刷新失败时在列表内提示，并可以重试。已有结果时继续显示该页上次结果；首次加载失败会提供重试，不再显示为没有会话。活动页和归档页互不借用对方的结果。
- 切换会话失败后可以再次选择同一会话。恢复超时，或恢复后对话订阅超时，都不再停在无法再次点击的空白页。

### English
- Fix occasional sign-in failures when personal and team plan authentication requests run concurrently.
- Explain incompatible ZCode server requests or parameters, guide users to check desktop and extension versions, reconnect and share diagnostics, and avoid misleading sign-in or quota guidance.
- Keep the Marketplace composer illustration on its published GitHub image. If it cannot be shown, explain that the GitHub connection is usually unavailable and keep the section guide visible.
- Distinguish “Starting service” from “Restoring last chat” during startup. After a longer wait, show the elapsed time and explain that the draft will be kept.
- Show an in-list notice with retry when a chat list cannot refresh. Keep that page's previous result when one exists, and offer retry after a failed first load instead of showing an empty workspace. Active and archived pages do not reuse each other's results.
- A failed chat switch can be selected again. A restore timeout, or a conversation subscription timeout after restore, no longer leaves a blank page that ignores the next click.

## 2.1.1 — 2026-10-25

### 中文
- 减少启动时团队及个人套餐 OAuth 换证的重复请求和模型列表读取，先完成会话订阅再请求额度，缩短进入对话时的等待。
- 启动时恢复会话等待 90 秒，避免冷启动尚未完成就改开其他会话；超时后不再重复发送恢复请求。
- 会话恢复进行中刷新侧栏会继续等待，恢复超时但服务端仍在处理时也一样，不再提前报告会话列表超时。
- 会话尚未恢复完成时不再查询状态，启动和切换时不再出现 Session is not active 警告。
- Windows 上启动恢复会话超过 20 秒时，提示可能是 Microsoft Defender 扫描 ZCode 插件文件，并可复制排除命令，由用户自行决定；可选择不再提示。
- 选中模型回复后，始终通过扩展写入系统剪贴板；网页剪贴板即使返回成功，也不再出现选中后无法粘贴的情况。
- 数字两侧的单个波浪号按范围显示，例如“几百毫秒~3 秒，总启动则是 4~6 秒”，不再把中间内容画成删除线；真正的 `~~删除线~~` 保持不变。
- 回复生成中切换供应商时，额度面板立即显示所选供应商的额度，并继续在下一条消息应用该模型。
- 打开模型选择器时自动定位到当前选中的模型，长列表中不再需要手动查找。

### English
- Reduce repeated team and personal plan OAuth exchanges and model catalog reads during startup, and subscribe to the conversation before fetching quota.
- Restoring a chat at startup waits 90 seconds, so a cold start does not open another chat before that restore finishes. A timeout does not send a second restore request.
- Refreshing the sidebar keeps waiting while a chat is being restored, including after a restore times out while the server is still working, instead of reporting a session-list timeout.
- Session state is no longer read before a chat finishes resuming, so startup and switching no longer report Session is not active.
- On Windows, when restoring a chat at startup takes over 20 seconds, a notice explains that Microsoft Defender may be scanning ZCode plugin files and can copy an exclusion command. The choice stays with the user, and the notice can be turned off.
- Copying selected model text always writes it through the extension, so a webview clipboard that reports success can no longer leave the selection unpastable.
- A single tilde beside a number stays a range marker, so text such as “几百毫秒~3 秒，总启动则是 4~6 秒” is no longer struck through; genuine `~~strikethrough~~` is unchanged.
- When switching providers while a reply is running, the quota panel follows the selected provider immediately; the model is still applied to the next message.
- Opening the model picker reveals the currently selected model, so long lists no longer require manual scrolling.


## 2.1.0 — 2026-10-24

### 中文

- 更正第三方声明：公式字体不进入安装包。按需下载的字体包附带 SIL OFL 全文；已安装的旧字体包会在下次美化时重新下载。
- 说明稳定版与预览版的更新通道。手动安装改为按 `zcode-desktop-chat-<版本>.vsix` 选择文件，不再写死旧文件名。
- 关闭尚未启动成功的 ZCode 时，不再把终止信号发给编辑器自身。
- 多个窗口同时下载公式字体时各自使用临时目录；其他窗口已经装好时直接复用，不再互相删除缓存。
- 修复点击美化公式后字形不变的问题。字体随页面注入，不再让 webview 按文件加载 WOFF2。
- 公式字体缓存不完整时重新下载；下载过程中「美化公式」不再接受重复点击。
- 公式字体改为按需下载，安装包不再附带字体。回复结束后，可在复制和时间旁选择美化公式；下载一次后可离线使用。
- 修复 Windows 路径变体导致会话索引冲突、桌面占位会话不可见及归档会话漏关联；跨库同步部分成功时明确提示，并支持重试相同操作。
- 修复插件会话在新版桌面端落入普通任务的问题；自动复用或创建对应目录的项目，并补齐未关联会话的项目归属。
- 各平台统一使用 VS Code 内置 SQLite，保留 WAL 快照恢复能力并移除 WASM 运行库，缩小安装包。
- 合并同一帧内的回复增量，减少流式输出时的重复绘制；代码在生成过程中先以纯文本显示，结束后恢复高亮。

### English

- Correct the third-party notice: formula fonts are not included in the install package. The downloaded font pack includes the full SIL OFL text, and an older installed pack is downloaded again the next time formulas are improved.
- Document the stable and preview update channels. Manual installation now uses `zcode-desktop-chat-<version>.vsix` instead of a stale filename.
- Closing a ZCode process that never started no longer signals the editor itself.
- Give each window its own temporary directory when downloading formula fonts, and reuse a pack another window has already installed instead of deleting the cache.
- Fix formulas staying on the system font after Improve formulas. The faces are injected into the page instead of loaded as webview WOFF2 files.
- Download formula fonts again when the saved pack is incomplete, and ignore extra clicks on Improve formulas while a download is running.
- Download formula fonts on demand instead of including them in the install package. After a reply finishes, Improve formulas appears beside Copy and the time; the download is kept for offline use.
- Fix session index conflicts with Windows path variants, invisible desktop placeholders, and missing project links for archived sessions. Report partial saves across databases and allow retrying the same operation.
- Keep plugin sessions in the matching desktop project, creating a project for new workspace directories and associating previously unassigned sessions.
- Use VS Code’s built-in SQLite across platforms, retain WAL snapshot recovery, and remove the WASM runtime to reduce package size.
- Combine reply updates within each frame to reduce repeated rendering. Show plain code while streaming and restore syntax highlighting when the text finishes.

## 2.0.2 — 2026-10-23

### 中文

- 更新 DOMPurify 至 3.4.17，修复上游安全告警。
- 修复新版桌面端自定义 API 供应商无法聊天、或继续使用旧 Key 与旧地址的问题；统一读取当前 Key、API 地址和协议，并保留旧配置兼容。
- 为新版 ZCode 桌面端的 Coding Plan 接入短期项目 Token 鉴权，保留旧版登录兼容；修正 Z.AI 不同接口的认证头格式。
- 套餐 Token 在请求时检查并按需刷新，只保留在内存中；换证失败时不再回退到旧密钥。

### English

- Update DOMPurify to 3.4.17 to address upstream security advisories.
- Fix custom API providers failing to start or using stale keys and endpoints on newer desktops. Read the current key, endpoint, and protocol together while retaining legacy configuration support.
- Support short-lived project tokens for Coding Plans on newer ZCode desktops while retaining legacy login support, and use the correct Z.AI authentication headers for each endpoint.
- Check and refresh plan tokens at request time, keep them in memory, and fail explicitly instead of falling back to old keys when token exchange fails.

## 2.0.1 — 2026-10-23

### 中文

- 修复 ZCode 桌面端 3.16.2 拒绝旧会话列表参数、导致历史会话无法显示的问题，同时保留旧版桌面端的参数支持。
- `zcode.binaryPath` 和 `zcode.nodePath` 改为只读取用户级（本机）设置，写在工作区 `.vscode/settings.json` 里的这两项将不再生效；如之前在工作区里配置过，请移到用户设置。
- 插件声明不支持受限模式：在未受信任的工作区中不会启用，因为它需要启动本地 ZCode 进程。
- webview 的 nonce 改用密码学安全随机数生成；`@types/vscode` 锁定到与最低支持版本一致的 1.106。
- 从对话里打开文件或查看改动时，如果文件不在当前工作区内（包括通过符号链接指向外部），会先弹窗确认；无效路径和 URL 不再打开。在 Windows 上，指向工作区外网络共享（`\\服务器\共享`）的路径和链接会直接拒绝、不会访问共享；但链接指向映射成盘符的网络驱动器（如 `Z:\`）时仍会访问该驱动器。
- 输出日志、错误提示和复制的诊断信息会自动隐藏 API Key、Bearer Token 等凭据。
- 在没有内置 SQLite 的 VS Code 上，会话记录的临时副本改为按需重建：数据库没有变化时不再每次读取都复制整个数据库，后台状态检查也会放慢，减少界面卡顿。ZCode 持续写入时副本仍会重建，届时仍可能短暂卡顿。

### English

- Restore history listing on ZCode desktop 3.16.2 when it rejects the legacy session-list parameter, while retaining support for older desktop versions.
- `zcode.binaryPath` and `zcode.nodePath` are now read only from user (machine) settings; values in a workspace `.vscode/settings.json` are ignored. Move any workspace-level values to your user settings.
- The extension now declares that it does not support Restricted Mode and stays disabled in untrusted workspaces, because it starts a local ZCode process.
- Webview nonces now come from a cryptographically secure random source, and `@types/vscode` is pinned to 1.106 to match the minimum supported VS Code version.
- Opening a file or a change from the chat now asks for confirmation when the file is outside the current workspace, including through symlinks; invalid paths and URLs are no longer opened. On Windows, paths and links that lead to a network share (`\\server\share`) outside the workspace are refused without contacting the share; a link to a mapped network drive such as `Z:\` is still followed and reaches that drive.
- API keys, bearer tokens and similar credentials are now masked in the output log, error notifications and copied diagnostics.
- On VS Code builds without built-in SQLite, the temporary copy of the chat database is rebuilt only when the database changes instead of on every read, and background status checks run less often, which reduces editor stalls. While ZCode keeps writing to the database the copy is still rebuilt, so short stalls remain possible.

## 2.0.0 — 2026-10-19

### 中文

- 发布首个开源版本，提供 MIT 许可证下的插件源码，以及开发、架构、贡献和发布说明。
- 启用蓝色折叠 Z 图标，新会话欢迎页背景同步使用同一图形的线稿。
- 恢复 README 中的中英文输入区图片，配合分区说明介绍排队消息、问题导航、模型设置和额度面板。

### English

- Introduce the first open-source release, with plugin source code under the MIT license and documentation for development, architecture, contributing, and releases.
- Adopt the blue folded Z icon and use a matching outline on the new-chat welcome screen.
- Restore Chinese and English composer illustrations in the README, with section guides for queued messages, question navigation, model settings, and the quota panel.

## 1.4.10 — 2026-10-18

### 中文

- 修复排队消息修改失败后丢失修改内容的问题；等待保存时防止重复提交，失败后保留内容供重试，保存成功后刷新不再恢复旧文字，切换会话后的回执不会影响其他会话。
- 修复模型、推理强度或权限切换失败后选择器仍显示未生效选项的问题；计划模式同时恢复原来的基础权限，切换会话后忽略迟到错误。
- 修复加载更早历史或跳转到未加载问题失败后无法重试的问题；历史加载错误不再中断界面的生成状态。
- 修复登录和套餐额度请求在响应中途断开时一直等待的问题，并限制整次请求的等待时间。
- 修复加载更早历史或刷新内容时丢失正在编辑的提问、光标及图片修改的问题；编辑失败保留内容，迟到回执不会覆盖新一轮编辑，并防止重复提交。
- 修复带行号范围或锚点的本地 Markdown 文件链接无法打开的问题；代码链接可定位到对应行，文件名中的编码符号仍按原名处理。
- 修复旧会话仍可向已删除或禁用的供应商／模型发送消息的问题；配置暂时读取失败时保留最近一次有效模型清单，避免过期模型重新出现。
- 为推理强度与命令面板模型选择补充会话归属检查，忽略切换前的迟到操作与提示。
- 修复加载更早历史或刷新回复后，工作过程、工具卡片、查阅／终端分组及单条思考丢失手动展开／折叠状态的问题；插入新提问仍默认收起上一段工作过程。

### English

- Preserve edited queued messages when saving fails, prevent duplicate submissions while waiting, retain accepted text through refreshes, and keep replies scoped to their originating chat and edit attempt.
- Restore confirmed model, reasoning, and permission selections when a change fails, including the base permission beneath Plan mode, and ignore late errors after switching chats.
- Allow retrying failed history loads and jumps to unloaded questions without interrupting the chat's generation state.
- End login and plan-quota requests when a response is interrupted, and bound the total waiting time for each request.
- Preserve an active question editor, cursor, and image changes while loading older history or refreshing content. Keep failed edits retryable, prevent duplicate submissions, and ignore acknowledgements from an earlier edit or submission.
- Open local Markdown file links containing line ranges or anchors, navigate code links to the requested lines, and preserve encoded filename delimiters.
- Block old chats from sending through deleted or disabled providers and models. Retain the last verified model inventory during temporary configuration read failures so stale models do not reappear.
- Bind reasoning changes and command-palette model selections to their originating chat and ignore outdated actions and notices after switching chats.
- Preserve manual expansion of work folds, tool cards, lookup/terminal groups, and individual thoughts when loading older history or refreshing replies, while still collapsing the previous work segment after a new question is inserted.

## 1.4.9 — 2026-10-17

### 中文

- 修复切换会话期间的停止、队列、编辑、撤销等异步操作可能误作用于新会话的问题；操作现在绑定发起会话，迟到结果只恢复原会话草稿。
- 修复桌面端删除或禁用供应商／模型后，恢复旧会话、新建会话和额度查询仍可能复用过期模型或密钥的问题；当前可用清单会约束模型选择和额度适配。
- 对齐 `/plan` 与桌面端行为：先将当前会话切换到计划模式，再只发送任务正文；空命令只切换模式，不支持的图片或上下文引用会保留在草稿并提示。
- 修复无输出的终端命令展开为原始 JSON、额度环误用其他额度桶；手动展开或收起工作过程时，后续回复随内容自然移动，自动收起仍保留阅读位置；插入新提问后，前一段工作过程默认折叠。
- 修复重试失败提问时切换会话可能把原问题发送到新会话的问题；重试动作和异步模型切换均核对会话归属，失败内容保留在原会话草稿中。
- 修复通用额度适配器只返回剩余数量或重置时间时额度行被隐藏的问题；数量按原值显示，数量和重置时间行不显示伪造的百分比或进度条。
- 修复切换供应商后额度面板短暂显示上一个供应商余额的问题，并忽略切换前尚未完成的额度请求。
- 修复工具输出中的完整 JSON 后附带日志时，JSON 解析恢复过程会吞掉后续日志的问题；只从确实截断在末尾的 JSON 中恢复字段。
- 修复桌面端快捷方式移除模型后，插件仍从旧 CLI 配置或实时会话目录显示该模型的问题；桌面端启用模型清单现在作为对应供应商的准确信息，并会在配置变更后自动刷新。
- 修复桌面端删除整个第三方供应商后，旧配置或会话模型目录仍让该供应商出现在插件选择器中的问题；可读取桌面供应商清单时，以清单为准过滤已删除的供应商，并保留官方账号及内置 API Key 模型。
- 修复桌面端禁用模型后，新会话仍尝试使用已保存默认模型的问题；新会话回退到 ZCode 当前可用模型，旧会话恢复和排队模型切换也不会再从过期配置复活已删除或禁用的模型凭据。
- 修复 OAuth 官方账号模型被 API 快捷方式过滤的问题，同时继续阻止桌面端已移除的账号模型从实时目录重新出现。
- 修复思考过程中的工具卡片将网页读取、网页搜索及其他工具结果显示成原始 JSON；统一整理结果摘要、MCP 文本封装、搜索列表和终端输出，并识别 camelCase 工具名。
- 修复正文内嵌网页读取工具时，该工具行与前文间距过短的问题，保留原有思考区整体间距。
- 修复被截断的网页读取结果无法显示可恢复的标题、链接和简介；工具卡片继续与其他结果一样默认折叠，展开时保持标题位置稳定，结果向下展开并可滚动查看，滚动条同步反映展开和折叠后的内容高度。
- 发布包加入第三方许可声明，附上 DOMPurify、highlight.js、marked、KaTeX（含字体）和 node-sqlite3-wasm 的许可原文。

### English

- Bind stop, queue, edit, and file-revert operations to their originating chat so delayed actions cannot affect a newly selected chat; late failures restore drafts only to the source chat.
- Prevent deleted or disabled desktop providers and models from being reused when restoring or creating chats or querying quotas; the current availability inventory now governs model selection and quota adapters.
- Align `/plan` with the desktop: switch the current chat to Plan mode before sending only the task body. A bare command changes mode without sending, and unsupported images or context references remain in the draft with an explanation.
- Fix silent terminal commands expanding to raw JSON and the quota ring using the wrong quota bucket. Manual work-fold toggles now let following replies flow naturally with the content, while automatic collapse preserves the reading position; a previous work segment now collapses by default after a new question is inserted.
- Fix retrying a failed question into a newly selected chat. Retry actions and asynchronous model changes now verify chat ownership, and rejected content stays in the original chat's draft.
- Show quota rows when a generic adapter returns only a remaining count or reset time. Counts retain their returned value, and count/reset-only rows do not show invented percentages or progress bars.
- Prevent a provider's cached balance from appearing after switching to another provider, and ignore quota requests that complete after the switch.
- Preserve log text following complete JSON in tool output; partial recovery now applies only when JSON is truncated at the end.
- Fix removed desktop shortcut models reappearing from stale CLI configuration or the live session catalog. The desktop's enabled model list is authoritative for each configured provider and refreshes when its shortcut configuration changes.
- Fix deleted third-party providers reappearing in the model picker from stale configuration or the live session catalog. When the desktop provider registry is available, use it to filter removed providers while preserving official account and built-in API-key models.
- Fix new chats trying a saved default after its desktop model is disabled. New chats now fall back to a currently available ZCode model, and resumed chats or queued model switches cannot revive credentials for removed or disabled models from stale configuration.
- Fix OAuth account models being filtered as API shortcut models while continuing to block removed account models from reappearing in the live catalog.
- Fix reasoning tool cards that showed raw JSON for web reading, web search, and other tool results. Normalize result summaries, MCP text envelopes, search lists, and terminal output, and recognize camelCase tool names.
- Fix cramped spacing before web-reader tools embedded in prose while preserving the existing reasoning timeline spacing.
- Recover the available title, link, and description from truncated saved web-reader output. Keep tool cards collapsed by default and preserve their header position when expanding results, and update the scrollbar as cards expand or collapse.
- Include third-party license texts in the package for DOMPurify, highlight.js, marked, KaTeX (including its fonts), and node-sqlite3-wasm.

## 1.4.8 — 2026-10-14

### 中文

- 将 README 中的输入区图片替换为中英文纯文本线框示意，让插件市场页面无需外部图片链接也能展示输入区布局。

### English

- Replace the README composer images with Chinese and English text wireframes so the composer layout remains visible on the Marketplace without external image links.

## 1.4.7 — 2026-10-14

### 中文

- 修复桌面端在对话中切换模型后，插件已同步当前模型但历史里没有「模型已切换」提示的问题。实时会话行与保存的时间线都会读出切换前后的模型名，并在模型名后保留供应商，格式与原来的「模型(来源)」一致。
- 问题跳转轨道以小数字标记每条提问，悬停只显示日期和问题内容，并移除轨道右侧计数；横向滚动到末端时为最后一个编号留出空间，避免渐隐遮挡。当前问题编号用随数字宽度伸缩的圆角矩形标识，并按顶栏下方的阅读线更新；折叠或展开对话后也会重新计算。全折叠按钮会把开头被历史截断的片段也折叠；再次点击恢复折叠前各轮状态和阅读位置，后续重绘仍保持全折叠状态。
- 略微提高对话区、思考块和问题跳转区滚动条的对比度，让深色主题下更容易辨认。
- 排队消息改到输入框上方、比输入框更窄的目标条区域，仍逐条排列；有目标时与目标条叠在同一窄列。支持拖动手柄或方向键调整发送顺序，立即发送使用双上箭头，队列操作与会话保持隔离。
- 回复中生成的工作区文件可显示文件卡片并在 VS Code 中打开；修复切回运行中会话时尾部转圈未立即出现的问题，微调英文 Agent 工具行的图标对齐。
- 校对并润色 README 中英文说明，突出第三方 API 模型与可配置额度适配，并分别加入中英文输入框分区示意图和说明。
- 修复粗体标记紧邻中文时不渲染的问题，并为强调文本指定清晰字重；数值区间中的短横线和波浪线按普通文字显示，不会误删跨句内容。
- 修复较早历史轮次折叠后仍显示回复复制和时间的问题；展开时复用原消息并移除折叠条。
- 修正自然完成后的阅读定位：短回复保持在底部且不显示多余的“回到底部”箭头；长回复在用户仍跟随输出时，将本轮最新提问气泡稳定移到与问题跳转按钮相同的顶部位置，后续历史刷新也不会覆盖定位；用户主动滚动后解除定位。
- 新会话第一条提问前切换模型时不再插入切换提示；已有对话中的模型切换仍会显示，长历史只加载末尾回复时也能正确区分。
- 微调工作过程图标与折叠箭头的视觉垂直对齐；思考、查阅、终端和询问按中文标签校正，普通工具按英文工具名单独校正。
- 回复中的工作区文件 Markdown 链接现在可点击并在 VS Code 中打开图片等文件；工作区外或已失效的路径会给出提示。
- 模型切换提示两侧的装饰线保持短距离；回复的复制和时间操作留在切换提示之前。快速直答在后端提供时长时也会显示工作时间，不生成空的可展开区域。
- 修复历史恢复时图片分析工具后的正式回复丢失的问题。
- 补齐 Start Plan 额度读取：通过 ZCode 登录令牌查询有效套餐的按模型额度桶，并使用桌面端版本参数；额度面板显示服务端名称和所有额度桶。
- 模型选择器按 ZCode 桌面端的模型启用状态过滤快捷方式模型；桌面端禁用的模型不会被实时后端目录重新加入，启用状态覆盖也会遵循模板默认值。
- 增加统一的额度适配器注册表：预制 DeepSeek 与 Kimi API 余额查询，和用户配置使用相同的配置结构、凭据读取、HTTPS 请求、JSON Pointer 映射及失败回退流程。Kimi 显示人民币可用余额与代金券余额。用户可在 `zcode.quotaAdapters` 添加精确匹配 providerId 的适配器，支持 Bearer、自定义认证请求头和认证前缀，最多组合 5 个同源 JSON 请求；可根据总额和已用金额计算剩余预算，也可从非货币总量推导剩余数量与百分比。自定义指标可映射或安全组合响应中的数值字段，并支持最小单位换算，用于显示“今日消费”等信息。API Key 默认保存在 VS Code 安全存储，也可复用 ZCode 中同一 providerId 的密钥；适配器可声明可信供应商主机和快捷方式模板，避免快捷方式未填写 API 基础地址时错误回退。查询失败或未配置时继续显示原有 ZCode 套餐额度。
- 修复切换到推理档位不同的模型时沿用旧档位导致切换失败的问题；后端已切换模型但拒绝旧档位时，读取目标模型支持的档位并重试。

### English

- Show the model-switch notice after the desktop app changes models during a conversation. Live session rows and stored timeline parts supply the previous and next model names, and keep the provider in parentheses as `model(source)`.
- Mark each question in the navigation rail with a small number, show only the date and question text on hover, and remove the rail's trailing counter. Leave room for the final number at the horizontal scroll limit so the edge fade does not obscure it. Frame the current question number in a rounded rectangle that expands to fit its digits, and track it against the reading line below the top bar, recalculating after turns fold or expand. Collapse every turn, including a partial fragment at the start of truncated history; clicking again restores each turn's prior fold state and reading position, and later redraws keep the all-folded state.
- Slightly increase the contrast of the conversation, reasoning, and question-navigation scrollbars for better visibility in dark themes.
- Place queued messages in the narrower goal band above the composer, one row each, stacked with the goal strip when a goal is showing. Reorder by dragging handles or using arrow keys, use double up arrows for Send now, and keep queue actions scoped to their chat.
- Show generated workspace files as cards in replies and open them in VS Code. Restore the tail spinner immediately when returning to a running chat, and align icons with English Agent tool labels.
- Refine the Chinese and English README to highlight third-party API models and configurable quota adapters, and add localized composer illustrations with section guides.
- Fix bold markers adjacent to CJK text, give emphasis a clear weight, and prevent hyphens or tildes in numeric ranges from striking through surrounding prose.
- Keep reply copy and time controls hidden inside folded older turns, and remove the fold row when reopening the existing messages.
- Fix reading position after natural completion: short replies stay at the bottom without a redundant jump-to-bottom arrow; long replies move the latest question bubble to the same top position as the question jump button while the user is following output, and later transcript syncs preserve that position. Manual scrolling releases it.
- Suppress the model-switch notice when the model changes before a new chat's first question; keep notices for existing conversations, including long histories whose loaded tail contains only replies.
- Refine optical alignment of work-process icons and chevrons, with a separate adjustment for raw English tool names alongside the Chinese reasoning and tool labels.
- Open workspace file links in Markdown replies directly in VS Code, including image files; show guidance for paths outside the workspace or no longer available.
- Keep the rules beside model-switch notices short and leave reply copy/time actions above the switch. Show known work duration for fast direct answers without an empty expandable section.
- Keep final prose after an image-analysis tool visible when restoring history.
- Read Start Plan quota buckets through the ZCode login token and desktop-version parameter, filter buckets to active plan instances, and show every server-named model bucket in the quota panel.
- Filter shortcut models in the picker by their enabled state in the ZCode desktop app. Disabled models are not reintroduced by the live backend catalog, and provider-level overrides take precedence over template defaults.
- Add one quota-adapter registry: packaged DeepSeek and Kimi API balance presets and user configurations share the same schema, credential lookup, HTTPS request, JSON Pointer mapping, and fallback path. The Kimi preset displays the available balance and voucher balance in CNY. Users can add adapters with an exact providerId in `zcode.quotaAdapters`, use Bearer or custom auth headers with an optional prefix, and combine up to five same-origin JSON requests. They can derive monetary budgets or non-monetary remaining counts and percentages from total and used values. Custom metrics can map or safely combine numeric response fields and normalize minor units, so readings such as today's spend can appear without pretending to be percentages. API keys default to VS Code SecretStorage, with an option to reuse the ZCode key for that exact provider ID. Adapters can declare a trusted provider host and shortcut template, so missing base URLs do not cause built-in shortcuts to fall back incorrectly. Missing or failed adapters fall back to the existing ZCode plan quota.
- Fix model switches that fail when the target model does not support the previous model's reasoning effort; if the backend has already switched models, read the target model's supported effort and retry.

## 1.4.6 — 2026-10-11

### 中文

- 优化启动、登录和会话恢复：减少重复读取，复用有效登录与恢复快照，同时保留交互事件重放；认证失效时重新读取，不再回退到过期凭据。
- 修复重载后偶发空白及模型、推理设置未及时显示的问题；会话切换和历史更新保留问题导航。新提问与历史完全一致时就地对账，减少整段重绘并保留阅读位置与折叠状态。
- 发送后立即显示工作计时与输出指示；修复计时回退、首秒不均和插话后沿用前段时长的问题。各工作分段独立计时，历史恢复保持一致；过滤隐藏的待办提醒和后台通知，并合并其造成的连续后端回合，将各回合时长各计一次；排队消息不会提前切段。
- 改善生成时的阅读跟随：贴底时跟随正文、思考和文件变更，用户主动翻阅时保持视角；思考折叠不再打断阅读。长回复自然完成后，仅在仍跟随且提问已离开视野时返回本轮提问。
- 完善最新提问的编辑与排队：编辑操作稳定放在消息底部，后端确认后才启用；使用紧凑图标操作栏，修复取消、重发、图片操作和队列恢复问题；编辑会话引用时继续保留引用上下文。
- 在输入框输入 `@` 可同时搜索当前工作区文件与会话，文件优先、会话随后；会话引用显示为独立标签，并随草稿、发送和失败恢复保留。
- 对齐思考块中的思考、终端、查阅和工具图标及权限模式图标，微调思考图标视觉居中并缩小权限图标；修正图片分析内容的折叠位置，并隐藏展示内容中的签名 URL 参数。权限回答后的延迟滚动不会误操作新会话。
- 稳定输入框随文字增长时的滚动条，统一为与回复区一致的细线；长问题可独立折叠。优化问题跳转、控件间距和深浅主题图标细节。
- 归档、恢复、删除和改名期间显示处理中提示；输入区状态文案去掉多余省略号。面板隐藏时暂停额度刷新和后台状态轮询，重新显示后立即刷新。
- 增加本地启动、扩展宿主和首段输出耗时记录，帮助定位连接等待；记录仅包含阶段与耗时，不包含对话正文或凭据。
- 模型选择器合并当前会话的后端可用模型，并读取桌面快捷方式配置中的模型（如 DeepSeek）；同一供应商的模型集中显示。API Key 只用于本地判断可用性，不会发送给界面。
- 会话内模型切换提示支持长模型名换行，窄窗口下仍能看清切换前后的模型。
- 设置菜单新增新会话默认模型、权限和思考强度；思考强度随模型校验，更换默认模型时会重置为模型默认值。选择自定义 API 模型时按手动切换的路径提交，不因新会话快照暂缺模型条目而误报不可用。

### English

- Reduce repeated reads during startup, login, and session restoration by reusing valid credentials and resume snapshots while continuing to replay interaction events. Refresh invalidated authentication without falling back to expired credentials.
- Fix occasional blank pages after reload and delayed model or reasoning controls. Preserve question navigation across switches and history updates; reconcile an exactly appended question in place to avoid rebuilding the full transcript and preserve reading and fold states.
- Show the work timer and output indicator immediately after sending. Fix timer rollback, uneven first seconds, and inserted messages inheriting the previous segment’s duration. Keep each segment independent across live output and restoration; ignore hidden todo reminders and background notifications, merge the backend turns they create when no visible user insertion separates them, and count each turn’s active duration once. Queued messages do not split a segment early.
- Improve reading while generating: follow new answer, reasoning, and file-change content when at the bottom, preserve manual reading, and keep the viewport stable when thoughts collapse. After a naturally completed long reply, return to its question only if following remained active and the question is offscreen.
- Improve editing and queuing for the latest question: keep actions in its footer and enable editing after backend confirmation. Use a compact icon toolbar, fix cancel, resend, image actions, and queue restoration, and preserve conversation references when editing.
- Search workspace files and conversations in the current workspace together with `@`, listing files first. Conversation references appear as separate chips and persist across drafts, sends, and failed-send recovery.
- Align reasoning, terminal, lookup, and tool icons with permission-mode icons; optically center the thought icon and reduce permission icons slightly. Keep image-analysis narration in the correct fold and hide signed URL parameters in its display. Deferred approval scrolling no longer affects a newly selected conversation.
- Keep the composer scrollbar stable as text grows and match the transcript’s hairline style; long questions can fold independently. Refine question navigation, control spacing, and icon details in light and dark themes.
- Show progress while archiving, restoring, deleting, or renaming sessions, and remove redundant ellipses from composer status labels. Pause quota refresh and background activity polling while the panel is hidden, then refresh when it reappears.
- Add local timing for startup, extension-host stalls, and first output to help diagnose connection delays. Records contain phase names and durations, not conversation text or credentials.
- Merge models available to the active backend session and read shortcut models such as DeepSeek from the desktop configuration. Group models from the same provider together. API keys are checked locally and never sent to the webview.
- Wrap long model names in conversation model-switch notices so both the previous and new model remain readable in narrow views.
- Set the default model, permission mode, and reasoning effort for new chats in Settings. Reasoning effort is checked against the selected model and resets to that model's default when the default model changes. Custom API models use the same backend selection path as manual switches, so a temporarily incomplete new-session catalog does not mark them unavailable.

## 1.4.5 — 2026-10-07

### 中文

- 修复新会话继承上一会话计划或权限状态的问题；切换会话时恢复各自的权限，发送后的状态更新不再意外退出计划模式。
- 计划模式使用独立的灯泡标记，保留原有权限；可从计划卡片打开工作区中的计划文档，批准计划或权限后继续跟随最新输出。
- 编辑最近提问时支持通过添加按钮、粘贴或拖放加入新图片；切换会话或取消编辑后的迟到附件不会加入其他问题。
- `/compact` 压缩过程以时间线显示，区分自动压缩、完成、失败、无需压缩和中断，历史恢复同样可见；不再产生空的工作折叠或多余的复制按钮。
- 改动 Diff 以只读预览文档打开，保留文件名和语法高亮；已写入磁盘的改动直接对比实际文件，关闭预览不再提示保存。
- 顶栏和输入区改为悬浮卡片，消息从卡片下方滚动；历史列表与各选择菜单统一毛玻璃风格，可在设置中关闭，滚动留白和问题跳转随卡片高度适配。
- 滚动条统一为细线样式，对话区、工作折叠和问题导航支持点击与拖动；优化空会话问候、输入框焦点描边和浅色主题输入提示的对比度。
- 设置按界面、问题跳转、额度和输入区分组，可分别隐藏导航按钮、额度展开、用量圆环和连接状态；权限与推理强度支持图标显示或折叠，选择在重启后保留。
- 上下文与 5 小时限额使用双圆环显示，按用量提供警示色；悬浮明细分别展示对应区域的已用、剩余与重置时间。
- 会话尚未连接时禁用发送，等待首段回复时不再显示占位气泡；在历史列表选择当前会话只关闭列表，不再重新加载对话。
- 输入框提示对齐桌面端；目标与计划冲突、运行中修改目标等错误提供本地化指引。
- README 与测试示例使用通用路径，移除个人目录信息。

### English

- Fixed new chats inheriting the previous session's plan or permission state. Switching sessions restores their own permissions, and status updates after sending no longer unexpectedly exit plan mode.
- Plan mode has a separate lightbulb indicator while retaining the base permission. Plan cards can open the workspace plan document, and approving a plan or permission preserves following the latest output.
- Editing the latest question supports new images through the add button, paste, or drop. Late attachments after a session switch or cancelled edit cannot enter another question.
- `/compact` renders as a timeline showing automatic compression, completion, failure, no-op, or interruption, including restored history. It no longer creates empty work folds or unnecessary copy buttons.
- Diff previews open as read-only documents with the original filename and syntax highlighting. Applied changes compare against the actual file on disk, and closing a preview no longer prompts to save.
- The header and composer float above the scrolling conversation. Session lists and selection menus share a frosted-glass style that can be disabled in settings; scroll spacing and question navigation follow the card heights.
- Scrollbars use a consistent hairline style, with click and drag support for the conversation, work folds, and question navigation. Refined the empty-chat greeting, composer focus border, and light-theme placeholder contrast.
- Settings are grouped by interface, question navigation, quota, and composer. Navigation, quota expansion, usage rings, and connection status can be hidden individually; permission and reasoning controls can use icons or be folded. Preferences persist across restarts.
- Context and 5-hour quota usage have separate rings with warning colors. Each hover shows the corresponding used, remaining, and reset details.
- Sending is disabled until the session connects, and replies start with real content rather than a placeholder bubble. Choosing the current session in history closes the list without reloading the conversation.
- Aligned the composer hint with the desktop and localized guidance for goal/plan conflicts and goal changes during a running reply.
- README and test examples use generic paths instead of personal directories.

## 1.4.4 — 2026-10-06

### 中文

- 回复过程中切换模型时，当前回复继续使用原来的模型，下一次提问再换成新模型。
- 选择归档会话时保持当前对话，并提示先取消归档再打开。
- 在归档列表删除会话后，列表停留在归档页，不再跳回活动页。
- 回合结束或被打断后，已收进工作过程的中间回复（如图片分析前后的说明）不再掉到工作折叠下方。
- 回合中插入新消息后，插入后的工作段从插入时刻重新计时；插入前的段落也按自身起止显示时长，不再把整轮时长套在后面的段上。多次插入时，每段只计自身时长。
- 输入 `/` 会弹出斜杠命令菜单，列出会话可用的内置与自定义命令（含图标、参数提示与描述），支持前缀过滤、上下键选择、Tab 或 Enter 补全；命令以普通文本发送，与桌面端一致；输入框重新获得焦点时菜单会按草稿恢复显示。
- 目标（goal）模式状态可视化：输入框上方一条目标状态卡，贴在输入框上沿、画在输入框后面，没有下边框、比输入框窄一圈；显示当前目标、状态、迭代次数与实时用时，支持清除、暂停/继续和展开详情；提交 `/goal` 与目标文字按桌面端的目标命令设置目标，新目标会替换上一条，目标达成后状态实时更新。
- 「第 N 次迭代 · 目标已完成，任务结束」在该次任务结束时就出现，并固定在该位置；之后再发消息或切换会话，这句话都留在原地。
- Plan 模式的方案确认渲染为计划文档卡片：Markdown 计划正文、批准后允许的操作清单与状态徽章（等待批准/已批准/已拒绝），历史恢复同样呈现，与桌面端一致。
- 模型切换在下一次发送消息时显示居中的分隔线：「模型已切换 A(来源) → B(来源)」，连续多次切换合并为一条；分隔线固定在切换所属的提问前，历史重绘按提问文本重新锚定，不随新消息下移。
- 系统注入的提醒记录不再渲染成提问气泡；此前它们排在真实提问后面，导致最后一条提问失去编辑按钮。
- 编辑最近提问时可以增删图片，也可以改文字，与桌面端一致；重发时只带保留的图片。编辑时三个操作按钮尽量排在一行，加号跟在图片后面。
- 在输入框输入 `/命令` 加空格（或从菜单选中命令）时，输入区行首即时渲染命令图标徽章；发送后消息气泡同样以图标加命令名标签呈现，参数保持正文，与桌面端一致。
- 图片预览支持缩放：滚轮以指针为中心缩放，可拖拽平移，双击在适应窗口与原始大小间切换，底部工具条提供缩放、比例与适应窗口；窗口尺寸变化时自动重新适配，缩放按钮不再被全局样式带偏位置。
- 悬浮提示改为跟随主题的圆角卡片（圆角、阴影、渐入），替代浏览器默认的直角文本框；键盘聚焦同样显示。
- 会话列表内弹出的提示（如点已归档会话的「请先取消归档再打开」）不再被列表浮层挡住。
- 修复发送新问题后，上一轮对话和 Git 汇总偶现出现在新问题下方的顺序错乱：迟到的对话记录行现在按协议行号归位，不再追加到末尾。
- 归档会话不再提供重命名，与桌面端一致。
- 模型、推理强度和权限菜单在对应按钮旁边展开。
- 任务进行中不能清除或修改目标，提示先暂停或等这轮结束，不再显示协议报错。计划模式和目标不能同时开启。
- 用 @ 选中 PNG、JPEG、WebP 或 GIF 时，按图片预览加入，和附件里的图片一致。
- 查阅只折叠连续的查看命令：命令里要有 grep、ls、head、tail 或 git status/diff 之一，且没有改文件的词、也没有真正的重定向。`2>/dev/null` 仍可进查阅；脚本里的 `=>` 会留在终端。组内有 grep 算搜索，只有 ls/find 算列表，其余算文件。展开后每一行仍标终端。
- 空会话和输入区更轻：标志和问候缩小，用户消息改为浅色气泡，模型、权限和连接状态改为灰色。
- 切换界面语言时，默认会话标题和输入提示一起切换；自己改过的会话名保持不变。设置里的语言和复制诊断信息并列。
- 同一轮里对同一文件的多次修改合成一份差异，并留在产生它的那一轮，不再记到后面的问题上。

### English

- Switching models during a reply keeps that reply on its current model. The next question uses the newly selected model.
- Choosing an archived session keeps the current conversation and asks to unarchive it before opening.
- Deleting a session from the archived list keeps the list on the archived tab instead of jumping back to the active tab.
- After a turn ends or is interrupted, an intermediate reply already inside the work fold (for example the text around an image analysis) no longer drops below the fold.
- After inserting a message mid-turn, the work segment after the insert restarts its clock from the insert; the earlier segment shows its own span instead of the whole turn duration. Repeated inserts keep each segment to its own span.
- Typing `/` opens a slash-command menu listing the session's builtin and custom commands with icons, input hints, and descriptions, prefix filtering, arrow-key selection, and Tab or Enter completion; commands send as plain text, matching the desktop app The menu also reopens from the draft when the composer regains focus.
- Goal mode is now visible: a status bar above the input sits on the composer, painted behind it with no bottom border and narrower than the input. It shows the current goal, status, iteration count, and a live elapsed time, with clear, pause/resume, and expandable details. Submitting `/goal` plus the goal text uses the desktop goal command, a new goal replaces the previous one, and the status updates live when the goal is reached.
- "Round N · goal reached, task finished" appears the moment that task ends and stays pinned there; later messages and session switches leave it in place.
- Plan mode's proposal now renders as a plan document card: the Markdown plan, the allowed-actions list, and a status badge (awaiting approval / approved / rejected), restored with history, matching the desktop app.
- Model switches now show a centered separator when the next message is sent: "Model switched A(source) → B(source)"; rapid re-picks collapse into one line, and the separator stays pinned before the question it belongs to — redraws re-anchor it by question text so it never drifts with newer messages.
- Harness-injected reminder rows no longer render as question bubbles; previously they trailed the real question and stripped the edit pen from it.
- Editing the last question can add or remove images as well as change the text, matching the desktop app; resending keeps only the remaining images. The three edit actions stay on one line when the column allows, and the add button sits beside the images.
- Typing `/command` plus a space (or picking one from the menu) renders an icon badge at the head of the composer instantly; the sent bubble shows the same icon-and-name chip while parameters stay in the body, matching the desktop app.
- The image preview now zooms: the wheel zooms towards the pointer, dragging pans, double click toggles fit-to-window and original size, and a bottom toolbar offers zoom steps, the ratio, and fit. Resizing the window re-fits automatically, and the zoom buttons keep their intended positions.
- Hover tips are now theme-aware rounded cards with a shadow and fade-in, replacing the browser's plain rectangular tooltips; keyboard focus shows them too.
- Guidance toasts fired inside the session list (for example the unarchive hint when choosing an archived session) are no longer hidden behind the list overlay.
- Fixed an occasional ordering glitch where the previous turn and its Git summary appeared below a newly sent question: late-arriving transcript rows now settle by protocol row id instead of appending to the end.
- Archived sessions no longer offer rename, matching the desktop app.
- The model, reasoning effort, and permission menus open beside their buttons.
- Clearing or changing a goal while a reply is running explains that you should pause or wait, instead of showing a protocol error. Plan mode and a goal cannot be active together.
- Choosing a PNG, JPEG, WebP, or GIF with @ adds it as an image preview, the same way as an attached image.
- Explore folds only consecutive lookup commands: the command must contain grep, ls, head, tail, or git status/diff, and must not contain a mutating command or a real redirect. `2>/dev/null` can still be explore; a script `=>` stays terminal. Inside the group, grep counts as search, ls/find alone as list, and the rest as files. Expanded rows still say terminal.
- Empty chats and the composer are quieter: a smaller mark and greeting, a light user bubble, and gray model, permission, and connection text.
- Changing the interface language also updates the default session title and the composer hint. A renamed session title stays as written. Language and copy-diagnostics sit side by side in settings.
- Repeated edits to the same file in one turn become one diff and stay on the turn that made them, instead of moving onto a later question.

## 1.4.3 — 2026-10-04

### 中文

- 回复过程中点停止会终止当前回合。停止后立刻编辑再发送时，旧回复不再接回来，停止按钮也可以继续使用。
- 生成过程中整页重画时，正在写的回复留在工作块外面，不再进入工作块的滚动区域。
- 长回复里，后到的思考不再把已经放进工作块的中间回复挪到末尾。
- 回合刚结束、对话按记录重画时，工作块保留已经记下的时长，不会退回单独的「已工作」。服务端耗时稍后到达时，切换会话仍显示同一段时间。
- 工作时长在数字和单位之间留空格，例如「已工作 1 分 5 秒」「已工作 12 秒」。

### English

- Stopping during a reply ends that turn. Editing and sending again after a stop no longer restores the old reply, and the stop control stays usable.
- While a reply is still generating, a full redraw keeps the current answer outside the work block.
- Later reasoning in a long reply no longer moves an intermediate answer that is already inside the work block to the bottom.
- When a turn finishes and the transcript is redrawn, the work block keeps the elapsed time already shown instead of falling back to a bare “Worked” label. Switching sessions still shows that duration once the server timing arrives.
- Work durations leave a space between the number and the unit, for example “已工作 1 分 5 秒” and “已工作 12 秒”.

## 1.4.2 — 2026-10-04

### 中文

- 会话切换后的恢复提示改为「会话已恢复」，避免将分段正文、思考和工具记录误计为消息数。
- 启动和删除当前会话与归档使用同一套落点：列表返回后再对账本机归档和删除标记。已归档或已删除的上次会话不再被直接恢复，删除进行中新写入的归档也不会成为落点。
- 长对话中途停止后，工作块一律显示「已工作 xx秒」。此前停在思考段会显示「已停止」，停在中间回复才显示时长。

### English

- Use a simple session-restored notice after switching, avoiding misleading message counts based on text segments, reasoning and tool records.
- Startup and deleting the current session use the same destination rule as archive: reconcile local archive and delete flags after the session list returns. A remembered session that is archived or deleted is not resumed, and a session archived while deletion is in flight is not selected.
- Stopping a long turn always labels its work block with the elapsed time, “Worked …”. A stop during thinking previously showed “Stopped” instead of that duration.

## 1.4.1 — 2026-10-04

### 中文

- 发送、排队或立即插入后清空输入栏中的文件引用，避免后续消息重复附带；提交失败时恢复原引用和草稿。
- 归档当前会话后切到最近的未归档会话，无可用会话时新建；结合持久化归档、删除状态筛选，避免后端列表滞后时跳回已归档会话，删除当前会话也使用相同筛选。

### English

- Clear composer file references after sending, queueing or inserting a message, preventing reuse in later messages. Restore the original references and draft if submission fails.
- After archiving the current session, switch to the most recent unarchived session or create a new chat if none remain. Reconcile persisted archive/delete flags to avoid selecting archived sessions from stale backend lists, including when deleting the current session.

## 1.4.0 — 2026-10-04

### 中文

- 新增图片选择、粘贴、拖放与预览，支持纯图片消息和排队发送；输入栏与已发送图片采用清晰的方形缩略图，图片并列在问题上方。附件草稿按会话保存，上传失败保留输入，窗口重载后可通过缩略图预览未发送图片。
- 新增 `@` 工作区文件搜索，支持模糊匹配、最近打开文件排序和键盘选择；完善多工作区、未保存内容与特殊文件名处理。取消自动附加当前编辑器文件，选中文件后立即加入引用，避免快速发送遗漏上下文。
- 支持行内与独立 LaTeX 公式，使用随包字体离线渲染；错误公式保留原文，长公式不会撑破界面布局。
- 改善图片分析工具展示：调用收进工作过程，默认折叠，区分参数与完整结果，隐藏图片地址的签名查询；任务结束或取消后正确更新状态，正式回复不再被误折叠。
- 改善长任务历史与工作计时，修复加载更多后折叠入口失效、内容被后续同步覆盖及文件变更卡片重复的问题；保留插入消息顺序，避免重复计时或误标已停止，仅在最后展示任务总时长。
- 修复新会话模型初始化失败、思考强度未显示及发送误报会话已切换的问题；模型与推理设置对齐后端配置，普通消息结束后排队消息可继续执行。
- 长思考中的权限请求保持可见，翻看历史时提供待处理入口而不抢输入焦点；已回答、拒绝或中止的问询收为可展开摘要。
- 用量面板保持三等分，百分比紧随标题，上下文计数与限额重置时间靠右；中文上下文统一使用万／萬，英文使用 k，保留上下文小环与悬浮详情。
- 错误提示增加设置、重试、切换模型及社区等操作指引；设置中新增「复制诊断信息」，隐藏个人路径，不包含聊天内容或登录凭据。登录读取对短暂文件占用、替换及网络故障增加有限重试。
- 改善编辑问题的宽度与自动增高，修复编辑、折叠按钮落入问题正文及纯图片问题缺少操作栏的问题；弱化输入提示并修正光标对齐，完善深浅主题适配。

### English

- Add image selection, paste, drag-and-drop and preview, including image-only messages and queued sends. Show clear square thumbnails above the question, save attachments per session, and preserve input after upload failures. Unsent images remain previewable through saved thumbnails after a window reload.
- Add `@` workspace file search with fuzzy matching, recently opened file ranking and keyboard selection. Improve support for multiple workspace folders, unsaved content and special filenames. Replace automatic editor context with explicit references, added immediately to avoid omissions when sending quickly.
- Support inline and display LaTeX formulas with bundled fonts for offline rendering. Preserve invalid formulas as source text and keep long formulas within the layout.
- Improve image-analysis tools: keep calls inside the work fold, collapse details by default, separate arguments from full results and hide signed image URL queries. Settle tool status when a task finishes or is cancelled, and keep final answers outside the fold.
- Improve long-task history and timing. Fix unresponsive fold controls after loading more history, restored content being overwritten and duplicate file-change cards. Preserve inserted-message order, avoid duplicate timers or incorrect stopped labels, and show total task duration at the end.
- Fix new-chat model initialization, missing reasoning controls and incorrect session-switched send errors. Align model and reasoning settings with the backend and allow queued messages to continue after a regular send finishes.
- Keep approval requests visible during long reasoning without stealing input focus, and provide a pending-action shortcut while reading history. Collapse answered, rejected or cancelled questionnaires into expandable summaries.
- Keep three equally sized usage sections, with percentages beside labels and context counts or quota reset times on the right. Use consistent units for context counts and retain the context ring and hover details.
- Provide actionable error guidance for settings, retries, model selection and community support. Add Copy diagnostics in Settings, redacting personal paths and excluding chat content and credentials. Retry transient login-file and network failures within bounded limits.
- Preserve question width when editing and grow the editor with its content. Fix misplaced Edit and Collapse controls and missing actions on image-only questions. Soften placeholder text, correct caret alignment and refine light and dark theme support.

## 1.3.5 — 2026-10-02

### 中文

- 修复 Windows 下工作区盘符或目录大小写不同导致插件与桌面端会话互不可见的问题，兼容旧路径记录，保留改名、置顶、归档和删除状态；Linux 保留区分大小写的路径匹配。
- 新会话空白页采用桌面端的空心 Z 与分时问候，支持深浅主题及三种界面语言。
- 补充平台适配与会话可见性排查说明；macOS 尚未实测，遇到问题可先将 README 交给本机智能体辅助排查。

### English

- Fix Windows session visibility across desktop and extension workspace path spellings, preserving legacy titles, pinned states and archive/delete flags. Keep Linux path matching case-sensitive.
- Add the desktop-style outlined Z and time-based greetings to empty chats, with theme and interface-language support.
- Document platform compatibility and session visibility troubleshooting. macOS has not been tested on a real machine; users can first give the README to a local AI agent for help diagnosing issues.

## 1.3.4 — 2026-10-02

### 中文

- 修复长思考输出时滚动跟随停住的问题，包括中间正文或工具调用之后的新思考块；向上翻看时保留阅读位置，回到底部后恢复跟随。
- 过程展示采用轻量的思考、查阅与终端摘要；连续同类工具调用合并展示，仍可展开查看每次调用的独立详情。生成中的思考保留全文与滚动跟随。
- 改善深浅主题下的文字、语法高亮及状态配色；生成中使用主题强调色，连接正常保留绿色，停止与发送采用统一按钮配色。
- 用量采用更清晰的圆角进度条；上下文小环与用量条在已用 75% 时提示黄色、90% 时提示红色，保留悬浮详情。
- 更新带有 VS Code 标记的扩展 Logo，优化图片体积并改善浅色主题可见性；校准顶部图标、会话标题、输入按钮与问题操作栏的视觉比重。问题编辑、折叠移到复制旁，回到底部与关闭采用图标，滚动条统一细化。

### English

- Fix live scrolling in long reasoning, including reasoning after intermediate text or tool calls. Preserve the reading position when scrolling up and resume following at the bottom.
- Use compact reasoning, exploration and terminal summaries. Group consecutive tools of the same category while retaining expandable details for each call; keep live reasoning text and scroll following.
- Improve text, syntax highlighting and status colors in light and dark themes. Use the theme accent during generation, retain green for healthy connections, and align Stop and Send colors.
- Make usage easier to scan with rounded progress bars. Align context-ring and usage warnings at 75% and 90%, retaining hover details.
- Introduce a VS Code accent in the extension logo, optimize its file size and improve light-theme visibility. Refine header, composer and question action proportions; place Edit and Collapse beside Copy, use icons for scrolling and closing, and slim scrollbars.

## 1.3.3 — 2026-10-02

### 中文

- 收紧输入框的模型、权限与推理强度间距；生成中输入文字时，操作从左到右为立即发送、排队发送、停止，单箭头排队与双箭头立即发送相呼应。

### English

- Tighten model, permission, and reasoning controls. With a draft during generation, order actions as send now, queue, then Stop; use matching double and single arrow icons.

## 1.3.2 — 2026-10-02

### 中文

- 禁止聊天内容自动加载远程图片，避免图片地址携带对话内容发起外部请求。
- 改名、删除、归档及恢复失败给出独立提示，不再将生成中的对话误标为中断；操作迟到结果不会切走当前会话。
- 会话重同步失败采用逐步退避重试，切换会话及恢复快照后清除旧重试；补充同步错误排查说明。
- 按会话保存草稿和手动文件引用，支持切换及窗口重新加载后恢复；发送失败恢复输入并保留较新的草稿。已提交的文字不会在重新加载后再次成为待发送草稿。
- 生成期间始终保留停止入口，可在保留草稿的同时停止当前回复；继续支持排队及立即发送。
- 正式版取消会占用编辑器重做快捷键的默认绑定，可通过命令面板打开对话或自行配置快捷键。
- 统一停止、会话、排队发送等文案，优化新会话提示；README 优先说明市场安装并补齐设置项。

### English

- Block automatic remote images in chat to prevent image URLs from sending conversation content externally.
- Report rename, delete, archive, and restore failures independently of generation, and prevent late operation results from switching the active session.
- Retry failed conversation resynchronization with backoff, cancel obsolete retries on switches and snapshot recovery, and document synchronization errors.
- Save drafts and manual file references per session across switches and window reloads. Recover rejected input while preserving newer typing; submitted text does not reappear as an unsent draft.
- Keep Stop available throughout generation without clearing the draft, alongside queue and send-now actions.
- Remove the release shortcut that conflicts with editor redo. Open chat from the Command Palette or assign a custom shortcut.
- Unify operation labels, improve the new-chat prompt, and update Marketplace installation and settings documentation.

## 1.3.1 — 2026-10-02

### 中文

- 正文的复制与时间仅在整轮回复结束后显示一次，中间正文和思考块不显示回复操作栏。

- 问题跳转、输入框和用量面板采用与输入框边线相接的抽屉式卡片样式，问题跳转由右上沿的小型圆点与箭头入口控制，用量由右下角上下文小环与小箭头展开，保留悬浮详情；发布文档移除个人开发和打包说明。

- 修复中文输入法回车选字时误发送消息并清空草稿的问题；切换会话期间保留输入，历史恢复后再允许发送。
- 修复切换会话后，编辑、撤销文件和队列操作的重试或迟到确认影响新会话的问题。
- 错误卡片的重试绑定当前会话的问题及上下文，不再发送上一会话的输入。
- 从服务器恢复排队消息，正确关联请求 ID 与队列 ID；历史重绘、会话切换、编辑、取消和提升为正式消息时进行对账。插入失败会恢复草稿，不中断正在生成的回复。
- 停止请求确认前显示正在暂停，失败时恢复实际运行状态并提示错误；旧会话的停止确认不影响新会话。

### English

- Show reply copy and timestamp controls once at the end of a completed turn, never on intermediate text or reasoning blocks.

- Present question navigation, the composer, and usage as compact drawer cards attached to the composer with navigation controlled by a small dots-and-chevron button at the top right and usage toggled by the bottom-right context ring and chevron, retaining hover details. Remove personal development and packaging instructions from release documentation.

- Prevent Enter from sending messages or clearing drafts while confirming IME candidates. Preserve drafts and defer sending until session switching completes.
- Keep edit, file rewind, and queue command retries and late acknowledgements scoped to their original session attachment.
- Retry the failed question and context from the current session instead of reusing input from another session.
- Restore pending messages from the server queue and correlate request IDs with queue IDs across history redraws, session switches, edits, cancellation, and promotion. Restore rejected input without interrupting the active reply.
- Show a pending state until a stop request is acknowledged. Restore the authoritative running state and report errors if stopping fails; ignore stop acknowledgements from old sessions.

## 1.3.0 — 2026-10-02

### 中文

- 修复生成中切换会话后，正文和思考块缺失、重复拼接或显示中断的问题；历史与实时输出按服务端对话快照和增量事件对账。
- 修复发送后立即切换会话时的状态同步，正确显示等待模型响应、生成中和已停止。
- 修复旧会话迟到的快照、模型和设置请求覆盖当前会话状态的问题；切走再切回同一会话也会拒绝过期结果。
- 界面语言默认跟随 VS Code，支持简体中文、繁体中文和 English；右上角新增语言设置，可即时切换，聊天内容不受影响。补齐通知、错误提示和繁体文案。
- 输入框下方新增可折叠的一行用量面板，分别展示上下文、5 小时和每周用量的已用比例与进度条；保留上下文小环及悬浮详情，记住展开状态。
- 统一界面配色，连接状态保留绿色、黄色和红色提示；折叠后的思考状态文案与桌面端对齐。
- 修复 SQLite WAL 校验字节序及持久化写入错误处理，收紧凭据配置和数据库临时文件权限；升级 DOMPurify 至 3.4.16。
- 最低 VS Code 版本调整为 1.106.0。

### English

- Fix missing, duplicated, or interrupted answer and reasoning text after switching sessions during generation. Reconcile history and live output using server conversation snapshots and incremental events.
- Keep waiting, generating, and stopped states synchronized when switching immediately after sending a message.
- Discard late snapshots, model responses, and settings acknowledgements from previous session attachments, including switching away and back to the same session.
- Follow the VS Code display language by default, with Simplified Chinese, Traditional Chinese, and English support. Add an instant language override in the top-right menu and localize notifications and errors without translating chat content.
- Add a collapsible, single-row panel for context, five-hour, and weekly usage. Keep the context ring, detailed hover information, and saved expansion state.
- Unify interface colors while retaining green, yellow, and red status indicators. Match collapsed reasoning status text to the desktop app.
- Correct SQLite WAL checksum byte order and persistence error handling, restrict credential configuration and temporary database file permissions, and update DOMPurify to 3.4.16.
- Require VS Code 1.106.0 or newer.

## 1.2.1 — 2026-09-30

### 中文

- 将聊天视图放到 VS Code 右侧边栏。

### English

- Place the chat view in the VS Code secondary side bar.

## 1.2.0 — 2026-09-30

### 中文

- 支持并行会话，改进会话切换时的工具状态显示。

### English

- Support concurrent sessions and preserve tool status across session switches.

## 1.1.0 — 2026-09-30

### 中文

- 增加可折叠的工作历史和消息时间。

### English

- Add folded work history and message timestamps.

## 1.0.0 — 2026-09-29

### 中文

- 使用 VS Code 编辑器运行时启动 app-server，支持回合编辑，提供中英双语说明。

### English

- Use the VS Code runtime for app-server, support turn edits, and provide a bilingual README.
