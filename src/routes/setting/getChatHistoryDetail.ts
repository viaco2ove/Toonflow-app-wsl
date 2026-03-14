import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  ChatMode,
  buildChatHistoryTitle,
  buildHistoryPreview,
  extractText,
  getProjectScriptMap,
  getModeFromScriptId,
  getSessionIdFromType,
  getSessionMetaMap,
  getUserProjects,
  isStoryboardSessionType,
  isSupportedChatType,
  normalizeHistoryArray,
  parseNovelScriptId,
} from "@/lib/chatHistoryManager";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
  }),
  async (req, res) => {
    const userId = Number((req as any)?.user?.id || 1);
    const historyId = Number(req.body.id);
    const projects = await getUserProjects(userId);
    if (!projects.length) {
      return res.status(404).send(error("未找到会话记录"));
    }

    const projectMap = new Map<number, string>();
    const projectIds = projects.map((item) => item.id);
    for (const item of projects) projectMap.set(item.id, item.name);
    const projectScriptMap = await getProjectScriptMap(projectIds);

    const row = await u
      .db("t_chatHistory")
      .where("id", historyId)
      .whereIn("projectId", projectIds)
      .select("id", "projectId", "type", "data", "novel")
      .first();
    if (!row) return res.status(404).send(error("未找到会话记录"));

    const type = String(row.type || "");
    if (!isSupportedChatType(type)) {
      return res.status(400).send(error("当前记录类型不支持查看"));
    }

    const projectId = Number(row.projectId);
    const projectName = projectMap.get(projectId) || `项目 ${projectId}`;
    const history = normalizeHistoryArray(row.data);
    const preview = buildHistoryPreview(history);
    const sessionMetaMap = await getSessionMetaMap([projectId]);

    let sessionId = "";
    let title = type === "outlineAgent" ? "大纲会话" : "旧版分镜会话";
    let mode: ChatMode = type === "outlineAgent" ? "outline" : "legacy";
    let scriptId: number | null = null;

    if (isStoryboardSessionType(type)) {
      sessionId = getSessionIdFromType(type);
      const sessionMeta = sessionMetaMap.get(projectId)?.get(sessionId);
      scriptId = sessionMeta?.scriptId ?? parseNovelScriptId(row.novel);
      mode = getModeFromScriptId(scriptId);
      title = sessionMeta?.title || (sessionId ? `会话 ${sessionId.slice(0, 8)}` : "会话");
    }
    const absScriptId = Number.isFinite(Number(scriptId)) ? Math.abs(Number(scriptId)) : 0;
    const scriptName = projectScriptMap.get(projectId)?.get(absScriptId)?.name || (absScriptId > 0 ? `第${absScriptId}集` : "未知集");
    const displayTitle = buildChatHistoryTitle(projectName, mode, sessionId, scriptId, scriptName);

    const messageList = history.map((item: any, index: number) => {
      const role =
        typeof item?.role === "string"
          ? item.role
          : typeof item?.type === "string"
            ? item.type
            : "unknown";
      const content = extractText(item?.content) || extractText(item?.text) || "";
      return {
        index: index + 1,
        role,
        content,
        raw: item,
      };
    });

    return res.status(200).send(
      success({
        id: Number(row.id),
        projectId,
        projectName,
        type,
        mode,
        usage: mode === "video" ? "视频" : mode === "storyboard" ? "分镜" : mode === "outline" ? "大纲" : "历史",
        sessionId,
        scriptId,
        scriptName,
        title,
        displayTitle,
        preview,
        messageCount: history.length,
        messageList,
      }),
    );
  },
);
