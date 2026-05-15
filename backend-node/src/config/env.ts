import dotenv from "dotenv";

/**
 * 配置和 DeepSeek 客户端
 * 统一读取环境变量。
 * 这里是统一读取 .env
 * 让 server.ts 不再关心 .env 细节，只拿已经校验过的配置使用。
 */
dotenv.config();

export const port = Number(process.env.PORT || 8000);
export const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
export const deepseekBaseURL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
export const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

if (!deepseekApiKey) {
  throw new Error("DEEPSEEK_API_KEY is missing. Please add it to your .env file.");
}
