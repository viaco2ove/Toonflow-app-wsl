import "../type";
import axios from "axios";
import { pollTask } from "@/utils/ai/utils";
import db from "@/utils/db";

const VIDEO_DEBUG = (process.env.AI_VIDEO_DEBUG || "").trim() === "1";
const VIDEO_DEBUG_VERBOSE = (process.env.AI_VIDEO_DEBUG_VERBOSE || "").trim() === "1";

function maskKey(input?: string): string {
  const value = String(input || "").trim();
  if (!value) return "";
  if (value.length <= 8) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function logDebug(message: string, payload?: unknown): void {
  if (!VIDEO_DEBUG) return;
  if (payload === undefined) {
    console.log(`[video:t8star] ${message}`);
    return;
  }
  try {
    const text = JSON.stringify(payload);
    console.log(`[video:t8star] ${message}: ${text.length > 1200 ? `${text.slice(0, 1200)}...` : text}`);
  } catch {
    console.log(`[video:t8star] ${message}:`, payload);
  }
}

function trimSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function resolveUrls(baseURL?: string): { submitUrl: string; queryUrl: string } {
  const fallbackRoot = "https://ai.t8star.cn";
  const raw = (baseURL || fallbackRoot).trim();

  if (raw.includes("|")) {
    const [submit, query] = raw.split("|");
    return {
      submitUrl: trimSlash((submit || "").trim()),
      queryUrl: (query || "").trim(),
    };
  }

  const normalized = trimSlash(raw);
  if (/\/v2\/videos\/generations(?:\/\{taskId\})?$/i.test(normalized)) {
    return {
      submitUrl: normalized.replace(/\/\{taskId\}$/i, ""),
      queryUrl: normalized.endsWith("/{taskId}") ? normalized : `${normalized}/{taskId}`,
    };
  }

  return {
    submitUrl: `${normalized}/v2/videos/generations`,
    queryUrl: `${normalized}/v2/videos/generations/{taskId}`,
  };
}

function pickTaskId(payload: any): string {
  const candidate =
    payload?.task_id ??
    payload?.id ??
    payload?.data?.task_id ??
    payload?.data?.id ??
    payload?.result?.task_id ??
    payload?.result?.id;
  return candidate ? String(candidate) : "";
}

function pickStatus(payload: any): string {
  const candidate = payload?.status ?? payload?.data?.status ?? payload?.result?.status ?? payload?.data?.result?.status;
  return candidate ? String(candidate) : "";
}

function pickVideoUrl(payload: any): string {
  const outputValue =
    payload?.data?.output ??
    payload?.output ??
    payload?.result?.output ??
    payload?.result?.data?.output ??
    payload?.data?.result?.output;

  if (typeof outputValue === "string" && outputValue.trim()) {
    return outputValue.trim();
  }
  if (Array.isArray(outputValue)) {
    const first = outputValue.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string" && first.trim()) return first.trim();
    const firstObjUrl = outputValue.find((item) => item && typeof item === "object" && (item.url || item.video_url));
    if (firstObjUrl) {
      const objUrl = String(firstObjUrl.url || firstObjUrl.video_url || "").trim();
      if (objUrl) return objUrl;
    }
  }
  if (outputValue && typeof outputValue === "object") {
    const objUrl = String(outputValue.url || outputValue.video_url || "").trim();
    if (objUrl) return objUrl;
  }

  const candidate =
    payload?.video_url ??
    payload?.url ??
    payload?.video?.url ??
    payload?.output?.video_url ??
    payload?.output?.url ??
    payload?.data?.video_url ??
    payload?.data?.url ??
    payload?.data?.video?.url ??
    payload?.data?.output?.video_url ??
    payload?.data?.output?.url ??
    payload?.data?.result?.video_url ??
    payload?.data?.result?.url ??
    payload?.result?.video_url ??
    payload?.result?.url ??
    payload?.result?.video?.url ??
    payload?.result?.output?.video_url ??
    payload?.result?.output?.url ??
    payload?.result?.data?.video_url ??
    payload?.result?.data?.url ??
    payload?.result?.data?.output?.video_url ??
    payload?.result?.data?.output?.url ??
    payload?.result?.generated_video ??
    payload?.result?.generated_videos?.[0]?.url ??
    payload?.result?.generated_videos?.[0]?.video_url ??
    payload?.data?.videos?.[0]?.url ??
    payload?.data?.videos?.[0]?.video_url ??
    payload?.result?.videos?.[0]?.url ??
    payload?.result?.videos?.[0]?.video_url;
  return candidate ? String(candidate) : "";
}

function pickError(payload: any): string {
  const candidate =
    payload?.fail_reason ??
    payload?.error?.message ??
    payload?.error_message ??
    payload?.message ??
    payload?.data?.fail_reason ??
    payload?.data?.error?.message ??
    payload?.data?.error_message ??
    payload?.data?.message ??
    payload?.result?.fail_reason ??
    payload?.result?.error?.message ??
    payload?.result?.message;
  return candidate ? String(candidate) : "";
}

export interface T8StarTaskQueryResult {
  status: string;
  completed: boolean;
  url?: string;
  error?: string;
}

export async function queryT8StarTaskOnce(
  taskId: string,
  options: {
    apiKey?: string;
    baseURL?: string;
    queryUrl?: string;
  },
): Promise<T8StarTaskQueryResult> {
  if (!taskId) {
    return { status: "UNKNOWN", completed: false, error: "缺少任务ID" };
  }
  if (!options.apiKey) {
    return { status: "UNKNOWN", completed: false, error: "缺少API Key" };
  }

  const queryTemplate =
    options.queryUrl && options.queryUrl.includes("{taskId}") ? options.queryUrl : resolveUrls(options.baseURL).queryUrl;
  const authorization = `Bearer ${options.apiKey.replace(/^Bearer\s*/i, "").trim()}`;

  const queryRes = await axios.get(queryTemplate.replace("{taskId}", taskId), {
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });

  const payload = queryRes.data;
  const status = pickStatus(payload).toUpperCase();
  const url = pickVideoUrl(payload);
  const errorText = pickError(payload);

  if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)) {
    if (!url) {
      return { status, completed: false };
    }
    return { status, completed: true, url };
  }

  if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
    return { status, completed: false, error: errorText || `任务失败: ${status}` };
  }

  if (url) {
    return { status: status || "UNKNOWN", completed: true, url };
  }

  return { status: status || "PENDING", completed: false };
}

export default async (input: VideoConfig, config: AIConfig) => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  const { submitUrl, queryUrl } = resolveUrls(config.baseURL);
  const authorization = `Bearer ${config.apiKey.replace(/^Bearer\s*/i, "").trim()}`;

  const body: Record<string, any> = {
    prompt: input.prompt,
    model: config.model,
    aspect_ratio: input.aspectRatio,
    enhance_prompt: true,
  };

  if (["1080p", "2K", "4K"].includes(input.resolution)) {
    body.enable_upsample = true;
  }
  if (input.imageBase64 && input.imageBase64.length > 0) {
    body.images = input.imageBase64;
  }

  logDebug("submit request", {
    submitUrl,
    queryUrl,
    model: config.model,
    apiKey: maskKey(config.apiKey),
    promptLength: String(input.prompt || "").length,
    imageCount: Array.isArray(input.imageBase64) ? input.imageBase64.length : 0,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    duration: input.duration,
    ...(VIDEO_DEBUG_VERBOSE ? { requestBody: body } : {}),
  });

  const createRes = await axios.post(submitUrl, body, {
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
  });
  const taskId = pickTaskId(createRes.data);
  logDebug("submit response", {
    httpStatus: createRes.status,
    requestId: createRes.headers?.["x-request-id"] || createRes.headers?.["request-id"] || "",
    taskId,
    ...(VIDEO_DEBUG_VERBOSE ? { data: createRes.data } : { status: pickStatus(createRes.data), error: pickError(createRes.data) || "" }),
  });
  if (!taskId) {
    throw new Error(`任务提交成功但未返回task_id: ${JSON.stringify(createRes.data)}`);
  }

  try {
    await db("t_video")
      .where({ filePath: input.savePath, state: 0 })
      .update({
        providerTaskId: taskId,
        providerQueryUrl: queryUrl,
        providerManufacturer: "t8star",
      } as any);
  } catch (err) {
    logDebug("persist task meta failed", {
      savePath: input.savePath,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let pollCount = 0;
  return pollTask(
    async () => {
      pollCount++;
    const queryRes = await axios.get(queryUrl.replace("{taskId}", taskId), {
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
    });

    const payload = queryRes.data;
    const status = pickStatus(payload).toUpperCase();
    const url = pickVideoUrl(payload);
    const errorText = pickError(payload);
    if (VIDEO_DEBUG && (pollCount <= 5 || pollCount % 10 === 0 || Boolean(url) || Boolean(errorText))) {
      logDebug(`poll response #${pollCount}`, {
        httpStatus: queryRes.status,
        requestId: queryRes.headers?.["x-request-id"] || queryRes.headers?.["request-id"] || "",
        status,
        hasUrl: Boolean(url),
        error: errorText || "",
        ...(VIDEO_DEBUG_VERBOSE ? { data: payload } : {}),
      });
    }

    if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(status)) {
      if (!url) {
        // 部分通道状态先完成，再延迟写入视频链接，继续轮询
        return { completed: false, status };
      }
      return { completed: true, url, status };
    }

    if (["FAILURE", "FAILED", "ERROR", "CANCELLED", "CANCELED"].includes(status)) {
      return { completed: false, error: errorText || `任务失败: ${status}`, status };
    }

    if (["NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS", "RUNNING", "PENDING", "PROCESSING"].includes(status)) {
      return { completed: false, status };
    }

    if (url) {
      return { completed: true, url, status };
    }

    // 兼容供应商扩展状态，默认继续轮询
    return { completed: false, status };
    },
    500,
    2000,
    {
      label: `video:t8star:${config.model}`,
      debug: VIDEO_DEBUG,
      logEvery: 10,
    },
  );
};
