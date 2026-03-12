import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

// 默认环境变量（当 env 文件不存在时自动创建）
const defaultEnvValues: Record<string, string> = {
  dev: `NODE_ENV=dev\nPORT=60000\nOSSURL=http://127.0.0.1:60000/\nDB_PATH=\nUPLOAD_DIR=`,
  local: `NODE_ENV=local\nPORT=60000\nOSSURL=http://127.0.0.1:60000/\nDB_PATH=\nUPLOAD_DIR=`,
  prod: `NODE_ENV=prod\nPORT=60000\nOSSURL=http://127.0.0.1:60000/\nDB_PATH=\nUPLOAD_DIR=`,
};

// 判断是否为打包后的 Electron 环境
const isElectron = typeof process.versions?.electron !== "undefined";
let isPackaged = false;
if (isElectron) {
  const { app } = require("electron");
  isPackaged = app.isPackaged;
}

function resolveEnvDir(currentEnv: string): string {
  const projectEnvDir = path.resolve("env");
  if (!isElectron) return projectEnvDir;

  const { app } = require("electron");
  const userDataEnvDir = path.join(app.getPath("userData"), "env");
  if (isPackaged) return userDataEnvDir;

  // 本地开发（含 local）优先使用项目根目录 env，若不存在再回退到 userData/env
  const projectEnvFile = path.join(projectEnvDir, `.env.${currentEnv}`);
  const userDataEnvFile = path.join(userDataEnvDir, `.env.${currentEnv}`);
  if (existsSync(projectEnvFile)) return projectEnvDir;
  if (existsSync(userDataEnvFile)) return userDataEnvDir;
  return projectEnvDir;
}

//加载环境变量（打包环境默认使用 prod）
const env = process.env.NODE_ENV ?? (isPackaged ? "prod" : "dev");
if (!env) {
  console.log("[env] empty NODE_ENV");
  process.exit(1);
} else {
  const envDir = resolveEnvDir(env);
  const envFilePath = path.join(envDir, `.env.${env}`);

  // 自动创建 env 目录和文件（.gitignore 可能忽略了这些文件）
  if (!existsSync(envDir)) {
    mkdirSync(envDir, { recursive: true });
  }
  if (!existsSync(envFilePath)) {
    const content = defaultEnvValues[env] ?? defaultEnvValues.prod;
    writeFileSync(envFilePath, content, "utf8");
    console.log(`[env] created ${envFilePath}`);
  }

  let text = readFileSync(envFilePath, "utf8");

  // 历史配置文件补齐新字段（保持向后兼容）
  const requiredKeys: Array<{ key: string; value: string }> = [
    { key: "PORT", value: "60000" },
    { key: "OSSURL", value: "http://127.0.0.1:60000/" },
    { key: "DB_PATH", value: "" },
    { key: "UPLOAD_DIR", value: "" },
  ];
  const missing = requiredKeys.filter((item) => !new RegExp(`^\\s*${item.key}=`, "m").test(text));
  if (missing.length > 0) {
    const suffix = missing.map((item) => `${item.key}=${item.value}`).join("\n");
    text = `${text.trimEnd()}\n${suffix}\n`;
    writeFileSync(envFilePath, text, "utf8");
  }

  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      const current = process.env[key];
      // 允许命令行/脚本提前注入的环境变量覆盖 env 文件配置
      if (typeof current === "undefined" || current === "") {
        process.env[key] = value;
      }
    }
  }
  console.log(`[env] ${env}`);
  console.log(`[env] file ${envFilePath}`);
}
