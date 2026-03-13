import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { createVideoTask, isVideoTaskActive, VideoGenerateMode } from "./generateVideo";

const router = express.Router();

function parseJson<T = any>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return null;
  }
}

export default router.post(
  "/",
  validateFields({
    configId: z.number(),
    force: z.boolean().optional(),
  }),
  async (req, res) => {
    const { configId, force = false } = req.body;

    const config = await u.db("t_videoConfig").where({ id: configId }).first();
    if (!config) return res.status(404).send(error("视频配置不存在"));

    if (!force) {
      const running = await u.db("t_video").where({ configId, state: 0 }).orderBy("id", "desc").first();
      if (running?.id) {
        const runningId = Number(running.id);
        if (isVideoTaskActive(runningId)) {
          return res.status(200).send(
            success({
              id: runningId,
              configId,
              reused: true,
              message: "该配置已有进行中的任务，已复用",
            }),
          );
        }
        await u
          .db("t_video")
          .where({ id: runningId })
          .update({
            state: -1,
            errorReason: "检测到历史残留进行中任务（进程重启或异常中断），已自动标记失败并重新创建任务",
          });
      }
    }

    const mode = (String(config.mode || "single") as VideoGenerateMode) || "single";
    const startFrame: any = parseJson(config.startFrame);
    const endFrame: any = parseJson(config.endFrame);
    const images: any[] = Array.isArray(parseJson(config.images)) ? (parseJson(config.images) as any[]) : [];

    let filePath: string[] = [];
    if (mode === "startEnd") {
      filePath = [startFrame?.filePath, endFrame?.filePath].filter((v) => typeof v === "string" && v.trim() !== "") as string[];
    } else if (mode === "multi") {
      filePath = images
        .map((it) => String(it?.filePath || "").trim())
        .filter((v) => v.length > 0);
    } else if (mode === "single") {
      const single = String(startFrame?.filePath || images?.[0]?.filePath || "").trim();
      filePath = single ? [single] : [];
    } else {
      filePath = [];
    }

    if (mode !== "text" && filePath.length === 0) {
      return res.status(400).send(error("该配置缺少可用图片，无法生成视频"));
    }

    try {
      const task = await createVideoTask({
        projectId: Number(config.projectId),
        scriptId: Number(config.scriptId),
        configId: Number(config.id),
        aiConfigId: Number(config.aiConfigId || 0),
        resolution: String(config.resolution || "720p"),
        filePath,
        duration: Number(config.duration || 5),
        prompt: String(config.prompt || ""),
        mode,
        audioEnabled: Boolean(config.audioEnabled),
      });
      return res.status(200).send(success({ ...task, reused: false }));
    } catch (err: any) {
      return res.status(500).send(error(u.error(err).message || "视频生成失败"));
    }
  },
);
