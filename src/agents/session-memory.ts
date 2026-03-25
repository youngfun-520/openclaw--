/**
 * Session Memory — 会话内存管理器
 *
 * 管理单次会话中工具调用的结果缓存：
 *   - 目录摘要（session_memory）: 工具名称 + 操作摘要，始终保留
 *   - 完整内容（knowledge_cache）: 按需读取，可被 LLM 通过 knowledge_retrieve 访问
 *
 * 核心设计：
 *   1. 工具执行完成后，自动拆分结果为「目录摘要 + 完整内容」
 *   2. 目录摘要写入 session_memory（随会话持久）
 *   3. 完整内容写入 knowledge_cache（按需读取）
 *   4. 后续轮次中 LLM 可通过 memory_index 工具查询可用缓存
 */

import { createHash } from "node:crypto";

// ── 类型定义 ──────────────────────────────────────────────

export interface MemoryEntry {
  /** 内容哈希（作为缓存 key） */
  contentHash: string;
  /** 工具名称 */
  toolName: string;
  /** 操作目录摘要（短文本） */
  summary: string;
  /** 完整内容的长度 */
  fullContentLength: number;
  /** 创建时间 */
  createdAt: number;
  /** 关联 tag */
  tags: string[];
}

export interface MemoryIndex {
  /** 本会话的所有内存条目 */
  entries: MemoryEntry[];
  /** 总内存条目数 */
  count: number;
  /** 总缓存大小（字符） */
  totalCacheSize: number;
}

export interface KnowledgeCacheEntry {
  /** 内容哈希 */
  hash: string;
  /** 完整内容 */
  content: string;
  /** 创建时间 */
  createdAt: number;
}

// ── SessionMemory 类 ─────────────────────────────────────

export class SessionMemory {
  /** 会话内存目录（轻量，始终在上下文中） */
  private memoryEntries = new Map<string, MemoryEntry>();

  /** 完整内容缓存（按需读取） */
  private knowledgeCache = new Map<string, KnowledgeCacheEntry>();

  /** 最大缓存条目数 */
  private maxEntries: number;

  /** 最大缓存总大小（字符） */
  private maxCacheSize: number;

  constructor(options?: { maxEntries?: number; maxCacheSize?: number }) {
    this.maxEntries = options?.maxEntries ?? 100;
    this.maxCacheSize = options?.maxCacheSize ?? 500_000; // 500KB
  }

  // ── 核心：拆分并存储工具结果 ──

  /**
   * 拆分工具执行结果为「目录摘要 + 完整内容」，分别存储。
   *
   * @param toolName 工具名称
   * @param result 工具执行结果文本
   * @param tags 关联 tag
   * @returns 内容哈希（可用于后续 knowledge_retrieve）
   */
  storeToolResult(toolName: string, result: string, tags: string[] = []): string {
    const contentHash = this.computeHash(result);
    const summary = this.generateSummary(toolName, result);

    // 写入目录
    const entry: MemoryEntry = {
      contentHash,
      toolName,
      summary,
      fullContentLength: result.length,
      createdAt: Date.now(),
      tags,
    };
    this.memoryEntries.set(contentHash, entry);

    // 写入完整内容缓存
    this.knowledgeCache.set(contentHash, {
      hash: contentHash,
      content: result,
      createdAt: Date.now(),
    });

    // LRU 淘汰
    this.evictIfNeeded();

    return contentHash;
  }

  // ── 查询接口 ──

  /** 获取会话内存索引（目录） */
  getIndex(): MemoryIndex {
    const entries = Array.from(this.memoryEntries.values());
    const totalCacheSize = Array.from(this.knowledgeCache.values()).reduce(
      (sum, e) => sum + e.content.length,
      0,
    );
    return {
      entries,
      count: entries.length,
      totalCacheSize,
    };
  }

  /** 根据哈希获取完整内容 */
  retrieve(hash: string): string | null {
    const entry = this.knowledgeCache.get(hash);
    if (!entry) return null;
    return entry.content;
  }

  /** 搜索内存目录（关键词匹配） */
  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return Array.from(this.memoryEntries.values()).filter(
      (entry) =>
        entry.summary.toLowerCase().includes(lower) ||
        entry.toolName.toLowerCase().includes(lower) ||
        entry.tags.some((tag) => tag.includes(lower)),
    );
  }

  /** 获取最近 N 条内存条目 */
  getRecent(limit = 10): MemoryEntry[] {
    return Array.from(this.memoryEntries.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  // ── 格式化输出 ──

  /**
   * 将内存目录格式化为可注入上下文的文本。
   * 只包含摘要，不包含完整内容。
   */
  formatMemoryIndex(maxEntries = 20): string {
    const recent = this.getRecent(maxEntries);
    if (recent.length === 0) return "";

    const lines: string[] = ["## Session Memory Index", ""];
    for (const entry of recent) {
      const time = new Date(entry.createdAt).toISOString().slice(11, 19);
      lines.push(
        `- [${time}] ${entry.toolName}: ${entry.summary} ` +
          `(cache: ${entry.contentHash.slice(0, 8)}, ${entry.fullContentLength} chars)`,
      );
    }
    lines.push("", "Use `knowledge_retrieve(hash)` to get full content of any cached result.");
    lines.push("");
    return lines.join("\n");
  }

  // ── 生命周期 ──

  /** 清除所有缓存 */
  clear(): void {
    this.memoryEntries.clear();
    this.knowledgeCache.clear();
  }

  /** 获取缓存统计 */
  getStats(): { entryCount: number; cacheSize: number; cacheEntries: number } {
    return {
      entryCount: this.memoryEntries.size,
      cacheSize: Array.from(this.knowledgeCache.values()).reduce(
        (sum, e) => sum + e.content.length,
        0,
      ),
      cacheEntries: this.knowledgeCache.size,
    };
  }

  // ── 私有方法 ──

  private computeHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private generateSummary(toolName: string, content: string): string {
    // 截取前 200 字符作为摘要
    const maxLength = 200;
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength).replace(/\n/g, " ").trim() + "...";
  }

  private evictIfNeeded(): void {
    // 按数量淘汰
    if (this.memoryEntries.size > this.maxEntries) {
      const entries = Array.from(this.memoryEntries.entries())
        .sort(([, a], [, b]) => a.createdAt - b.createdAt);
      const toRemove = entries.length - this.maxEntries;
      for (let i = 0; i < toRemove; i++) {
        const [hash] = entries[i];
        this.memoryEntries.delete(hash);
        this.knowledgeCache.delete(hash);
      }
    }

    // 按大小淘汰
    let totalSize = Array.from(this.knowledgeCache.values()).reduce(
      (sum, e) => sum + e.content.length,
      0,
    );
    while (totalSize > this.maxCacheSize && this.knowledgeCache.size > 1) {
      const oldest = Array.from(this.knowledgeCache.entries())
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        const [hash] = oldest;
        this.knowledgeCache.delete(hash);
        this.memoryEntries.delete(hash);
        totalSize -= oldest[1].content.length;
      }
    }
  }
}
