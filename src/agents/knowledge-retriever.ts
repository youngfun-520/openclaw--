/**
 * Knowledge Retriever — 按需知识检索器
 *
 * 接收预分类器的 output（intent + tags），
 * 从知识库中检索最相关的 chunks。
 *
 * 检索策略：
 *   1. Tag 精确匹配 → 必取
 *   2. 向量相似度 top-k → 补充
 *   3. Hybrid merge → 排序
 *   4. 按 token budget 截断
 */

import { cosineSimilarity } from "../memory/internal.js";
import type { KnowledgeChunk } from "./knowledge-index.js";
import { getKnowledgeRegistry } from "./knowledge-index.js";

// ── 类型定义 ──────────────────────────────────────────────

export interface RetrievalRequest {
  /** 用户消息文本（用于向量相似度检索） */
  query: string;
  /** 预分类器输出的工具 tag */
  toolTags: string[];
  /** 预分类器输出的 section tag */
  sectionTags: string[];
  /** 是否包含工具 schema（默认 true） */
  includeSchemas?: boolean;
  /** 是否包含工具描述（默认 true） */
  includeDescriptions?: boolean;
  /** 是否包含系统 section（默认 true） */
  includeSections?: boolean;
  /** 向量 top-k 数量（默认 10） */
  topK?: number;
  /** 最大 token 预算（粗估，默认 2000） */
  tokenBudget?: number;
}

export interface RetrievalResult {
  /** 检索到的知识 chunks（已排序） */
  chunks: KnowledgeChunk[];
  /** 实际使用的 tokens 估算 */
  estimatedTokens: number;
  /** 是否被 budget 截断 */
  truncated: boolean;
}

// ── 常量 ─────────────────────────────────────────────────

/** 粗略估算：1 token ≈ 4 字符（英文）或 1.5 字符（中文） */
const CHARS_PER_TOKEN = 3;

// ── 核心：retrieve 函数 ──────────────────────────────────

export function retrieveKnowledge(request: RetrievalRequest): RetrievalResult {
  const registry = getKnowledgeRegistry();
  const {
    toolTags,
    sectionTags,
    includeSchemas = true,
    includeDescriptions = true,
    includeSections = true,
    topK = 10,
    tokenBudget = 2000,
  } = request;

  // ── Step 1: Tag 精确匹配（必取） ──
  const tagMatchedChunks = new Map<string, KnowledgeChunk>();
  const allTags = [...toolTags, ...sectionTags];

  for (const tag of allTags) {
    for (const chunk of registry.getByTag(tag)) {
      // 按 category 过滤
      if (!includeDescriptions && chunk.category === "tool_desc") continue;
      if (!includeSchemas && chunk.category === "tool_schema") continue;
      if (!includeSections && chunk.category === "sys_section") continue;

      // 同一 id 只保留最高优先级
      const existing = tagMatchedChunks.get(chunk.id);
      if (!existing || chunk.priority > existing.priority) {
        tagMatchedChunks.set(chunk.id, chunk);
      }
    }
  }

  // ── Step 2: 工具索引始终包含 ──
  const toolIndex = registry.getToolIndex();
  if (toolIndex) {
    tagMatchedChunks.set(toolIndex.id, toolIndex);
  }

  // ── Step 3: 向量相似度补充（如果有 embedding） ──
  const vectorResults = new Map<string, KnowledgeChunk>();

  // 收集所有有 embedding 的 chunks
  const allChunks = registry.getAll();
  const chunksWithEmbeddings = allChunks.filter(
    (c) => c.embedding && c.embedding.length > 0 && !tagMatchedChunks.has(c.id),
  );

  if (chunksWithEmbeddings.length > 0) {
    // 使用 query 作为嵌入输入（如果 query 有 embedding 则用 query embedding）
    // 这里简化处理：直接用 tag 匹配的 chunks 的 embedding 与 query 做比较
    // 在实际集成时，会使用 embedding provider 生成 query embedding
    const queryEmbedding = tryGetQueryEmbedding(request.query);
    if (queryEmbedding) {
      const scored = chunksWithEmbeddings
        .map((chunk) => ({
          chunk,
          score: cosineSimilarity(queryEmbedding, chunk.embedding!),
        }))
        .filter((item) => item.score > 0.5) // 相似度阈值
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

      for (const item of scored) {
        vectorResults.set(item.chunk.id, item.chunk);
      }
    }
  }

  // ── Step 4: 合并并排序 ──
  const mergedChunks = new Map<string, { chunk: KnowledgeChunk; score: number }>();

  // Tag 匹配的 chunks 优先级最高（基础分 1.0 + priority）
  for (const chunk of tagMatchedChunks.values()) {
    mergedChunks.set(chunk.id, { chunk, score: 1.0 + chunk.priority });
  }

  // 向量匹配的 chunks 补充
  for (const chunk of vectorResults.values()) {
    if (!mergedChunks.has(chunk.id)) {
      mergedChunks.set(chunk.id, { chunk, score: chunk.priority });
    }
  }

  // 按 score 降序排序
  const sorted = Array.from(mergedChunks.values())
    .sort((a, b) => b.score - a.score)
    .map((item) => item.chunk);

  // ── Step 5: Token budget 截断 ──
  let totalChars = 0;
  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  const result: KnowledgeChunk[] = [];
  let truncated = false;

  for (const chunk of sorted) {
    const chunkChars = chunk.content.length;
    if (totalChars + chunkChars > budgetChars) {
      truncated = true;
      break;
    }
    result.push(chunk);
    totalChars += chunkChars;
  }

  return {
    chunks: result,
    estimatedTokens: Math.ceil(totalChars / CHARS_PER_TOKEN),
    truncated,
  };
}

// ── 辅助函数 ─────────────────────────────────────────────

/**
 * 尝试获取查询文本的 embedding。
 * 当前为占位实现，实际集成时需要调用 embedding provider。
 */
function tryGetQueryEmbedding(query: string): number[] | null {
  // 在没有 embedding provider 的情况下，返回 null（纯 tag 模式）
  // 实际集成时，这里会调用 embedding provider:
  //   const embedding = await embeddingProvider.embed(query);
  //   return embedding;
  void query;
  return null;
}

/**
 * 从检索结果中提取工具名称列表（用于动态组装系统提示词的工具部分）。
 */
export function extractToolNames(chunks: KnowledgeChunk[]): string[] {
  const names = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.category === "tool_desc" || chunk.category === "tool_schema" || chunk.category === "tool_index") {
      // 从 id 中提取工具名: "tool.cron.desc" -> "cron"
      const match = chunk.id.match(/^tool\.([^.]+)\./);
      if (match) {
        names.add(match[1]);
      }
    }
  }
  return Array.from(names);
}

/**
 * 从检索结果中提取 section 内容（用于动态组装系统提示词的 section 部分）。
 */
export function extractSectionContents(chunks: KnowledgeChunk[]): Map<string, string> {
  const sections = new Map<string, string>();
  for (const chunk of chunks) {
    if (chunk.category === "sys_section") {
      // 从 id 中提取 section 标识: "section.sandbox" -> "sandbox"
      const match = chunk.id.match(/^section\.([^.]+)$/);
      if (match) {
        sections.set(match[1], chunk.content);
      }
    }
  }
  return sections;
}

/**
 * 将检索到的 chunks 格式化为可注入系统提示词的文本。
 */
export function formatRetrievedKnowledge(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return "";

  const lines: string[] = [];

  // 按类别分组
  const toolDescs = chunks.filter((c) => c.category === "tool_desc");
  const toolSchemas = chunks.filter((c) => c.category === "tool_schema");
  const sections = chunks.filter((c) => c.category === "sys_section");

  if (toolDescs.length > 0) {
    lines.push("### Retrieved Tool Descriptions", "");
    for (const chunk of toolDescs) {
      lines.push(`#### ${chunk.title}`, "", chunk.content, "");
    }
  }

  if (toolSchemas.length > 0) {
    lines.push("### Retrieved Tool Schemas", "");
    for (const chunk of toolSchemas) {
      lines.push(`#### ${chunk.title}`, "```json", chunk.content, "```", "");
    }
  }

  if (sections.length > 0) {
    lines.push("### Retrieved System Sections", "");
    for (const chunk of sections) {
      lines.push(chunk.content, "");
    }
  }

  return lines.filter(Boolean).join("\n");
}
