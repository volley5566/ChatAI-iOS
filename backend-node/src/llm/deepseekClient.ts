import OpenAI from "openai";
import { deepseekBaseURL, requireDeepSeekApiKey } from "../config/env";

/**
 * DeepSeek API 兼容 OpenAI SDK。
 *
 * 这里集中创建客户端，其他模块只需要 import deepseek。
 */
export const deepseek = new OpenAI({
  apiKey: requireDeepSeekApiKey(),
  baseURL: deepseekBaseURL,
});
