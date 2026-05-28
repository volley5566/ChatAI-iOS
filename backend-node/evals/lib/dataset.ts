import { readFile } from "node:fs/promises";

import type { EvalCase, EvalScenario } from "./types";

/**
 * Phase 10.2 #5 — 数据集加载器。
 *
 * 职责单一:**读 jsonl 文件 → 校验每行 → 返回 EvalCase 数组**。
 *
 * 为什么用 jsonl 不用 json/yaml/ts:
 *
 * - **追加友好** —— 加一条 case 就是 append 一行,Git diff 干净,
 *   也不会因为某行格式错让整个文件解析失败(可以选择性 skip 坏行)
 *
 * - **流式友好** —— 数据集小的时候没区别;一旦上千条,可以一行一行流式加载
 *   而不用一次性 JSON.parse 整个文件(当前实现还是一次读完,但格式预留了升级空间)
 *
 * - **行 = 记录** —— 这是工业界(OpenAI / Anthropic / LangSmith)
 *   evaluation dataset 的事实标准。学习项目跟主流走,以后想推到 LangSmith
 *   Dataset 不用做格式转换。
 *
 * 行内允许的格式:
 *   - 标准 JSON 对象(必须单行,内部不能换行,因为换行符在 jsonl 里是记录分隔)
 *   - 纯空行 → 跳过
 *   - `//` 或 `#` 开头的行 → 跳过(给写数据集时加注释用,严格 jsonl 不支持
 *     这两种但这里宽松一点,便于学习时给 case 写中文注释)
 */

/**
 * 默认数据集相对路径(相对项目根/CWD)。
 * runEval 主入口(#9)可以用 CLI 参数覆盖。
 */
export const DEFAULT_DATASET_PATH = "evals/datasets/qa.jsonl";

/**
 * 加载并校验数据集。
 *
 * 失败模式:
 * - 文件读不到 → 抛 Error(原样把 fs 错误冒出去,让 runEval 直接 fail)
 * - 某行 JSON.parse 失败 → 抛 Error,带行号(给你看错在哪)
 * - 某行字段不全(没 id / scenario / input / expected)→ 抛 Error
 *
 * 严格 fail-fast 的理由:数据集错了应该立刻让整个 eval 红,
 * 而不是静默用脏数据出报告。
 */
export async function loadDataset(
  path: string = DEFAULT_DATASET_PATH
): Promise<EvalCase[]> {
  const raw = await readFile(path, "utf-8");

  const cases: EvalCase[] = [];
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1; // 给报错用的人类可读行号(从 1 开始)
    const line = lines[i].trim();

    /**
     * 跳过空行 + 注释行。
     * 这是对严格 jsonl 的宽容扩展——方便写数据集时按场景分组加中文说明。
     */
    if (!line || line.startsWith("//") || line.startsWith("#")) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `[loadDataset] JSON parse failed at ${path}:${lineNumber} — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const validated = validateCase(parsed, `${path}:${lineNumber}`);
    cases.push(validated);
  }

  return cases;
}

/**
 * 校验一行解出来的对象是不是合法 EvalCase。
 *
 * 不做完美 schema 校验(那个交给 zod / ajv),只挡最常见的错:
 * 字段缺失、类型错。expected 子字段类型也粗略 check,
 * 数据集格式跑偏第一次跑就会立刻报错,不会到后面 evaluator 才挂。
 */
function validateCase(value: unknown, location: string): EvalCase {
  if (!value || typeof value !== "object") {
    throw new Error(`[loadDataset] ${location} — 不是对象`);
  }
  const obj = value as Record<string, unknown>;

  /**
   * 必填字段挨个检查 + 给出精准错误信息。
   * 错误信息里带 location(文件路径+行号),你打开 jsonl 一搜就能定位。
   */
  if (typeof obj.id !== "string" || !obj.id.trim()) {
    throw new Error(`[loadDataset] ${location} — 缺 id 或 id 不是字符串`);
  }
  if (!isValidScenario(obj.scenario)) {
    throw new Error(
      `[loadDataset] ${location} — scenario 必须是: rag/evaluate/recommend/explain/quiz/multiturn/chat,实际:${String(obj.scenario)}`
    );
  }
  if (typeof obj.input !== "string" || !obj.input.trim()) {
    throw new Error(`[loadDataset] ${location} — 缺 input 或 input 不是字符串`);
  }
  if (!obj.expected || typeof obj.expected !== "object") {
    throw new Error(`[loadDataset] ${location} — 缺 expected 字段`);
  }

  const expected = obj.expected as Record<string, unknown>;

  /**
   * expected 内部字段全可选,但只要存在就要类型正确。
   * 这一段比较啰嗦,但每条 case 在数据集里只写一次,加载校验出错的成本远小于
   * 跑到 evaluator 里才 crash 的成本。
   */
  const tools = optionalStringArray(expected.tools, `${location} expected.tools`);
  const keywords = optionalStringArray(expected.keywords, `${location} expected.keywords`);
  const chain = optionalStringArray(expected.chain, `${location} expected.chain`);
  const reference =
    expected.reference === undefined
      ? undefined
      : typeof expected.reference === "string"
        ? expected.reference
        : (() => {
            throw new Error(`[loadDataset] ${location} expected.reference 必须是字符串`);
          })();

  return {
    id: obj.id,
    scenario: obj.scenario as EvalScenario,
    input: obj.input,
    expected: { tools, keywords, chain, reference },
  };
}

/**
 * 把 scenario 字段收窄到合法字面量集合。
 * 加新场景时,**只需要在两个地方同步**:这里的列表 + types.ts 的 EvalScenario 联合类型。
 */
function isValidScenario(value: unknown): value is EvalScenario {
  return (
    value === "rag" ||
    value === "evaluate" ||
    value === "recommend" ||
    value === "explain" ||
    value === "quiz" ||
    value === "multiturn" ||
    value === "chat"
  );
}

/**
 * 校验"可选的 string[]"字段。
 * - 字段不存在 → 返回 undefined(代表 evaluator 应该跳过)
 * - 字段存在但不是 string[] → 抛错
 * - 是 string[] → 原样返回
 */
function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`[loadDataset] ${label} 必须是 string[],实际:${JSON.stringify(value)}`);
  }
  return value;
}
