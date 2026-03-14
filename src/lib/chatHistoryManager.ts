import u from "@/utils";

export const STORYBOARD_META_TYPE = "storyboardAgent:sessions";
export const STORYBOARD_SESSION_PREFIX = "storyboardAgent:session:";

export type ChatMode = "storyboard" | "video" | "outline" | "legacy" | "unknown";

export interface SessionMetaLite {
  id: string;
  title: string;
  updatedAt: number;
  preview: string;
  scriptId: number | null;
}

export interface UserProject {
  id: number;
  name: string;
}

export interface ScriptLite {
  id: number;
  projectId: number;
  name: string;
}

const safeParseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const extractText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const text = (item as Record<string, any>).text;
          return typeof text === "string" ? text.trim() : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, any>;
    if (typeof record.text === "string") return record.text.trim();
    if (typeof record.content === "string") return record.content.trim();
  }
  return "";
};

export const normalizeHistoryArray = (raw: unknown): any[] => {
  let value = raw;
  for (let i = 0; i < 3; i++) {
    if (typeof value !== "string") break;
    const text = value.trim();
    if (!text) return [];
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, any>;
    if (Array.isArray(record.history)) return record.history;
    if (Array.isArray(record.messages)) return record.messages;
  }
  return [];
};

export const buildHistoryPreview = (history: any[]): string => {
  if (!Array.isArray(history) || history.length === 0) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    const fromContent = extractText((item as any)?.content);
    if (fromContent) return fromContent.slice(0, 100);
    const fromText = extractText((item as any)?.text);
    if (fromText) return fromText.slice(0, 100);
  }
  return "";
};

export const getModeFromScriptId = (scriptId: number | null): ChatMode => {
  if (!Number.isFinite(Number(scriptId))) return "storyboard";
  return Number(scriptId) < 0 ? "video" : "storyboard";
};

export const getUserProjects = async (userId: number): Promise<UserProject[]> => {
  const rows = await u.db("t_project").where("userId", userId).select("id", "name");
  return rows.map((row: any) => ({ id: Number(row.id), name: String(row.name || "") })).filter((row) => Number.isFinite(row.id));
};

export const getProjectScriptMap = async (projectIds: number[]): Promise<Map<number, Map<number, ScriptLite>>> => {
  const result = new Map<number, Map<number, ScriptLite>>();
  if (!projectIds.length) return result;
  const rows = await u.db("t_script").whereIn("projectId", projectIds).select("id", "projectId", "name");
  for (const row of rows) {
    const projectId = Number(row.projectId);
    const scriptId = Number(row.id);
    if (!Number.isFinite(projectId) || !Number.isFinite(scriptId)) continue;
    if (!result.has(projectId)) result.set(projectId, new Map<number, ScriptLite>());
    result.get(projectId)!.set(scriptId, {
      id: scriptId,
      projectId,
      name: String(row.name || `脚本${scriptId}`),
    });
  }
  return result;
};

export const buildChatHistoryTitle = (
  projectName: string,
  mode: ChatMode,
  sessionId: string,
  scriptId: number | null,
  scriptName?: string,
): string => {
  const safeProject = String(projectName || "未命名项目").trim() || "未命名项目";
  const usage = mode === "video" ? "视频" : mode === "storyboard" ? "分镜" : mode === "outline" ? "大纲" : "会话";
  const sid = Number(scriptId);
  const absScriptId = Number.isFinite(sid) ? Math.abs(sid) : 0;
  const episode = String(scriptName || (absScriptId > 0 ? `第${absScriptId}集` : "未知集")).trim() || "未知集";
  const shortSession = String(sessionId || "legacy").trim() || "legacy";
  return `${safeProject}_${episode}_${usage}_${shortSession}`;
};

export const getSessionMetaMap = async (projectIds: number[]): Promise<Map<number, Map<string, SessionMetaLite>>> => {
  const result = new Map<number, Map<string, SessionMetaLite>>();
  if (!projectIds.length) return result;

  const metaRows = await u
    .db("t_chatHistory")
    .whereIn("projectId", projectIds)
    .andWhere("type", STORYBOARD_META_TYPE)
    .select("projectId", "data");

  for (const row of metaRows) {
    const projectId = Number(row.projectId);
    if (!Number.isFinite(projectId)) continue;
    const raw = safeParseJson<any[]>(row.data, []);
    const map = new Map<string, SessionMetaLite>();
    for (const item of Array.isArray(raw) ? raw : []) {
      const sessionId = typeof item?.id === "string" ? item.id.trim() : "";
      if (!sessionId) continue;
      const updatedAt = Number(item?.updatedAt);
      const parsedScriptId = Number(item?.scriptId);
      map.set(sessionId, {
        id: sessionId,
        title: typeof item?.title === "string" && item.title.trim() ? item.title.trim() : sessionId,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
        preview: typeof item?.preview === "string" ? item.preview : "",
        scriptId: Number.isFinite(parsedScriptId) ? parsedScriptId : null,
      });
    }
    result.set(projectId, map);
  }

  return result;
};

export const parseNovelScriptId = (novel: string | null | undefined): number | null => {
  const parsed = safeParseJson<any>(novel, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const scriptId = Number((parsed as Record<string, any>).scriptId);
  return Number.isFinite(scriptId) ? scriptId : null;
};

export const getSessionIdFromType = (type: string): string => {
  if (!type.startsWith(STORYBOARD_SESSION_PREFIX)) return "";
  return type.slice(STORYBOARD_SESSION_PREFIX.length).trim();
};

export const isStoryboardSessionType = (type: string): boolean => {
  return type.startsWith(STORYBOARD_SESSION_PREFIX);
};

export const isSupportedChatType = (type: string): boolean => {
  if (isStoryboardSessionType(type)) return true;
  return type === "outlineAgent" || type === "storyboardAgent";
};
