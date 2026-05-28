/**
 * Phase 10.2 #5 — Eval 体系的核心类型。
 *
 * 这个文件是整个 evals/ 目录的"语法"。
 * 后面所有的 evaluator(#8)、Agent 包装(#7)、runEval 主入口(#9)
 * 都引用这里的类型。先把类型定清楚,后面写代码不容易跑偏。
 *
 * 设计原则:
 * 1. **expected 全可选** —— 不是每条 case 都需要 4 个 evaluator 都跑。
 *    比如"闲聊无 tool"的 case 没 tool 要测,`tools` 留空;evaluator
 *    自己负责判断"我需要的字段在不在",不在就 skip 自己,返回 null。
 *
 * 2. **EvalResult 不存 score** —— 跑 Agent 拿到的只是"原始事实"
 *    (回答了什么、调了哪些 tool)。"这个事实算几分"是 Evaluator 的事。
 *    分开后,加新 evaluator 不用动 runAgent / EvalResult 结构。
 *
 * 3. **Evaluator 是纯函数** —— 给定 (case, result) → 给一个 EvaluatorOutcome。
 *    不该有副作用、不该读外部状态。这样 evaluator 之间可以并发跑、单独单测。
 */

/**
 * 评测场景标签。
 *
 * 7 类对应 #6 数据集里的 7 种 case。用 string literal 而不是 enum,
 * 是因为 jsonl 数据文件里写起来更自然(直接写 "rag" 而不是 EvalScenario.RAG)。
 *
 * 加新场景:直接往这个联合类型里加一个字面量即可。
 */
export type EvalScenario =
  | "rag"             // 纯 RAG 检索:期望调 searchKnowledge,回答含引用
  | "evaluate"        // 评估用户答案:期望调 evaluateAnswer
  | "recommend"       // 推荐下一步:期望调 recommendNextTopic
  | "explain"         // 解释概念:可能调 searchKnowledge,也可能不调
  | "quiz"            // 出题:期望调 generateQuiz
  | "multiturn"       // 多轮上下文:测试 history 是否被正确使用
  | "chat";           // 闲聊:期望不调任何 tool

/**
 * 单条评测用例。
 *
 * 一条 jsonl 行 = 一个 EvalCase。
 */
export type EvalCase = {
  /**
   * case 的稳定标识,用于报告里定位 + 失败回归追踪。
   * 推荐用 "{scenario}-{序号}" 比如 "rag-001",方便人眼扫。
   */
  id: string;

  /**
   * 这条 case 属于哪类场景。runEval 会按 scenario 聚合 pass rate。
   */
  scenario: EvalScenario;

  /**
   * 用户输入(就是真实场景下用户会发给 Agent 的那段话)。
   */
  input: string;

  /**
   * 期望表现。**所有字段都可选**——每条 case 只填实际能验证的那几项。
   */
  expected: {
    /**
     * 期望被调用的 tool 名集合(顺序无关)。
     * 给 toolChoice evaluator 用。
     * 例:`["searchKnowledge"]` 表示这条 case 应该至少调一次 searchKnowledge。
     * 留空 ⇒ toolChoice evaluator 跳过这条 case。
     */
    tools?: string[];

    /**
     * 期望最终回答里出现的关键词(子串匹配,大小写不敏感)。
     * 给 keyword evaluator 用。
     * 例:`["@State", "属性包装器"]` 表示回答必须同时包含这两段。
     * 留空 ⇒ keyword evaluator 跳过。
     */
    keywords?: string[];

    /**
     * 期望的 tool 调用**顺序**(序列匹配)。
     * 给 toolChain evaluator 用——比 tools 更严格,可以测多步推理顺序。
     * 例:`["searchKnowledge", "generateQuiz"]` 表示必须先查再出题。
     * 留空 ⇒ toolChain evaluator 跳过。
     */
    chain?: string[];

    /**
     * 参考答案(给 LLM judge 用)。
     * 不是"标准答案",而是"差不多就该这么回答"的样本,
     * judge 模型会比较实际回答和这个参考的语义接近度。
     * 留空 ⇒ llmJudge evaluator 跳过。
     */
    reference?: string;
  };
};

/**
 * 跑一次 Agent 得到的"原始事实"。
 *
 * 注意:这里**不含分数**。分数是 Evaluator 的工作。
 *
 * 一条 EvalCase 跑一次 → 一个 EvalResult → 喂给所有 evaluator 各打一份分。
 */
export type EvalResult = {
  /**
   * 对应哪条 case(用 case.id 关联)。
   */
  caseId: string;

  /**
   * Agent 给出的最终回答文本(没有工具步骤、没有 SSE 包装,纯文本)。
   */
  finalText: string;

  /**
   * Agent 在跑这条 case 时**实际**调用了哪些 tool,按调用顺序。
   * 给 toolChoice / toolChain evaluator 用。
   * 例:`["searchKnowledge", "searchKnowledge"]`(同一个 tool 调两次也算两条)。
   */
  toolCalls: string[];

  /**
   * LangSmith 这次跑的根 run id。
   * 可选——LangSmith 没开时为 undefined。
   * 用途:报告里直接给一条 LangSmith trace 链接,可以一键回看现场。
   */
  rootRunId?: string;

  /**
   * 端到端耗时,毫秒。用于报告里展示性能维度。
   */
  durationMs: number;

  /**
   * Agent 跑出异常时存这里——case 仍然"跑过"但所有 evaluator 都会被跳过。
   * 这样报告能区分"跑失败"和"跑成功但评分低"两种情况。
   */
  error?: string;
};

/**
 * 单个 evaluator 对一条 case 的评分结果。
 *
 * **score 为 null 表示"这个 evaluator 不适用这条 case"**(因为对应的
 * expected 字段为空),报告里这条 case 不计入该 evaluator 的分母。
 *
 * 这是 #5 设计里最关键的一个决定:不可用 ≠ 失败。
 */
export type EvaluatorOutcome = {
  /**
   * 0..1 浮点分;null 表示 skip。
   * 用 number 而不是 boolean,是给将来"半对"留出表达空间
   * (比如 chain evaluator 命中 50% 顺序应该是 0.5,不是 false)。
   */
  score: number | null;

  /**
   * 可选的人类可读理由,主要给 LLM judge 用(judge 模型会同时给分 + 理由)。
   * 其它 evaluator 也可以填(比如"期望 tools=[searchKnowledge] 但实际调了 generateQuiz")。
   */
  reasoning?: string;
};

/**
 * Evaluator 接口——4 个评分器都实现这个。
 *
 * 纯函数:给一条 case + 它的运行结果 → 算出分数。
 * 不允许有副作用(不能写文件、不能改全局状态)。
 *
 * `async` 是因为 LLM judge 内部要调模型;其它几个其实是同步的,
 * 但统一签名让 runEval 里能用 Promise.all 并行跑所有 evaluator。
 */
export type Evaluator = {
  /**
   * 评分器名字,会出现在报告列名里。例:"toolChoice" / "keyword" / "llmJudge"。
   */
  name: string;

  /**
   * 评分逻辑。
   */
  evaluate: (
    evalCase: EvalCase,
    result: EvalResult
  ) => Promise<EvaluatorOutcome>;
};
