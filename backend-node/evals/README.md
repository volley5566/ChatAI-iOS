# Eval 体系(Phase 10.2)

这个目录是给 Agent 做"自动评测"的小工厂——给一批输入 case → 跑 Agent → 多个评分器自动打分 → 出报告。

> **为什么需要这个**:没这套东西,改 prompt 完全凭感觉,改完不知道是变好还是变坏。
> 有了它,改完跑一次 `npm run eval`(#9 task 引入)看分数升降。

---

## 目录结构

```
evals/
├── README.md                  ← 你正在看
├── datasets/
│   └── qa.jsonl               ← 测试用例(jsonl 格式,一行一条 case)
├── evaluators/                ← 4 个评分器(每个评一个维度)
│   ├── toolChoice.ts          ← 期望 tool 是否被调用
│   ├── keyword.ts             ← 回答是否包含关键词
│   ├── toolChain.ts           ← tool 调用顺序是否匹配
│   └── llmJudge.ts            ← 用 LLM 比较实际回答 vs 参考答案
├── lib/
│   ├── types.ts               ← 核心类型(EvalCase / EvalResult / Evaluator)
│   ├── dataset.ts             ← loadDataset() 读 jsonl
│   └── runAgent.ts            ← 把 Agent 包成纯函数(无 SSE 包装,#7 task 引入)
└── runEval.ts                 ← 主入口(#9 task 引入)
```

**目前状态(#5 完成时)**:`lib/types.ts`、`lib/dataset.ts`、本 README 已就绪。
其它文件由后续 task(#6/#7/#8/#9)填充。

---

## 核心概念

### 一条 case 长什么样

每条 case 是 jsonl 一行,例如:

```json
{"id":"rag-001","scenario":"rag","input":"什么是 SwiftUI @State","expected":{"tools":["searchKnowledge"],"keywords":["@State","属性包装器"]}}
```

- **id**:稳定标识(推荐 `{scenario}-{序号}`)
- **scenario**:7 类之一(见下)
- **input**:用户输入(就是真实场景下用户会发的话)
- **expected**:期望表现,**全字段可选**——只写实际能验证的那几项

### 7 类场景

| scenario | 含义 | 期望调的 tool |
|---|---|---|
| `rag` | 纯 RAG 检索 | `searchKnowledge` |
| `evaluate` | 评估用户答案 | `evaluateAnswer` |
| `recommend` | 推荐下一步 | `recommendNextTopic` |
| `explain` | 解释概念 | 可能调 `searchKnowledge`,也可能不调 |
| `quiz` | 出题 | `generateQuiz` |
| `multiturn` | 多轮上下文 | 取决于内容,主要测 history 是否被用上 |
| `chat` | 闲聊 | **不调任何 tool** |

### 4 个评分维度

| evaluator | 评什么 | 看 expected 里的 |
|---|---|---|
| `toolChoice` | Agent 是否调了期望的 tool(顺序无关) | `tools` |
| `keyword` | 回答是否包含期望关键词(子串匹配,大小写不敏感) | `keywords` |
| `toolChain` | tool 调用顺序是否完全匹配(更严格) | `chain` |
| `llmJudge` | LLM 比较实际回答 vs 参考答案的语义接近度 | `reference` |

**关键设计**:每个 evaluator 看自己关心的字段——字段没填就 **skip 这条 case**
(`EvaluatorOutcome.score = null`)。这样数据集写起来不用每条都凑齐 4 个字段,
evaluator 之间完全解耦。

---

## 怎么扩展

### 加新 case
直接往 `datasets/qa.jsonl` 末尾追加一行 JSON 就行,**不用动任何代码**。
注释:行首加 `//` 或 `#` 即可,加载器会自动跳过。

### 加新场景类型
1. 在 `lib/types.ts` 的 `EvalScenario` 联合类型里加新字面量
2. 在 `lib/dataset.ts` 的 `isValidScenario()` 列表里加同一个字面量
3. 往数据集里加用 这个 scenario 的 case
4. (可选)如果新场景需要专门的 evaluator,去 `evaluators/` 里加一个文件

### 加新 evaluator(打新维度的分)
在 `evaluators/` 加个新文件,导出一个实现 `Evaluator` 接口的对象,
然后在 `runEval.ts` 里 import 并加进 evaluator 列表。

---

## 运行(#9 task 引入,#5 还跑不起来)

```bash
# 跑全量
npm run eval

# 只跑前 5 条(给 CI / PR 检查用,省 token)
npm run eval -- --quick

# 总分低于 0.7 → process.exit(1)(给 CI gating 用)
npm run eval -- --fail-below 0.7

# 用其它数据集
npm run eval -- --dataset evals/datasets/my-dataset.jsonl
```
