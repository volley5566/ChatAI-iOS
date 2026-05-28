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

---

## 整体调用流程 & 运行机制(通俗版)

> **一句话总结**:这套 Eval 体系就像是给 AI Agent 出一张"期末考试卷",
> 每道题有标准答案的几个要点,Agent 答完后由 4 位"阅卷老师"分别打分,
> 最后汇总成一份成绩单。

### 比喻理解

想象你在学校参加考试:

| 考试环节 | 对应 Eval 体系 |
|---|---|
| **试卷**(题目 + 参考答案) | `datasets/qa.jsonl`(21 条 case) |
| **考生**(答题的人) | `lib/runAgent.ts`(把 Agent 包成纯函数来跑) |
| **答题卡**(你写的答案 + 用了什么草稿纸) | `EvalResult`(Agent 的回答 + 调了哪些 tool) |
| **4 位阅卷老师**(各看一个维度) | `evaluators/` 目录里的 4 个文件 |
| **成绩单** | `runEval.ts` 汇总输出的报告 |

### 流程图(文本版)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        npm run eval 启动                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ① 读取试卷:loadDataset("evals/datasets/qa.jsonl")                │
│     ── 逐行读 jsonl → 跳过注释/空行 → 校验字段 → 返回 EvalCase[]    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  拿到 21 条 EvalCase │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │         (逐条或并行)
              ▼                ▼                ▼
        ┌──────────┐    ┌──────────┐    ┌──────────┐
        │ case #1  │    │ case #2  │    │ case #N  │
        │ runAgent │    │ runAgent │    │ runAgent │
        │  ↓       │    │  ↓       │    │  ↓       │
        │EvalResult│    │EvalResult│    │EvalResult│
        └────┬─────┘    └────┬─────┘    └────┬─────┘
             │               │               │
             └───────────────┼───────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ② 答题完毕:现在手上有 21 个 EvalResult                            │
│     每个里面包含:Agent 的回答文本 + 实际调了哪些 tool + 耗时         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ③ 阅卷:每个 EvalResult 交给 4 位"老师"打分                       │
│                                                                     │
│     ┌─────────────┐  ┌─────────────┐  ┌────────────┐  ┌─────────┐ │
│     │ toolChoice  │  │  keyword    │  │ toolChain  │  │llmJudge │ │
│     │ "调对tool了 │  │ "包含关键   │  │ "tool顺序  │  │ "语义上 │ │
│     │  吗？"      │  │  词了吗？"  │  │  对吗？"   │  │  对吗？"│ │
│     └──────┬──────┘  └──────┬──────┘  └─────┬──────┘  └────┬────┘ │
│            │               │               │              │       │
│            ▼               ▼               ▼              ▼       │
│     ┌─────────────────────────────────────────────────────────┐    │
│     │  每位老师对每条 case 返回一个 EvaluatorOutcome:          │    │
│     │    score: 0~1 (打了几分)  或  null (这道题我不改)       │    │
│     │    reasoning: "为什么给这个分"                           │    │
│     └─────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ④ 汇总成绩单(runEval.ts)                                        │
│                                                                     │
│     ┌───────────────────────────────────────────────────────┐       │
│     │  case       toolChoice  keyword  toolChain  llmJudge │       │
│     │  rag-001    1.0         0.5      —          0.8      │       │
│     │  chat-001   1.0         —        —          —        │       │
│     │  quiz-001   0.0         1.0      0.0        0.6      │       │
│     │  ...                                                  │       │
│     │                                                       │       │
│     │  总分: 0.78    (— 表示 skip,不计入分母)              │       │
│     └───────────────────────────────────────────────────────┘       │
│                                                                     │
│     如果 --fail-below 0.7 且总分 < 0.7 → exit(1) CI 红灯           │
└─────────────────────────────────────────────────────────────────────┘
```

### 分步详解

#### 第一步:读试卷 —— `loadDataset()`

**做什么**:读 `datasets/qa.jsonl` 文件,把里面每一行 JSON 变成一个 `EvalCase` 对象。

**怎么做**:
1. 用 Node.js 的 `fs.readFile` 读取整个文件
2. 按换行符 `\n` 拆成一行一行
3. 跳过空行和注释行(`//` 或 `#` 开头的行)
4. 每行用 `JSON.parse()` 解析成 JS 对象
5. 校验必填字段(id / scenario / input / expected),格式不对就直接报错退出
6. 返回 `EvalCase[]` 数组

**Android 类比**:就像 Gson 把一个 JSON 文件反序列化成 `List<EvalCase>` 一样,
只不过这里是 jsonl(每行一个独立 JSON 对象)。好处是 Git diff 很干净——
新增一条 case 只多一行,不会像 JSON Array 那样修改首尾的 `[]`。

#### 第二步:跑 Agent —— `runAgent()`(#7 task 创建)

**做什么**:把我们真正的 LangGraph Agent 包成一个纯函数——
给它一段用户输入,它返回"回答了什么"和"调了哪些 tool"。

**为什么要"包"**:
正常的 Agent 跑在 Express 路由里,输出是 SSE 流,掺杂了 HTTP 协议细节。
Eval 不需要这些——我只想知道:
- Agent **最终说了什么**(`finalText`)
- Agent **调了哪些 tool**(`toolCalls`,按顺序)
- **花了多久**(`durationMs`)
- LangSmith 的 **trace id**(`rootRunId`,方便回看)

所以 `runAgent()` 就是把 Agent 的 SSE 输出"解包"成一个干净的 `EvalResult` 对象。

**Android 类比**:这就像你在 Android 里写单元测试时,不会启动整个 Activity,
而是直接 `new ViewModel()` 然后调它的方法。`runAgent()` 就是绕过 HTTP 层
直接调 Agent 逻辑。

#### 第三步:评分 —— 4 个 Evaluator(#8 task 创建)

每个 Evaluator 就是一个"阅卷老师",只看自己关心的那一面:

**① toolChoice(调对 tool 了吗？)**
```
- 看 expected.tools 字段
- expected.tools 没填 → 返回 null(skip,我不改这道题)
- 填了 → 检查 EvalResult.toolCalls 是否包含所有期望的 tool(不管顺序)
- 全包含 → score: 1.0
- 缺了一些 → score: 命中数 / 期望数
```
例:期望 `["searchKnowledge"]`,实际调了 `["searchKnowledge", "generateQuiz"]` → 1.0(多调不扣分)

**② keyword(回答里有关键词吗？)**
```
- 看 expected.keywords 字段
- 没填 → null(skip)
- 填了 → 对每个关键词做子串匹配(大小写不敏感)
- score = 命中关键词数 / 总关键词数
```
例:期望 `["@State", "属性包装器"]`,回答里有 `@State` 但没有 `属性包装器` → 0.5

**③ toolChain(tool 调用顺序对吗？)**
```
- 看 expected.chain 字段
- 没填 → null(skip)
- 填了 → 检查 toolCalls 的前 N 项是否完全匹配 chain 的顺序
- 完全匹配 → 1.0
- 不匹配 → 0.0(这个维度是严格的,不给半分)
```
例:期望 `["searchKnowledge", "generateQuiz"]`,实际 `["generateQuiz", "searchKnowledge"]` → 0.0

**④ llmJudge(语义上回答得对吗？)**
```
- 看 expected.reference 字段
- 没填 → null(skip)
- 填了 → 调一次 LLM(用 DeepSeek 或其他便宜模型),让它比较:
    "参考答案是 XXX,实际回答是 YYY,请给 0-1 分"
- 返回 LLM 给的分 + 理由
```
这是唯一一个**自己也要调 AI** 的 evaluator——成本最高但覆盖面最广,
可以判断"意思对了但换了个说法"这种硬规则覆盖不了的情况。

#### 第四步:汇总报告 —— `runEval.ts`(#9 task 创建)

把所有分数按 case × evaluator 的矩阵排好,计算:
- 每个 evaluator 的平均分(只算 score 不为 null 的那些 case)
- 按 scenario 分组的平均分(看哪类场景弱)
- 总分(所有有效 score 的平均)

### Evaluator 的"跳过"机制(核心设计)

这是整套系统最重要的设计决策,值得单独说清楚:

```
                   expected.tools 有值吗?
                         │
              ┌──── 有 ──┤── 没有 ────┐
              │          │             │
              ▼          │             ▼
        toolChoice       │        score: null
        正常打分         │        (跳过,不计入
        0~1 分           │         这个维度的平均分)
                         │
                   expected.keywords 有值吗?
                         │
              ┌──── 有 ──┤── 没有 ────┐
              │          │             │
              ▼          │             ▼
         keyword         │        score: null
         正常打分        ...          (跳过)
```

**为什么这么设计**:
- 不是每条 case 都能验证所有维度——闲聊题没有"期望 tool",那 toolChoice 就不该跑
- 如果把 skip 当成 0 分 → 闲聊题因为没调 tool 被扣分(不合理)
- 如果把 skip 当成 1 分 → 白白拉高平均分(也不合理)
- **null = 我不参与** → 该 case 不计入这个 evaluator 的分母

**Android 类比**:就像 RecyclerView.ViewHolder 的 `getItemViewType()`——
不是每种 ViewHolder 都需要绑定所有数据。evaluator 看到自己不认识的 case 类型
就 skip,不会因为数据不匹配而 crash。

### 数据流总结

```
qa.jsonl
  │
  │  loadDataset()
  ▼
EvalCase[]  ────  每条 case  ────  runAgent(case.input)  ────▶  EvalResult
                                                                    │
                     ┌──────────────────────────────────────────────┘
                     │
                     │  evaluator.evaluate(case, result)  × 4 个 evaluator
                     ▼
              EvaluatorOutcome[][]      (21 条 × 4 个 = 最多 84 个打分)
                     │
                     │  汇总统计
                     ▼
                 成绩单报告
                 (终端表格 + 总分 + 按场景分组)
```

### TypeScript 编译的双轨制

为什么 evals/ 有自己的 `tsconfig.json`?

```
项目根/
├── tsconfig.json          ← 主 config:rootDir=src, outDir=dist
│                             只负责 src/ → dist/ 的编译产物
│                             exclude: ["evals"](不管 evals 的事)
│
└── evals/
    └── tsconfig.json      ← Eval 专用 config:extends 主 config
                              rootDir=.. (往上一层,覆盖 src + evals)
                              noEmit=true (只做类型检查,不输出 .js)
                              include: evals/**/* + src/**/*
```

**问题背景**:evals/ 里的代码要 `import` src/ 里的代码(比如 runAgent.ts 要用
agentGraph.ts),但主 tsconfig 的 `rootDir` 是 `src/`,evals/ 在 src/ 外面。
TypeScript 会报 `"File is not under rootDir"` 错误。

**解决方案**:让 evals/ 有自己的 tsconfig,把 rootDir 放宽到项目根(`..`),
两边都在范围内就不会报错。同时 `noEmit: true` 确保不会意外输出 .js 到奇怪的地方。

**Android 类比**:就像 Android 多模块项目中 `:app` 和 `:benchmark` 有各自的
`build.gradle`——`:benchmark` 能依赖 `:app` 的代码做测试,但不会参与正式构建产出 APK。
