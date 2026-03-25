import { describe, expect, it, beforeEach } from "vitest";
import {
  getKnowledgeRegistry,
  registerToolKnowledge,
  registerSectionKnowledge,
} from "./knowledge-index.js";
import type { ToolKnowledgeInput, SectionKnowledgeInput } from "./knowledge-index.js";

describe("KnowledgeRegistry", () => {
  beforeEach(() => {
    getKnowledgeRegistry().clear();
  });

  it("注册并获取工具知识", () => {
    const tools: ToolKnowledgeInput[] = [
      { name: "read", description: "Read file contents", parameters: { type: "object" } },
      { name: "exec", description: "Run shell commands", parameters: { type: "object" } },
    ];
    registerToolKnowledge(tools);

    const registry = getKnowledgeRegistry();
    expect(registry.size).toBe(5); // tool.index + read.desc + read.schema + exec.desc + exec.schema

    const readDesc = registry.get("tool.read.desc");
    expect(readDesc).toBeDefined();
    expect(readDesc!.content).toBe("Read file contents");
    expect(readDesc!.category).toBe("tool_desc");
    expect(readDesc!.tags).toContain("read");

    const readSchema = registry.get("tool.read.schema");
    expect(readSchema).toBeDefined();
    expect(readSchema!.category).toBe("tool_schema");
  });

  it("注册并获取 section 知识", () => {
    const sections: SectionKnowledgeInput[] = [
      {
        id: "safety",
        title: "## Safety",
        content: "Prioritize safety and human oversight.",
        tags: ["safety", "important"],
        priority: 0.9,
      },
      {
        id: "sandbox",
        title: "## Sandbox",
        content: "Running in Docker sandbox.",
        tags: ["sandbox", "docker"],
        priority: 0.7,
      },
    ];
    registerSectionKnowledge(sections);

    const registry = getKnowledgeRegistry();
    expect(registry.size).toBe(2);

    const safety = registry.get("section.safety");
    expect(safety).toBeDefined();
    expect(safety!.content).toBe("Prioritize safety and human oversight.");
    expect(safety!.priority).toBe(0.9);
  });

  it("按 tag 精确匹配", () => {
    registerToolKnowledge([
      { name: "cron", description: "Manage cron jobs", parameters: {} },
      { name: "read", description: "Read files", parameters: {} },
    ]);

    const registry = getKnowledgeRegistry();
    const results = registry.getByTag("cron");
    expect(results.length).toBe(2); // desc + schema
    expect(results.every((r) => r.tags.includes("cron"))).toBe(true);
  });

  it("按多 tag 匹配（去重）", () => {
    registerToolKnowledge([
      { name: "read", description: "Read files", parameters: {} },
      { name: "exec", description: "Run commands", parameters: {} },
      { name: "grep", description: "Search patterns", parameters: {} },
    ]);

    const registry = getKnowledgeRegistry();
    const results = registry.getByTags(["read", "grep"]);
    // read.desc, read.schema, grep.desc, grep.schema = 4 (tool.index 不在这些 tag 中)
    expect(results.length).toBe(4);
  });

  it("按 category 过滤", () => {
    registerToolKnowledge([
      { name: "read", description: "Read files", parameters: {} },
    ]);

    const registry = getKnowledgeRegistry();
    const descs = registry.getByCategory("tool_desc");
    expect(descs.length).toBe(1);
    expect(descs[0].id).toBe("tool.read.desc");

    const schemas = registry.getByCategory("tool_schema");
    expect(schemas.length).toBe(1);
    expect(schemas[0].id).toBe("tool.read.schema");
  });

  it("getToolIndex 返回工具索引", () => {
    registerToolKnowledge([
      { name: "read", description: "Read files", parameters: {} },
    ]);

    const registry = getKnowledgeRegistry();
    const index = registry.getToolIndex();
    expect(index).toBeDefined();
    expect(index!.category).toBe("tool_index");
    expect(index!.content).toContain("read");
  });

  it("clear 清空所有注册", () => {
    registerToolKnowledge([
      { name: "read", description: "Read files", parameters: {} },
    ]);

    const registry = getKnowledgeRegistry();
    expect(registry.size).toBeGreaterThan(0);
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it("重复注册同一 id 会覆盖", () => {
    registerSectionKnowledge([
      { id: "test", title: "## Test", content: "v1", tags: [] },
    ]);

    const registry = getKnowledgeRegistry();
    expect(registry.get("section.test")!.content).toBe("v1");

    registerSectionKnowledge([
      { id: "test", title: "## Test", content: "v2", tags: [] },
    ]);
    expect(registry.get("section.test")!.content).toBe("v2");
    expect(registry.size).toBe(1);
  });
});
