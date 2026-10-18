/** Recovery instructions are extension-owned; the original diagnostic stays separate. */
export const COMMUNITY_URL = "https://marketplace.visualstudio.com/items?itemName=fanghua.zcode-desktop-chat#qna";
export type RecoveryAction = "pickModel" | "retry" | "binaryPath" | "nodePath";
export interface ErrorGuidance { category: string; title: string; hint: string; action: RecoveryAction; label: string }
export function errorGuidance(message: string): ErrorGuidance {
  if (/zcode\.nodePath|Node\.js.*(?:not found|无法|不存在)|node runtime|spawn.*node.*ENOENT|运行时.*(?:不存在|无法启动)/i.test(message)) return {
    category:"runtime", title:"无法启动 ZCode 运行时", action:"nodePath", label:"设置运行时路径",
    hint:"请先更新 VS Code 并重新连接。若使用自定义 Node.js，在设置 zcode.nodePath 中填写 Node 可执行文件的完整路径。",
  };
  if (/zcode\.binaryPath|Cannot find module|找不到.*app-server|app-server.*(?:not found|invalid.*path)|找不到.*ZCode|ZCode.*安装路径/i.test(message)) return {
    category:"installation", title:"没有找到 ZCode 安装文件", action:"binaryPath", label:"设置 ZCode 路径",
    hint:"请确认已安装 ZCode。自定义安装位置请在设置 zcode.binaryPath 中填写 resources/glm/zcode.cjs 的完整路径，而不是安装文件夹；保存后重新连接。",
  };
  if (/1113|余额不足|无可用资源包|insufficient.*(?:balance|quota)|quota|rate.?limit|\b429\b|额度.*(?:不足|用尽)/i.test(message)) return {
    category:"quota", title:"当前额度暂时无法使用", action:"retry", label:"重新读取登录",
    hint:"请在桌面端检查剩余额度和重置时间。可以稍后重试，或切换到仍有额度的项目后重新读取登录。",
  };
  if (/401|403|unauthorized|oauth|login|credentials|api.?key|登录|凭据|鉴权|Could not reuse/i.test(message)) return {
    category:"login", title:"需要重新确认 ZCode 登录", action:"retry", label:"重新读取登录",
    hint:"请打开 ZCode 桌面端，确认已登录且当前项目有可用模型，再点击重新读取登录后重试。",
  };
  if (/-32031|no.*(?:available |usable )?model|没有.*模型|模型.*(?:不可用|未就绪)|无可用模型|model.*(?:unavailable|not.?found|not.*available|no longer.*available)|provider\.notInRegistry|config\.invalid/i.test(message)) return {
    category:"model", title:"模型尚未准备好", action:"pickModel", label:"切换模型",
    hint:"请先重新选择一次模型后重试。若仍没有可用模型，请在桌面端确认模型能正常对话，再重新读取登录。",
  };
  if (/schema|unsupported|not supported|Method not found|版本.*不支持|会话同步失败|无法安全写入 WAL/i.test(message)) return {
    category:"compatibility", title:"当前版本可能不支持这项操作", action:"retry", label:"重新连接",
    hint:"请确认扩展与 ZCode 桌面端版本兼容，更新后重新连接。仍有问题时可携带诊断信息到社区提问。",
  };
  if (/ETIMEDOUT|ECONN|ENOTFOUND|fetch failed|network|timed? ?out|timeout|网络|超时|process exited|进程已退出|app-server.*退出/i.test(message)) return {
    category:"network", title:"暂时无法连接到 ZCode 或模型服务", action:"retry", label:"重新连接",
    hint:"请检查网络、代理和桌面端是否能正常对话，再重新连接后重试。",
  };
  if (/EACCES|EPERM|permission denied|access denied|拒绝访问|权限不足/i.test(message)) return {
    category:"access", title:"当前文件或目录无法访问", action:"retry", label:"重新连接",
    hint:"请检查工作区、ZCode 安装目录和用户数据目录的读写权限，以及是否被安全软件拦截，处理后重试。",
  };
  return {
    category:"general", title:"这次操作未能完成", action:"pickModel", label:"切换模型",
    hint:"请先重试。若是发送或模型初始化失败，可重新选择一次模型；仍失败时重新读取登录。问题持续时，可复制诊断信息到社区提问。",
  };
}
