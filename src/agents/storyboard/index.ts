// @/agents/Storyboard.ts
import u from "@/utils";
import { tool, ModelMessage, Tool } from "ai";
import { EventEmitter } from "events";
import { z } from "zod";
import type { DB } from "@/types/database";
import generateImageTool from "./generateImageTool";
import imageSplitting from "./imageSplitting";
import path from "path";
import sharp from "sharp";

// ==================== 类型定义 ====================

type AgentType = "segmentAgent" | "shotAgent";
type RefreshEvent = "storyline" | "outline" | "assets";

// ==================== 常量配置 ====================

// const SYSTEM_PROMPTS: Record<AgentType, string> = {
//   segmentAgent: segmentPrompts,
//   shotAgent: shotPrompts,
//   director: directorPrompts,
// };

// ==================== 类型定义：片段和画面 ====================

interface Segment {
  index: number;
  description: string;
  emotion?: string;
  action?: string;
}

interface Shot {
  id: number; // 分镜独立ID
  segmentId: number; // 所属片段ID
  title: string;
  x: number;
  y: number;
  cells: Array<{ src?: string; prompt?: string; id?: string }>; // 镜头数组，每个cell是一个镜头
  fragmentContent: string;
  assetsTags: AssetsType[];
}
interface AssetsType {
  type: "role" | "props" | "scene";
  text: string;
}

type ScriptRow = {
  id: number;
  projectId: number;
  name?: string;
  content?: string;
  outlineId?: number | null;
};

type OutlineAsset = { name?: string; description?: string };
type OutlineData = {
  characters?: OutlineAsset[];
  props?: OutlineAsset[];
  scenes?: OutlineAsset[];
};
// ==================== 主类 ====================

export default class Storyboard {
  private readonly projectId: number;
  private readonly scriptId: number;
  readonly emitter = new EventEmitter();
  history: ModelMessage[] = [];
  novelChapters: DB["t_novel"][] = [];

  // 存储 segmentAgent 生成的片段结果
  private segments: Segment[] = [];
  // 存储 shotAgent 生成的分镜结果
  private shots: Shot[] = [];
  // 分镜ID计数器
  private shotIdCounter: number = 0;
  // 存储正在生成分镜图的分镜ID
  private generatingShots: Set<number> = new Set();
  // 片段持久化存储类型（按 script 维度隔离）
  private readonly segmentsStoreType: string;
  // 是否已尝试从持久化存储加载片段
  private segmentsLoadedFromStore = false;
  // 当前 segmentAgent 运行是否已显式调用过 updateSegments
  private segmentUpdatedInCurrentRun = false;

  constructor(projectId: number, scriptId: number) {
    this.projectId = projectId;
    this.scriptId = scriptId;
    this.segmentsStoreType = `storyboardSegments:${scriptId}`;
  }

  // 更新shopts
  public updatePreShots(segmentId: number, cellId: number, cell: { src?: string; prompt?: string; id?: string }) {
    const shotIndex = this.shots.findIndex((item) => item.segmentId === segmentId);
    if (shotIndex === -1) {
      return `分镜 ${segmentId} 不存在，请检查分镜ID是否正确`;
    }
    const cellIndex = this.shots[shotIndex].cells.findIndex((item) => item.id === cellId.toString());
    if (cellIndex === -1) {
      return `镜头 ${cellId} 不存在，请检查镜头ID是否正确`;
    }
    this.shots[shotIndex].cells[cellIndex] = { ...this.shots[shotIndex].cells[cellIndex], ...cell };
  }

  // 获取当前分镜快照（用于会话持久化）
  public getShotsSnapshot(): { shots: Shot[]; shotIdCounter: number } {
    return {
      shots: JSON.parse(JSON.stringify(this.shots || [])),
      shotIdCounter: this.shotIdCounter || 0,
    };
  }

  // 从会话恢复分镜，并刷新前端画布
  public restoreShotsFromSession(shots: Shot[] | undefined | null, shotIdCounter?: number): void {
    const nextShots = Array.isArray(shots) ? JSON.parse(JSON.stringify(shots)) : [];
    this.shots = nextShots;
    this.generatingShots.clear();

    const maxShotId = this.shots.reduce((max, item) => {
      const id = Number(item?.id);
      return Number.isFinite(id) ? Math.max(max, id) : max;
    }, 0);

    const safeCounter = Number.isFinite(shotIdCounter as number) ? Number(shotIdCounter) : 0;
    this.shotIdCounter = Math.max(maxShotId, safeCounter);
    this.emit("shotsUpdated", this.shots);
  }

  // ==================== 公共方法 ====================

  get events() {
    return this.emitter;
  }
  // ==================== 私有工具方法 ====================

  private emit(event: string, data?: any) {
    this.emitter.emit(event, data);
  }

  private refresh(type: RefreshEvent) {
    this.emit("refresh", type);
  }

  private log(action: string, detail?: string) {
    const msg = detail ? `${action}: ${detail}` : action;
    console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}\n`);
  }

  private isQuotaExhaustedMessage(message: string): boolean {
    if (!message) return false;
    return [
      /token quota exhausted/i,
      /insufficient(?:\s+\w+)?\s+quota/i,
      /quota(?:\s+\w+)?\s+exhausted/i,
      /余额不足|配额不足|额度不足|欠费|信用点不足|令牌不足/i,
    ].some((pattern) => pattern.test(message));
  }

  private normalizeShotImageError(error: unknown): string {
    const rawMessage = u.error(error).message || "分镜图生成失败";
    if (!this.isQuotaExhaustedMessage(rawMessage)) return rawMessage;
    if (rawMessage.includes("图片生成额度不足")) return rawMessage;
    return `图片生成额度不足，请在设置中更换可用 API Key 或充值后重试。${rawMessage}`;
  }

  private cancelRemainingShotImageGeneration(remainingShotIds: number[], reason: string): void {
    for (const shotId of remainingShotIds) {
      this.generatingShots.delete(shotId);
      this.emit("shotImageGenerateError", { shotId, error: `已取消：${reason}` });
      this.log("分镜图生成取消", `分镜 ${shotId}: 前序分镜触发配额错误，已停止后续生成`);
    }
  }



  private normalizeSegments(segments: Segment[]): Segment[] {
    const cleaned = segments
      .filter((seg) => Number.isFinite(seg.index) && seg.index > 0 && seg.description?.trim())
      .map((seg) => ({
        index: Math.trunc(seg.index),
        description: seg.description.trim(),
        ...(seg.emotion ? { emotion: seg.emotion } : {}),
        ...(seg.action ? { action: seg.action } : {}),
      }));

    const uniq = new Map<number, Segment>();
    for (const seg of cleaned) {
      if (!uniq.has(seg.index)) uniq.set(seg.index, seg);
    }
    return Array.from(uniq.values()).sort((a, b) => a.index - b.index);
  }

  private parseSegmentsFromText(text: string): Segment[] {
    const segmentsMap = new Map<number, Segment>();
    let currentIndex: number | null = null;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const segmentMatch = line.match(/^🎬\s*(\d+)\b/);
      if (segmentMatch) {
        currentIndex = Number(segmentMatch[1]);
        continue;
      }

      const descMatch = line.match(/^📝\s*片段描述[:：]\s*(.+)$/);
      if (descMatch && currentIndex != null) {
        const description = descMatch[1].trim();
        if (description) segmentsMap.set(currentIndex, { index: currentIndex, description });
      }
    }

    // 兼容“1. **xxx**”这类摘要格式
    if (segmentsMap.size === 0) {
      const inlineMatches = Array.from(text.matchAll(/(?:^|\n)\s*(\d+)[\.、]\s*\*{0,2}([^*\n]+?)\*{0,2}(?=\n|$)/g));
      for (const match of inlineMatches) {
        const index = Number(match[1]);
        const description = (match[2] || '').trim();
        if (description) segmentsMap.set(index, { index, description });
      }
    }

    return this.normalizeSegments(Array.from(segmentsMap.values()));
  }

  private async loadSegmentsFromStore(): Promise<void> {
    if (this.segmentsLoadedFromStore) return;
    this.segmentsLoadedFromStore = true;
    try {
      const row = await u.db('t_chatHistory').where({ projectId: this.projectId, type: this.segmentsStoreType }).first();
      if (row?.data) {
        const parsed = JSON.parse(row.data);
        if (Array.isArray(parsed)) {
          const normalized = this.normalizeSegments(parsed as Segment[]);
          if (normalized.length) {
            this.segments = normalized;
            this.emit('segmentsUpdated', this.segments);
            this.log('加载片段数据', `从存储恢复 ${normalized.length} 个片段`);
            return;
          }
        }
      }
    } catch (err: any) {
      this.log('加载片段数据失败', err?.message || String(err));
    }
  }

  private async saveSegmentsToStore(): Promise<void> {
    try {
      const payload = JSON.stringify(this.segments);
      const existing = await u.db('t_chatHistory').where({ projectId: this.projectId, type: this.segmentsStoreType }).first();
      if (existing) {
        await u
          .db('t_chatHistory')
          .where({ projectId: this.projectId, type: this.segmentsStoreType })
          .update({ data: payload, novel: '' });
      } else {
        await u.db('t_chatHistory').insert({
          projectId: this.projectId,
          type: this.segmentsStoreType,
          data: payload,
          novel: '',
        });
      }
    } catch (err: any) {
      this.log('保存片段数据失败', err?.message || String(err));
    }
  }
  // ==================== 剧本相关操作 ====================

  private async loadCurrentScript(): Promise<ScriptRow> {
    const script = (await u.db("t_script").where({ id: this.scriptId, projectId: this.projectId }).first()) as ScriptRow | undefined;
    if (!script) throw new Error(`当前剧本不存在（projectId=${this.projectId}, scriptId=${this.scriptId}）`);
    return script;
  }

  private filterAssetsByScript(outline: OutlineData | null | undefined, scriptContent: string) {
    const rawCharacters = Array.isArray(outline?.characters) ? outline!.characters! : [];
    const rawProps = Array.isArray(outline?.props) ? outline!.props! : [];
    const rawScenes = Array.isArray(outline?.scenes) ? outline!.scenes! : [];
    const content = String(scriptContent || "");
    const byContent = (items: OutlineAsset[]) => {
      const matched = items.filter((item) => {
        const name = String(item?.name || "").trim();
        return Boolean(name) && content.includes(name);
      });
      return matched.length ? matched : items;
    };
    return {
      characters: byContent(rawCharacters),
      props: byContent(rawProps),
      scenes: byContent(rawScenes),
    };
  }

  getScript = tool({
    title: "getScript",
    description: "获取剧本内容",
    inputSchema: z.object({}),
    execute: async () => {
      this.log("获取剧本", `scriptId: ${this.scriptId}`);
      const script = await this.loadCurrentScript();
      return `剧本集：${script.name}\n\n内容：\n\`\`\`${script.content}\`\`\``;
    },
  });

  // ==================== 资产相关操作 ====================

  /**
   * 获取资产列表（供 segmentAgent 和 shotAgent 调用）
   */
  getAssets = tool({
    title: "getAssets",
    description: "获取资产列表（角色、道具、场景），包含名称和详细介绍。生成片段和分镜时必须先调用此工具获取资产信息，确保名称一致性",
    inputSchema: z.object({}),
    execute: async () => {
      this.log("获取资产列表", `scriptId: ${this.scriptId}`);
      const scriptData = await this.loadCurrentScript();
      const row = await u.db("t_outline").where({ id: scriptData?.outlineId!, projectId: this.projectId }).first();
      const outline: OutlineData | null = row?.data ? JSON.parse(row.data) : null;

      if (!outline) {
        return "暂无资产数据";
      }
      const filtered = this.filterAssetsByScript(outline, String(scriptData?.content || ""));

      // 提取资源名称和描述（与generateImageTool保持一致的字段名）
      const resources = filtered
        ? (["characters", "props", "scenes"] as const).flatMap(
            (k) => filtered[k]?.map((i: any) => ({ name: i.name, description: i.description })) ?? [],
          )
        : [];

      if (resources.length === 0) {
        return "暂无资产数据";
      }

      // 分类提取资源并格式化
      const characters = filtered?.characters?.map((item: any) => `- ${item.name}${item.description ? `：${item.description}` : ""}`) ?? [];
      const props = filtered?.props?.map((item: any) => `- ${item.name}${item.description ? `：${item.description}` : ""}`) ?? [];
      const scenes = filtered?.scenes?.map((item: any) => `- ${item.name}${item.description ? `：${item.description}` : ""}`) ?? [];

      const sections = [
        characters.length ? `【角色】\n${characters.join("\n")}` : "",
        props.length ? `【道具】\n${props.join("\n")}` : "",
        scenes.length ? `【场景】\n${scenes.join("\n")}` : "",
      ].filter(Boolean);

      if (sections.length === 0) {
        return "暂无资产数据";
      }

      return `<资产列表>
${sections.join("\n\n")}
</资产列表>

⚠️ 重要规则：
1. 必须原封不动地使用上述资产名称，禁止使用近义词、缩写或任何变体
2. 禁止在资产名称前后添加修饰词
3. 禁止捏造资产列表中不存在的角色、场景、道具`;
    },
  });

  // ==================== 片段和分镜工具 ====================

  /**
   * 获取当前存储的片段数据（供 shotAgent 调用）
   */
  getSegments = tool({
    title: "getSegments",
    description: "获取当前已生成的片段数据，用于生成分镜",
    inputSchema: z.object({}),
    execute: async () => {
      if (this.segments.length === 0) await this.loadSegmentsFromStore();
      this.log("获取片段数据", `共 ${this.segments.length} 个片段`);
      if (this.segments.length === 0) {
        return "暂无片段数据，请先调用 segmentAgent 生成片段";
      }
      return JSON.stringify(this.segments, null, 2);
    },
  });

  /**
   * 更新/存储片段数据（供 segmentAgent 调用）
   */
  updateSegments = tool({
    title: "updateSegments",
    description: "存储生成的片段数据，segmentAgent 在生成片段后必须调用此工具保存结果",
    inputSchema: z.object({
      segments: z
        .array(
          z.object({
            index: z.number().int().min(1).describe("片段序号（从1开始）"),
            description: z.string().describe("片段描述"),
            emotion: z.string().optional().describe("情绪氛围"),
            action: z.string().optional().describe("主要动作"),
          }),
        )
        .describe("片段数组"),
    }),
    execute: async ({ segments }: { segments: Segment[] }) => {
      const normalized = this.normalizeSegments(segments);
      this.log("更新片段数据", `共 ${normalized.length} 个片段`);
      this.segments = normalized;
      this.segmentsLoadedFromStore = true;
      this.segmentUpdatedInCurrentRun = true;
      await this.saveSegmentsToStore();
      this.emit("segmentsUpdated", this.segments);
      return `成功存储 ${normalized.length} 个片段`;
    },
  });

  /**
   * 添加分镜（供 shotAgent 调用）
   */
  addShots = tool({
    title: "addShots",
    description: "添加新的分镜。每个分镜有独立ID，包含多个镜头（每个镜头对应一个提示词）。如果片段已存在分镜会跳过",
    inputSchema: z.object({
      shots: z
        .array(
          z.object({
            segmentIndex: z.number().int().min(1).describe("对应的片段序号（从1开始）"),
            prompts: z.array(z.string()).describe("镜头提示词数组，每个提示词对应一个镜头（中文）"),
            assetsTags: z.array(
              z.object({
                type: z.enum(["role", "props", "scene"]).describe("资源类型"),
                text: z.string().describe("资源名称"),
              }),
            ),
          }),
        )
        .describe("要添加的分镜数组"),
    }),
    execute: async ({ shots }: { shots: Array<{ segmentIndex: number; prompts: string[]; assetsTags: AssetsType[] }> }) => {
      const added: { id: number; segmentIndex: number }[] = [];
      const skipped: number[] = [];

      for (const item of shots) {
        const segmentIndex = Math.trunc(Number(item.segmentIndex || 0));
        if (!Number.isFinite(segmentIndex) || segmentIndex <= 0) {
          skipped.push(segmentIndex);
          continue;
        }

        const exists = this.shots.some((f) => f.segmentId === segmentIndex);
        if (exists) {
          skipped.push(segmentIndex);
          continue;
        }
        // 分配独立的分镜ID
        this.shotIdCounter++;
        const shotId = this.shotIdCounter;
        this.shots.push({
          id: shotId,
          segmentId: segmentIndex,
          title: `片段 ${segmentIndex}`,
          x: 0,
          y: 0,
          cells: item.prompts.map((prompt) => ({ id: u.uuid(), prompt })),
          fragmentContent: this.segments[segmentIndex - 1]?.description,
          assetsTags: item.assetsTags,
        });
        added.push({ id: shotId, segmentIndex });
      }

      const addedInfo = added.map((a) => `分镜${a.id}(片段${a.segmentIndex})`).join(", ");
      this.log("添加分镜", `新增: [${addedInfo}], 跳过片段: [${skipped.join(", ")}]`);
      this.emit("shotsUpdated", this.shots);

      if (skipped.length) {
        return `已添加${addedInfo}；片段 ${skipped.join(", ")} 已存在分镜被跳过。当前共 ${this.shots.length} 个分镜`;
      }
      return `已添加${addedInfo}。当前共 ${this.shots.length} 个分镜`;
    },
  });

  /**
   * 更新指定分镜（供 shotAgent 调用）
   * 保留原有 cells 的 id 和 src 字段，只更新 prompt
   */
  updateShots = tool({
    title: "updateShots",
    description: "更新指定分镜的镜头提示词。通过分镜ID指定要修改的分镜",
    inputSchema: z.object({
      shotId: z.number().describe("要更新的分镜ID"),
      prompts: z.array(z.string()).describe("新的镜头提示词数组，每个提示词对应一个镜头"),
    }),
    execute: async ({ shotId, prompts }: { shotId: number; prompts: string[] }) => {
      const existingIndex = this.shots.findIndex((item) => item.id === shotId);

      if (existingIndex === -1) {
        return `分镜 ${shotId} 不存在，请检查分镜ID是否正确`;
      }

      const existingCells = this.shots[existingIndex].cells;

      // 更新 cells，保留原有的 id 和 src 字段
      this.shots[existingIndex].cells = prompts.map((prompt, i) => {
        const existingCell = existingCells[i];
        if (existingCell) {
          // 保留原有 cell 的 id 和 src，只更新 prompt
          return { ...existingCell, prompt };
        } else {
          // 新增的 cell
          return { id: u.uuid(), prompt };
        }
      });

      this.log("更新分镜", `分镜 ${shotId}`);
      this.emit("shotsUpdated", this.shots);

      return `已更新分镜 ${shotId}`;
    },
  });

  /**
   * 删除指定分镜（供 shotAgent 调用）
   */
  deleteShots = tool({
    title: "deleteShots",
    description: "删除指定的分镜。通过分镜ID指定要删除的分镜",
    inputSchema: z.object({
      shotIds: z.array(z.number()).describe("要删除的分镜ID数组"),
    }),
    execute: async ({ shotIds }: { shotIds: number[] }) => {
      const deleted: number[] = [];
      const notFound: number[] = [];

      for (const shotId of shotIds) {
        const idx = this.shots.findIndex((item) => item.id === shotId);
        if (idx === -1) {
          notFound.push(shotId);
        } else {
          this.shots.splice(idx, 1);
          deleted.push(shotId);
        }
      }

      this.log("删除分镜", `删除: [分镜${deleted.join(", 分镜")}], 未找到: [分镜${notFound.join(", 分镜")}]`);
      this.emit("shotsUpdated", this.shots);

      if (notFound.length) {
        return `已删除分镜 ${deleted.join(", ")}；分镜 ${notFound.join(", ")} 不存在。当前共 ${this.shots.length} 个分镜`;
      }
      return `已删除分镜 ${deleted.join(", ")}。当前共 ${this.shots.length} 个分镜`;
    },
  });

  /**
   * 生成分镜图（异步执行，使用 nanoBanana）
   */
  generateShotImage = tool({
    title: "generateShotImage",
    description:
      "为指定分镜生成分镜图。每个分镜会根据其所有提示词生成一张完整宫格图，然后自动分割为单格图片。通过分镜ID指定，不需要指定具体格子，整个分镜是一个完整的生成单元",
    inputSchema: z.object({
      shotIds: z.array(z.number()).describe("要生成分镜图的分镜ID数组"),
    }),
    execute: async ({ shotIds }: { shotIds: number[] }) => {
      return this.startGenerateShotImages(shotIds);
    },
  });

  /**
   * 启动分镜图生成任务（异步后台执行）
   */
  public async startGenerateShotImages(shotIds: number[]): Promise<string> {
    const normalizedIds = Array.from(
      new Set(
        (Array.isArray(shotIds) ? shotIds : [])
          .map((id) => Math.trunc(Number(id)))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );
    const toGenerate: number[] = [];
    const alreadyGenerating: number[] = [];
    const notFound: number[] = [];

    for (const shotId of normalizedIds) {
      const shot = this.shots.find((f) => f.id === shotId);
      if (!shot) {
        notFound.push(shotId);
        continue;
      }
      if (this.generatingShots.has(shotId)) {
        alreadyGenerating.push(shotId);
        continue;
      }
      toGenerate.push(shotId);
    }

    if (toGenerate.length === 0) {
      if (notFound.length) {
        return `分镜 ${notFound.join(", ")} 不存在，请检查分镜ID是否正确`;
      }
      if (alreadyGenerating.length) {
        return `分镜 ${alreadyGenerating.join(", ")} 正在生成中，请稍候`;
      }
      return normalizedIds.length ? "没有需要生成的分镜" : "请提供有效的分镜ID";
    }

    // 标记为正在生成
    for (const id of toGenerate) {
      this.generatingShots.add(id);
    }

    // 通知前端开始生成
    this.emit("shotImageGenerateStart", { shotIds: toGenerate });
    this.log("开始生成分镜图", `分镜: [${toGenerate.join(", ")}]`);

    // 异步执行图片生成（不阻塞 Agent 流程）
    this.executeShotImageGeneration(toGenerate).catch((err) => {
      const errorMessage = this.normalizeShotImageError(err);
      this.log("分镜图生成错误", errorMessage);
      if (!this.isQuotaExhaustedMessage(errorMessage)) {
        this.emit("shotImageGenerateError", { shotIds: toGenerate, error: errorMessage });
      }
    });

    let result = `已开始为分镜 ${toGenerate.join(", ")} 生成分镜图，生成过程在后台进行`;
    if (alreadyGenerating.length) {
      result += `；分镜 ${alreadyGenerating.join(", ")} 正在生成中`;
    }
    if (notFound.length) {
      result += `；分镜 ${notFound.join(", ")} 不存在`;
    }
    return result;
  }

  /**
   * 执行分镜图生成的具体逻辑（异步串行）
   * 每个分镜包含多个镜头，所有镜头的提示词合并生成一张宫格图，再分割为单张镜头图片
   */
  async executeShotImageGeneration(shotIds: number[]): Promise<void> {
    const successIds: number[] = [];
    const failed: Array<{ shotId: number; error: string }> = [];
    // WSL + Electron 环境下并发过高容易触发渲染层不稳定，改为串行生成以优先保证稳定性
    for (let i = 0; i < shotIds.length; i++) {
      const shotId = shotIds[i];
      try {
        await this.generateSingleShotImage(shotId);
        successIds.push(shotId);
      } catch (err) {
        const errorMessage = this.normalizeShotImageError(err);
        failed.push({ shotId, error: errorMessage });
        if (this.isQuotaExhaustedMessage(errorMessage)) {
          const remainingShotIds = shotIds.slice(i + 1);
          if (remainingShotIds.length > 0) {
            this.cancelRemainingShotImageGeneration(remainingShotIds, errorMessage);
            for (const remainId of remainingShotIds) {
              failed.push({ shotId: remainId, error: `已取消：${errorMessage}` });
            }
          }
          break;
        }
      }
    }

    this.emit("shotImageGenerateSummary", {
      shotIds,
      successIds,
      failed,
      successCount: successIds.length,
      failedCount: failed.length,
    });
  }

  /**
   * 生成单个分镜的图片
   */
  private async generateSingleShotImage(shotId: number): Promise<void> {
    try {
      const shot = this.shots.find((f) => f.id === shotId);
      if (!shot) return;

      // 提取所有镜头的有效提示词
      const prompts: string[] = shot.cells.map((c) => c.prompt).filter((p): p is string => Boolean(p));

      if (prompts.length === 0) {
        this.log("跳过分镜图生成", `分镜 ${shotId} 没有有效的镜头提示词`);
        this.generatingShots.delete(shotId);
        return;
      }

      // 通知前端正在生成该分镜
      this.emit("shotImageGenerateProgress", { shotId, status: "generating", message: "正在调用 AI 生成宫格图片" });

      // 根据所有镜头提示词生成宫格图片
      const gridImage = await generateImageTool(
        prompts.map((p) => ({ prompt: p })),
        this.scriptId,
        this.projectId,
      );
      // 通知前端正在分割图片
      this.emit("shotImageGenerateProgress", { shotId, status: "splitting", message: "正在分割宫格图片为单张镜头图" });

      // 分割宫格图片为单张镜头图片
      const imageBuffers = await imageSplitting(gridImage, prompts.length);
      if (!Array.isArray(imageBuffers) || imageBuffers.length !== prompts.length) {
        throw new Error(`宫格分割结果异常：期望 ${prompts.length} 张，实际 ${imageBuffers?.length || 0} 张`);
      }

      // 通知前端正在保存图片
      this.emit("shotImageGenerateProgress", { shotId, status: "saving", message: `正在保存 ${imageBuffers.length} 张镜头图片` });

      // 保存分割后的镜头图片到 OSS，并获取文件路径
      const timestamp = Date.now();
      const imagePaths: string[] = [];

      for (let i = 0; i < imageBuffers.length; i++) {
        const fileName = `${this.projectId}/chat/${this.scriptId}/storyboard/shot_${shotId}_take_${i}_${timestamp}.png`;
        await u.oss.writeFile(fileName, imageBuffers[i]);
        const imageUrl = await u.oss.getFileUrl(fileName);
        imagePaths.push(imageUrl);

        // 每保存一张镜头图片通知进度
        this.emit("shotImageGenerateProgress", {
          shotId,
          status: "saving",
          message: `已保存 ${i + 1}/${imageBuffers.length} 张镜头图片`,
          progress: Math.round(((i + 1) / imageBuffers.length) * 100),
        });
      }

      if (imagePaths.length !== prompts.length) {
        throw new Error(`分镜图保存不完整：期望 ${prompts.length} 张，实际保存 ${imagePaths.length} 张`);
      }

      // 更新每个镜头的 src 字段
      shot.cells = shot.cells.map((cell, i) => ({
        id: u.uuid(),
        ...cell,
        src: imagePaths[i] || cell.src,
      }));

      // 生成完成后更新状态
      this.generatingShots.delete(shotId);
      this.emit("shotImageGenerateComplete", { shotId, shot, imagePaths });
      this.emit("shotsUpdated", this.shots);
      this.log("分镜图生成完成", `分镜 ${shotId}，共 ${imagePaths.length} 张镜头图片`);
    } catch (err: any) {
      const errorMessage = this.normalizeShotImageError(err);
      this.generatingShots.delete(shotId);
      this.emit("shotImageGenerateError", { shotId, error: errorMessage });
      this.log("分镜图生成失败", `分镜 ${shotId}: ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  // ==================== 公共访问器 ====================

  /**
   * 获取当前片段数据
   */
  getSegmentsData(): Segment[] {
    return this.segments;
  }

  /**
   * 获取当前分镜数据
   */
  getShotsData(): Shot[] {
    return this.shots;
  }

  // ==================== 上下文构建 ====================

  private async buildEnvironmentContext(): Promise<string> {
    const projectInfo = await u.db("t_project").where({ id: this.projectId }).first();
    const scriptData = await this.loadCurrentScript();
    const outlineId = Number(scriptData?.outlineId || 0);
    const row = outlineId > 0 ? await u.db("t_outline").where({ id: outlineId, projectId: this.projectId }).first() : null;
    const outline: OutlineData | null = row?.data ? JSON.parse(row.data) : null;
    const filtered = this.filterAssetsByScript(outline, String(scriptData?.content || ""));

    // 分类提取资源名称
    const characters = filtered?.characters?.map((i: any) => i.name) ?? [];
    const props = filtered?.props?.map((i: any) => i.name) ?? [];
    const scenes = filtered?.scenes?.map((i: any) => i.name) ?? [];

    const assetList =
      [
        characters.length ? `【角色】${characters.join("、")}` : "",
        props.length ? `【道具】${props.join("、")}` : "",
        scenes.length ? `【场景】${scenes.join("、")}` : "",
      ]
        .filter(Boolean)
        .join("\n") || "无";

    return `<环境信息>
项目ID: ${this.projectId}
系统时间: ${new Date().toLocaleString()}

项目名称: ${projectInfo?.name || "未知"}
项目简介: ${projectInfo?.intro || "无"}
当前剧集: ${scriptData?.name || `脚本${this.scriptId}`}
当前剧集ID: ${this.scriptId}
类型: ${projectInfo?.type || "未知"}
风格: ${projectInfo?.artStyle || "未知"}
视频比例: ${projectInfo?.videoRatio || "未知"}

资产列表:
${assetList}

</环境信息>`;
  }

  private async buildSegmentAgentContext(task: string): Promise<string> {
    const env = await this.buildEnvironmentContext();
    const scriptData = await this.loadCurrentScript();
    const scriptName = String(scriptData?.name || `脚本${this.scriptId}`);
    const scriptContent = String(scriptData?.content || "").trim();
    return `${env}

<当前剧本>
剧本ID: ${this.scriptId}
剧本名称: ${scriptName}
剧本正文:
\`\`\`
${scriptContent}
\`\`\`
</当前剧本>

<执行约束>
1. 只能基于“当前剧本”生成片段，禁止引用其他剧集或其他项目内容。
2. 若当前剧本信息不足，请明确说明不足点，不要编造外部剧情。
3. 输出片段序号必须从 1 开始连续编号。
</执行约束>

<当前任务>
${task}
</当前任务>`;
  }

  private buildConversationHistory(): string {
    if (!this.history.length) return "无对话历史";
    return this.history.map(({ role, content }) => `${role}: ${content}`).join("\n\n");
  }

  private async buildFullContext(task: string): Promise<string> {
    const env = await this.buildEnvironmentContext();
    const history = this.buildConversationHistory();

    return `${env}

<对话历史>
${history}
</对话历史>

<当前任务>
${task}
</当前任务>`;
  }

  // ==================== Sub-Agent ====================

  /**
   * 获取不同 Sub-Agent 可用的工具
   */
  private getSubAgentTools(agentType: AgentType): Record<string, Tool> {
    switch (agentType) {
      case "segmentAgent":
        // segmentAgent 可以获取剧本和资产，并需要调用 updateSegments 保存结果
        return {
          getScript: this.getScript,
          getAssets: this.getAssets,
          updateSegments: this.updateSegments,
        };
      case "shotAgent":
        // shotAgent 可以获取剧本、资产和片段，并可使用 add/update/delete 操作分镜
        return {
          getScript: this.getScript,
          getAssets: this.getAssets,
          getSegments: this.getSegments,
          addShots: this.addShots,
          updateShots: this.updateShots,
          deleteShots: this.deleteShots,
        };
      default:
        return {
          getScript: this.getScript,
        };
    }
  }

  /**
   * 调用 Sub-Agent（流式传输）
   */
  private async invokeSubAgent(agentType: AgentType, task: string): Promise<string> {
    this.emit("transfer", { to: agentType });
    this.log(`Sub-Agent 调用`, agentType);

    if (this.segments.length === 0) await this.loadSegmentsFromStore();
    if (agentType === "segmentAgent") this.segmentUpdatedInCurrentRun = false;

    try {
      const promptsList = await u.db("t_prompts").where("code", "in", ["storyboard-segment", "storyboard-shot"]);
      const promptConfig = await u.getPromptAi("storyboardAgent");

      const errPrompts = "不论用户说什么，请直接输出Agent配置异常";

      const getAiPromptConfig = (code: string) => {
        const item = promptsList.find((p) => p.code === code);
        return item?.customValue || item?.defaultValue || errPrompts;
      };
      const segmentAgent = getAiPromptConfig("storyboard-segment");
      const shotAgent = getAiPromptConfig("storyboard-shot");
      const SYSTEM_PROMPTS = {
        segmentAgent: segmentAgent,
        shotAgent: shotAgent,
      };

      const context = agentType === "segmentAgent" ? await this.buildSegmentAgentContext(task) : await this.buildFullContext(task);
      if (agentType === "segmentAgent") {
        this.log("segmentAgent上下文", `projectId=${this.projectId}, scriptId=${this.scriptId}, taskLength=${task.length}`);
      }

      const { fullStream } = await u.ai.text.stream(
        {
          system: SYSTEM_PROMPTS[agentType],
          tools: this.getSubAgentTools(agentType),
          messages: [{ role: "user", content: context }],
          maxStep: 100,
        },
        promptConfig,
      );

      let fullResponse = "";
      for await (const item of fullStream) {
        if (item.type == "tool-call") {
          this.emit("toolCall", { agent: "main", name: item.title, args: null });
        }
        if (item.type == "text-delta") {
          fullResponse += item.text;
          this.emit("subAgentStream", { agent: agentType, text: item.text });
        }
      }

      if (agentType === "segmentAgent" && !this.segmentUpdatedInCurrentRun) {
        const fallbackSegments = this.parseSegmentsFromText(fullResponse);
        if (fallbackSegments.length > 0) {
          this.segments = fallbackSegments;
          this.segmentsLoadedFromStore = true;
          await this.saveSegmentsToStore();
          this.emit("segmentsUpdated", this.segments);
          this.log("片段兜底存储", `从文本解析并存储 ${fallbackSegments.length} 个片段`);
        }
      }

      this.emit("subAgentEnd", { agent: agentType });
      this.history.push({
        role: "assistant",
        content: fullResponse,
      });
      this.log(`Sub-Agent 完成`, agentType);

      return fullResponse ?? `${agentType}已完成任务`;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code;
      const isTimeout = code === "UND_ERR_BODY_TIMEOUT" || /Body Timeout Error|TypeError:\s*terminated/i.test(String(err?.stack || err?.message || ""));
      const friendly = isTimeout ? "模型响应超时（网络或上游接口超时），请重试或切换模型。" : err?.message || String(err);
      this.log("Sub-Agent 失败", `${agentType}: ${friendly}`);
      this.emit("subAgentEnd", { agent: agentType });
      this.emit("error", new Error(friendly));
      return `子代理执行失败：${friendly}`;
    }
  }

  private createSubAgentTool(agentType: AgentType, description: string) {
    return tool({
      title: agentType,
      description,
      inputSchema: z.object({
        taskDescription: z.string().describe("具体的任务描述，包含章节范围、修改要求等详细信息"),
      }),
      execute: async ({ taskDescription }) => this.invokeSubAgent(agentType, taskDescription),
    });
  }

  // ==================== 主入口 ====================

  private getAllTools() {
    return {
      segmentAgent: this.createSubAgentTool(
        "segmentAgent",
        "调用片段师。负责根据剧本生成片段，会自行调用 getScript 获取剧本内容，并调用 updateSegments 保存片段结果。",
      ),
      shotAgent: this.createSubAgentTool(
        "shotAgent",
        "调用分镜师。负责根据片段生成分镜提示词，会自行调用 getSegments 获取片段数据，并调用 addShots/updateShots 保存分镜结果。",
      ),
      // this.createSubAgentTool("director", "调用导演。负责审核故事线和大纲，会自行调用 updateOutline 或 saveStoryline 进行修改。"),
      getScript: this.getScript,
      getSegments: this.getSegments,
      ...this.getSubAgentTools("segmentAgent"),
      ...this.getSubAgentTools("shotAgent"),
    };
  }

  async call(msg: string): Promise<string> {
    if (this.segments.length === 0) await this.loadSegmentsFromStore();

    this.history.push({
      role: "user",
      content: msg,
    });

    const envContext = await this.buildEnvironmentContext();

    const prompts = await u.db("t_prompts").where("code", "storyboard-main").first();
    const promptConfig = await u.getPromptAi("storyboardAgent");

    const mainPrompts = prompts?.customValue || prompts?.defaultValue || "不论用户说什么，请直接输出Agent配置异常";

    const { fullStream } = await u.ai.text.stream(
      {
        system: `${envContext}\n${mainPrompts}`,
        tools: this.getAllTools(),
        messages: this.history,
        maxStep: 100,
      },
      promptConfig,
    );

    let fullResponse = "";
    for await (const item of fullStream) {
      if (item.type == "tool-call") {
        this.emit("toolCall", { agent: "main", name: item.title, args: null });
      }
      if (item.type == "text-delta") {
        fullResponse += item.text;
        this.emit("data", item.text);
      }
    }
    this.history.push({
      role: "assistant",
      content: fullResponse,
    });

    this.emit("response", fullResponse);

    return fullResponse;
  }
}
