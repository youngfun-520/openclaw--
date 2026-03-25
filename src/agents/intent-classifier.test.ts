import { describe, expect, it } from "vitest";
import { classifyIntent, isSimpleConversation } from "./intent-classifier.js";

describe("classifyIntent", () => {
  it("识别问候语", () => {
    const r = classifyIntent("hello");
    expect(r.intent).toBe("greeting");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("识别中文问候", () => {
    const r = classifyIntent("你好");
    // "你好" 长度<=2 会走到空消息分支返回 greeting
    expect(r.intent).toBe("greeting");
  });

  it("识别 hey", () => {
    const r = classifyIntent("hey");
    expect(r.intent).toBe("greeting");
  });

  it("识别告别语", () => {
    const r = classifyIntent("goodbye");
    expect(r.intent).toBe("farewell");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("识别 see you", () => {
    const r = classifyIntent("see you");
    expect(r.intent).toBe("farewell");
  });

  it("识别文件读取意图", () => {
    const r = classifyIntent("read the config.json file");
    expect(r.intent).toBe("file_read");
    expect(r.toolTags).toContain("read");
    expect(r.toolTags).toContain("grep");
    expect(r.toolTags).toContain("find");
  });

  it("识别文件写入意图", () => {
    const r = classifyIntent("create a new file called test.ts");
    expect(r.intent).toBe("file_write");
    expect(r.toolTags).toContain("write");
  });

  it("识别文件编辑意图", () => {
    const r = classifyIntent("fix the bug in server.ts");
    expect(r.intent).toBe("file_edit");
    expect(r.toolTags).toContain("edit");
  });

  it("识别 shell 执行意图", () => {
    const r = classifyIntent("run npm install");
    expect(r.intent).toBe("shell_exec");
    expect(r.toolTags).toContain("exec");
  });

  it("识别 cron/定时器意图", () => {
    const r = classifyIntent("remind me to check emails in 30 minutes");
    expect(r.intent).toBe("cron");
    expect(r.toolTags).toContain("cron");
  });

  it("识别 web search 意图", () => {
    const r = classifyIntent("search the web for TypeScript best practices");
    expect(r.intent).toBe("web_search");
    expect(r.toolTags).toContain("web_search");
  });

  it("识别 browser 意图", () => {
    const r = classifyIntent("open the browser and take a screenshot");
    expect(r.intent).toBe("browser");
    expect(r.toolTags).toContain("browser");
  });

  it("识别 message 意图", () => {
    const r = classifyIntent("send a message to John");
    expect(r.intent).toBe("message");
    expect(r.toolTags).toContain("message");
  });

  it("识别 image 分析意图", () => {
    const r = classifyIntent("analyze this image");
    expect(r.intent).toBe("image");
    expect(r.toolTags).toContain("image");
  });

  it("识别 image 生成意图", () => {
    const r = classifyIntent("generate an image of a cat");
    expect(r.intent).toBe("image_generate");
    expect(r.toolTags).toContain("image_generate");
  });

  it("识别 gateway 意图", () => {
    const r = classifyIntent("restart the gateway");
    expect(r.intent).toBe("gateway");
    expect(r.toolTags).toContain("gateway");
  });

  it("识别 knowledge 意图", () => {
    const r = classifyIntent("what tools are available?");
    expect(r.intent).toBe("knowledge");
    expect(r.toolTags).toContain("knowledge_search");
  });

  it("识别 generic_task（无规则命中）", () => {
    const r = classifyIntent("I think the weather is nice today");
    expect(r.intent).toBe("generic_task");
  });

  it("空消息返回 greeting", () => {
    const r = classifyIntent("");
    expect(r.intent).toBe("greeting");
  });

  it("极短消息返回 greeting", () => {
    const r = classifyIntent("ok");
    // "ok" 会命中 simplePatterns 但不会命中 greeting keywords
    // classifyIntent 不检测 simplePatterns，那是 isSimpleConversation 的职责
    expect(["greeting", "generic_task"]).toContain(r.intent);
  });

  it("所有结果都包含基础工具 tags", () => {
    const r = classifyIntent("whatever");
    expect(r.toolTags).toContain("read");
    expect(r.toolTags).toContain("ls");
    expect(r.toolTags).toContain("find");
    expect(r.toolTags).toContain("grep");
  });

  it("toolTags 是去重的", () => {
    const r = classifyIntent("read the file and edit it");
    // 不应该有重复的 tag
    const unique = new Set(r.toolTags);
    expect(unique.size).toBe(r.toolTags.length);
  });

  it("sectionTags 正确关联", () => {
    const r = classifyIntent("run a shell command");
    expect(r.sectionTags).toContain("sandbox");
  });

  it("高优先级规则优先匹配", () => {
    // "remind me" 同时命中 cron（优先级90）和可能的 generic
    const r = classifyIntent("remind me to call mom");
    expect(r.intent).toBe("cron");
  });
});

describe("isSimpleConversation", () => {
  it("识别 thanks", () => {
    expect(isSimpleConversation("thanks")).toBe(true);
  });

  it("识别 thank you", () => {
    expect(isSimpleConversation("thank you")).toBe(true);
  });

  it("识别 ok", () => {
    expect(isSimpleConversation("ok")).toBe(true);
  });

  it("识别 haha", () => {
    expect(isSimpleConversation("haha")).toBe(true);
  });

  it("识别纯标点", () => {
    expect(isSimpleConversation("...")).toBe(true);
  });

  it("识别 yes", () => {
    expect(isSimpleConversation("yes")).toBe(true);
  });

  it("普通请求不是简单对话", () => {
    expect(isSimpleConversation("read the file")).toBe(false);
  });

  it("空字符串不是简单对话", () => {
    // 空字符串不匹配任何 simplePatterns 正则
    expect(isSimpleConversation("")).toBe(false);
  });

  it("长文本不是简单对话", () => {
    expect(isSimpleConversation("can you help me install node and configure the project")).toBe(false);
  });
});
