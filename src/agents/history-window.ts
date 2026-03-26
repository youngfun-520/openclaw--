/**
 * History Window Manager — transformContext 中间件
 *
 * 挂在 Agent.transformContext 上，将旧消息归档并注入历史索引。
 * 与 tool-result-context-guard.ts 链式串联，不影响现有工具结果截断逻辑。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { UserMessage } from "@mariozechner/pi-ai";
import { HistoryArchiver } from "./history-archiver.js";

// ── 类型定义 ──────────────────────────────────────────────

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

export interface HistoryWindowConfig {
  /** 保留最近多少轮（默认 6） */
  keepRecentTurns: number;
}

// ── 核心函数 ────────────────────────────────────────────────

/**
 * 安装历史窗口管理器到 Agent 的 transformContext 链上。
 *
 * 返回一个清理函数，调用后恢复原始 transformContext。
 */
export function installHistoryWindowManager(params: {
  agent: GuardableAgent;
  archiver: HistoryArchiver;
  config: HistoryWindowConfig;
}): () => void {
  const { agent, archiver, config } = params;
  const mutableAgent = agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  const wrappedTransformContext: GuardableTransformContext = async (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => {
    // 先执行原始 transformContext（如 tool-result-context-guard）
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;

    // 归档窗口外的消息
    const archivedCount = archiver.archive(contextMessages, config.keepRecentTurns);
    if (archivedCount === 0) {
      return contextMessages;
    }

    // 找到保留的消息起点
    const cutoff = contextMessages.length - countRecentMessages(contextMessages, config.keepRecentTurns);
    if (cutoff <= 0) {
      return contextMessages;
    }

    // 保留的消息
    const keptMessages = contextMessages.slice(cutoff);

    // 生成历史索引消息并插入
    const index = archiver.getHistoryIndex();
    const indexMessage = buildIndexMessage(index);

    // 在第一条 user 消息之前插入
    const insertPos = findInsertPosition(keptMessages);
    const result = [...keptMessages];
    result.splice(insertPos, 0, indexMessage as AgentMessage);

    return result;
  };
  mutableAgent.transformContext = wrappedTransformContext;

  // 返回清理函数
  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}

/**
 * 计算保留最近 N 轮对应的消息数量。
 */
function countRecentMessages(messages: AgentMessage[], keepRecentTurns: number): number {
  let turnCount = 0;
  let msgCount = 0;

  // 从后向前扫描，计算最近 N 轮的消息数
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role === "user") {
      turnCount++;
      if (turnCount > keepRecentTurns) break;
    }
    msgCount++;
  }

  return msgCount;
}

/**
 * 找到第一条 user 消息的位置（用于插入索引消息）。
 */
function findInsertPosition(messages: AgentMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      return i;
    }
  }
  return 0;
}

/**
 * 构建历史索引消息。
 */
function buildIndexMessage(index: { totalArchivedTurns: number; totalArchivedTokens: number; turns: Array<{ turnIndex: number; summary: string; toolNames: string[] }> }): UserMessage {
  const tokenEstimate = Math.ceil(index.totalArchivedTokens);
  const turnSummaries = index.turns
    .map((t) => {
      const tools = t.toolNames.length > 0 ? ` (${t.toolNames.join(", ")})` : "";
      return `[T${t.turnIndex}]${tools} ${t.summary}`;
    })
    .join("\n");

  const content =
    `[Archived conversation history: ${index.totalArchivedTurns} earlier turns (~${tokenEstimate} tokens) available via history_read tool]\n` +
    (turnSummaries ? `${turnSummaries}\n` : "") +
    `Use history_read(turn=N) to retrieve a specific turn, or history_search(query="...") to search.`;

  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}
