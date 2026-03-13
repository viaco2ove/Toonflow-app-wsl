import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
const router = express.Router();

// 删除视频配置
export default router.post(
  "/",
  validateFields({
    id: z.number().optional(),
    ids: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    const { id, ids } = req.body;
    const targetIds = Array.from(
      new Set([
        ...(Array.isArray(ids) ? ids : []),
        ...(Number.isFinite(id) ? [id] : []),
      ]),
    ).filter((item) => Number.isFinite(item) && item > 0);

    if (targetIds.length === 0) {
      return res.status(400).send(error("未提供可删除的视频配置ID"));
    }

    const existingConfigs = await u.db("t_videoConfig").whereIn("id", targetIds).select("id");
    const existingIds = new Set(existingConfigs.map((item: any) => Number(item.id)));
    const validIds = targetIds.filter((item) => existingIds.has(item));

    if (!validIds.length) {
      return res.status(404).send(error("视频配置不存在"));
    }

    // 获取关联的视频生成结果
    const videoResults = await u.db("t_video").whereIn("configId", validIds).select("*");

    // 收集需要删除的文件路径
    const filesToDelete = Array.from(
      new Set(
        videoResults
          .map((result: any) => String(result?.filePath || "").trim())
          .filter((item) => item.length > 0),
      ),
    );

    // 删除文件
    for (const filePath of filesToDelete) {
      try {
        await u.oss.deleteFile(filePath);
        console.log("[deleteVideoConfig] deleted file:", filePath);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          // 文件不存在属于幂等场景，忽略即可
          console.warn("[deleteVideoConfig] file already missing:", filePath);
          continue;
        }
        console.error("[deleteVideoConfig] delete file failed:", filePath, err);
      }
    }

    // 删除数据库中的视频结果记录和配置记录
    await u.db("t_video").whereIn("configId", validIds).delete();
    await u.db("t_videoConfig").whereIn("id", validIds).delete();

    res.status(200).send(
      success({
        message: "删除视频配置成功",
        data: {
          deletedConfigIds: validIds,
          deletedConfigCount: validIds.length,
          deletedResultsCount: videoResults.length,
          deletedFilesCount: filesToDelete.length,
        },
      }),
    );
  },
);
