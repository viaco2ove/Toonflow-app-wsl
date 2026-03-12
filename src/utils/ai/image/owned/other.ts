import "../type";
import { generateImage, generateText, ModelMessage } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import axios from "axios";

const normalizeBaseURL = (baseURL: string): string => {
  let normalized = baseURL.trim().replace(/\|+$/g, "");
  if (!normalized) throw new Error("缺少baseUrl");

  // OpenAI 兼容 SDK 会自动拼接 /images/generations，避免重复拼接。
  normalized = normalized.replace(/\/images\/generations\/?$/i, "");

  if (normalized.includes("|")) {
    throw new Error("other 厂商的 baseURL 不能包含 |，请只填写 OpenAI 兼容根路径（例如 https://example.com/v1）");
  }

  return normalized;
};

export default async (input: ImageConfig, config: AIConfig): Promise<string> => {
  if (!config.model) throw new Error("缺少Model名称");
  if (!config.apiKey) throw new Error("缺少API Key");
  if (!config.baseURL) throw new Error("缺少baseUrl");
  const baseURL = normalizeBaseURL(config.baseURL);

  const apiKey = config.apiKey.replace("Bearer ", "");

  const otherProvider = createOpenAICompatible({
    name: "xixixi",
    baseURL,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  // 根据 size 配置映射到具体尺寸
  const sizeMap: Record<string, `${number}x${number}`> = {
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "4096x4096",
  };
  // 构建完整的提示词
  const fullPrompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
  const model = config.model;
  if (model.includes("gemini") || model.includes("nano")) {
    let promptData;
    if (input.imageBase64 && input.imageBase64.length) {
      promptData = [{ role: "system", content: fullPrompt + `请直接输出图片` }];
      (promptData as ModelMessage[]).push({
        role: "user",
        content: input.imageBase64.map((i) => ({
          type: "image",
          image: i,
        })),
      });
    } else {
      promptData = fullPrompt + `请直接输出图片`;
    }

    const result = await generateText({
      model: otherProvider.languageModel(model),
      prompt: promptData as string | ModelMessage[],
      providerOptions: {
        google: {
          imageConfig: {
            ...(config.model == "gemini-2.5-flash-image"
              ? { aspectRatio: input.aspectRatio }
              : { aspectRatio: input.aspectRatio, imageSize: input.size }),
          },
          responseModalities: ["IMAGE"],
        },
      },
    });

    if (result.files && result.files.length) {
      let imageBase64;
      for (const item of result.files) {
        imageBase64 = `data:${item.mediaType};base64,${item.base64}`;
      }
      // 返回生成的图片 base64
      return imageBase64!;
    } else {
      if (!result.text) {
        console.error(JSON.stringify(result.response, null, 2));
        throw new Error("图片生成失败");
      }
      // 匹配所有 markdown 图片 ![...](url)
      const mdImgPattern = /!\[.*?\]\((.+?)\)/g;
      const matches = [...result.text.matchAll(mdImgPattern)];
      for (const match of matches) {
        const imgInfo = match[1];
        // 检查是否已是 base64
        const base64InMd = imgInfo.match(/data:image\/[a-z]+;base64,.+/);
        if (base64InMd) {
          return imgInfo; // 已经是base64，直接返回
        } else {
          return await urlToBase64(imgInfo); // 否则尝试转base64
        }
      }
      // 检查纯base64字符串
      const base64Match = result.text.match(/base64,([A-Za-z0-9+/=]+)/);
      if (base64Match) {
        return "data:image/jpeg;base64," + base64Match[1];
      }
      // 检查是否为图片直链接
      if (/^https?:\/\/.*\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(result.text)) {
        return await urlToBase64(result.text);
      }
      // 默认情况
      return result.text;
    }
  } else {
    const { image } = await generateImage({
      model: otherProvider.imageModel(model),
      prompt:
        input.imageBase64 && input.imageBase64.length
          ? { text: fullPrompt + `请直接输出图片`, images: input.imageBase64 }
          : fullPrompt + `请直接输出图片`,
      aspectRatio: input.aspectRatio as "1:1" | "3:4" | "4:3" | "9:16" | "16:9",
      size: sizeMap[input.size] ?? "1024x1024",
    });

    return image.base64;
  }
};

async function urlToBase64(url: string): Promise<string> {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  const base64 = Buffer.from(res.data).toString("base64");
  const mimeType = res.headers["content-type"] || "image/png";
  return `data:${mimeType};base64,${base64}`;
}
