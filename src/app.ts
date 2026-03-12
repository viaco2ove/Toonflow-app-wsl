import "./logger";
import "./err";
import "./env";
import express, { Request, Response, NextFunction } from "express";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import buildRoute from "@/core";
import fs from "fs";
import u from "@/utils";
import jwt from "jsonwebtoken";
import { getUploadRootDir } from "@/lib/runtimePaths";

function ensureNoProxyForLocalhost() {
  const localHosts = ["127.0.0.1", "localhost", "::1"];
  const split = (v: string) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const merged = new Set<string>([...split(process.env.NO_PROXY || ""), ...split(process.env.no_proxy || "")]);
  let changed = false;
  for (const host of localHosts) {
    if (!merged.has(host)) {
      merged.add(host);
      changed = true;
    }
  }
  if (changed || !process.env.NO_PROXY || !process.env.no_proxy) {
    const value = Array.from(merged).join(",");
    process.env.NO_PROXY = value;
    process.env.no_proxy = value;
  }
}

ensureNoProxyForLocalhost();

const app = express();
let server: ReturnType<typeof app.listen> | null = null;

export default async function startServe(randomPort: Boolean = false) {
  if (["dev", "local"].includes((process.env.NODE_ENV || "").toLowerCase())) await buildRoute();

  expressWs(app);

  app.use(logger("dev"));
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  const rootDir = getUploadRootDir();

  // 确保 uploads 目录存在
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  console.log("文件目录:", rootDir);

  app.use(express.static(rootDir));

  app.use(async (req, res, next) => {
    const setting = await u.db("t_setting").where("id", 1).select("tokenKey").first();
    if (!setting) return res.status(500).send({ message: "服务器未配置，请联系管理员" });
    const { tokenKey } = setting;
    // 从 header 或 query 参数获取 token
    const rawToken = req.headers.authorization || (req.query.token as string) || "";
    const token = rawToken.replace("Bearer ", "");
    // 白名单路径
    if (req.path === "/other/login") return next();

    if (!token) return res.status(401).send({ message: "未提供token" });
    try {
      const decoded = jwt.verify(token, tokenKey as string);
      (req as any).user = decoded;
      next();
    } catch (err) {
      return res.status(401).send({ message: "无效的token" });
    }
  });

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "Not Found" });
  });

  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err?.message;
    res.locals.error = err;
    console.error(err);

    const status = err?.status || err?.statusCode || 500;
    // Express will serialize native Error objects to `{}`; return a stable JSON payload instead.
    if (err instanceof Error) {
      return res.status(status).send({
        message: err.message || "Internal Server Error",
        name: err.name,
        ...(["dev", "local"].includes((process.env.NODE_ENV || "").toLowerCase()) ? { stack: err.stack } : {}),
      });
    }
    if (typeof err === "string") return res.status(status).send({ message: err });
    return res.status(status).send(err);
  });

  const configuredPort = Number.parseInt((process.env.PORT || "").trim(), 10);
  const port = randomPort ? 0 : Number.isFinite(configuredPort) ? configuredPort : 60000;
  return await new Promise((resolve, reject) => {
    server = app.listen(port, async (v) => {
      const address = server?.address();
      const realPort = typeof address === "string" ? address : address?.port;
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
      resolve(realPort);
    });
  });
}

// 支持await关闭
export function closeServe(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err?: Error) => {
        if (err) return reject(err);
        console.log("[服务已关闭]");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron) startServe();
