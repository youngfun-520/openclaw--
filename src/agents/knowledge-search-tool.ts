/**
 * Knowledge Search Tool — LLM 可调用的知识搜索工具
 *
 * 当预分类器未能覆盖某个意图时，LLM 可以主动调用此工具
 * 从系统知识库中检索工具用法、安全规则或操作指南。
 *
 * 返回匹配的知识片段列表，LLM 可据此操作。
 */

import type { AnyAgentTool } from "./pi-tools.types.js";
import { retrieveKnowledge, formatRetrievedKnowledge } from "./knowledge-retriever.js";
import type { KnowledgeCategory } from "./knowledge-index.js";

// ── 工具定义 ──────────────────────────────────────────────

const TOOL_NAME = "knowledge_search";

const TOOL_DESCRIPTION =
  "Search the system knowledge base for tool usage, safety rules, or operation guides. " +
  "Call this when you are uncertain about a specific tool's usage, available options, " +
  "or system behavior. Returns the most relevant knowledge chunks.";

const TOOL_PARAMETERS = {
  type: "object" as const,
  properties: {
    query: {
      type: "string",
      description: "What knowledge to search for (e.g., 'how to use cron tool', 'sandbox rules', 'how to send messages')",
    },
    category: {
      type: "string",
      description: "Category to narrow the search scope",
      enum: ["all", "tool_desc", "tool_schema", "sys_section"] as const,
      default: "all",
    },
  },
  required: ["query"] as const,
  additionalProperties: false,
};

// ── 工具执行器 ────────────────────────────────────────────

interface KnowledgeSearchResult {
  /** 搜索到的知识内容（格式化后的文本） */
  content: string;
  /** 命中的 chunk 数量 */
  hitCount: number;
  /** 是否被截断 */
  truncated: boolean;
}

/**
 * 执行知识搜索。
 */
function executeKnowledgeSearch(args: {
  query: string;
  category?: string;
}): KnowledgeSearchResult {
  const categoryFilter = args.category ?? "all";

  // 从 query 中提取可能的 tag
  const queryLower = args.query.toLowerCase();
  const possibleToolTags = extractPossibleToolTags(queryLower);
  const possibleSectionTags = extractPossibleSectionTags(queryLower);

  const includeCategories: KnowledgeCategory[] =
    categoryFilter === "all"
      ? ["tool_desc", "tool_schema", "sys_section"]
      : [categoryFilter as KnowledgeCategory];

  const result = retrieveKnowledge({
    query: args.query,
    toolTags: possibleToolTags,
    sectionTags: possibleSectionTags,
    includeDescriptions: includeCategories.includes("tool_desc"),
    includeSchemas: includeCategories.includes("tool_schema"),
    includeSections: includeCategories.includes("sys_section"),
    topK: 8,
    tokenBudget: 1500,
  });

  const formattedContent = formatRetrievedKnowledge(result.chunks);

  return {
    content: formattedContent || "No relevant knowledge found for this query. Proceed with your best judgment based on the tool descriptions in the system prompt.",
    hitCount: result.chunks.length,
    truncated: result.truncated,
  };
}

/**
 * 从查询文本中提取可能的工具 tag。
 */
function extractPossibleToolTags(query: string): string[] {
  const toolKeywords: Record<string, string[]> = {
    cron: ["cron", "schedule", "reminder", "timer"],
    exec: ["exec", "run", "command", "shell", "bash"],
    read: ["read", "file", "open", "view"],
    write: ["write", "create", "save"],
    edit: ["edit", "modify", "change", "patch"],
    grep: ["grep", "search", "find in file", "pattern"],
    find: ["find", "glob", "file search"],
    browser: ["browser", "web page", "navigate", "screenshot"],
    canvas: ["canvas", "plot", "chart", "visualization"],
    nodes: ["node", "device", "camera", "remote"],
    message: ["message", "send", "dm", "notify", "channel"],
    gateway: ["gateway", "restart", "config", "update"],
    session_status: ["status", "model", "session"],
    sessions_spawn: ["spawn", "subagent", "sub-agent"],
    subagents: ["subagent", "sub-agent", "delegate"],
    web_search: ["web search", "search web", "google"],
    web_fetch: ["fetch", "url", "scrape", "crawl"],
    image: ["image", "picture", "vision", "analyze image"],
    image_generate: ["generate image", "create image", "draw"],
    process: ["process", "background", "job"],
  };

  const tags: string[] = [];
  for (const [toolName, keywords] of Object.entries(toolKeywords)) {
    if (keywords.some((kw) => query.includes(kw))) {
      tags.push(toolName);
    }
  }
  return tags;
}

/**
 * 从查询文本中提取可能的 section tag。
 */
function extractPossibleSectionTags(query: string): string[] {
  const sectionKeywords: Record<string, string[]> = {
    safety: ["safety", "secure", "danger", "harm", "risk"],
    sandbox: ["sandbox", "docker", "container", "isolation"],
    messaging: ["message", "reply", "channel", "send"],
    reply_tags: ["reply tag", "quote", "[[reply"],
    voice: ["voice", "tts", "speech", "audio"],
    tooling: ["tool", "available tools", "tool list"],
    tool_call_style: ["tool call", "narrate", "tool usage"],
    skills: ["skill", "plugin", "extension"],
    memory: ["memory", "remember", "recall", "search memory"],
  };

  const tags: string[] = [];
  for (const [sectionName, keywords] of Object.entries(sectionKeywords)) {
    if (keywords.some((kw) => query.includes(kw))) {
      tags.push(sectionName);
    }
  }
  return tags;
}

// ── 工具工厂 ──────────────────────────────────────────────

export interface CreateKnowledgeSearchToolOptions {
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/**
 * 创建 knowledge_search 工具。
 */
export function createKnowledgeSearchTool(
  options?: CreateKnowledgeSearchToolOptions,
): AnyAgentTool | null {
  if (options?.enabled === false) {
    return null;
  }

  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
    ) => {
      const query = String(args.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "query is required" }) }], details: undefined };
      }

      const result = executeKnowledgeSearch({
        query,
        category: args.category ? String(args.category) : undefined,
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
    },
  };
}
