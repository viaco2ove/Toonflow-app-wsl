import express from "express";
import axios from "axios";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { queryT8StarTaskOnce } from "@/utils/ai/video/owned/t8star";

const router = express.Router();
const VIDEO_DEBUG = (process.env.AI_VIDEO_DEBUG || "").trim() === "1";

function toPathname(value: string): string {
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return new URL(value).pathname;
  }
  return value;
}

// 刷新远端任务状态（模型接口）
export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
    specifyIds: z
      .preprocess((value) => {
        if (typeof value === "number") return [value];
        return value;
      }, z.array(z.number()))
      .optional(),
  }),
  async (req, res) => {
    const { scriptId, specifyIds } = req.body as { scriptId: number; specifyIds?: number[] };

    const pendingVideos = await u
      .db("t_video")
      .where({ scriptId, state: 0 })
      .modify((qb) => {
        if (Array.isArray(specifyIds) && specifyIds.length > 0) {
          qb.whereIn("id", specifyIds);
        }
      })
      .select("id", "filePath", "aiConfigId", "providerTaskId", "providerQueryUrl", "providerManufacturer");

    if (VIDEO_DEBUG) {
      console.log("[video] /video/refreshVideoStatus request", {
        scriptId,
        specifyIdsCount: Array.isArray(specifyIds) ? specifyIds.length : 0,
        pendingCount: pendingVideos.length,
      });
    }

    if (!pendingVideos.length) {
      return res.status(200).send(
        success({
          refreshed: 0,
          success: 0,
          failed: 0,
          pending: 0,
          unsupported: 0,
          details: [],
        }),
      );
    }

    const configCache = new Map<number, any>();
    const details: Array<{ id: number; status: "success" | "failed" | "pending" | "unsupported"; reason?: string }> = [];

    let successCount = 0;
    let failedCount = 0;
    let pendingCount = 0;
    let unsupportedCount = 0;

    for (const item of pendingVideos as any[]) {
      const id = Number(item.id);
      const providerTaskId = String(item.providerTaskId || "").trim();
      const providerQueryUrl = String(item.providerQueryUrl || "").trim();
      const providerManufacturer = String(item.providerManufacturer || "").trim().toLowerCase();
      const aiConfigId = Number(item.aiConfigId || 0);

      if (!aiConfigId) {
        unsupportedCount += 1;
        details.push({ id, status: "unsupported", reason: "缺少 aiConfigId" });
        continue;
      }

      if (!configCache.has(aiConfigId)) {
        const configRow = await u.db("t_config").where({ id: aiConfigId }).first();
        configCache.set(aiConfigId, configRow || null);
      }

      const configRow = configCache.get(aiConfigId);
      if (!configRow) {
        unsupportedCount += 1;
        details.push({ id, status: "unsupported", reason: `模型配置不存在(aiConfigId=${aiConfigId})` });
        continue;
      }

      const manufacturer = String(providerManufacturer || configRow.manufacturer || "").toLowerCase();
      if (manufacturer !== "t8star") {
        unsupportedCount += 1;
        details.push({ id, status: "unsupported", reason: `暂不支持 ${manufacturer || "unknown"} 的远端刷新` });
        continue;
      }

      if (!providerTaskId) {
        unsupportedCount += 1;
        details.push({ id, status: "unsupported", reason: "缺少 providerTaskId（历史任务可能不支持远端刷新）" });
        continue;
      }

      try {
        const remote = await queryT8StarTaskOnce(providerTaskId, {
          apiKey: String(configRow.apiKey || ""),
          baseURL: String(configRow.baseUrl || ""),
          queryUrl: providerQueryUrl || undefined,
        });

        if (remote.completed && remote.url) {
          const savePath = toPathname(String(item.filePath || "").trim());
          if (!savePath) {
            await u.db("t_video").where({ id }).update({
              state: -1,
              errorReason: "远端任务成功但本地保存路径为空",
            } as any);
            failedCount += 1;
            details.push({ id, status: "failed", reason: "本地保存路径为空" });
            continue;
          }

          const response = await axios.get(remote.url, { responseType: "stream" });
          await u.oss.writeFile(savePath, response.data);

          await u.db("t_video").where({ id }).update({
            state: 1,
            filePath: savePath,
            errorReason: null,
          } as any);

          successCount += 1;
          details.push({ id, status: "success" });
          continue;
        }

        if (remote.error) {
          await u.db("t_video").where({ id }).update({
            state: -1,
            errorReason: remote.error,
          } as any);

          failedCount += 1;
          details.push({ id, status: "failed", reason: remote.error });
          continue;
        }

        pendingCount += 1;
        details.push({ id, status: "pending", reason: remote.status || "PENDING" });
      } catch (err) {
        const reason = u.error(err).message || "刷新远端状态失败";
        pendingCount += 1;
        details.push({ id, status: "pending", reason });
      }
    }

    if (VIDEO_DEBUG) {
      console.log("[video] /video/refreshVideoStatus response", {
        scriptId,
        refreshed: pendingVideos.length,
        success: successCount,
        failed: failedCount,
        pending: pendingCount,
        unsupported: unsupportedCount,
      });
    }

    res.status(200).send(
      success({
        refreshed: pendingVideos.length,
        success: successCount,
        failed: failedCount,
        pending: pendingCount,
        unsupported: unsupportedCount,
        details,
      }),
    );
  },
);
