/**
 * Local stand-in for DeepSeek's Search / Fetch API.
 *
 * Used only for UI development and screenshots. The real app talks to
 * https://api.deepseek.com unless DEEPSEEK_API_BASE is explicitly overridden.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4100);
const HOST = '127.0.0.1';

const seeds = [
  {
    title: 'DeepSeek V4 正式发布：更强推理、更长上下文与原生多模态',
    url: 'https://www.deepseek.com/news/deepseek-v4',
    site: 'DeepSeek',
    snippet:
      'DeepSeek V4 已正式开放。新模型在复杂推理、代码生成和长上下文任务上均有明显提升，并首次支持原生多模态输入。API 从今天起开放升级。',
    date: '2026-10-18T02:30:00+00:00',
    authority: 4,
    score: 2.9,
  },
  {
    title: 'DeepSeek V4 技术报告解读：稀疏注意力、强化学习与训练效率',
    url: 'https://www.zhihu.com/question/123456789/answer/9876543210',
    site: '知乎',
    snippet:
      '从技术报告看，V4 的核心变化在于更高效的稀疏注意力和新一轮强化学习配方。本文拆解模型架构、训练数据与评测结果，并讨论这些改进对推理成本的影响。',
    date: '2026-10-19T11:12:00+00:00',
    authority: 2,
    score: 2.7,
  },
  {
    title: 'DeepSeek V4 API 文档：模型能力、上下文长度与定价',
    url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    site: 'DeepSeek API Docs',
    snippet:
      '查看 DeepSeek V4 系列模型的上下文窗口、最大输出长度、工具调用能力与每百万 tokens 的输入输出价格，并了解缓存命中时的计费方式。',
    date: '2026-10-18T06:00:00+00:00',
    authority: 4,
    score: 2.8,
  },
  {
    title: '如何评价 DeepSeek 刚刚发布的 V4 模型？',
    url: 'https://www.zhihu.com/question/987654321',
    site: '知乎',
    snippet:
      'V4 发布后，社区讨论集中在真实任务表现、多模态能力和开源权重上。多位开发者分享了编程、文档分析与 Agent 工作流中的实测体验。',
    date: '2026-10-18T13:40:00+00:00',
    authority: 2,
    score: 2.5,
  },
  {
    title: 'deepseek-ai/DeepSeek-V4 · Hugging Face',
    url: 'https://huggingface.co/deepseek-ai/DeepSeek-V4',
    site: 'Hugging Face',
    snippet:
      'DeepSeek-V4 model card with architecture details, evaluation tables, intended use, limitations, and deployment notes for both reasoning and non-reasoning modes.',
    date: '2026-10-18T08:15:00+00:00',
    authority: 3,
    score: 2.6,
  },
  {
    title: 'DeepSeek-V4: Open-Weight Models with Native Multimodal Reasoning',
    url: 'https://arxiv.org/abs/2610.01234',
    site: 'arXiv',
    snippet:
      'We present DeepSeek-V4, a family of open-weight language models with improved long-context reasoning, vision understanding, and tool use. We report benchmark results and ablations.',
    date: '2026-10-17T16:05:00+00:00',
    authority: 4,
    score: 2.4,
  },
  {
    title: 'DeepSeek V4 发布，AI 应用开发者有哪些新机会？',
    url: 'https://36kr.com/p/3000000000000000',
    site: '36氪',
    snippet:
      '更低的推理成本和更强的 Agent 能力，可能让长流程自动化、企业知识库和端侧应用迎来新的产品窗口。本文采访了多位 AI 创业者与投资人。',
    date: '2026-10-20T01:20:00+00:00',
    authority: 2,
    score: 2.2,
  },
  {
    title: 'DeepSeek V4 实测：代码能力、多模态与 1M 长文本',
    url: 'https://sspai.com/post/998877',
    site: '少数派',
    snippet:
      '我们用真实项目测试了 V4 的代码重构、截图理解和超长文档问答。它在复杂指令遵循上表现稳定，但多模态细节识别仍有提升空间。',
    date: '2026-10-19T09:00:00+00:00',
    authority: 2,
    score: 2.3,
  },
  {
    title: 'DeepSeek V4 发布会全程回顾（完整版）',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    site: '哔哩哔哩',
    snippet:
      '发布会完整录像：模型能力演示、技术路线介绍、API 价格公布以及开发者问答环节。视频附有章节时间轴和关键数据整理。',
    date: '2026-10-18T14:30:00+00:00',
    authority: 1,
    score: 1.9,
  },
  {
    title: 'DeepSeek V4 is here: benchmarks, pricing, and what changed',
    url: 'https://www.theverge.com/2026/10/18/deepseek-v4-release',
    site: 'The Verge',
    snippet:
      'DeepSeek released V4 with native multimodal input and a larger context window. The company says the model is cheaper to serve, while independent testers are still checking the claims.',
    date: '2026-10-18T17:45:00+00:00',
    authority: 3,
    score: 2.1,
  },
  {
    title: 'DeepSeek V4 与主流大模型基准测试对比',
    url: 'https://github.com/deepseek-ai/benchmarks-v4',
    site: 'GitHub',
    snippet:
      '包含数学、代码、长上下文与多模态任务的复现脚本和原始评测结果。仓库同时提供了不同推理预算下的性能对比与消融实验数据。',
    date: '2026-10-19T04:10:00+00:00',
    authority: 3,
    score: 2.0,
  },
  {
    title: 'DeepSeek V4 模型升级公告与迁移指南',
    url: 'https://platform.deepseek.com/docs/migration/v4',
    site: 'DeepSeek Platform',
    snippet:
      '了解原有模型名称如何映射到 V4 系列、SDK 需要哪些改动，以及推理模式、JSON 输出和函数调用的参数变化。建议在升级前阅读兼容性说明。',
    date: '2026-10-18T03:00:00+00:00',
    authority: 4,
    score: 2.5,
  },
  {
    title: '大模型价格战继续：DeepSeek V4 把长上下文成本打下来了',
    url: 'https://www.qbitai.com/2026/10/123456.html',
    site: '量子位',
    snippet:
      'V4 在保持输出质量的同时进一步降低了长文本推理成本。业内分析认为，缓存定价和批处理能力将成为下一阶段 API 竞争的关键。',
    date: '2026-10-19T00:30:00+00:00',
    authority: 2,
    score: 2.0,
  },
  {
    title: 'Using DeepSeek V4 for agentic coding: early impressions',
    url: 'https://simonwillison.net/2026/Oct/19/deepseek-v4/',
    site: 'Simon Willison’s Weblog',
    snippet:
      'I ran V4 against a handful of tool-use and coding tasks. The model follows multi-step instructions well, and the new context limit changes how much repository state you can keep in the prompt.',
    date: '2026-10-19T22:10:00+00:00',
    authority: 3,
    score: 2.2,
  },
  {
    title: 'DeepSeek V4 多模态能力上手：图片理解、OCR 与图表问答',
    url: 'https://www.jiqizhixin.com/articles/deepseek-v4-multimodal',
    site: '机器之心',
    snippet:
      '本文用文档截图、复杂图表和手写笔记测试了 V4 的视觉理解能力，并对比了不同提示词下的输出稳定性与延迟表现。',
    date: '2026-10-20T02:15:00+00:00',
    authority: 2,
    score: 2.1,
  },
  {
    title: 'DeepSeek V4 发布后，推理基础设施会怎么变？',
    url: 'https://www.infoq.cn/article/deepseek-v4-infra',
    site: 'InfoQ',
    snippet:
      '从 MoE 路由、KV Cache 到推理集群调度，V4 的设计给基础设施团队带来了新的优化空间。几位工程师分享了部署侧需要关注的变化。',
    date: '2026-10-19T15:20:00+00:00',
    authority: 2,
    score: 1.8,
  },
  {
    title: 'DeepSeek V4 常见问题：模型选择、上下文与限流',
    url: 'https://api-docs.deepseek.com/zh-cn/faq/v4',
    site: 'DeepSeek API Docs',
    snippet:
      '汇总开发者最常问的问题：应该选择 V4 还是 V4 Flash？上下文如何计费？遇到 429 怎么办？以及如何开启流式输出和工具调用。',
    date: '2026-10-18T05:20:00+00:00',
    authority: 4,
    score: 2.4,
  },
  {
    title: 'DeepSeek V4 本地部署初体验：显存占用与量化方案',
    url: 'https://zhuanlan.zhihu.com/p/700000000',
    site: '知乎专栏',
    snippet:
      '在双卡工作站上测试 V4 不同量化版本的加载速度、显存占用和吞吐。文中提供了部署脚本、常见报错处理与推理参数建议。',
    date: '2026-10-20T06:40:00+00:00',
    authority: 1,
    score: 1.7,
  },
  {
    title: 'DeepSeek V4：一次面向 Agent 时代的模型更新',
    url: 'https://www.geekpark.net/news/340000',
    site: '极客公园',
    snippet:
      '相比单纯追求榜单分数，V4 更强调工具调用、长任务规划和多模态输入。这些能力如何影响下一代 AI 产品的设计？',
    date: '2026-10-19T05:05:00+00:00',
    authority: 2,
    score: 1.9,
  },
  {
    title: 'What’s new in DeepSeek V4 — release notes',
    url: 'https://api-docs.deepseek.com/news/v4',
    site: 'DeepSeek API Docs',
    snippet:
      'Release notes for the V4 model family: new model IDs, context limits, maximum output tokens, tool-calling updates, and the migration timeline for older model aliases.',
    date: '2026-10-18T02:45:00+00:00',
    authority: 4,
    score: 2.6,
  },
];

const article = `# DeepSeek V4 正式发布：更强推理、更长上下文与原生多模态

DeepSeek V4 已正式开放使用。此次更新面向复杂推理、代码生成、长文档分析和 Agent 工作流，在多模态理解与工具调用方面也带来了明显改进。

## 核心更新

- **原生长上下文**：支持最高 1M tokens 的上下文窗口，适合代码仓库与长篇文档分析。
- **原生多模态输入**：可以直接理解图片、截图、图表和扫描文档。
- **更稳定的工具调用**：改进多步任务中的函数选择与参数生成。
- **更低的缓存价格**：重复前缀命中缓存时，输入成本显著降低。

> V4 不只是一次参数规模升级，而是围绕真实工作任务重新设计的模型系列。

## API 快速开始

\`\`\`bash
curl https://api.deepseek.com/chat/completions \\
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek-v4",
    "messages": [{"role": "user", "content": "你好"}]
  }'
\`\`\`

所有新模型都可以通过现有 SDK 调用。旧模型名称将在迁移期内继续可用，具体时间表见[升级指南](https://api-docs.deepseek.com/)。

## 评测结果

| 评测项目 | V4 | 上一代 | 变化 |
| --- | --- | --- | --- |
| 推理 | 89.4 | 84.1 | +5.3 |
| 代码 | 82.7 | 78.9 | +3.8 |
| 长文本 | 91.2 | 84.6 | +6.6 |

*以上数据来自内部评测，实际表现会因任务和提示词而异。*

## 开始使用

开发者可以在 DeepSeek 开放平台创建 API Key，并通过 Search / Fetch API 为应用接入实时网页内容。更多信息请访问官方文档。`;

function makeResults(query, count) {
  return seeds.slice(0, Math.min(count, seeds.length)).map((seed) => ({
    rerank_score: seed.score,
    title: query && !/deepseek/i.test(query) ? `${query} — ${seed.title}` : seed.title,
    url: seed.url,
    snippet: seed.snippet,
    summary: `${seed.snippet} ${seed.snippet} 这是一段更长的摘要，用于给模型提供额外上下文，不会直接显示在搜索结果中。`,
    content: '',
    site_name: seed.site,
    site_icon: null,
    date: seed.date,
    authority: seed.authority,
  }));
}

const server = createServer(async (request, response) => {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;

  const payload = (() => {
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      return {};
    }
  })();

  if (request.url === '/v1/tools/search') {
    const query = typeof payload.query === 'string' ? payload.query : '';
    const count = Number.isInteger(payload.count) ? payload.count : 10;
    await new Promise((resolve) => setTimeout(resolve, 320));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ results: makeResults(query, count) }));
    return;
  }

  if (request.url === '/v1/tools/fetch') {
    await new Promise((resolve) => setTimeout(resolve, 480));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ title: 'DeepSeek V4 正式发布', content: article }));
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Mock route not found.' } }));
});

server.listen(PORT, HOST, () => {
  console.log(`Mock DeepSeek API listening at http://${HOST}:${PORT}`);
});
