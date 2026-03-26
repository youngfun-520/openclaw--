/**
 * 端到端验证：动态 prompt 核心管道
 *
 * 验证 registerToolKnowledge → classifyIntent → retrieveKnowledge 管道
 * 不依赖 pi-embedded-runner，避免 extensions 模块导入问题
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  getKnowledgeRegistry,
  registerToolKnowledge,
  registerSectionKnowledge,
  type ToolKnowledgeInput,
} from "./knowledge-index.js";
import {
  retrieveKnowledge,
  formatRetrievedKnowledge,
} from "./knowledge-retriever.js";
import { classifyIntent } from "./intent-classifier.js";

// ── 模拟 OpenClaw 的真实工具集（精简版） ──

const MOCK_TOOLS: ToolKnowledgeInput[] = [
  {
    name: "read",
    description:
      "Read the contents of a file at the given path. Supports text files up to 100MB. Returns the file content as a string.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write",
    description:
      "Write content to a file at the given path. Creates parent directories if needed. Overwrites existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Apply a search-and-replace edit to an existing file. The old_string must be an exact match.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "exec",
    description:
      "Execute a shell command in the runtime environment. Commands run in bash. Returns stdout and stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description: "Search for files matching a glob pattern. Returns matching file paths.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search for a pattern in file contents. Supports regex. Returns matching lines with context.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "knowledge_search",
    description:
      "Search the system knowledge base for tool usage, safety rules, or operation guides.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "cron",
    description: "Manage scheduled cron jobs. Create, list, update, or delete recurring tasks.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: [],
    },
  },
  {
    name: "browser",
    description: "Control a web browser. Navigate, take screenshots, fill forms, click elements.",
    parameters: {
      type: "object",
      properties: { action: { type: "string" } },
      required: [],
    },
  },
];

const MOCK_SECTIONS = [
  {
    id: "safety",
    title: "## Safety Rules",
    content:
      "Prioritize safety and human oversight over completion. If instructions conflict, pause and ask. Do not manipulate or persuade anyone to expand access.",
    tags: ["safety", "important"],
  },
  {
    id: "sandbox",
    title: "## Sandbox",
    content:
      "Running in Docker sandbox. Some tools may be unavailable. File paths are relative to the sandbox container.",
    tags: ["sandbox", "docker"],
  },
  {
    id: "messaging",
    title: "## Messaging",
    content:
      "Reply routes to source channel automatically. Use message tool for proactive sends.",
    tags: ["messaging", "channel"],
  },
  {
    id: "tool_call_style",
    title: "## Tool Call Style",
    content:
      "Default: do not narrate routine, low-risk tool calls (just call the tool). Narrate only when it helps: multi-step work, complex/challenging problems.",
    tags: ["tooling", "style"],
  },
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

describe("动态 prompt 核心管道验证", () => {
  beforeEach(() => {
    getKnowledgeRegistry().clear();
  });

  it("Step 1: registerToolKnowledge 正确填充知识库", () => {
    registerToolKnowledge(MOCK_TOOLS);
    registerSectionKnowledge(MOCK_SECTIONS);

    const registry = getKnowledgeRegistry();
    // 每个工具产生 desc + schema 两个 chunk，外加一个 tool.index
    const expectedChunks = MOCK_TOOLS.length * 2 + 1;
    expect(registry.size).toBe(expectedChunks);

    // 验证每个工具都有 desc 和 schema
    for (const tool of MOCK_TOOLS) {
      const desc = registry.get(`tool.${tool.name.toLowerCase()}.desc`);
      const schema = registry.get(`tool.${tool.name.toLowerCase()}.schema`);
      expect(desc).toBeDefined();
      expect(schema).toBeDefined();
      expect(desc!.content).toContain(tool.description);
    }

    // 验证 tool.index
    const index = registry.getToolIndex();
    expect(index).toBeDefined();
    expect(index!.content).toContain("read");
    expect(index!.content).toContain("write");
    expect(index!.content).toContain("exec");
  });

  it("Step 2: classifyIntent 为不同意图提供不同 tool tags", () => {
    const fileOps = classifyIntent("帮我读取 main.ts 文件的内容");
    const shellOps = classifyIntent("运行 npm install 安装依赖");
    const greeting = classifyIntent("你好，今天天气怎么样");
    const cronOps = classifyIntent("设置一个每天早上 9 点的提醒");

    console.log(`  → 文件操作: tags=[${fileOps.toolTags.join(", ")}]`);
    console.log(`  → 命令执行: tags=[${shellOps.toolTags.join(", ")}]`);
    console.log(`  → 简单对话: tags=[${greeting.toolTags.join(", ")}]`);
    console.log(`  → 定时任务: tags=[${cronOps.toolTags.join(", ")}]`);

    // 文件操作应包含 read
    expect(fileOps.toolTags).toContain("read");
    // 命令执行应包含 exec
    expect(shellOps.toolTags).toContain("exec");
    // 定时任务应包含 cron
    expect(cronOps.toolTags).toContain("cron");
  });

  it("Step 3: retrieveKnowledge 使用 tags 检索到正确的知识", () => {
    registerToolKnowledge(MOCK_TOOLS);
    registerSectionKnowledge(MOCK_SECTIONS);

    // 文件操作意图
    const fileResult = retrieveKnowledge({
      query: "读取文件",
      toolTags: ["read"],
      sectionTags: [],
    });
    expect(fileResult.chunks.length).toBeGreaterThan(0);
    const readChunks = fileResult.chunks.filter((c) => c.id.includes("read"));
    expect(readChunks.length).toBeGreaterThan(0);

    // 命令执行意图
    const execResult = retrieveKnowledge({
      query: "运行命令",
      toolTags: ["exec"],
      sectionTags: [],
    });
    const execChunks = execResult.chunks.filter((c) => c.id.includes("exec"));
    expect(execChunks.length).toBeGreaterThan(0);

    // Section 检索
    const safetyResult = retrieveKnowledge({
      query: "安全规则",
      toolTags: [],
      sectionTags: ["safety"],
    });
    const safetyChunks = safetyResult.chunks.filter((c) => c.id.includes("safety"));
    expect(safetyChunks.length).toBeGreaterThan(0);

    console.log(`  → "read" 查询: ${fileResult.chunks.length} chunks (read相关 ${readChunks.length})`);
    console.log(`  → "exec" 查询: ${execResult.chunks.length} chunks (exec相关 ${execChunks.length})`);
    console.log(`  → "safety" 查询: ${safetyResult.chunks.length} chunks (safety相关 ${safetyChunks.length})`);
  });

  it("Step 4: 完整管道 — 用户消息 → 分类 → 检索 → 格式化输出", () => {
    registerToolKnowledge(MOCK_TOOLS);
    registerSectionKnowledge(MOCK_SECTIONS);

    // 模拟：用户说 "帮我创建一个 hello.txt 文件"
    const userMessage = "帮我创建一个 hello.txt 文件";
    const classification = classifyIntent(userMessage);

    const retrieval = retrieveKnowledge({
      query: userMessage,
      toolTags: classification.toolTags,
      sectionTags: classification.sectionTags,
      tokenBudget: 1500,
    });

    const formatted = formatRetrievedKnowledge(retrieval.chunks);

    console.log(`\n  用户消息: "${userMessage}"`);
    console.log(`  分类 tags: [${classification.toolTags.join(", ")}] + [${classification.sectionTags.join(", ")}]`);
    console.log(`  检索到 ${retrieval.chunks.length} chunks, ${retrieval.estimatedTokens} tokens`);
    console.log(`  截断: ${retrieval.truncated}`);
    console.log(`  格式化输出长度: ${formatted.length} chars\n`);

    // 应该检索到 write 工具
    expect(retrieval.chunks.length).toBeGreaterThan(0);
    // 格式化输出应包含工具内容
    expect(formatted.length).toBeGreaterThan(0);

    // 关键验证：不同意图检索到的 chunks 内容不同
    const fileMessage = "读取 main.ts 的内容";
    const fileRetrieval = retrieveKnowledge({
      query: fileMessage,
      toolTags: classifyIntent(fileMessage).toolTags,
      sectionTags: [],
    });

    const shellMessage = "运行 npm test";
    const shellRetrieval = retrieveKnowledge({
      query: shellMessage,
      toolTags: classifyIntent(shellMessage).toolTags,
      sectionTags: [],
    });

    const fileIds = new Set(fileRetrieval.chunks.map((c) => c.id));
    const shellIds = new Set(shellRetrieval.chunks.map((c) => c.id));

    // 文件操作应命中 read，命令执行应命中 exec
    expect([...fileIds].some((id) => id.includes("read"))).toBe(true);
    expect([...shellIds].some((id) => id.includes("exec"))).toBe(true);
    // 两者检索结果应有差异
    const overlap = [...fileIds].filter((id) => shellIds.has(id)).length;
    const overlapRatio = overlap / Math.max(fileIds.size, shellIds.size, 1);
    expect(overlapRatio).toBeLessThan(0.8); // 不完全重叠
  });

  it("Step 5: Token 预算验证 — 检索结果受 budget 控制", () => {
    registerToolKnowledge(MOCK_TOOLS);
    registerSectionKnowledge(MOCK_SECTIONS);

    // 大 budget 应返回更多 chunks
    const bigBudget = retrieveKnowledge({
      query: "工具使用方法",
      toolTags: ["read", "write", "exec", "glob", "grep"],
      sectionTags: ["safety", "tooling", "sandbox", "messaging"],
      tokenBudget: 10000,
    });

    const smallBudget = retrieveKnowledge({
      query: "工具使用方法",
      toolTags: ["read", "write", "exec", "glob", "grep"],
      sectionTags: ["safety", "tooling", "sandbox", "messaging"],
      tokenBudget: 500,
    });

    console.log(`  → 大 budget (10K): ${bigBudget.chunks.length} chunks, ${bigBudget.estimatedTokens} tokens`);
    console.log(`  → 小 budget (500): ${smallBudget.chunks.length} chunks, ${smallBudget.estimatedTokens} tokens`);
    console.log(`  → 截断: big=${bigBudget.truncated}, small=${smallBudget.truncated}`);

    // 大 budget 不应截断，小 budget 应截断
    expect(bigBudget.truncated).toBe(false);
    expect(smallBudget.truncated).toBe(true);
    // 小 budget 的 chunks 数应更少
    expect(smallBudget.chunks.length).toBeLessThan(bigBudget.chunks.length);
  });

  it("关键指标：按需检索比全量注入节省大量 tokens", () => {
    registerToolKnowledge(MOCK_TOOLS);

    // 模拟：9 个工具，但用户只需要 1-2 个
    // 全量：所有工具的 desc + schema
    const allToolContent = MOCK_TOOLS.map((t) => t.description + JSON.stringify(t.parameters)).join("\n");
    const fullTokens = estimateTokens(allToolContent);

    // 按需：只检索 1-2 个工具
    const retrieval = retrieveKnowledge({
      query: "创建文件",
      toolTags: ["write"],
      sectionTags: [],
      tokenBudget: 1500,
    });
    const onDemandTokens = retrieval.estimatedTokens;

    const savings = Math.round((1 - onDemandTokens / fullTokens) * 100);
    console.log(`\n  全量注入所有工具: ~${fullTokens} tokens`);
    console.log(`  按需检索 write 工具: ~${onDemandTokens} tokens`);
    console.log(`  节省: ${savings}%\n`);

    // 按需应该比全量少至少 50%
    expect(onDemandTokens).toBeLessThan(fullTokens * 0.5);
    expect(savings).toBeGreaterThan(50);
  });
});
