/**
 * Intent Classifier — 轻量预分类引擎
 *
 * 纯规则引擎 + 可选 BM25 关键词匹配，不调用 LLM。
 * 延迟 <5ms，在用户消息到达后立即执行，输出 intent tags。
 *
 * Tags 供后续 knowledge-retriever 使用，
 * 用于精确匹配对应的工具 desc/schema 和系统提示词 section。
 */

// ── 类型定义 ──────────────────────────────────────────────

export type IntentCategory =
  | "greeting"
  | "farewell"
  | "question"
  | "file_read"
  | "file_write"
  | "file_edit"
  | "shell_exec"
  | "web_search"
  | "web_fetch"
  | "browser"
  | "cron"
  | "message"
  | "session"
  | "subagent"
  | "image"
  | "image_generate"
  | "canvas"
  | "nodes"
  | "gateway"
  | "knowledge"
  | "generic_task";

export interface ClassificationResult {
  /** 主意图分类 */
  intent: IntentCategory;
  /** 关联的工具 tag 列表（用于精确匹配知识库 chunks） */
  toolTags: string[];
  /** 关联的系统提示词 section tag 列表 */
  sectionTags: string[];
  /** 分类置信度 0-1 */
  confidence: number;
}

// ── 关键词规则表 ──────────────────────────────────────────

interface RuleEntry {
  intent: IntentCategory;
  /** 任一命中即触发 */
  keywords: string[];
  /** 正则表达式（可选，关键词匹配后进一步确认） */
  patterns?: RegExp[];
  toolTags: string[];
  sectionTags: string[];
  priority: number; // 高优先级先匹配
}

const RULES: RuleEntry[] = [
  {
    intent: "cron",
    keywords: ["cron", "schedule", "reminder", "remind", "alarm", "timer", "wake", "periodic"],
    patterns: [/remind\s+me/i, /set\s+(a\s+)?timer/i, /in\s+\d+\s+(min|hour|sec)/i, /every\s+\d+/i],
    toolTags: ["cron"],
    sectionTags: [],
    priority: 90,
  },
  {
    intent: "file_read",
    keywords: ["read", "show", "display", "view", "open", "cat ", "head ", "tail ", "print"],
    patterns: [/what'?s?\s+in/i, /contents?\s+of/i, /look\s+at/i, /check\s+(the\s+)?file/i],
    toolTags: ["read", "grep", "find", "ls"],
    sectionTags: [],
    priority: 80,
  },
  {
    intent: "file_write",
    keywords: ["write", "create", "save", "new file", "generate file", "output file"],
    patterns: [/create\s+a\s+file/i, /write\s+(to|a)/i, /save\s+(to|as)/i],
    toolTags: ["write"],
    sectionTags: [],
    priority: 80,
  },
  {
    intent: "file_edit",
    keywords: ["edit", "modify", "change", "update", "fix", "replace", "patch", "refactor"],
    patterns: [/change\s+(the|this|that)/i, /fix\s+(the|this|that|a)/i, /rename/i],
    toolTags: ["edit", "apply_patch", "read", "write"],
    sectionTags: [],
    priority: 80,
  },
  {
    intent: "shell_exec",
    keywords: [
      "run", "exec", "execute", "command", "install", "npm", "pip", "cargo", "go ",
      "python ", "node ", "bash", "shell", "compile", "build", "test", "deploy",
      "git ", "docker", "curl", "wget", "chmod", "systemctl",
    ],
    patterns: [/run\s+(a|the|this)?\s*(command|script)/i, /execute\s+/i, /start\s+(the\s+)?/i],
    toolTags: ["exec", "process"],
    sectionTags: ["sandbox"],
    priority: 70,
  },
  {
    intent: "web_search",
    keywords: ["search", "look up", "find", "google", "bing", "brave"],
    patterns: [/search\s+(for|on|the|about)/i, /look\s+up/i, /what\s+is/i, /who\s+is/i, /how\s+(to|do|can)/i],
    toolTags: ["web_search", "web_fetch"],
    sectionTags: [],
    priority: 60,
  },
  {
    intent: "web_fetch",
    keywords: ["fetch", "scrape", "crawl", "url", "website", "webpage", "http", "https://"],
    patterns: [/fetch\s+(the\s+)?(url|content|page|data)/i, /get\s+(the\s+)?(content|data|info)\s+from/i],
    toolTags: ["web_fetch"],
    sectionTags: [],
    priority: 60,
  },
  {
    intent: "browser",
    keywords: ["browser", "browse", "navigate", "screenshot", "click", "scroll", "web page"],
    patterns: [/open\s+(the\s+)?browser/i, /go\s+to\s+(the\s+)?(url|website|page)/i, /take\s+a\s+screenshot/i],
    toolTags: ["browser"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "message",
    keywords: ["send", "message", "dm", "notify", "reply", "channel", "slack", "telegram", "discord", "whatsapp"],
    patterns: [/send\s+(a\s+)?message/i, /notify\s+/i, /dm\s+/i],
    toolTags: ["message"],
    sectionTags: ["messaging", "reply_tags"],
    priority: 70,
  },
  {
    intent: "session",
    keywords: ["session", "history", "status", "model", "switch model", "reasoning"],
    patterns: [/session_status/i, /what\s+model/i, /switch\s+(to\s+)?model/i, /toggle\s+reasoning/i],
    toolTags: ["session_status", "sessions_list", "sessions_history", "sessions_send"],
    sectionTags: [],
    priority: 65,
  },
  {
    intent: "subagent",
    keywords: ["spawn", "subagent", "sub-agent", "delegate", "parallel", "background task"],
    patterns: [/spawn\s+(a\s+)?(sub)?agent/i, /do\s+this\s+in/i, /run\s+(in|as)\s+/i],
    toolTags: ["sessions_spawn", "subagents", "agents_list"],
    sectionTags: [],
    priority: 70,
  },
  {
    intent: "image",
    keywords: ["image", "picture", "photo", "analyze image", "vision", "describe image", "ocr"],
    patterns: [/analyze\s+(this|the)\s+image/i, /what(?:'s| is)\s+in\s+(this|the)\s+(image|picture|photo)/i],
    toolTags: ["image"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "image_generate",
    keywords: ["generate image", "create image", "draw", "paint", "illustration", "dall-e", "midjourney"],
    patterns: [/generate\s+(a|an|the)\s+image/i, /create\s+(a|an|the)\s+(image|picture|illustration)/i],
    toolTags: ["image_generate"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "canvas",
    keywords: ["canvas", "plot", "chart", "graph", "visualization", "visualize", "diagram"],
    patterns: [/show\s+(on|in)\s+canvas/i, /plot\s+/i, /draw\s+a\s+(chart|graph|diagram)/i],
    toolTags: ["canvas"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "nodes",
    keywords: ["node", "device", "camera", "screen", "remote", "paired"],
    patterns: [/list\s+nodes/i, /notify\s+nodes/i, /camera\s+(on|capture|stream)/i],
    toolTags: ["nodes"],
    sectionTags: [],
    priority: 70,
  },
  {
    intent: "gateway",
    keywords: ["gateway", "restart", "config", "update", "upgrade", "openclaw"],
    patterns: [/restart\s+(the\s+)?gateway/i, /apply\s+config/i, /update\s+openclaw/i, /openclaw\s+(status|help)/i],
    toolTags: ["gateway"],
    sectionTags: [],
    priority: 65,
  },
  {
    intent: "knowledge",
    keywords: ["knowledge", "how to", "help me use", "tool guide", "capability", "what can you"],
    patterns: [/what\s+(tools|can you|are\s+the)/i, /how\s+do\s+i\s+use/i, /help\s+with/i],
    toolTags: ["knowledge_search"],
    sectionTags: ["tooling", "tool_call_style"],
    priority: 50,
  },
];

// ── 问候/告别规则（单独处理，始终返回基础工具集） ──────────

const GREETING_KEYWORDS = [
  "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
  "howdy", "greetings", "what's up", "sup", "yo",
];

const FAREWELL_KEYWORDS = [
  "bye", "goodbye", "see you", "good night", "take care", "later",
  "farewell", "gotta go", "ttyl", "cya",
];

// ── 默认工具集（所有意图都包含的基础工具） ────────────────

const BASE_TOOL_TAGS = ["read", "ls", "find", "grep"];
const BASE_SECTION_TAGS: string[] = [];

// ── 核心：classify 函数 ───────────────────────────────────

export function classifyIntent(userMessage: string): ClassificationResult {
  const trimmed = userMessage.trim();

  // 空消息或纯表情/空白
  if (!trimmed || trimmed.length <= 2) {
    return {
      intent: "greeting",
      toolTags: BASE_TOOL_TAGS,
      sectionTags: BASE_SECTION_TAGS,
      confidence: 0.5,
    };
  }

  const lower = trimmed.toLowerCase();

  // 问候检测
  if (GREETING_KEYWORDS.some((kw) => lower === kw || lower.startsWith(kw + " ") || lower.startsWith(kw + "!"))) {
    return {
      intent: "greeting",
      toolTags: BASE_TOOL_TAGS,
      sectionTags: BASE_SECTION_TAGS,
      confidence: 0.95,
    };
  }

  // 告别检测
  if (FAREWELL_KEYWORDS.some((kw) => lower === kw || lower.startsWith(kw + " ") || lower.startsWith(kw + "!"))) {
    return {
      intent: "farewell",
      toolTags: BASE_TOOL_TAGS,
      sectionTags: BASE_SECTION_TAGS,
      confidence: 0.95,
    };
  }

  // 规则匹配：按 priority 降序
  const matches: { rule: RuleEntry; score: number }[] = [];

  for (const rule of RULES) {
    let score = 0;

    // 关键词匹配（每个命中的关键词加 1 分）
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        score += 1;
      }
    }

    // 正则匹配（每个命中加 2 分，权重更高）
    if (rule.patterns) {
      for (const pat of rule.patterns) {
        if (pat.test(trimmed)) {
          score += 2;
        }
      }
    }

    if (score > 0) {
      matches.push({ rule, score });
    }
  }

  // 无规则命中 → generic_task
  if (matches.length === 0) {
    return {
      intent: "generic_task",
      toolTags: [...BASE_TOOL_TAGS, "exec", "write", "edit"],
      sectionTags: ["tooling", "tool_call_style"],
      confidence: 0.4,
    };
  }

  // 按 (priority * score) 降序排列，取最高分
  matches.sort((a, b) => b.rule.priority * b.score - a.rule.priority * a.score);
  const best = matches[0];
  const maxPossibleScore = best.rule.keywords.length + (best.rule.patterns?.length ?? 0) * 2;
  const confidence = Math.min(best.score / Math.max(maxPossibleScore * 0.5, 1), 1);

  // 合并所有命中的 toolTags 和 sectionTags（去重）
  const toolTags = [...new Set([...BASE_TOOL_TAGS, ...best.rule.toolTags])];
  const sectionTags = [...new Set([...BASE_SECTION_TAGS, ...best.rule.sectionTags])];

  // 额外匹配：如果意图是 web_search 但内容像问问题，补充 knowledge_search
  if (best.rule.intent === "web_search" || best.rule.intent === "question") {
    toolTags.push("knowledge_search");
  }

  return {
    intent: best.rule.intent,
    toolTags,
    sectionTags,
    confidence,
  };
}

/**
 * 快速判断是否为简单对话（问候/告别/感谢/确认），
 * 这类消息只需要最小系统提示词。
 */
export function isSimpleConversation(message: string): boolean {
  const lower = message.trim().toLowerCase();
  const simplePatterns = [
    /^(thanks?|thank you|thx|ty|cheers|appreciate)/,
    /^(ok|okay|sure|got it|understood|alright|fine|great|awesome|cool|perfect|nice|sweet|lol|ha|😅|👍|❤️|🎉)/,
    /^(yes|no|yep|nope|yeah|nah|mhm|uh huh)/,
    /^(hello|hi|hey|good\s+(morning|afternoon|evening)|howdy|greetings)/,
    /^(bye|goodbye|see\s+you|good\s+night|take\s+care|later|farewell|ttyl|cya)/,
    /^[.?!]+$/,
    /^(haha|lol|lmao|rofl|😂|🤣)/,
    /^[a-z]{1,3}(!|\?|\.){1,3}$/,
  ];
  return simplePatterns.some((pat) => pat.test(lower));
}
