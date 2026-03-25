/**
 * Knowledge Index — 系统知识库索引构建器
 *
 * 将第一梯队（工具定义）和第二梯队（系统提示词 section）
 * 拆分为 "目录 + 内容" 结构，存储到 sqlite-vec 向量库。
 *
 * 每条记录包含:
 *   id       — 唯一标识符 (如 "tool.cron.desc", "section.sandbox")
 *   category — 分类 ("tool_desc" | "tool_schema" | "sys_section")
 *   title    — 短标题（目录展示用）
 *   content  — 完整内容
 *   tags     — 关联 tag 数组（供精确匹配）
 *   priority — 优先级权重 0-1
 *   embedding— 向量（可选，后端可用时生成）
 */

import type { DatabaseSync } from "node:sqlite";

// ── 类型定义 ──────────────────────────────────────────────

export type KnowledgeCategory = "tool_desc" | "tool_schema" | "sys_section" | "tool_index";

export interface KnowledgeChunk {
  /** 唯一标识符 */
  id: string;
  /** 分类 */
  category: KnowledgeCategory;
  /** 短标题（目录展示） */
  title: string;
  /** 完整内容 */
  content: string;
  /** 关联 tag 数组（供精确匹配） */
  tags: string[];
  /** 优先级权重 0-1，越高越重要 */
  priority: number;
  /** 向量（懒计算，后端可用时生成） */
  embedding?: number[];
}

export interface KnowledgeIndexOptions {
  /** sqlite-vec 数据库实例（可选，不传则使用内存存储） */
  db?: DatabaseSync;
  /** 表名前缀 */
  tablePrefix?: string;
}

// ── 系统知识注册表 ────────────────────────────────────────

/**
 * 所有系统知识的静态注册表。
 * 在构建时一次性填入，运行时只读查询。
 */
class KnowledgeRegistry {
  private chunks = new Map<string, KnowledgeChunk>();

  register(chunk: KnowledgeChunk): void {
    this.chunks.set(chunk.id, chunk);
  }

  get(id: string): KnowledgeChunk | undefined {
    return this.chunks.get(id);
  }

  getAll(): KnowledgeChunk[] {
    return Array.from(this.chunks.values());
  }

  /** 按 tag 精确匹配获取 chunks */
  getByTag(tag: string): KnowledgeChunk[] {
    return this.getAll().filter((c) => c.tags.includes(tag));
  }

  /** 按多个 tag 匹配（OR 语义），去重 */
  getByTags(tags: string[]): KnowledgeChunk[] {
    if (tags.length === 0) return [];
    const seen = new Set<string>();
    const results: KnowledgeChunk[] = [];
    for (const tag of tags) {
      for (const chunk of this.getByTag(tag)) {
        if (!seen.has(chunk.id)) {
          seen.add(chunk.id);
          results.push(chunk);
        }
      }
    }
    return results;
  }

  /** 按 category 过滤 */
  getByCategory(category: KnowledgeCategory): KnowledgeChunk[] {
    return this.getAll().filter((c) => c.category === category);
  }

  /** 获取所有工具名称索引 */
  getToolIndex(): KnowledgeChunk | undefined {
    return this.get("tool.index");
  }

  clear(): void {
    this.chunks.clear();
  }

  get size(): number {
    return this.chunks.size;
  }
}

// ── 全局注册表实例（单例） ────────────────────────────────

let globalRegistry: KnowledgeRegistry | null = null;

export function getKnowledgeRegistry(): KnowledgeRegistry {
  if (!globalRegistry) {
    globalRegistry = new KnowledgeRegistry();
  }
  return globalRegistry;
}

// ── 从 pi-tools 提取工具知识 ─────────────────────────────

export interface ToolKnowledgeInput {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 从工具定义数组注册到知识库。
 * 每个工具拆分为 desc + schema 两个 chunk。
 */
export function registerToolKnowledge(tools: ToolKnowledgeInput[]): void {
  const registry = getKnowledgeRegistry();

  // 1. 工具名称索引
  const toolNames = tools.map((t) => t.name);
  registry.register({
    id: "tool.index",
    category: "tool_index",
    title: "Available Tools",
    content: `Available tools: ${toolNames.join(", ")}`,
    tags: ["tooling", "tool_index"],
    priority: 1.0,
  });

  // 2. 每个工具拆分为 desc + schema
  for (const tool of tools) {
    const name = tool.name.toLowerCase();

    // 工具描述
    registry.register({
      id: `tool.${name}.desc`,
      category: "tool_desc",
      title: `Tool: ${tool.name}`,
      content: tool.description,
      tags: [name, "tool_desc"],
      priority: 0.8,
    });

    // 工具 Schema
    registry.register({
      id: `tool.${name}.schema`,
      category: "tool_schema",
      title: `Tool Schema: ${tool.name}`,
      content: JSON.stringify(tool.parameters, null, 2),
      tags: [name, "tool_schema"],
      priority: 0.7,
    });
  }
}

// ── 从 system-prompt 提取 section 知识 ───────────────────

export interface SectionKnowledgeInput {
  /** section 标识符（如 "sandbox", "safety", "messaging"） */
  id: string;
  /** section 标题（如 "## Sandbox"） */
  title: string;
  /** section 完整内容 */
  content: string;
  /** 关联 tag */
  tags: string[];
  /** 优先级 */
  priority?: number;
}

/**
 * 注册系统提示词 section 到知识库。
 */
export function registerSectionKnowledge(sections: SectionKnowledgeInput[]): void {
  const registry = getKnowledgeRegistry();
  for (const section of sections) {
    registry.register({
      id: `section.${section.id}`,
      category: "sys_section",
      title: section.title,
      content: section.content,
      tags: [...section.tags, "sys_section", `section.${section.id}`],
      priority: section.priority ?? 0.6,
    });
  }
}

// ── SQLite 持久化（可选） ────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS {prefix}_knowledge (
  id        TEXT PRIMARY KEY,
  category  TEXT NOT NULL,
  title     TEXT NOT NULL,
  content   TEXT NOT NULL,
  tags      TEXT NOT NULL DEFAULT '[]',
  priority  REAL NOT NULL DEFAULT 0.5,
  embedding BLOB
);

CREATE INDEX IF NOT EXISTS {prefix}_knowledge_category ON {prefix}_knowledge(category);
CREATE INDEX IF NOT EXISTS {prefix}_knowledge_priority ON {prefix}_knowledge(priority DESC);
`;

export function ensureKnowledgeTable(db: DatabaseSync, tablePrefix = "system"): void {
  const sql = SCHEMA_SQL.replace(/\{prefix\}/g, tablePrefix);
  db.exec(sql);
}

export function persistKnowledgeToDb(
  db: DatabaseSync,
  tablePrefix = "system",
): void {
  const registry = getKnowledgeRegistry();
  const table = `${tablePrefix}_knowledge`;

  const upsert = db.prepare(
    `INSERT INTO ${table} (id, category, title, content, tags, priority, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       category = excluded.category,
       title    = excluded.title,
       content  = excluded.content,
       tags     = excluded.tags,
       priority = excluded.priority,
       embedding = excluded.embedding`,
  );

  const insertMany = db.transaction((chunks: KnowledgeChunk[]) => {
    for (const chunk of chunks) {
      const embeddingBlob = chunk.embedding
        ? Buffer.from(new Float32Array(chunk.embedding).buffer)
        : null;
      upsert.run(
        chunk.id,
        chunk.category,
        chunk.title,
        chunk.content,
        JSON.stringify(chunk.tags),
        chunk.priority,
        embeddingBlob,
      );
    }
  });

  insertMany(registry.getAll());
}

/**
 * 从 SQLite 加载知识到内存注册表。
 */
export function loadKnowledgeFromDb(
  db: DatabaseSync,
  tablePrefix = "system",
): void {
  const registry = getKnowledgeRegistry();
  const table = `${tablePrefix}_knowledge`;

  let rows: Array<{
    id: string;
    category: KnowledgeCategory;
    title: string;
    content: string;
    tags: string;
    priority: number;
    embedding: Buffer | null;
  }>;

  try {
    rows = db.prepare(`SELECT * FROM ${table}`).all() as typeof rows;
  } catch {
    // 表不存在，首次运行
    return;
  }

  registry.clear();
  for (const row of rows) {
    registry.register({
      id: row.id,
      category: row.category,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags),
      priority: row.priority,
      embedding: row.embedding ? Array.from(new Float32Array(row.embedding.buffer)) : undefined,
    });
  }
}
