/**
 * History Archiver — 对话历史归档器（纯内存）
 *
 * 按"轮次"（turn = user + assistant + tool_results）归档旧消息。
 * 提供 HistoryIndex（目录）和 retrieve/search（内容）接口。
 *
 * 与 SessionMemory 互补：
 *   - SessionMemory: 缓存工具结果，按需知识检索
 *   - HistoryArchiver: 归档对话历史，按需历史回溯
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, ToolCall, UserMessage, Message } from "@mariozechner/pi-ai";

// ── 类型定义 ──────────────────────────────────────────────

export interface ArchivedTurn {
  /** 轮次序号（从 1 开始） */
  turnIndex: number;
  /** 该轮第一条消息的时间戳 */
  startTime: number;
  /** 用户消息文本摘要（前 200 字符） */
  userText: string;
  /** 助手文本摘要（前 500 字符） */
  assistantText: string;
  /** 该轮调用的工具名 */
  toolNames: string[];
  /** 估算的 token 数 */
  tokenEstimate: number;
  /** 完整消息列表（供 retrieve 返回） */
  fullMessages: AgentMessage[];
}

export interface HistoryIndex {
  /** 归档的轮次总数 */
  totalArchivedTurns: number;
  /** 归档的估算总 token */
  totalArchivedTokens: number;
  /** 每轮的摘要条目 */
  turns: Array<{
    turnIndex: number;
    summary: string;
    toolNames: string[];
  }>;
}

/** 单条消息的角色 */
type MessageRole = "user" | "assistant" | "toolResult";

// ── 常量 ──────────────────────────────────────────────────

/** 估算 token 的字符/token 比率（保守值，中文约 2 字符/token，英文约 4） */
const CHARS_PER_TOKEN_ESTIMATE = 3;
/** 用户消息摘要截取长度 */
const USER_TEXT_MAX_LENGTH = 200;
/** 助手消息摘要截取长度 */
const ASSISTANT_TEXT_MAX_LENGTH = 500;
/** 最大归档轮数 */
const MAX_ARCHIVED_TURNS = 200;

// ── 辅助函数 ──────────────────────────────────────────────

/**
 * 从消息中提取纯文本内容。
 * 支持 string content 和 (TextContent|ImageContent)[] 数组。
 */
function extractTextContent(msg: AgentMessage): string {
  // AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]
  // Message 的所有变体都有 content 属性
  const message = msg as Message;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * 从 assistant 消息中提取工具调用名列表。
 * SDK 的 AssistantMessage.content 中 ToolCall 对象格式：
 *   { type: "toolCall", id: string, name: string, arguments: Record<string, any> }
 */
function extractToolNames(msg: AssistantMessage): string[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((p): p is ToolCall => p.type === "toolCall" && typeof p.name === "string")
    .map((p) => p.name);
}

/**
 * 生成消息的唯一标识（基于时间戳 + role，因为没有 id 字段）。
 */
function messageFingerprint(msg: AgentMessage, index: number): string {
  const ts = ("timestamp" in msg && typeof msg.timestamp === "number") ? msg.timestamp : 0;
  return `${ts}:${msg.role}:${index}`;
}

// ── 核心类 ────────────────────────────────────────────────

export class HistoryArchiver {
  private turns = new Map<number, ArchivedTurn>();
  private archivedFingerprints = new Set<string>();

  /**
   * 归档窗口外的消息。
   *
   * @param messages - 当前活跃的消息列表（SDK 传来的完整历史）
   * @param keepRecentTurns - 保留最近多少轮
   * @returns 被归档的轮次数
   */
  archive(messages: AgentMessage[], keepRecentTurns: number): number {
    const turns = this.groupIntoTurns(messages);
    if (turns.length <= keepRecentTurns) {
      return 0;
    }

    const cutoffIndex = turns.length - keepRecentTurns;
    let archivedCount = 0;

    for (let i = 0; i < cutoffIndex; i++) {
      const turn = turns[i];
      // 跳过已经归档过的消息（通过 fingerprint 去重）
      const hasNewMessage = turn.messages.some(
        (m, idx) => !this.archivedFingerprints.has(messageFingerprint(m, idx)),
      );
      if (!hasNewMessage) continue;

      const archived: ArchivedTurn = {
        turnIndex: turn.turnIndex,
        startTime: turn.startTime,
        userText: turn.userText.slice(0, USER_TEXT_MAX_LENGTH),
        assistantText: turn.assistantText.slice(0, ASSISTANT_TEXT_MAX_LENGTH),
        toolNames: turn.toolNames,
        tokenEstimate: Math.ceil(turn.totalChars / CHARS_PER_TOKEN_ESTIMATE),
        fullMessages: turn.messages,
      };

      this.turns.set(turn.turnIndex, archived);
      for (let j = 0; j < turn.messages.length; j++) {
        this.archivedFingerprints.add(messageFingerprint(turn.messages[j], j));
      }
      archivedCount++;
    }

    // 超出上限时淘汰最旧的
    if (this.turns.size > MAX_ARCHIVED_TURNS) {
      const sorted = [...this.turns.keys()].sort((a, b) => a - b);
      const excess = this.turns.size - MAX_ARCHIVED_TURNS;
      for (let i = 0; i < excess; i++) {
        this.turns.delete(sorted[i]);
      }
    }

    return archivedCount;
  }

  /**
   * 生成历史目录索引。
   */
  getHistoryIndex(): HistoryIndex {
    const sorted = [...this.turns.entries()].sort((a, b) => a[0] - b[0]);
    let totalTokens = 0;
    const turns: HistoryIndex["turns"] = [];

    for (const [turnIndex, turn] of sorted) {
      totalTokens += turn.tokenEstimate;
      turns.push({
        turnIndex,
        summary: this.buildSummary(turn),
        toolNames: turn.toolNames,
      });
    }

    return {
      totalArchivedTurns: sorted.length,
      totalArchivedTokens: totalTokens,
      turns,
    };
  }

  /**
   * 按轮次号检索完整历史内容。
   */
  retrieveTurn(turnIndex: number): string | null {
    const turn = this.turns.get(turnIndex);
    if (!turn) return null;
    return this.formatTurnContent(turn);
  }

  /**
   * 按关键词搜索归档历史。
   */
  search(query: string): string {
    const lower = query.toLowerCase();
    const keywords = lower.split(/\s+/).filter((w) => w.length > 1);

    const matches: ArchivedTurn[] = [];
    for (const turn of this.turns.values()) {
      const text = `${turn.userText} ${turn.assistantText} ${turn.toolNames.join(" ")}`.toLowerCase();
      if (keywords.some((kw) => text.includes(kw))) {
        matches.push(turn);
      }
    }

    if (matches.length === 0) {
      return "No archived history matches your query.";
    }

    const parts = matches.slice(0, 5).map((t) =>
      `[T${t.turnIndex}] ${this.buildSummary(t)}`,
    );

    let result = `Found ${matches.length} matching turn(s):\n${parts.join("\n")}`;
    if (matches.length > 5) {
      result += `\n(Showing first 5 of ${matches.length} matches. Use history_read(turn=N) for specific turns.)`;
    }

    return result;
  }

  /** 获取归档轮次总数 */
  get archivedTurnCount(): number {
    return this.turns.size;
  }

  /**
   * 将消息列表分组为轮次。
   * 轮次定义：一个 user 消息开始，到下一个 user 消息之前（包含中间的 assistant 和 tool_result）。
   */
  private groupIntoTurns(
    messages: AgentMessage[],
  ): Array<{
    turnIndex: number;
    startTime: number;
    userText: string;
    assistantText: string;
    toolNames: string[];
    totalChars: number;
    messages: AgentMessage[];
  }> {
    const turns: Array<{
      turnIndex: number;
      startTime: number;
      userText: string;
      assistantText: string;
      toolNames: string[];
      totalChars: number;
      messages: AgentMessage[];
    }> = [];

    let currentTurn: (typeof turns)[number] | null = null;
    let turnIndex = 0;

    for (const msg of messages) {
      const role = msg.role as MessageRole;

      if (role === "user") {
        if (currentTurn) {
          turns.push(currentTurn);
        }
        turnIndex++;
        currentTurn = {
          turnIndex,
          startTime: ("timestamp" in msg && typeof msg.timestamp === "number") ? msg.timestamp : 0,
          userText: extractTextContent(msg),
          assistantText: "",
          toolNames: [],
          totalChars: 0,
          messages: [msg],
        };
      } else if (currentTurn) {
        currentTurn.messages.push(msg);
        const text = extractTextContent(msg);

        if (role === "assistant") {
          currentTurn.assistantText += (currentTurn.assistantText ? " " : "") + text;
          // 提取工具调用名（从 content 数组中的 ToolCall 对象）
          const toolNames = extractToolNames(msg as AssistantMessage);
          for (const name of toolNames) {
            if (!currentTurn.toolNames.includes(name)) {
              currentTurn.toolNames.push(name);
            }
          }
        }
        // tool_result: 计算字符数但不附加文本（结果通常很大）
        currentTurn.totalChars += text.length;
      }
    }

    if (currentTurn) {
      turns.push(currentTurn);
    }

    return turns;
  }

  private buildSummary(turn: ArchivedTurn): string {
    const parts: string[] = [];
    if (turn.userText) {
      parts.push(turn.userText.slice(0, 80));
    }
    if (turn.toolNames.length > 0) {
      parts.push(`[${turn.toolNames.join(", ")}]`);
    }
    return parts.join(" — ") || "(no content)";
  }

  private formatTurnContent(turn: ArchivedTurn): string {
    const MAX_OUTPUT_CHARS = 6000;
    const parts: string[] = [];
    let totalChars = 0;

    for (const msg of turn.fullMessages) {
      const role = msg.role as string;
      const text = extractTextContent(msg);
      if (!text) continue;

      // toolResult 消息附带工具名
      let prefix = `[${role}]`;
      if (msg.role === "toolResult") {
        const tr = msg as ToolResultMessage;
        prefix = `[toolResult:${tr.toolName ?? "unknown"}]`;
      }

      const line = `${prefix}: ${text}`;
      totalChars += line.length;
      if (totalChars > MAX_OUTPUT_CHARS) {
        parts.push(line.slice(0, MAX_OUTPUT_CHARS - totalChars) + "\n... (truncated)");
        break;
      }
      parts.push(line);
    }

    return parts.join("\n");
  }
}
