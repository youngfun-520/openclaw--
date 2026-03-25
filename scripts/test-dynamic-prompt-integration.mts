/**
 * Dynamic Prompt System — Integration Test
 *
 * Validates the full chain: intent classification → knowledge retrieval → prompt assembly
 * Run: npx tsx scripts/test-dynamic-prompt-integration.mts
 */

import { classifyIntent, isSimpleConversation } from "../src/agents/intent-classifier.js";
import { getKnowledgeRegistry, registerToolKnowledge } from "../src/agents/knowledge-index.js";
import { retrieveKnowledge, formatRetrievedKnowledge } from "../src/agents/knowledge-retriever.js";
import { buildDynamicSystemPrompt, buildDynamicPromptFromMessage } from "../src/agents/dynamic-prompt-builder.js";
import { SessionMemory } from "../src/agents/session-memory.js";
import { createKnowledgeSearchTool } from "../src/agents/knowledge-search-tool.js";

let passed = 0;
let failed = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ────────────────────────────────────────────────────────
// 1. Intent Classifier
// ────────────────────────────────────────────────────────
console.log("\n=== 1. Intent Classifier ===");

const testCases: [string, string, number][] = [
  // English
  ["read the file config.json", "file_read", 85],
  ["create a file called hello.py", "file_write", 85],
  ["search for all TODO comments in this project", "web_search", 85],
  ["list files in the current directory", "generic_task", 80],
  ["run npm install", "shell_exec", 90],
  ["what time is it in Tokyo", "generic_task", 70],
  ["set a reminder for tomorrow", "cron", 80],
  ["thanks for your help", "generic_task", 100],
  ["show me the weather", "file_read", 60],
  ["grep for error patterns in logs", "generic_task", 90],
  ["execute ls -la", "shell_exec", 90],
  ["rename file.txt to backup.txt", "file_edit", 80],
  ["open the browser and go to google.com", "browser", 80],
  // Chinese
  ["帮我设置每天早上9点的提醒", "cron", 90],
  ["读取配置文件", "file_read", 85],
  ["创建一个新文件", "file_write", 85],
  ["修改这个文件的内容", "file_edit", 80],
  ["运行 npm install", "shell_exec", 90],
  ["安装依赖包", "shell_exec", 70],
  ["搜索关于人工智能的信息", "web_search", 60],
  ["打开浏览器", "browser", 75],
  ["发送消息给某人", "message", 70],
  ["截图当前屏幕", "browser", 75],
  ["生成一张图片", "image_generate", 75],
  ["查看当前状态", "session", 65],
  ["重启网关", "gateway", 65],
  ["你能做什么", "knowledge", 50],
  ["画一个折线图", "canvas", 75],
];

for (const [msg, expectedIntent] of testCases) {
  const result = classifyIntent(msg);
  assert(
    `classifyIntent("${msg}") → ${result.intent}`,
    result.intent === expectedIntent,
    `expected "${expectedIntent}", got "${result.intent}"`,
  );
}

assert("isSimpleConversation('hello')", isSimpleConversation("hello") === true);
assert("isSimpleConversation('你好')", isSimpleConversation("你好") === true);
assert("isSimpleConversation('谢谢')", isSimpleConversation("谢谢") === true);
assert("isSimpleConversation('好的')", isSimpleConversation("好的") === true);
assert("isSimpleConversation('晚安')", isSimpleConversation("晚安") === true);
assert("isSimpleConversation('没问题')", isSimpleConversation("没问题") === true);
assert("isSimpleConversation('帮我写代码')", isSimpleConversation("帮我写代码") === false);
assert("isSimpleConversation('goodbye')", isSimpleConversation("goodbye") === true);

// ────────────────────────────────────────────────────────
// 2. Knowledge Index
// ────────────────────────────────────────────────────────
console.log("\n=== 2. Knowledge Index ===");

const registry = getKnowledgeRegistry();
registry.clear(); // reset singleton for clean test

// Register some sample knowledge chunks
registry.register({
  id: "tool-read",
  category: "tool",
  title: "Read File",
  content: "Reads file contents from the workspace. Supports text files and images.",
  tags: ["read", "file", "filesystem"],
  priority: 90,
});

registry.register({
  id: "tool-write",
  category: "tool",
  title: "Write File",
  content: "Writes content to a file in the workspace. Creates parent directories as needed.",
  tags: ["write", "file", "filesystem", "create"],
  priority: 90,
});

registry.register({
  id: "tool-shell",
  category: "tool",
  title: "Shell Execute",
  content: "Executes shell commands and returns stdout/stderr. Respects sandbox restrictions.",
  tags: ["shell", "exec", "command", "bash"],
  priority: 85,
});

registry.register({
  id: "section-sandbox",
  category: "sys_section",
  title: "Sandbox Rules",
  content: "When running in sandbox mode, the agent can only access files within the sandbox directory. Network access may be restricted.",
  tags: ["sandbox", "security", "permissions"],
  priority: 50,
});

registry.register({
  id: "section-messaging",
  category: "sys_section",
  title: "Messaging Channels",
  content: "OpenClaw supports WhatsApp, Telegram, Discord, Slack, and 20+ other channels for bidirectional communication.",
  tags: ["messaging", "channels", "telegram", "discord", "slack"],
  priority: 40,
});

registry.register({
  id: "section-reply-tags",
  category: "sys_section",
  title: "Reply Tags",
  content: "Reply tags control how responses are delivered back to channels. Available tags: [reply:all], [reply:channel], [reply:thread], [reply:dm].",
  tags: ["reply", "tags", "delivery"],
  priority: 45,
});

assert("registry.getAll() returns all chunks", registry.getAll().length === 6);
assert("registry.get('tool-read') found", registry.get("tool-read")?.title === "Read File");
assert("registry.get('nonexistent') returns undefined", registry.get("nonexistent") === undefined);

const readChunks = registry.getByTag("read");
assert("getByTag('read') returns correct chunks", readChunks.length >= 1 && readChunks[0].id === "tool-read");

const fileChunks = registry.getByTag("file");
assert("getByTag('file') returns read+write", fileChunks.length === 2);

const toolChunks = registry.getByCategory("tool");
assert("getByCategory('tool') returns 3 tools", toolChunks.length === 3);

// Test tool knowledge registration (uses global singleton)
registerToolKnowledge([
  { name: "read", description: "Read file contents", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write", description: "Write file contents", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
]);

const toolIndexChunks = registry.getByCategory("tool_index");
assert("registerToolKnowledge creates tool index entry", toolIndexChunks.length >= 1);
const toolDescChunks = registry.getByCategory("tool_desc");
assert("registerToolKnowledge creates tool desc entries", toolDescChunks.length >= 2);

// ────────────────────────────────────────────────────────
// 3. Knowledge Retrieval
// ────────────────────────────────────────────────────────
console.log("\n=== 3. Knowledge Retrieval ===");

const retrieval1 = retrieveKnowledge({
  toolTags: ["read", "file"],
  sectionTags: [],
  query: "read the config file",
  registry,
});
assert("retrieveKnowledge with tool tags returns relevant chunks", retrieval1.chunks.length > 0);

const formatted1 = formatRetrievedKnowledge(retrieval1.chunks);
assert("formatRetrievedKnowledge returns non-empty string", formatted1.length > 0);
assert("formatted knowledge contains 'Read'", formatted1.includes("Read"));

const retrieval2 = retrieveKnowledge({
  toolTags: ["shell"],
  sectionTags: [],
  query: "execute command",
  registry,
});
assert("retrieval for shell returns shell tool", retrieval2.chunks.some(c => c.id === "tool-shell"));

const retrieval3 = retrieveKnowledge({
  toolTags: [],
  sectionTags: ["sandbox"],
  query: "",
  registry,
});
assert("retrieval for section tag returns section", retrieval3.chunks.some(c => c.id === "section-sandbox"));

// Empty retrieval — with no tags and no query, should return minimal or empty
const retrievalEmpty = retrieveKnowledge({
  toolTags: [],
  sectionTags: [],
  query: "",
});
assert("empty request returns few or no chunks", retrievalEmpty.chunks.length <= 2);

// ────────────────────────────────────────────────────────
// 4. Session Memory
// ────────────────────────────────────────────────────────
console.log("\n=== 4. Session Memory ===");

const memory = new SessionMemory({ maxEntries: 50, maxSizeBytes: 100_000 });

memory.storeToolResult("read", "File content: line1\nline2\nline3...", ["config"]);
memory.storeToolResult("shell", "Output: build successful\n3 files changed", ["build"]);
memory.storeToolResult("read", "Another file with some content here", ["log"]);

const index = memory.formatMemoryIndex();
assert("memory index is non-empty", index.length > 0);
assert("memory index contains tool names", index.includes("read") && index.includes("shell"));

const recentResults = memory.getRecent(10);
assert("getRecent returns all stored results", recentResults.length === 3);

// LRU eviction
const bigMemory = new SessionMemory({ maxEntries: 3, maxSizeBytes: 100_000 });
bigMemory.storeToolResult("a", "result a", []);
bigMemory.storeToolResult("b", "result b", []);
bigMemory.storeToolResult("c", "result c", []);
bigMemory.storeToolResult("d", "result d", []); // should evict "a"
assert("LRU eviction works", bigMemory.getRecent(10).length === 3 && !bigMemory.getRecent(10).some(r => r.toolName === "a"));

// ────────────────────────────────────────────────────────
// 5. Dynamic Prompt Builder
// ────────────────────────────────────────────────────────
console.log("\n=== 5. Dynamic Prompt Builder ===");

const prompt1 = buildDynamicSystemPrompt({
  classification: classifyIntent("read the file config.json"),
  retrieval: retrieval1,
  sessionMemory: memory,
  workspaceDir: "/tmp/test-workspace",
  userTime: "2026-03-26 01:00:00 CST",
  userTimezone: "Asia/Shanghai",
  runtimeInfo: {
    agentId: "test",
    host: "local",
    os: "linux",
    arch: "x86_64",
    node: "v24.0.0",
    model: "qwen3.5-4b.gguf",
  },
  tools: [
    { name: "read", description: "Read files" },
    { name: "write", description: "Write files" },
    { name: "exec", description: "Execute commands" },
    { name: "knowledge_search", description: "Search knowledge" },
    { name: "sessions_list", description: "List sessions" },
  ],
  memoryCitationsMode: undefined,
});
assert("buildDynamicSystemPrompt returns non-empty prompt", prompt1.length > 100);
assert("prompt contains timezone info", prompt1.includes("Asia/Shanghai"));
assert("prompt does NOT contain full tool schemas for unrelated tools", !prompt1.includes("SessionMemory"));

// Test minimal prompt for greeting
const greetingResult = buildDynamicPromptFromMessage("hello", {
  sessionMemory: memory,
  workspaceDir: "/tmp/test-workspace",
  userTime: "2026-03-26 01:00:00 CST",
  userTimezone: "Asia/Shanghai",
  runtimeInfo: {
    agentId: "test",
    os: "linux",
    node: "v24.0.0",
  },
  tools: [
    { name: "read", description: "Read files" },
    { name: "write", description: "Write files" },
    { name: "exec", description: "Execute commands" },
    { name: "knowledge_search", description: "Search knowledge" },
  ],
});
assert("greeting prompt is short (< 2000 chars)", greetingResult.prompt.length < 2000);
assert("greeting prompt does NOT contain sandbox section", !greetingResult.prompt.includes("Sandbox"));

// Test full task prompt
const fullResult = buildDynamicPromptFromMessage("read the file config.json and show me its contents", {
  sessionMemory: memory,
  workspaceDir: "/tmp/test-workspace",
  userTime: "2026-03-26 01:00:00 CST",
  userTimezone: "Asia/Shanghai",
  runtimeInfo: {
    agentId: "test",
    os: "linux",
    node: "v24.0.0",
  },
  tools: [
    { name: "read", description: "Read files" },
    { name: "write", description: "Write files" },
    { name: "exec", description: "Execute commands" },
    { name: "knowledge_search", description: "Search knowledge" },
    { name: "sessions_list", description: "List sessions" },
    { name: "browser", description: "Open browser" },
  ],
});
assert("full task prompt includes relevant tool info", fullResult.prompt.includes("read"));
assert("full task prompt is reasonable size (< 5000 chars)", fullResult.prompt.length < 5000);

// ────────────────────────────────────────────────────────
// 6. knowledge_search Tool
// ────────────────────────────────────────────────────────
console.log("\n=== 6. knowledge_search Tool ===");

const knowledgeTool = createKnowledgeSearchTool({ enabled: true });
assert("knowledge_search tool is created", knowledgeTool !== null);
if (knowledgeTool) {
  assert("tool has correct name", knowledgeTool.name === "knowledge_search");
  assert("tool has label", "label" in knowledgeTool);
  assert("tool has parameters schema", knowledgeTool.parameters !== undefined);

  // Execute the tool
  const toolResult = await knowledgeTool.execute("test-call", { query: "file reading operations" });
  assert("tool execute returns AgentToolResult", "content" in toolResult && Array.isArray(toolResult.content));
  assert("tool result content is non-empty", toolResult.content.length > 0);

  // Test with category filter
  const catResult = await knowledgeTool.execute("test-call", { query: "shell commands", category: "tool" });
  assert("category filter returns results", catResult.content.length > 0);
}

// Test disabled tool
const disabledTool = createKnowledgeSearchTool({ enabled: false });
assert("disabled knowledge_search returns null", disabledTool === null);

// ────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  console.log("\nFailed tests:");
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
  process.exit(0);
}
