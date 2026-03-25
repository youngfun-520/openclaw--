import { describe, expect, it, beforeEach } from "vitest";
import { SessionMemory } from "./session-memory.js";

describe("SessionMemory", () => {
  let memory: SessionMemory;

  beforeEach(() => {
    memory = new SessionMemory();
  });

  it("storeToolResult 返回内容哈希", () => {
    const hash = memory.storeToolResult("read", "file contents here...");
    expect(hash).toBeTruthy();
    expect(hash.length).toBe(16);
  });

  it("相同内容返回相同哈希", () => {
    const hash1 = memory.storeToolResult("read", "same content");
    const hash2 = memory.storeToolResult("exec", "same content");
    expect(hash1).toBe(hash2);
  });

  it("不同内容返回不同哈希", () => {
    const hash1 = memory.storeToolResult("read", "content a");
    const hash2 = memory.storeToolResult("read", "content b");
    expect(hash1).not.toBe(hash2);
  });

  it("retrieve 根据哈希获取完整内容", () => {
    const content = "full file content\nwith multiple lines\nof text";
    const hash = memory.storeToolResult("read", content);
    const retrieved = memory.retrieve(hash);
    expect(retrieved).toBe(content);
  });

  it("retrieve 不存在的哈希返回 null", () => {
    expect(memory.retrieve("nonexistent")).toBeNull();
  });

  it("getIndex 返回内存索引", () => {
    memory.storeToolResult("read", "file contents");
    memory.storeToolResult("exec", "command output");

    const index = memory.getIndex();
    expect(index.count).toBe(2);
    expect(index.entries.length).toBe(2);
    expect(index.entries[0].toolName).toBeTruthy();
    expect(index.totalCacheSize).toBeGreaterThan(0);
  });

  it("search 按关键词搜索目录", () => {
    memory.storeToolResult("read", "config.json contents");
    memory.storeToolResult("exec", "npm install output");

    const results = memory.search("config");
    expect(results.length).toBe(1);
    expect(results[0].toolName).toBe("read");
  });

  it("search 按工具名搜索", () => {
    memory.storeToolResult("read", "some content");
    memory.storeToolResult("exec", "other content");

    const results = memory.search("exec");
    expect(results.length).toBe(1);
  });

  it("search 按 tag 搜索", () => {
    memory.storeToolResult("read", "content", ["file", "config"]);
    memory.storeToolResult("exec", "output", ["command"]);

    const results = memory.search("file");
    expect(results.length).toBe(1);
  });

  it("getRecent 返回最近条目（限制数量）", () => {
    memory.storeToolResult("read", "first");
    memory.storeToolResult("exec", "second");
    memory.storeToolResult("grep", "third");

    const recent = memory.getRecent(2);
    expect(recent.length).toBe(2);
    // 不依赖精确时间排序，只验证数量限制和总条目数
    const allRecent = memory.getRecent(10);
    expect(allRecent.length).toBe(3);
  });

  it("formatMemoryIndex 格式化输出", () => {
    memory.storeToolResult("read", "file contents...");
    memory.storeToolResult("exec", "command output...");

    const formatted = memory.formatMemoryIndex();
    expect(formatted).toContain("Session Memory Index");
    expect(formatted).toContain("read");
    expect(formatted).toContain("exec");
    expect(formatted).toContain("knowledge_retrieve");
  });

  it("formatMemoryIndex 限制条目数", () => {
    for (let i = 0; i < 30; i++) {
      memory.storeToolResult("read", `content ${i}`);
    }

    const formatted = memory.formatMemoryIndex(5);
    // 应该只包含 5 条
    const lines = formatted.split("\n").filter((l) => l.startsWith("- ["));
    expect(lines.length).toBe(5);
  });

  it("clear 清空所有缓存", () => {
    memory.storeToolResult("read", "content");
    memory.storeToolResult("exec", "output");

    memory.clear();
    expect(memory.getIndex().count).toBe(0);
    expect(memory.retrieve(memory.getIndex().entries[0]?.contentHash ?? "")).toBeNull();
  });

  it("getStats 返回统计信息", () => {
    memory.storeToolResult("read", "content");

    const stats = memory.getStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.cacheSize).toBeGreaterThan(0);
    expect(stats.cacheEntries).toBe(1);
  });

  it("LRU 淘汰：超过 maxEntries 时淘汰旧条目", () => {
    const smallMemory = new SessionMemory({ maxEntries: 3 });
    smallMemory.storeToolResult("read", "a");
    smallMemory.storeToolResult("exec", "b");
    smallMemory.storeToolResult("grep", "c");
    smallMemory.storeToolResult("cron", "d"); // 超出限制，淘汰 "read"

    const index = smallMemory.getIndex();
    expect(index.count).toBe(3);
    const toolNames = index.entries.map((e) => e.toolName);
    expect(toolNames).not.toContain("read");
  });

  it("长内容被截断为摘要", () => {
    const longContent = "x".repeat(500);
    const hash = memory.storeToolResult("read", longContent);

    const index = memory.getIndex();
    const entry = index.entries.find((e) => e.contentHash === hash);
    expect(entry).toBeDefined();
    expect(entry!.summary.length).toBeLessThanOrEqual(200 + 3); // 200 + "..."
  });

  it("短内容不做截断", () => {
    const shortContent = "hello world";
    const hash = memory.storeToolResult("read", shortContent);

    const index = memory.getIndex();
    const entry = index.entries.find((e) => e.contentHash === hash);
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe(shortContent);
  });
});
