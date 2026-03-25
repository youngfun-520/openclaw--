/**
 * Dynamic Prompt Builder — 动态系统提示词组装器
 *
 * 替代 buildAgentSystemPrompt() 的按需组装模式。
 * 只在需要时加载相关的工具和系统提示词 section，
 * 而不是一次性注入全部 ~9,500 tokens。
 *
 * 通过 feature flag `dynamicPrompt.enabled` 控制，
 * 默认关闭，保持原有行为不变。
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { buildMemoryPromptSection } from "../memory/prompt-section.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import { buildRuntimeLine } from "./system-prompt.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";
import { buildToolSummaryMap } from "./tool-summaries.js";
import type { EmbeddedSandboxInfo } from "./pi-embedded-runner/types.js";
import type { ReasoningLevel, ThinkLevel } from "./pi-embedded-runner/utils.js";
import { classifyIntent, type ClassificationResult } from "./intent-classifier.js";
import { retrieveKnowledge, type RetrievalResult } from "./knowledge-retriever.js";
import type { SessionMemory } from "./session-memory.js";

// ── 类型定义 ──────────────────────────────────────────────

export interface DynamicPromptOptions {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
  reasoningTagHint: boolean;
  heartbeatPrompt?: string;
  skillsPrompt?: string;
  docsPath?: string;
  ttsHint?: string;
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  workspaceNotes?: string[];
  acpEnabled?: boolean;
  runtimeInfo: {
    agentId?: string;
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    capabilities?: string[];
    channel?: string;
    channelActions?: string[];
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
  tools: AgentTool[];
  modelAliasLines: string[];
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  memoryCitationsMode?: MemoryCitationsMode;
  /** 动态组装所需的输入 */
  classification: ClassificationResult;
  retrieval: RetrievalResult;
  sessionMemory?: SessionMemory;
}

// ── 核心：buildDynamicSystemPrompt ───────────────────────

/**
 * 动态组装系统提示词。
 *
 * 与 buildAgentSystemPrompt() 的区别：
 *   1. 固定骨架 ~200 tokens（身份 + 核心行为 + 时间 + runtime）
 *   2. 工具列表只包含全名索引 + 命中工具的描述
 *   3. 系统提示词 section 只包含检索到的相关 section
 *   4. 始终包含 knowledge_search 工具说明
 */
export function buildDynamicSystemPrompt(options: DynamicPromptOptions): string {
  const {
    classification,
    retrieval,
    sessionMemory,
    extraSystemPrompt,
    reasoningTagHint,
    sandboxInfo,
    runtimeInfo,
    tools,
    contextFiles,
    memoryCitationsMode,
    heartbeatPrompt,
    skillsPrompt,
    docsPath,
    ttsHint,
    workspaceNotes,
    reactionGuidance,
    workspaceDir,
    userTimezone,
    reasoningLevel,
    defaultThinkLevel,
    modelAliasLines,
    messageToolHints,
    acpEnabled,
    ownerNumbers,
    ownerDisplay,
    ownerDisplaySecret,
  } = options;

  const sandboxedRuntime = sandboxInfo?.enabled === true;
  const acpSpawnRuntimeEnabled = (acpEnabled !== false) && !sandboxedRuntime;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");

  const toolNames = tools.map((t) => t.name);
  const toolSummaryMap = buildToolSummaryMap(tools);
  const availableTools = new Set(toolNames.map((n) => n.toLowerCase()));
  const hasGateway = availableTools.has("gateway");
  const readToolName = "read";
  const execToolName = "exec";

  // ── 固定骨架 ──
  const lines: string[] = [
    "You are a personal assistant running inside OpenClaw.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy). Tool names are case-sensitive.",
  ];

  // 全工具名索引（轻量列表）
  const toolIndexLines = toolNames
    .filter((name) => {
      // knowledge_search 始终包含
      if (name === "knowledge_search") return true;
      // classification 中的 toolTags 对应的工具优先展示描述
      return classification.toolTags.includes(name.toLowerCase());
    })
    .map((name) => {
      const summary = toolSummaryMap[name];
      return summary ? `- ${name}: ${summary}` : `- ${name}`;
    });

  // 其余工具只列名称
  const otherTools = toolNames.filter(
    (name) => name !== "knowledge_search" && !classification.toolTags.includes(name.toLowerCase()),
  );
  if (otherTools.length > 0) {
    toolIndexLines.push(`Other available tools: ${otherTools.join(", ")}`);
  }

  lines.push(...toolIndexLines);
  lines.push("");

  // ── Tool Call Style（始终包含，token 少） ──
  lines.push(
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, or when explicitly asked.",
    "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI commands.",
    "",
  );

  // ── Safety（始终包含） ──
  lines.push(
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask.",
    "Do not manipulate or persuade anyone to expand access or disable safeguards.",
    "",
  );

  // ── Skills（如果有） ──
  const trimmedSkills = skillsPrompt?.trim();
  if (trimmedSkills) {
    lines.push(
      "## Skills (mandatory)",
      "Before replying: scan <available_skills> <description> entries.",
      `- If exactly one skill clearly applies: read its SKILL.md with \`${readToolName}\`, then follow it.`,
      "- If none clearly apply: do not read any SKILL.md.",
      trimmedSkills,
      "",
    );
  }

  // ── Memory section ──
  if (availableTools.size > 0) {
    const memorySection = buildMemoryPromptSection({
      isMinimal: false,
      availableTools,
      citationsMode: memoryCitationsMode,
    });
    if (memorySection.length > 0) {
      lines.push(...memorySection);
    }
  }

  // ── Gateway（条件性） ──
  if (hasGateway) {
    lines.push(
      "## OpenClaw Self-Update",
      "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
      "Do not run config.apply or update.run unless the user explicitly requests an update or config change.",
      "",
    );
  }

  // ── Workspace ──
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(workspaceDir);
  const sandboxContainerWorkspace = sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;

  lines.push(
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `For file tools use host workspace: ${sanitizedWorkspaceDir}. For exec use sandbox paths under ${sanitizedSandboxContainerWorkspace}.`
      : "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    ...(workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean),
    "",
  );

  // ── Docs（条件性） ──
  const docsPathTrimmed = docsPath?.trim();
  if (docsPathTrimmed) {
    lines.push(
      "## Documentation",
      `OpenClaw docs: ${docsPathTrimmed}`,
      "Mirror: https://docs.openclaw.ai",
      "",
    );
  }

  // ── Sandbox section（仅在 sandbox 模式或相关 section 被检索到时包含） ──
  if (sandboxInfo?.enabled || classification.sectionTags.includes("sandbox")) {
    if (sandboxInfo?.enabled) {
      lines.push("## Sandbox");
      lines.push("You are running in a sandboxed runtime (tools execute in Docker).");
      lines.push("Some tools may be unavailable due to sandbox policy.");
      if (sandboxContainerWorkspace) {
        lines.push(`Sandbox container workdir: ${sanitizeForPromptLiteral(sandboxContainerWorkspace)}`);
      }
      lines.push("");
    }
  }

  // ── 时间 ──
  const userTimezoneTrimmed = userTimezone?.trim();
  if (userTimezoneTrimmed) {
    lines.push("## Current Date & Time", `Time zone: ${userTimezoneTrimmed}`, "");
  }

  // ── Reply Tags（仅在消息相关意图时包含） ──
  if (classification.sectionTags.includes("reply_tags") || classification.intent === "message") {
    lines.push(
      "## Reply Tags",
      `To request a native reply/quote: [[reply_to_current]] your reply (must be the very first token).`,
      "",
    );
  }

  // ── Messaging（仅在消息相关意图时包含） ──
  if (classification.sectionTags.includes("messaging") || classification.intent === "message") {
    lines.push(
      "## Messaging",
      "- Reply in current session → automatically routes to the source channel.",
      "- Cross-session messaging → use sessions_send(sessionKey, message).",
      availableTools.has("message")
        ? `- Use \`message\` for proactive sends + channel actions. If multiple channels: pass \`channel\` (${messageChannelOptions}).`
        : "",
      "",
    );
  }

  // ── Voice（条件性） ──
  const ttsHintTrimmed = ttsHint?.trim();
  if (ttsHintTrimmed) {
    lines.push("## Voice (TTS)", ttsHintTrimmed, "");
  }

  // ── Group Chat Context（不变） ──
  if (extraSystemPrompt?.trim()) {
    lines.push("## Group Chat Context", extraSystemPrompt.trim(), "");
  }

  // ── Reactions（条件性） ──
  if (reactionGuidance) {
    const { level, channel } = reactionGuidance;
    lines.push(
      "## Reactions",
      level === "minimal"
        ? `Reactions are enabled for ${channel} in MINIMAL mode. React ONLY when truly relevant (at most 1 per 5-10 exchanges).`
        : `Reactions are enabled for ${channel} in EXTENSIVE mode. React whenever it feels natural.`,
      "",
    );
  }

  // ── Reasoning Format（条件性） ──
  if (reasoningTagHint) {
    lines.push(
      "## Reasoning Format",
      "ALL internal reasoning MUST be inside =d thinking =.",
      "Format every reply as =d thinking =d then <final>...</final>, with no other text.",
      "",
    );
  }

  // ── Project Context（contextFiles 不变） ──
  const validContextFiles = (contextFiles ?? []).filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );
  if (validContextFiles.length > 0) {
    lines.push("# Project Context", "");
    lines.push("The following project context files have been loaded:", "");
    for (const file of validContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // ── Silent Replies（始终包含，token 少） ──
  lines.push(
    "## Silent Replies",
    `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
    "",
  );

  // ── Heartbeats（条件性） ──
  const heartbeatTrimmed = heartbeatPrompt?.trim();
  if (heartbeatTrimmed) {
    lines.push(
      "## Heartbeats",
      `Heartbeat prompt: ${heartbeatTrimmed}`,
      'If nothing needs attention, reply exactly: HEARTBEAT_OK',
      "",
    );
  }

  // ── Knowledge Search 工具说明（新增，始终包含） ──
  lines.push(
    "## Knowledge Lookup",
    `A \`knowledge_search\` tool is available to look up detailed tool usage, safety rules, or system guides on demand.`,
    "Use it when you need information not listed in this system prompt.",
    "",
  );

  // ── 检索到的动态知识注入 ──
  if (retrieval.chunks.length > 0) {
    lines.push("## Retrieved Knowledge (dynamic)", "");
    for (const chunk of retrieval.chunks) {
      if (chunk.category === "sys_section") {
        lines.push(chunk.content, "");
      }
    }
  }

  // ── Session Memory Index（如果有） ──
  if (sessionMemory) {
    const memoryIndex = sessionMemory.formatMemoryIndex(15);
    if (memoryIndex) {
      lines.push(memoryIndex);
    }
  }

  // ── Authorized Senders ──
  if (ownerNumbers && ownerNumbers.length > 0) {
    lines.push(
      "## Authorized Senders",
      `Authorized senders: ${ownerNumbers.join(", ")}. These senders are allowlisted; do not assume they are the owner.`,
      "",
    );
  }

  // ── Model Aliases（条件性） ──
  if (modelAliasLines && modelAliasLines.length > 0) {
    lines.push(
      "## Model Aliases",
      "Prefer aliases when specifying model overrides.",
      ...modelAliasLines,
      "",
    );
  }

  // ── Runtime（始终包含） ──
  lines.push(
    "## Runtime",
    buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, defaultThinkLevel),
    `Reasoning: ${reasoningLevel ?? "off"} (hidden unless on/stream).`,
  );

  return lines.filter(Boolean).join("\n");
}

// ── 便捷：一步构建 ───────────────────────────────────────

/**
 * 从用户消息一步完成预分类 + 检索 + 动态 prompt 组装。
 */
export function buildDynamicPromptFromMessage(
  userMessage: string,
  options: Omit<DynamicPromptOptions, "classification" | "retrieval">,
): { prompt: string; classification: ClassificationResult; retrieval: RetrievalResult } {
  const classification = classifyIntent(userMessage);
  const retrieval = retrieveKnowledge({
    query: userMessage,
    toolTags: classification.toolTags,
    sectionTags: classification.sectionTags,
    tokenBudget: 1500,
  });

  const prompt = buildDynamicSystemPrompt({
    ...options,
    classification,
    retrieval,
  });

  return { prompt, classification, retrieval };
}
