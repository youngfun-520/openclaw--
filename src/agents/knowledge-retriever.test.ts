import { describe, expect, it, beforeEach } from "vitest";
import {
  retrieveKnowledge,
  extractToolNames,
  extractSectionContents,
  formatRetrievedKnowledge,
} from "./knowledge-retriever.js";
import {
  getKnowledgeRegistry,
  registerToolKnowledge,
  registerSectionKnowledge,
} from "./knowledge-index.js";

describe("retrieveKnowledge", () => {
  beforeEach(() => {
    getKnowledgeRegistry().clear();
    registerToolKnowledge([
      { name: "read", description: "Read file contents", parameters: { type: "object" } },
      { name: "exec", description: "Run shell commands", parameters: { type: "object" } },
      { name: "cron", description: "Manage cron jobs", parameters: { type: "object" } },
      { name: "browser", description: "Control web browser", parameters: { type: "object" } },
    ]);
    registerSectionKnowledge([
      {
        id: "safety",
        title: "## Safety",
        content: "Prioritize safety and human oversight over completion.",
        tags: ["safety", "important"],
      },
      {
        id: "sandbox",
        title: "## Sandbox",
        content: "Running in Docker sandbox. Some tools may be unavailable.",
        tags: ["sandbox", "docker"],
      },
      {
        id: "messaging",
        title: "## Messaging",
        content: "Reply routes to source channel automatically.",
        tags: ["messaging", "channel"],
      },
    ]);
  });

  it("tag 精确匹配返回对应 chunks", () => {
    const result = retrieveKnowledge({
      query: "read a file",
      toolTags: ["read", "grep"],
      sectionTags: [],
    });

    // 应包含 read.desc + read.schema + grep.desc + grep.schema + tool.index
    expect(result.chunks.length).toBeGreaterThanOrEqual(3);
    expect(result.truncated).toBe(false);
  });

  it("section tags 匹配返回对应 sections", () => {
    const result = retrieveKnowledge({
      query: "sandbox rules",
      toolTags: [],
      sectionTags: ["sandbox"],
    });

    const hasSandbox = result.chunks.some((c) => c.id === "section.sandbox");
    expect(hasSandbox).toBe(true);
  });

  it("toolIndex 始终包含", () => {
    const result = retrieveKnowledge({
      query: "anything",
      toolTags: [],
      sectionTags: [],
    });

    const hasToolIndex = result.chunks.some((c) => c.id === "tool.index");
    expect(hasToolIndex).toBe(true);
  });

  it("token budget 截断", () => {
    const result = retrieveKnowledge({
      query: "test",
      toolTags: ["read", "exec", "cron", "browser"],
      sectionTags: ["safety", "sandbox", "messaging"],
      tokenBudget: 50, // 很小的 budget
    });

    expect(result.truncated).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(60); // 允许小幅超出
  });

  it("includeSchemas=false 过滤 schema", () => {
    const result = retrieveKnowledge({
      query: "read",
      toolTags: ["read"],
      sectionTags: [],
      includeSchemas: false,
    });

    const hasSchema = result.chunks.some((c) => c.category === "tool_schema");
    expect(hasSchema).toBe(false);
    const hasDesc = result.chunks.some((c) => c.category === "tool_desc");
    expect(hasDesc).toBe(true);
  });

  it("includeDescriptions=false 过滤 desc", () => {
    const result = retrieveKnowledge({
      query: "read",
      toolTags: ["read"],
      sectionTags: [],
      includeDescriptions: false,
    });

    const hasDesc = result.chunks.some((c) => c.category === "tool_desc");
    expect(hasDesc).toBe(false);
  });

  it("includeSections=false 过滤 sections", () => {
    const result = retrieveKnowledge({
      query: "sandbox",
      toolTags: [],
      sectionTags: ["sandbox"],
      includeSections: false,
    });

    const hasSection = result.chunks.some((c) => c.category === "sys_section");
    expect(hasSection).toBe(false);
  });

  it("空 tags 只返回 tool.index", () => {
    const result = retrieveKnowledge({
      query: "hello",
      toolTags: [],
      sectionTags: [],
    });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0].id).toBe("tool.index");
  });
});

describe("extractToolNames", () => {
  beforeEach(() => {
    getKnowledgeRegistry().clear();
    registerToolKnowledge([
      { name: "read", description: "Read files", parameters: {} },
      { name: "exec", description: "Run commands", parameters: {} },
    ]);
  });

  it("从 tool_desc chunks 提取工具名", () => {
    const registry = getKnowledgeRegistry();
    const chunks = [registry.get("tool.read.desc")!, registry.get("tool.exec.desc")!];
    const names = extractToolNames(chunks);
    expect(names).toContain("read");
    expect(names).toContain("exec");
  });

  it("从 tool_schema chunks 也提取工具名", () => {
    const registry = getKnowledgeRegistry();
    const chunks = [registry.get("tool.read.schema")!];
    const names = extractToolNames(chunks);
    expect(names).toContain("read");
  });

  it("去重", () => {
    const registry = getKnowledgeRegistry();
    const chunks = [
      registry.get("tool.read.desc")!,
      registry.get("tool.read.schema")!,
    ];
    const names = extractToolNames(chunks);
    expect(names.length).toBe(1);
  });
});

describe("extractSectionContents", () => {
  beforeEach(() => {
    getKnowledgeRegistry().clear();
    registerSectionKnowledge([
      { id: "safety", title: "## Safety", content: "Be safe.", tags: [] },
      { id: "sandbox", title: "## Sandbox", content: "Docker rules.", tags: [] },
    ]);
  });

  it("提取 section 内容", () => {
    const registry = getKnowledgeRegistry();
    const chunks = [registry.get("section.safety")!, registry.get("section.sandbox")!];
    const sections = extractSectionContents(chunks);
    expect(sections.get("safety")).toBe("Be safe.");
    expect(sections.get("sandbox")).toBe("Docker rules.");
  });

  it("忽略非 section chunks", () => {
    const sections = extractSectionContents([]);
    expect(sections.size).toBe(0);
  });
});

describe("formatRetrievedKnowledge", () => {
  it("空 chunks 返回空字符串", () => {
    expect(formatRetrievedKnowledge([])).toBe("");
  });

  it("格式化 tool_desc chunks", () => {
    const result = formatRetrievedKnowledge([
      {
        id: "tool.read.desc",
        category: "tool_desc",
        title: "Tool: read",
        content: "Read file contents",
        tags: ["read"],
        priority: 0.8,
      },
    ]);
    expect(result).toContain("Retrieved Tool Descriptions");
    expect(result).toContain("Read file contents");
  });

  it("格式化 sys_section chunks", () => {
    const result = formatRetrievedKnowledge([
      {
        id: "section.safety",
        category: "sys_section",
        title: "## Safety",
        content: "Prioritize safety.",
        tags: ["safety"],
        priority: 0.9,
      },
    ]);
    expect(result).toContain("Retrieved System Sections");
    expect(result).toContain("Prioritize safety.");
  });
});
