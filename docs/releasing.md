# 打包与发布

## 准备版本

1. 确认发布范围和工作区状态，完成 [开发验证](development.md)。版本号由维护者确定，不自动推进。
2. 同步 `package.json` 和 `package-lock.json` 根版本。README 用 `zcode-desktop-chat-<版本>.vsix` 表示安装文件，并说明稳定版与预览版通道；不要写死已经过期的文件名。扩展名称为 `zcode-desktop-chat`，发布者为 `fanghua`；贡献者自行发布派生扩展时需使用自己的发布者和扩展标识。
3. 整理 CHANGELOG，使用 `## 版本 — YYYY-MM-DD`、中文和 English 两组条目。只描述用户可感知的变化，保留已发布记录；测试与内部维护过程写入提交或 PR 说明。
4. 在干净检出目录执行 `npm ci`、完整的适用回归和 `npm run package`。打包自动执行类型检查、单元测试、生产构建、CHANGELOG 门禁及文件清单审计，不修改 manifest。打包设置 `ZCODE_RELEASE_CHECK=1`，要求更新日志首段具有匹配的版本和日期；日常验证允许 Unreleased。
5. 检查实际 VSIX 的名称、版本、命令注册、更新日志及 ZIP 文件清单。交付完整文件名和 SHA-256，说明未验证的平台。

## 文件清单

`.vscodeignore` 只允许运行资产和用户文档。`npm run check:package` 使用 VSCE 的实际文件收集接口验证必需文件，并确认安装包不含公式字体；还需检查最终 ZIP，不能只依赖构建成功。

增加运行资产时同时更新白名单与审计脚本。公式布局 CSS、KaTeX 许可证和 `THIRD-PARTY-NOTICES.txt` 必须保留。公式 WOFF2 不进入 VSIX。开发文档、源码、测试、备份、个人配置、凭据及 source map 不得进入 VSIX。

## 公式字体

字体包由 `node scripts/pack-math-fonts.mjs <zip>` 从当前安装的 KaTeX 生成，包含 WOFF2、KaTeX 的 MIT `LICENSE` 和 `OFL.txt`。页面内联这些 WOFF2，因为 VS Code 会把 webview 里的 `.woff2` 标成 `application/unknown`，浏览器不会把它当作字体。当前公开附件是 `math-fonts-0.19.0` 上的 `katex-0.19.0-woff2.zip`，其 SHA-256 必须与 `src/mathFonts.ts` 中的 `MATH_FONTS_SHA256` 一致。公开客户端开始使用某个地址后，不要在原址替换附件：旧版本把哈希写死，替换后会无法下载。字体或许可文件变化时，发布新的修订标签和附件，更新 `MATH_FONTS_URL` 与哈希，并保留旧附件。只发布扩展、不改字体包时不必重复上传。

## 安装与上传

在 VS Code 中选择 “Install from VSIX”，明确选择目标文件。安装可能替换已有的同标识扩展，完成后由使用者重载窗口。

打包成功不等于安装或发布。Marketplace 上传、GitHub 推送和发布标签由维护者确认后执行；脚本不自动上传、不自动安装，也不操作正在运行的桌面窗口。仓库不保存发布令牌。
