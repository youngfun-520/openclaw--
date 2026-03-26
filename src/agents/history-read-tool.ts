/**
 * History Read Tool — LLM 可调用的历史检索工具
 *
 * 当 LLM 需要查看已归档的早期对话历史时，调用此工具。
 * 支持按轮次号检索或按关键词搜索。
 */

import type { AnyAgentTool } from "./pi-tools.types.js";
import { HistoryArchiver } from "./history-archiver.js";

// ── 工具定义 ──────────────────────────────────────────────

const TOOL_NAME = "history_read";

const TOOL_DESCRIPTION =
  "Retrieve archived conversation history from earlier in this session. " +
  "Use turn=N to get a specific turn's content, or query=\"...\" to search. " +
  "This is needed when context from an earlier conversation turn is required.";

const TOOL_PARAMETERS = {
  type: "object" as const,
  properties: {
    turn: {
      type: "number",
      description: "Turn index to retrieve (e.g. 1, 2, 3... as shown in the archived history index)",
    },
    query: {
      type: "string",
      description: "Search query to find relevant archived turns (alternative to turn number)",
    },
  },
  additionalProperties: false,
};

// ── 工具工厂 ──────────────────────────────────────────────

export interface CreateHistoryReadToolOptions {
  archiver: HistoryArchiver;
  enabled?: boolean;
}

/**
 * 创建 history_read 工具。
 */
export function createHistoryReadTool(
  options: CreateHistoryReadToolOptions,
): AnyAgentTool | null {
  if (options.enabled === false) {
    return null;
  }

  const { archiver } = options;

  return {
    label: "History Read",
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
    ) => {
      const turn = args.turn !== undefined ? Number(args.turn) : undefined;
      const query = args.query !== undefined ? String(args.query).trim() : undefined;

      let content: string;

      if (turn !== undefined && Number.isFinite(turn)) {
        const result = archiver.retrieveTurn(turn);
        if (!result) {
          content = `Turn ${turn} not found in archived history. Available turns: ${archiver.archivedTurnCount}.`;
        } else {
          content = result;
        }
      } else if (query) {
        content = archiver.search(query);
      } else {
        const index = archiver.getHistoryIndex();
        if (index.totalArchivedTurns === 0) {
          content = "No archived history available.";
        } else {
          content = `Archived history index (${index.totalArchivedTurns} turns, ~${index.totalArchivedTokens} tokens):\n` +
            index.turns.map((t) => `[T${t.turnIndex}] ${t.summary}`).join("\n") +
            "\n\nUse history_read(turn=N) to retrieve a specific turn.";
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ content }) }],
        details: undefined,
      };
    },
  };
}
