import "../type";
import axios from "axios";
import u from "@/utils";

const normalizeAspectRatio = (ratio: string): string => ratio.replace(/\s+/g, "");

const toPixelSizeByRatio = (size: "1K" | "2K" | "4K", ratio: string): string | null => {
  const normalized = normalizeAspectRatio(ratio);
  // Seedream-5.0 对像素下限较高，1K 在部分比例下会报错，保持历史逻辑等价到 2K。
  const level: "2K" | "4K" = size === "4K" ? "4K" : "2K";
  const baseMap2k: Record<string, [number, number]> = {
    "1:1": [2048, 2048],
    "16:9": [2560, 1440],
    "9:16": [1440, 2560],
    "4:3": [2304, 1728],
    "3:4": [1728, 2304],
    "21:9": [3072, 1312],
  };
  const wh = baseMap2k[normalized];
  if (!wh) return null;
  const scale = level === "4K" ? 2 : 1;
  return `${wh[0] * scale}x${wh[1] * scale}`;
};

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");

  const apiKey = "Bearer " + config.apiKey.replace(/Bearer\s+/g, "").trim();
  const fallbackSize = input.size === "1K" ? "2K" : input.size;
  const pixelSize = input.aspectRatio ? toPixelSizeByRatio(input.size, input.aspectRatio) : null;
  const size = pixelSize ?? fallbackSize;

  const body: Record<string, any> = {
    model: config.model,
    prompt: input.prompt,
    size,
    response_format: "url",
    sequential_image_generation: "disabled",
    stream: false,
    watermark: false,
    ...(input.aspectRatio && { aspect_ratio: normalizeAspectRatio(input.aspectRatio) }),
    ...(input.imageBase64 && { image: input.imageBase64 }),
  };

  const url = config.baseURL ?? "https://ark.cn-beijing.volces.com/api/v3/images/generations";
  try {
    const { data } = await axios.post(url, body, { headers: { Authorization: apiKey } });
    return data.data[0]?.url;
  } catch (error) {
    const msg = u.error(error).message || "Volcengine 图片生成失败";
    throw new Error(msg);
  }
}
