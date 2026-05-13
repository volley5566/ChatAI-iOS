import OpenAI from "openai";
import { deepseekApiKey, deepseekBaseURL } from "./config";

/**
 * DeepSeek API 兼容 OpenAI SDK。
 *
 * 这里集中创建客户端，其他模块只需要 import deepseek。
 */
export const deepseek = new OpenAI({
  apiKey: deepseekApiKey,
  baseURL: deepseekBaseURL,
});
