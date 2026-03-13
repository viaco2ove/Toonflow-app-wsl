import { app, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import startServe, { closeServe } from "src/app";

// 默认端口配置
const envPort = Number.parseInt((process.env.PORT || "").trim(), 10);
const defaultPort = Number.isFinite(envPort) ? envPort : 60000;
let mainWindow: BrowserWindow | null = null;

function isWslLinux(): boolean {
  if (process.platform !== "linux") return false;
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP || process.env.WSLENV);
}

// WSL 下启用兼容模式，规避 Chromium/GTK 在 Wayland/GPU 下的崩溃（SIGTRAP）
if (isWslLinux()) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? "1000"}`;
  const safeTmpDir = path.join(runtimeDir, "electron-tmp");
  try {
    fs.mkdirSync(safeTmpDir, { recursive: true });
    process.env.TMPDIR = safeTmpDir;
    process.env.TMP = safeTmpDir;
    process.env.TEMP = safeTmpDir;
    app.setPath("temp", safeTmpDir);
  } catch (err: any) {
    console.warn("[WSL兼容模式] 设置临时目录失败:", err?.message || String(err));
  }

  process.env.GDK_BACKEND = "x11";
  process.env.XDG_SESSION_TYPE = "x11";
  process.env.OZONE_PLATFORM = "x11";
  process.env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  process.env.GTK_USE_PORTAL = "0";

  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("use-gl", "swiftshader");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("ozone-platform", "x11");
  app.commandLine.appendSwitch(
    "disable-features",
    "UseOzonePlatform,WaylandWindowDecorations,WaylandPerSurfaceScale,VizDisplayCompositor,WaylandLinuxDrmSyncobj",
  );
  app.commandLine.appendSwitch("disable-dev-shm-usage");
  console.log(`[WSL兼容模式] 已启用 x11 + 软件渲染，TMPDIR=${process.env.TMPDIR}`);

  let trapCount = 0;
  process.on("SIGTRAP", () => {
    trapCount += 1;
    console.error(`[WSL兼容模式] 捕获 SIGTRAP(${trapCount})，已拦截以避免主进程退出`);
  });
}

function createMainWindow(port: number): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    show: true,
    autoHideMenuBar: true,
  });
  // 开发环境和生产环境使用不同的路径
  const isDev = process.env.NODE_ENV === "dev" || !app.isPackaged;
  const htmlPath = isDev
    ? path.join(process.cwd(), "scripts", "web", "index.html")
    : path.join(app.getAppPath(), "scripts", "web", "index.html");
  
  // 使用实际端口构建地址
  const baseUrl = `http://localhost:${port}`;
  const wsBaseUrl = `ws://localhost:${port}`;
  
  // 构建带有 query 参数的 URL
  const url = new URL(`file://${htmlPath}`);
  url.searchParams.set("baseUrl", baseUrl);
  url.searchParams.set("wsBaseUrl", wsBaseUrl);
  
  console.log("[MainWindow] URL:", url.toString());

  void mainWindow.loadURL(url.toString());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
app.whenReady().then(async () => {
  try {
    console.log("[video debug flags]", {
      AI_VIDEO_DEBUG: (process.env.AI_VIDEO_DEBUG || "").trim() || "0",
      AI_VIDEO_DEBUG_VERBOSE: (process.env.AI_VIDEO_DEBUG_VERBOSE || "").trim() || "0",
      AI_VIDEO_DEBUG_GET_VIDEO: (process.env.AI_VIDEO_DEBUG_GET_VIDEO || "").trim() || "0",
      AI_VIDEO_POLL_MAX_ATTEMPTS: (process.env.AI_VIDEO_POLL_MAX_ATTEMPTS || "").trim() || "(default)",
      AI_VIDEO_POLL_INTERVAL_MS: (process.env.AI_VIDEO_POLL_INTERVAL_MS || "").trim() || "(default)",
    });
    const port = await startServe(false);
    createMainWindow(Number(port));
  } catch (err) {
    console.error("[服务启动失败]:", err);
    // 如果服务启动失败，使用默认端口创建窗口
    createMainWindow(defaultPort);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // 重新激活时使用默认端口
    createMainWindow(defaultPort);
  }
});

app.on("before-quit", async (event) => {
  await closeServe();
});
