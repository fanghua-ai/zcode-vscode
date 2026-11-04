import assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import {
  DESKTOP_ONLY_PLUGIN_IDS,
  isRuntimeConfigPath,
  overlayConfigText,
  restoreConfigText,
} from "./desktopPluginOverlay";

const documents = "documents@zcode-plugins-official";
const fitools = "fitools@fi-workspace-local";
const legacy = "zcode-cua@zcode-plugins-official";
const canonical = "computer-use@zcode-plugins-official";

/** Official migration deletes the legacy id and skips copying it when the overlay already defined the canonical id. */
function migrateLegacyId(original: string): string {
  const viewed = JSON.parse(overlayConfigText(original)) as {
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  delete viewed.plugins.enabledPlugins[legacy];
  return JSON.stringify(viewed, null, 2) + "\n";
}

test("runtime config paths are the shared user and project files", () => {
  assert.equal(isRuntimeConfigPath("/home/person/.zcode/cli/config.json"), true);
  assert.equal(isRuntimeConfigPath("/work/.zcode/config.json"), true);
  assert.equal(isRuntimeConfigPath("/work/zcode.json"), true);
  assert.equal(isRuntimeConfigPath("/home/person/.zcode/v2/provider_config.json"), false);
  assert.equal(isRuntimeConfigPath("/home/person/.zcode/v2/config.json"), false);
  assert.equal(isRuntimeConfigPath("/home/person/.zcode/cli/plugins/cache/config.json"), false);
  assert.equal(isRuntimeConfigPath(3), false);
});

test("overlay forces desktop viewer plugins off and leaves other plugins", () => {
  const text = JSON.stringify({
    model: "glm",
    plugins: { enabledPlugins: { [fitools]: true, [documents]: true } },
  });
  const parsed = JSON.parse(overlayConfigText(text)) as {
    plugins: { enabledPlugins: Record<string, boolean>; suppressedBuiltins?: unknown };
  };
  for (const id of DESKTOP_ONLY_PLUGIN_IDS) assert.equal(parsed.plugins.enabledPlugins[id], false);
  assert.equal(parsed.plugins.enabledPlugins[fitools], true);
  assert.equal(parsed.plugins.suppressedBuiltins, undefined);
  assert.equal(overlayConfigText("not json"), "not json");
});

test("a shared-file write keeps the on-disk enablement", () => {
  const original = `{
  "plugins": {
    "enabledPlugins": {
      "${fitools}": true,
      "${documents}": true
    }
  }
}
`;
  const viewed = JSON.parse(overlayConfigText(original)) as {
    ui?: { locale: string };
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  viewed.ui = { locale: "zh-CN" };
  const written = restoreConfigText(original, JSON.stringify(viewed, null, 2) + "\n");
  const parsed = JSON.parse(written) as {
    ui: { locale: string };
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  assert.equal(parsed.ui.locale, "zh-CN");
  assert.equal(parsed.plugins.enabledPlugins[documents], true);
  assert.equal(parsed.plugins.enabledPlugins["browser-use@zcode-plugins-official"], undefined);
  assert.equal(parsed.plugins.enabledPlugins[fitools], true);

  const unchanged = JSON.parse(overlayConfigText(original)) as { plugins: { enabledPlugins: Record<string, boolean> } };
  assert.equal(restoreConfigText(original, JSON.stringify(unchanged)), original);
});

test("a legacy computer-use id survives a migration that drops the key", () => {
  for (const saved of [true, false]) {
    const original = `{
  "plugins": {
    "enabledPlugins": {
      "${legacy}": ${saved},
      "${fitools}": true
    }
  }
}
`;
    const written = restoreConfigText(original, migrateLegacyId(original));
    assert.equal(written, original);
  }

  const both = `{
  "plugins": {
    "enabledPlugins": {
      "${legacy}": true,
      "${canonical}": true,
      "${fitools}": true
    }
  }
}
`;
  const parsed = JSON.parse(restoreConfigText(both, migrateLegacyId(both))) as {
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  assert.equal(parsed.plugins.enabledPlugins[legacy], true);
  assert.equal(parsed.plugins.enabledPlugins[canonical], true);
  assert.equal(parsed.plugins.enabledPlugins[fitools], true);
});

test("omitted plugin keys are restored from disk", () => {
  const original = `{
  "plugins": {
    "enabledPlugins": {
      "${legacy}": false,
      "${fitools}": true
    }
  }
}
`;
  const omittedMap = JSON.stringify({ model: "glm", plugins: { options: { keep: 1 } } }, null, 2) + "\n";
  const parsed = JSON.parse(restoreConfigText(original, omittedMap)) as {
    model: string;
    plugins: { options: { keep: number }; enabledPlugins: Record<string, boolean> };
  };
  assert.equal(parsed.model, "glm");
  assert.equal(parsed.plugins.options.keep, 1);
  assert.equal(parsed.plugins.enabledPlugins[legacy], false);
  assert.equal(parsed.plugins.enabledPlugins[canonical], undefined);
  assert.equal(Object.hasOwn(parsed.plugins.enabledPlugins, fitools), false);

  const omittedPlugins = JSON.parse(restoreConfigText(original, '{"model":"glm"}\n')) as {
    model: string;
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  assert.equal(omittedPlugins.model, "glm");
  assert.equal(omittedPlugins.plugins.enabledPlugins[legacy], false);
  assert.equal(Object.hasOwn(omittedPlugins.plugins.enabledPlugins, fitools), false);
});

test("the preload hides plugins from this process and does not persist them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-overlay-"));
  const outfile = path.join(root, "preload.cjs");
  const userConfig = path.join(root, ".zcode", "cli", "config.json");
  const projectConfig = path.join(root, "repo", ".zcode", "config.json");
  const providerConfig = path.join(root, ".zcode", "v2", "provider_config.json");
  const originalUser = `{
  "model": "glm",
  "plugins": {
    "enabledPlugins": {
      "${fitools}": true
    }
  }
}
`;
  const originalProject = `{
  "plugins": {
    "enabledPlugins": {
      "${documents}": true,
      "${fitools}": true
    }
  }
}
`;
  const legacyConfig = path.join(root, "legacy", ".zcode", "cli", "config.json");
  const omittedConfig = path.join(root, "repo", "zcode.json");
  const originalLegacy = `{
  "plugins": {
    "enabledPlugins": {
      "${legacy}": true,
      "${fitools}": true
    }
  }
}
`;
  const originalOmitted = `{
  "plugins": {
    "enabledPlugins": {
      "${legacy}": false,
      "${fitools}": true
    }
  }
}
`;
  const originalProvider = '{"provider":"keep"}\n';
  fs.mkdirSync(path.dirname(userConfig), { recursive: true });
  fs.mkdirSync(path.dirname(projectConfig), { recursive: true });
  fs.mkdirSync(path.dirname(providerConfig), { recursive: true });
  fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
  fs.writeFileSync(userConfig, originalUser);
  fs.writeFileSync(projectConfig, originalProject);
  fs.writeFileSync(providerConfig, originalProvider);
  fs.writeFileSync(legacyConfig, originalLegacy);
  fs.writeFileSync(omittedConfig, originalOmitted);
  const legacyMtime = fs.statSync(legacyConfig).mtimeMs;

  const built = spawnSync(process.execPath, ["-e", `
    require("esbuild").buildSync({
      entryPoints: [process.env.ENTRY],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: process.env.OUTFILE,
      logLevel: "silent",
    });
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      ENTRY: path.join(process.cwd(), "src", "desktopPluginOverlayPreload.ts"),
      OUTFILE: outfile,
    },
  });
  assert.equal(built.status, 0, built.stderr);

  const child = spawnSync(process.execPath, ["--require", outfile, "-e", `
    const fs = require("fs");
    const path = require("path");
    const user = process.env.USER_CONFIG;
    const project = process.env.PROJECT_CONFIG;
    const provider = process.env.PROVIDER_CONFIG;
    const legacy = process.env.LEGACY_CONFIG;
    const omitted = process.env.OMITTED_CONFIG;
    const userView = JSON.parse(fs.readFileSync(user, "utf8"));
    const projectView = JSON.parse(fs.promises ? fs.readFileSync(project, "utf8") : "");
    const providerText = fs.readFileSync(provider, "utf8");
    const next = JSON.parse(fs.readFileSync(user, "utf8"));
    next.ui = { locale: "zh-CN" };
    const temp = path.join(path.dirname(user), ".config.json." + process.pid + ".tmp");
    fs.promises.writeFile(temp, JSON.stringify(next, null, 2) + "\\n", { mode: 0o600 })
      .then(() => fs.promises.rename(temp, user))
      .then(() => new Promise((resolve, reject) => {
        fs.readFile(project, "utf8", (err, text) => err ? reject(err) : resolve(text));
      }))
      .then((text) => {
        const rewritten = JSON.parse(text);
        const projectTemp = project + ".tmp";
        fs.writeFileSync(projectTemp, JSON.stringify(rewritten, null, 2) + "\\n");
        fs.renameSync(projectTemp, project);
        const migrated = JSON.parse(fs.readFileSync(legacy, "utf8"));
        delete migrated.plugins.enabledPlugins["zcode-cua@zcode-plugins-official"];
        const legacyTemp = legacy + ".migrate.tmp";
        fs.writeFileSync(legacyTemp, JSON.stringify(migrated, null, 2) + "\\n");
        fs.renameSync(legacyTemp, legacy);
        fs.writeFileSync(omitted, JSON.stringify({ model: "glm", plugins: { options: { keep: 1 } } }));
        process.stdout.write(JSON.stringify({
          userView, projectView, providerText,
          legacyTempRemains: fs.existsSync(legacyTemp),
        }));
      })
      .catch((error) => {
        process.stderr.write(String(error && error.stack || error));
        process.exit(1);
      });
  `], {
    encoding: "utf8",
    env: {
      ...process.env,
      ZCODE_VSCODE_DESKTOP_PLUGIN_OVERLAY: "1",
      USER_CONFIG: userConfig,
      PROJECT_CONFIG: projectConfig,
      PROVIDER_CONFIG: providerConfig,
      LEGACY_CONFIG: legacyConfig,
      OMITTED_CONFIG: omittedConfig,
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const viewed = JSON.parse(child.stdout) as {
    userView: { plugins: { enabledPlugins: Record<string, boolean> } };
    projectView: { plugins: { enabledPlugins: Record<string, boolean> } };
    providerText: string;
    legacyTempRemains: boolean;
  };
  assert.equal(viewed.userView.plugins.enabledPlugins[documents], false);
  assert.equal(viewed.userView.plugins.enabledPlugins["browser-use@zcode-plugins-official"], false);
  assert.equal(viewed.userView.plugins.enabledPlugins[fitools], true);
  assert.equal(viewed.projectView.plugins.enabledPlugins[documents], false);
  assert.equal(viewed.projectView.plugins.enabledPlugins[fitools], true);
  assert.equal(viewed.providerText, originalProvider);

  const savedUser = JSON.parse(fs.readFileSync(userConfig, "utf8")) as {
    model: string;
    ui: { locale: string };
    plugins: { enabledPlugins: Record<string, boolean> };
  };
  assert.equal(savedUser.model, "glm");
  assert.equal(savedUser.ui.locale, "zh-CN");
  assert.equal(savedUser.plugins.enabledPlugins[fitools], true);
  assert.equal(Object.hasOwn(savedUser.plugins.enabledPlugins, documents), false);
  assert.equal(fs.readFileSync(projectConfig, "utf8"), originalProject);
  assert.equal(fs.readFileSync(providerConfig, "utf8"), originalProvider);
  assert.equal(viewed.legacyTempRemains, false);
  assert.equal(fs.readFileSync(legacyConfig, "utf8"), originalLegacy);
  assert.equal(fs.statSync(legacyConfig).mtimeMs, legacyMtime);
  const omittedSaved = JSON.parse(fs.readFileSync(omittedConfig, "utf8")) as {
    model: string;
    plugins: { options: { keep: number }; enabledPlugins: Record<string, boolean> };
  };
  assert.equal(omittedSaved.model, "glm");
  assert.equal(omittedSaved.plugins.options.keep, 1);
  assert.equal(omittedSaved.plugins.enabledPlugins[legacy], false);
  assert.equal(Object.hasOwn(omittedSaved.plugins.enabledPlugins, canonical), false);
  assert.equal(Object.hasOwn(omittedSaved.plugins.enabledPlugins, fitools), false);
  fs.rmSync(root, { recursive: true, force: true });
});
