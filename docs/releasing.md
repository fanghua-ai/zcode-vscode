# 打包与发布

## 准备版本

1. 确认发布范围和工作区状态，完成 [开发验证](development.md)。版本号由维护者确定，不自动推进。
2. 同步 `package.json`、`package-lock.json` 根版本和 README 的安装示例。扩展名称为 `zcode-desktop-chat`，发布者为 `fanghua`；贡献者自行发布派生扩展时需使用自己的发布者和扩展标识。
3. 整理 CHANGELOG，使用 `## 版本 — YYYY-MM-DD`、中文和 English 两组条目。只描述用户可感知的变化，保留已发布记录；测试与内部维护过程写入提交或 PR 说明。
4. 在干净检出目录执行 `npm ci`、完整的适用回归和 `npm run package`。打包自动执行类型检查、单元测试、生产构建、CHANGELOG 门禁及文件清单审计，不修改 manifest。打包设置 `ZCODE_RELEASE_CHECK=1`，要求更新日志首段具有匹配的版本和日期；日常验证允许 Unreleased。
5. 检查实际 VSIX 的名称、版本、命令注册、更新日志及 ZIP 文件清单。交付完整文件名和 SHA-256，说明未验证的平台。

## 文件清单

`.vscodeignore` 只允许运行资产和用户文档。`npm run check:package` 使用 VSCE 的实际文件收集接口验证必需文件和离线字体引用；还需检查最终 ZIP，不能只依赖构建成功。

增加运行资产时同时更新白名单与审计脚本。公式 CSS、WOFF2、SQLite WASM、许可证和 `THIRD-PARTY-NOTICES.txt` 必须保留。开发文档、源码、测试、备份、个人配置、凭据及 source map 不得进入 VSIX。

## 安装与上传

在 VS Code 中选择 “Install from VSIX”，明确选择目标文件。安装可能替换已有的同标识扩展，完成后由使用者重载窗口。

打包成功不等于安装或发布。Marketplace 上传、GitHub 推送和发布标签由维护者确认后执行；脚本不自动上传、不自动安装，也不操作正在运行的桌面窗口。仓库不保存发布令牌。
