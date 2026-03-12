import express from "express";
import expressWs, { Application } from "express-ws";
import Storyboard from "@/agents/storyboard";
import {
  createStoryboardChatSession,
  deleteStoryboardChatSession,
  ensureStoryboardChatBootstrap,
  listStoryboardChatSessions,
  loadStoryboardChatSession,
  renameStoryboardChatSession,
  saveStoryboardChatSession,
  StoryboardChatSessionMeta,
} from "@/lib/storyboardChatSessionStore";

const router = express.Router();
expressWs(router as unknown as Application);

const formatSessionListText = (sessions: StoryboardChatSessionMeta[], currentSessionId: string): string => {
  if (sessions.length === 0) {
    return "当前没有历史会话。可发送 /新建会话 创建。";
  }
  const lines = sessions.map((item, index) => {
    const marker = item.id === currentSessionId ? "⭐" : " ";
    const time = new Date(item.updatedAt).toLocaleString();
    const preview = item.preview ? `\n   预览：${item.preview}` : "";
    return `${marker}${index + 1}. ${item.title}（ID: ${item.id}，更新于 ${time}）${preview}`;
  });
  return `会话列表：\n${lines.join("\n")}\n\n可用命令（ID或序号都可）：\n/切换会话 <ID或序号>\n/新建会话 [标题]\n/重命名会话 <ID或序号> <新标题>\n/删除会话 <ID或序号>`;
};

router.ws("/", async (ws, req) => {
  let agent: Storyboard;

  const projectId = req.query.projectId;
  const scriptId = req.query.scriptId;
  const requestedSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";

  if (!projectId || typeof projectId !== "string" || !scriptId || typeof scriptId !== "string") {
    ws.send(JSON.stringify({ type: "error", data: "项目ID或脚本ID缺失" }));
    ws.close(500, "项目ID或脚本ID缺失");
    return;
  }

  const projectIdNum = Number(projectId);
  const scriptIdNum = Number(scriptId);
  agent = new Storyboard(projectIdNum, scriptIdNum);

  const send = (type: string, data: any) => {
    try {
      ws.send(JSON.stringify({ type, data }));
    } catch (err: any) {
      console.error("ws send error:", err?.message || String(err));
    }
  };

  const bootstrap = await ensureStoryboardChatBootstrap({
    projectId: projectIdNum,
    scriptId: scriptIdNum,
  });

  let sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
  let currentSessionId = bootstrap.sessionId;
  let sessionData = {
    history: bootstrap.history,
    novelChapters: bootstrap.novelChapters,
  };

  if (requestedSessionId) {
    const target = sessionsCache.find((item) => item.id === requestedSessionId);
    if (target) {
      const loaded = await loadStoryboardChatSession(projectIdNum, requestedSessionId);
      if (loaded) {
        currentSessionId = requestedSessionId;
        sessionData = loaded;
      }
    }
  }

  agent.history = Array.isArray(sessionData.history) ? sessionData.history : [];
  agent.novelChapters = Array.isArray(sessionData.novelChapters) ? sessionData.novelChapters : [];

  const getCurrentSessionTitle = () => {
    const current = sessionsCache.find((item) => item.id === currentSessionId);
    return current?.title || "未命名会话";
  };

  const listSessions = async () => {
    sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
    send("notice", formatSessionListText(sessionsCache, currentSessionId));
  };

  const resolveSessionId = (inputId: string): string => {
    const raw = inputId.trim();
    if (!raw) return "";
    const byId = sessionsCache.find((item) => item.id === raw);
    if (byId) return byId.id;
    if (/^\d+$/.test(raw)) {
      const index = Number(raw) - 1;
      if (index >= 0 && index < sessionsCache.length) return sessionsCache[index].id;
    }
    return raw;
  };

  const switchSession = async (sessionIdToSwitch: string) => {
    const targetId = resolveSessionId(sessionIdToSwitch);
    if (!targetId) {
      send("notice", "会话ID不能为空。");
      return;
    }
    const target = sessionsCache.find((item) => item.id === targetId);
    if (!target) {
      send("notice", `未找到会话：${sessionIdToSwitch}。可发送 /会话 查看列表（支持ID或序号）。`);
      return;
    }
    await saveHistory();
    const loaded = await loadStoryboardChatSession(projectIdNum, targetId);
    if (!loaded) {
      send("notice", `会话数据不存在：${targetId}。`);
      return;
    }
    currentSessionId = targetId;
    agent.history = Array.isArray(loaded.history) ? loaded.history : [];
    agent.novelChapters = Array.isArray(loaded.novelChapters) ? loaded.novelChapters : [];
    send("notice", `已切换到会话「${target.title}」。你可以继续提问。`);
  };

  const createAndSwitchSession = async (title?: string) => {
    await saveHistory();
    const created = await createStoryboardChatSession({
      projectId: projectIdNum,
      scriptId: scriptIdNum,
      title,
    });
    sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
    currentSessionId = created.sessionId;
    agent.history = [];
    agent.novelChapters = [];
    send("notice", `已创建并切换到新会话「${getCurrentSessionTitle()}」。`);
  };

  const renameSession = async (sessionIdToRename: string, nextTitle: string) => {
    const targetId = resolveSessionId(sessionIdToRename);
    const title = nextTitle.trim();
    if (!targetId || !title) {
      send("notice", "用法：/重命名会话 <ID> <新标题>");
      return;
    }
    await renameStoryboardChatSession(projectIdNum, targetId, title);
    sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
    send("notice", `会话 ${targetId} 已重命名为「${title}」。`);
  };

  const deleteSession = async (sessionIdToDelete: string) => {
    const targetId = resolveSessionId(sessionIdToDelete);
    if (!targetId) {
      send("notice", "用法：/删除会话 <ID>");
      return;
    }

    sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
    if (sessionsCache.length <= 1 && sessionsCache[0]?.id === targetId) {
      agent.history = [];
      agent.novelChapters = [];
      await saveHistory();
      send("notice", "当前只有一个会话，已清空其历史内容。");
      return;
    }

    const exists = sessionsCache.some((item) => item.id === targetId);
    if (!exists) {
      send("notice", `未找到会话：${sessionIdToDelete}（支持ID或序号）`);
      return;
    }

    await saveHistory();
    await deleteStoryboardChatSession(projectIdNum, targetId);
    sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
    if (targetId === currentSessionId) {
      const next = sessionsCache[0];
      if (next) {
        const loaded = await loadStoryboardChatSession(projectIdNum, next.id);
        currentSessionId = next.id;
        agent.history = loaded?.history ?? [];
        agent.novelChapters = loaded?.novelChapters ?? [];
        send("notice", `已删除当前会话，自动切换到「${next.title}」。`);
      } else {
        await createAndSwitchSession("默认会话");
      }
    } else {
      send("notice", `已删除会话：${targetId}`);
    }
  };

  const handleSessionCommand = async (prompt: string): Promise<boolean> => {
    const input = prompt.trim();
    if (!input.startsWith("/")) return false;

    if (/^\/(会话|sessions?)$/i.test(input)) {
      await listSessions();
      return true;
    }

    const createMatch = input.match(/^\/(新建会话|newsession)(?:\s+(.+))?$/i);
    if (createMatch) {
      await createAndSwitchSession(createMatch[2]?.trim());
      return true;
    }

    const switchMatch = input.match(/^\/(切换会话|switch)\s+([^\s]+)$/i);
    if (switchMatch) {
      await switchSession(switchMatch[2]);
      return true;
    }

    const renameMatch = input.match(/^\/(重命名会话|rename)\s+([^\s]+)\s+(.+)$/i);
    if (renameMatch) {
      await renameSession(renameMatch[2], renameMatch[3]);
      return true;
    }

    const deleteMatch = input.match(/^\/(删除会话|delete)\s+([^\s]+)$/i);
    if (deleteMatch) {
      await deleteSession(deleteMatch[2]);
      return true;
    }

    if (/^\/(会话帮助|session-help|help-session)$/i.test(input)) {
      send(
        "notice",
        "会话命令：\n/会话\n/新建会话 [标题]\n/切换会话 <ID或序号>\n/重命名会话 <ID或序号> <新标题>\n/删除会话 <ID或序号>",
      );
      return true;
    }

    return false;
  };

  // 监听各类事件
  agent.emitter.on("data", (text) => {
    send("stream", text);
  });

  agent.emitter.on("response", async (text) => {
    send("response_end", text);
    await saveHistory();
  });

  agent.emitter.on("subAgentStream", (data) => {
    send("subAgentStream", data);
  });

  agent.emitter.on("subAgentEnd", (data) => {
    send("subAgentEnd", data);
  });

  agent.emitter.on("toolCall", (data) => {
    send("toolCall", data);
  });

  agent.emitter.on("transfer", (data) => {
    send("transfer", data);
  });

  agent.emitter.on("refresh", (data) => {
    send("refresh", data);
  });

  agent.emitter.on("error", (err) => {
    send("error", err.toString());
  });

  agent.emitter.on("segmentsUpdated", (data) => {
    send("segmentsUpdated", data);
  });

  agent.emitter.on("shotsUpdated", (data) => {
    send("shotsUpdated", data);
  });

  agent.emitter.on("shotImageGenerateStart", (data) => {
    send("shotImageGenerateStart", data);
  });

  agent.emitter.on("shotImageGenerateProgress", (data) => {
    send("shotImageGenerateProgress", data);
  });

  agent.emitter.on("shotImageGenerateComplete", (data) => {
    send("shotImageGenerateComplete", data);
  });

  agent.emitter.on("shotImageGenerateError", (data) => {
    send("shotImageGenerateError", data);
  });

  send("init", {
    projectId,
    scriptId,
    currentSessionId,
    currentSessionTitle: getCurrentSessionTitle(),
  });

  send("notice", `已进入会话「${getCurrentSessionTitle()}」。发送 /会话 可查看并切换历史会话。`);

  type DataTyype =
    | "msg"
    | "cleanHistory"
    | "generateShotImage"
    | "replaceShot"
    | "listSessions"
    | "createSession"
    | "switchSession"
    | "renameSession"
    | "deleteSession";

  ws.on("message", async function (rawData: string) {
    let data: { type: DataTyype; data: any } | null = null;

    try {
      data = JSON.parse(rawData);
    } catch (error) {
      send("error", "数据解析异常");
      ws.close(500, "数据解析异常");
      return;
    }

    if (!data) {
      send("error", "数据格式错误");
      ws.close(500, "数据格式错误");
      return;
    }

    const msg = data.data;
    try {
      switch (data?.type) {
        case "msg": {
          const prompt = msg.data;
          if (msg.type === "user") {
            if (await handleSessionCommand(prompt)) return;
            await agent.call(prompt);
          }
          break;
        }
        case "cleanHistory":
          agent.history = [];
          agent.novelChapters = [];
          await saveHistory();
          send("notice", "当前会话历史已清空");
          break;
        case "generateShotImage":
          send("notice", "请在分镜面板中操作生成分镜图，当前会话历史不会被清空。");
          break;
        case "replaceShot":
          agent.updatePreShots(msg.segmentId, msg.cellId, msg.cell);
          break;
        case "listSessions":
          await listSessions();
          break;
        case "createSession":
          await createAndSwitchSession(msg?.title);
          break;
        case "switchSession":
          await switchSession(msg?.sessionId || "");
          break;
        case "renameSession":
          await renameSession(msg?.sessionId || "", msg?.title || "");
          break;
        case "deleteSession":
          await deleteSession(msg?.sessionId || "");
          break;
        default:
          break;
      }
    } catch (e: any) {
      send("error", `数据解析/脚本生成异常: ${e?.message || String(e)}`);
      console.error(e);
    }
  });

  ws.on("close", async () => {
    agent?.emitter?.removeAllListeners();
    await saveHistory();
  });

  async function saveHistory() {
    const history = agent?.history || [];
    const novelChapters = agent?.novelChapters || [];
    sessionsCache = await saveStoryboardChatSession({
      projectId: projectIdNum,
      scriptId: scriptIdNum,
      sessionId: currentSessionId,
      history,
      novelChapters,
      titleIfMissing: getCurrentSessionTitle(),
    });
    sessionsCache = await listStoryboardChatSessions(projectIdNum, scriptIdNum);
  }
});

export default router;
