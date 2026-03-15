import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { listStoryboardChatSessions, loadStoryboardChatSession, saveStoryboardChatSession } from "@/lib/storyboardChatSessionStore";
const router = express.Router();
const META_TYPE = "storyboardAgent:sessions";

const draftIdToVirtualId = (draftId: string): number => {
  let hash = 0;
  for (let i = 0; i < draftId.length; i++) {
    hash = (hash * 31 + draftId.charCodeAt(i)) | 0;
  }
  return -Math.max(1, Math.abs(hash));
};

const parseMetaSessionList = (raw: string): Array<{ id: string; scriptId?: number | null; title?: string }> => {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: any) => ({
        id: String(item?.id || "").trim(),
        scriptId: Number(item?.scriptId),
        title: typeof item?.title === "string" ? item.title : "",
      }))
      .filter((item) => item.id);
  } catch {
    return [];
  }
};

// 删除视频配置
export default router.post(
  "/",
  validateFields({
    id: z.number().optional(),
    ids: z.array(z.number()).optional(),
    scriptId: z.number().optional(),
    projectId: z.number().optional(),
  }),
  async (req, res) => {
    const { id, ids, scriptId, projectId } = req.body;
    const targetIds = Array.from(
      new Set([
        ...(Array.isArray(ids) ? ids : []),
        ...(Number.isFinite(id) ? [id] : []),
      ]),
    ).filter((item) => Number.isFinite(item) && item !== 0);

    if (targetIds.length === 0) {
      return res.status(400).send(error("未提供可删除的视频配置ID"));
    }

    const positiveIds = targetIds.filter((item) => item > 0);
    const virtualIds = targetIds.filter((item) => item < 0);
    const virtualIdSet = new Set<number>(virtualIds);
    const deletedVirtualIdSet = new Set<number>();
    const checkedSessionSet = new Set<string>();

    const deleteDraftBySession = async (
      projectIdNum: number,
      sessionId: string,
      sessionScriptId?: number | null,
      sessionTitle?: string,
    ) => {
      const key = `${projectIdNum}:${sessionId}`;
      if (!sessionId || checkedSessionSet.has(key)) return;
      checkedSessionSet.add(key);

      const loaded = await loadStoryboardChatSession(projectIdNum, sessionId);
      const draft = loaded?.videoDraft;
      if (!loaded || !draft?.configs?.length) return;

      const originConfigs = draft.configs;
      const nextConfigs = originConfigs.filter((item) => {
        const vid = draftIdToVirtualId(String(item?.draftId || ""));
        return !virtualIdSet.has(vid);
      });
      if (nextConfigs.length === originConfigs.length) return;

      originConfigs.forEach((item) => {
        const vid = draftIdToVirtualId(String(item?.draftId || ""));
        if (virtualIdSet.has(vid)) deletedVirtualIdSet.add(vid);
      });

      await saveStoryboardChatSession({
        projectId: projectIdNum,
        sessionId,
        scriptId: Number.isFinite(Number(sessionScriptId)) ? Number(sessionScriptId) : null,
        history: loaded.history || [],
        novelChapters: loaded.novelChapters || [],
        shots: loaded.shots || [],
        shotIdCounter: loaded.shotIdCounter || 0,
        videoDraft: {
          ...draft,
          configs: nextConfigs,
          updatedAt: Date.now(),
        },
        pendingStoryboardPlan: loaded.pendingStoryboardPlan || null,
        titleIfMissing: sessionTitle || "",
      });
    };

    if (virtualIds.length > 0) {
      const projectIdNum = Number(projectId || 0);
      const scriptIdNum = Number(scriptId || 0);

      if (projectIdNum > 0) {
        const scopedScriptId = scriptIdNum > 0 ? -Math.abs(scriptIdNum) : undefined;
        const scopedSessions = await listStoryboardChatSessions(projectIdNum, scopedScriptId);
        for (const session of scopedSessions) {
          await deleteDraftBySession(projectIdNum, String(session.id || ""), Number(session.scriptId), session.title);
        }
      }

      if (deletedVirtualIdSet.size < virtualIds.length) {
        const metaRows = await u.db("t_chatHistory").where({ type: META_TYPE }).select("projectId", "data");
        for (const row of metaRows as any[]) {
          if (deletedVirtualIdSet.size >= virtualIds.length) break;
          const projectIdNum = Number(row?.projectId || 0);
          if (projectIdNum <= 0) continue;
          const sessions = parseMetaSessionList(String(row?.data || ""));
          for (const session of sessions) {
            await deleteDraftBySession(projectIdNum, session.id, session.scriptId, session.title);
            if (deletedVirtualIdSet.size >= virtualIds.length) break;
          }
        }
      }
    }

    let validIds: number[] = [];
    if (positiveIds.length > 0) {
      const existingConfigs = await u.db("t_videoConfig").whereIn("id", positiveIds).select("id");
      const existingIds = new Set(existingConfigs.map((item: any) => Number(item.id)));
      validIds = positiveIds.filter((item) => existingIds.has(item));
    }

    if (!validIds.length && deletedVirtualIdSet.size === 0) {
      return res.status(404).send(error("视频配置不存在"));
    }

    let videoResults: any[] = [];
    let filesToDelete: string[] = [];
    if (validIds.length > 0) {
      // 获取关联的视频生成结果
      videoResults = await u.db("t_video").whereIn("configId", validIds).select("*");

      // 收集需要删除的文件路径
      filesToDelete = Array.from(
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
    }

    res.status(200).send(
      success({
        message: "删除视频配置成功",
        data: {
          deletedConfigIds: validIds,
          deletedVirtualConfigIds: Array.from(deletedVirtualIdSet),
          deletedConfigCount: validIds.length,
          deletedVirtualConfigCount: deletedVirtualIdSet.size,
          deletedResultsCount: videoResults.length,
          deletedFilesCount: filesToDelete.length,
        },
      }),
    );
  },
);
