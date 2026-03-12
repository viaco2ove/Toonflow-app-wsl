import u from "@/utils";
import axios from "axios";
import { v4 as uuid } from "uuid";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalOssUrl(imageUrl: string): boolean {
  const parsed = tryParseUrl(imageUrl);
  if (!parsed) return false;
  return LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
}

function filePathFromLocalOssUrl(imageUrl: string): string | null {
  const parsed = tryParseUrl(imageUrl);
  if (!parsed) return null;
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
}

async function getImageBase64ForId(imageId: string | number) {
  const imagePath = await u
    .db("t_assets")
    .select("filePath")
    .where({ id: Number(imageId) })
    .first();

  if (!imagePath || !imagePath.filePath) return ""; // 未找到图片路径

  // 优先走本地文件读取，避免 HTTP 代理回环导致 502。
  try {
    return await u.oss.getImageBase64(imagePath.filePath);
  } catch {
    const url = await u.oss.getFileUrl(imagePath.filePath);
    return await urlToBase64(url);
  }
}

async function urlToBase64(imageUrl: string): Promise<string> {
  if (!imageUrl) return "";
  if (/^data:image\//i.test(imageUrl)) return imageUrl;

  const localPath = filePathFromLocalOssUrl(imageUrl);
  if (localPath) {
    try {
      return await u.oss.getImageBase64(localPath);
    } catch (err) {
      console.warn("[editImage] local oss read failed, fallback to http:", err);
    }
  }

  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 15000,
    // 本地 OSS 地址不走代理，避免被 HTTP_PROXY/ALL_PROXY 劫持。
    ...(isLocalOssUrl(imageUrl) ? { proxy: false } : {}),
  });
  const contentType = response.headers["content-type"] || "image/png";
  const base64 = Buffer.from(response.data, "binary").toString("base64");
  return `data:${contentType};base64,${base64}`;
}
// 将图片ID和指令转换为base64数组和替换后的指令
async function convertDirectiveAndImages(images: Record<string, string>, directive: string) {
  // step1: 列出所有别名
  const aliasList = Object.keys(images);
  // step2: 在指令中提取所有 @别名出现
  const aliasRegex = /@[\u4e00-\u9fa5\w]+/g;
  const referencedAliases = directive.match(aliasRegex) || [];
  // step3: 检查别名
  for (const alias of referencedAliases) {
    if (!(alias in images)) {
      throw new Error(`您引用了不存在的图片：${alias}`);
    }
  }
  // step4: 构建别名与顺序编号映射
  const aliasToIndex: Record<string, number> = {};
  aliasList.forEach((alias, i) => {
    aliasToIndex[alias] = i + 1;
  });
  // step5: 替换指令中的别名为"图N"
  let prompt = directive;
  for (const [alias, idx] of Object.entries(aliasToIndex)) {
    // 转义alias可能含特殊字符
    const reg = new RegExp(alias.replace(/([.*+?^${}()|\[\]\/\\])/g, "\\$1"), "g");
    prompt = prompt.replace(reg, `图${idx}`);
  }
  // step6: 依次获取图片 base64 内容（区分id或者本身就是base64）
  const base64Images: string[] = [];

  for (const imageVal of Object.values(images)) {
    // 判断是否为base64串
    const val = String(imageVal ?? "").trim();
    const isBase64 = typeof imageVal === "string" && /^data:image\//.test(val);
    if (isBase64) {
      base64Images.push(val);
    } else if (/^\d+$/.test(val)) {
      const base64 = await getImageBase64ForId(val);
      base64Images.push(base64);
    } else if (/^https?:\/\//i.test(val)) {
      const base64 = await urlToBase64(val);
      base64Images.push(base64);
    }
  }
  return {
    prompt,
    images: base64Images,
  };
}

/**
 * 示例用法：
 *
 * editImages(
 *   {
 *     "@图8": "456",   // key: 图片别名（如@图8），value: 图片ID（如456）
 *     "@图10": "123"   // key: 图片别名（如@图10），value: 图片ID（如123）
 *   },
 *   "将@图10中圈起来的部分换成@图8"
 * );
 */
export default async (images: Record<string, string>, directive: string, projectId: number, aspectRatio: string | null) => {
  const { prompt, images: base64Images } = await convertDirectiveAndImages(images, directive);
  const apiConfig = await u.getPromptAi("editImage");

  const contentStr = await u.ai.image(
    {
      systemPrompt: "根据用户提供的具体修改指令，对上传的图片进行智能编辑。",
      prompt: prompt,
      imageBase64: base64Images,
      aspectRatio: aspectRatio ? aspectRatio : "16:9",
      size: "1K",
    },
    apiConfig,
  );
  const match = contentStr.match(/base64,([A-Za-z0-9+/=]+)/);
  const buffer = Buffer.from(match && match.length >= 1 ? match[1]! : contentStr, "base64");
  const filePath = `/${projectId}/storyboard/${uuid()}.jpg`;
  await u.oss.writeFile(filePath, buffer);
  return filePath;
};
