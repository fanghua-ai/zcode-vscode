import { realpathSync } from "node:fs";
import { DESKTOP_PLUGIN_OVERLAY_ENV, installDesktopPluginOverlay } from "./desktopPluginOverlay";
import { allowedDesktopPlugins } from "./desktopPluginChoices";

if (process.env[DESKTOP_PLUGIN_OVERLAY_ENV] === "1") {
  // The backend persists execArgv into shared plugin manifests. The preload is
  // already loaded; remove only our own argument pair before it sees the list.
  for (let i = process.execArgv.length - 2; i >= 0; i--) {
    if (process.execArgv[i] !== "--require") continue;
    try {
      if (realpathSync(process.execArgv[i + 1]) === realpathSync(__filename)) process.execArgv.splice(i, 2);
    } catch { /* Leave unrelated or missing preload arguments alone. */ }
  }
  let allowed: unknown = [];
  try { allowed = JSON.parse(process.env.ZCODE_VSCODE_ALLOWED_PLUGINS || "[]"); } catch { /* Invalid input keeps the default suppression. */ }
  installDesktopPluginOverlay(allowedDesktopPlugins(allowed));
}
