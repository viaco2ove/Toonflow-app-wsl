import "./type";
import u from "@/utils";
import modelList from "./modelList";
import axios from "axios";

import volcengine from "./owned/volcengine";
import kling from "./owned/kling";
import vidu from "./owned/vidu";
import runninghub from "./owned/runninghub";
import apimart from "./owned/apimart";
import other from "./owned/other";
import gemini from "./owned/gemini";

const QUOTA_ERROR_PATTERNS = [
  /token quota exhausted/i,
  /insufficient(?:\s+\w+)?\s+quota/i,
  /quota(?:\s+\w+)?\s+exhausted/i,
  /余额不足|配额不足|额度不足|欠费|信用点不足|令牌不足/i,
];

const isQuotaErrorMessage = (message: string): boolean => QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(message));

const normalizeImageErrorMessage = (message: string): string => {
  const normalized = message?.trim() || "图片生成失败";
  if (!isQuotaErrorMessage(normalized)) return normalized;
  if (normalized.includes("图片生成额度不足")) return normalized;
  return `图片生成额度不足，请更换可用 API Key 或充值后重试。${normalized}`;
};

const urlToBase64 = async (url: string): Promise<string> => {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const base64 = Buffer.from(res.data).toString("base64");
  const mimeType = res.headers["content-type"] || "image/png";
  return `data:${mimeType};base64,${base64}`;
};

const modelInstance = {
  gemini: gemini,
  volcengine: volcengine,
  kling: kling,
  vidu: vidu,
  runninghub: runninghub,
  // apimart: apimart,
  other,
} as const;

export default async (input: ImageConfig, config: AIConfig) => {
  const debugImageLog = process.env.DEBUG_AI_IMAGE === "1";
  // Avoid leaking API keys in logs.
  const redacted =
    config?.apiKey && config.apiKey.trim().length > 12
      ? `${config.apiKey.trim().slice(0, 6)}***${config.apiKey.trim().slice(-4)}`
      : config?.apiKey
      ? "***"
      : config?.apiKey;
  if (debugImageLog) {
    console.log("%c Line:32 🥪 config", "background:#33a5ff", { ...config, apiKey: redacted });
  }
  const { model, apiKey, baseURL, manufacturer } = { ...config };
  if (!config || !config?.model || !config?.apiKey || !config?.manufacturer) throw new Error("请检查模型配置是否正确");

  const manufacturerFn = modelInstance[manufacturer as keyof typeof modelInstance];
  if (!manufacturerFn) throw new Error("不支持的图片厂商");

  const owned = modelList.find((m) => m.model === model);
  if (manufacturer === "other") {
    if (owned && owned.manufacturer !== "other") {
      throw new Error(`模型 ${model} 属于 ${owned.manufacturer} 厂商，请将厂商设置为 ${owned.manufacturer}`);
    }
  } else {
    if (!owned) throw new Error("不支持的模型");
    if (owned.manufacturer !== manufacturer) {
      throw new Error(`模型 ${model} 与厂商 ${manufacturer} 不匹配，应为 ${owned.manufacturer}`);
    }
  }

  // 补充图片的 base64 内容类型字符串
  if (input.imageBase64 && input.imageBase64.length > 0) {
    input.imageBase64 = input.imageBase64.map((img) => {
      if (img.startsWith("data:image/")) {
        return img;
      }
      // 根据 base64 头部判断图片类型
      if (img.startsWith("/9j/")) {
        return `data:image/jpeg;base64,${img}`;
      }
      if (img.startsWith("iVBORw")) {
        return `data:image/png;base64,${img}`;
      }
      if (img.startsWith("R0lGOD")) {
        return `data:image/gif;base64,${img}`;
      }
      if (img.startsWith("UklGR")) {
        return `data:image/webp;base64,${img}`;
      }
      // 默认使用 png
      return `data:image/png;base64,${img}`;
    });
  }

  try {
    let imageUrl = await manufacturerFn(input, { model, apiKey, baseURL });
    if (debugImageLog) {
      console.log("%c Line:68 🍷 imageUrl", "background:#4fff4B", imageUrl);
    }
    if (!input.resType) input.resType = "b64";
    if (input.resType === "b64" && imageUrl.startsWith("http")) imageUrl = await urlToBase64(imageUrl);
    return imageUrl;
  } catch (error) {
    const rawMessage = u.error(error).message || "图片生成失败";
    throw new Error(normalizeImageErrorMessage(rawMessage));
  }
};
