import assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import test from "node:test";
import {
  appServerEntry,
  appServerLaunch,
  candidatesFromExecutable,
  installRootFromUninstallFields,
  locateAppServer,
  parseDesktopExec,
  rootsFromUninstallRegistry,
  startupExitMessage,
} from "./serverPath";

test("explicit binaryPath wins and a missing file is not auto-detected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-path-"));
  const configured = path.join(root, "custom", "zcode.cjs");
  const fallback = path.join(root, "default", "zcode.cjs");
  fs.mkdirSync(path.dirname(fallback), { recursive: true });
  fs.writeFileSync(fallback, "");
  let discovered = false;
  await assert.rejects(
    () =>
      locateAppServer(configured, {
        exists: (file) => file === fallback,
        platform: "linux",
        installRoots: async () => {
          discovered = true;
          return [];
        },
      }),
    (error: Error) => {
      assert.match(error.message, /zcode\.binaryPath/);
      assert.match(error.message, /不存在/);
      assert.ok(error.message.includes(path.resolve(configured)));
      return true;
    }
  );
  assert.equal(discovered, false);
});

test("an existing explicit binaryPath is used as-is", async () => {
  const file = path.join(os.tmpdir(), "marked-zcode.cjs");
  const found = await locateAppServer(file, {
    exists: (candidate) => candidate === path.resolve(file),
    platform: "win32",
    installRoots: async () => {
      throw new Error("registry should not be read");
    },
  });
  assert.equal(found, path.resolve(file));
});

test("a remembered path is reused before registry or desktop search", async () => {
  let discovered = false;
  const remembered = path.join(os.tmpdir(), "remembered-zcode.cjs");
  const found = await locateAppServer("", {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\user_\\AppData\\Local" },
    preferred: remembered,
    exists: (file) => file === path.resolve(remembered),
    installRoots: async () => {
      discovered = true;
      return ["D:\\Apps\\ZCode"];
    },
  });
  assert.equal(found, path.resolve(remembered));
  assert.equal(discovered, false);
});

test("Windows InstallLocation is used when the default path is missing", async () => {
  const entry = appServerEntry("D:\\Apps\\ZCode", "win32");
  const found = await locateAppServer("", {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\user_\\AppData\\Local" },
    exists: (file) => file === entry,
    installRoots: async () => ["D:\\Apps\\ZCode"],
  });
  assert.equal(found, entry);
});

test("DisplayIcon locates ZCode when InstallLocation is empty", () => {
  const text = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCode
    DisplayName    REG_SZ    ZCode
    InstallLocation    REG_SZ
    DisplayIcon    REG_SZ    D:\\Apps\\ZCode\\uninstallerIcon.ico
`;
  assert.deepEqual(rootsFromUninstallRegistry(text), ["D:\\Apps\\ZCode"]);
  assert.equal(
    installRootFromUninstallFields({
      installLocation: "",
      displayIcon: "D:\\Apps\\ZCode\\uninstallerIcon.ico",
    }),
    "D:\\Apps\\ZCode"
  );
});

test("InstallLocation is preferred over DisplayIcon", () => {
  assert.equal(
    installRootFromUninstallFields({
      installLocation: "E:\\ZCode\\",
      displayIcon: "D:\\Other\\uninstallerIcon.ico",
    }),
    "E:\\ZCode"
  );
});

test("Linux desktop Exec finds a non-default install", async () => {
  const entry = "/home/dev/apps/ZCode/resources/glm/zcode.cjs";
  const found = await locateAppServer("", {
    platform: "linux",
    homedir: "/home/dev",
    env: { XDG_DATA_HOME: "/home/dev/.local/share", XDG_DATA_DIRS: "/usr/share" },
    exists: (file) => file === entry,
    listDir: (dir) =>
      dir === "/home/dev/.local/share/applications" ? ["zcode.desktop"] : [],
    readFile: (file) =>
      file.endsWith("zcode.desktop")
        ? "[Desktop Entry]\nExec=/home/dev/apps/ZCode/zcode %U\n"
        : null,
  });
  assert.equal(found, entry);
  assert.equal(
    parseDesktopExec("[Desktop Entry]\nExec=/opt/ZCode/zcode %U\n"),
    "/opt/ZCode/zcode"
  );
  assert.deepEqual(candidatesFromExecutable("/opt/ZCode/zcode", "linux"), [
    "/opt/ZCode/resources/glm/zcode.cjs",
  ]);
});

test("macOS Spotlight app path finds the bundled server", async () => {
  const entry =
    "/Users/dev/Apps/ZCode.app/Contents/Resources/glm/zcode.cjs";
  const found = await locateAppServer("", {
    platform: "darwin",
    homedir: "/Users/dev",
    exists: (file) => file === entry,
    run: async (command, args) => {
      assert.equal(command, "mdfind");
      assert.match(args[0], /ZCode\.app/);
      return "/Users/dev/Apps/ZCode.app\n";
    },
  });
  assert.equal(found, entry);
});

test("missing everywhere tells the user to set zcode.binaryPath", async () => {
  await assert.rejects(
    () =>
      locateAppServer("", {
        platform: "linux",
        homedir: "/home/dev",
        env: { XDG_DATA_HOME: "/home/dev/.local/share", XDG_DATA_DIRS: "/usr/share" },
        exists: () => false,
        listDir: () => [],
      }),
    (error: Error) => {
      assert.match(error.message, /zcode\.binaryPath/);
      assert.match(error.message, /已检查/);
      return true;
    }
  );
});

test("startup failure names a missing app-server file instead of an RPC timeout", () => {
  const message = startupExitMessage({
    stderr: "Error: Cannot find module 'C:\\\\Users\\\\user_\\\\AppData\\\\Local\\\\Programs\\\\ZCode\\\\resources\\\\glm\\\\zcode.cjs'",
    code: 1,
    binaryPath: "C:\\Users\\user_\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs",
  });
  assert.match(message, /安装路径无效/);
  assert.match(message, /zcode\.cjs/);
  assert.doesNotMatch(message, /timed out/);
});

test("a script app-server uses the editor runtime when nodePath is empty", () => {
  const launch = appServerLaunch({
    binaryPath: "/opt/ZCode/resources/glm/zcode.cjs",
    execPath: "/usr/share/code/code",
  });
  assert.deepEqual(launch, {
    command: "/usr/share/code/code",
    args: ["/opt/ZCode/resources/glm/zcode.cjs", "app-server"],
    electronAsNode: true,
  });
});

test("an explicit nodePath overrides the editor runtime", () => {
  const launch = appServerLaunch({
    binaryPath: "/opt/ZCode/resources/glm/zcode.cjs",
    nodePath: "  /usr/local/bin/node  ",
    execPath: "/usr/share/code/code",
  });
  assert.equal(launch.command, "/usr/local/bin/node");
  assert.deepEqual(launch.args, ["/opt/ZCode/resources/glm/zcode.cjs", "app-server"]);
  assert.equal(launch.electronAsNode, false);
});

test("a native app-server binary is launched directly", () => {
  const launch = appServerLaunch({
    binaryPath: "/opt/ZCode/zcode",
    nodePath: "/usr/bin/node",
    execPath: "/usr/share/code/code",
  });
  assert.deepEqual(launch, {
    command: "/opt/ZCode/zcode",
    args: ["app-server"],
    electronAsNode: false,
  });
});

test("spawn ENOENT is reported before any RPC", () => {
  const message = startupExitMessage({ spawnCode: "ENOENT", command: "node" });
  assert.match(message, /找不到命令 node/);
  assert.match(message, /zcode\.nodePath/);
});

test("non-default Windows and macOS installs preserve Chinese names and spaces", async () => {
  for (const [platform, root] of [
    ["win32", "D:\\应用 程序\\ZCode"],
    ["darwin", "/Users/person/Applications/应用 程序/ZCode.app"],
    ["linux", "/home/person/应用 程序/ZCode"],
  ] as const) {
    const entry = appServerEntry(root, platform);
    assert.ok(entry.includes("应用 程序"));
    assert.equal(await locateAppServer("", {
      platform, exists: candidate => candidate === entry,
      installRoots: async () => [root], env: {}, homedir: "/unused",
      run: async () => root,
      listDir: () => ["zcode.desktop"],
      readFile: () => `[Desktop Entry]\nExec="${root}/zcode"\n`,
    }), entry);
  }
});
