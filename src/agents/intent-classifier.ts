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
    keywords: [
      "cron", "schedule", "reminder", "remind", "alarm", "timer", "wake", "periodic",
      "提醒", "定时", "闹钟", "日程", "提醒我", "预约", "周期性", "每天", "每隔",
      "倒计时", "计时器",
    ],
    patterns: [/remind\s+me/i, /set\s+(a\s+)?timer/i, /in\s+\d+\s+(min|hour|sec)/i, /every\s+\d+/i, /提醒我/i, /设.*闹钟/i, /每天.*点/i, /每隔.*小时/i, /定时.*执行/i, /倒计时/i],
    toolTags: ["cron"],
    sectionTags: [],
    priority: 90,
  },
  {
    intent: "file_read",
    keywords: [
      "read", "show", "display", "view", "open", "cat ", "head ", "tail ", "print",
      "读取", "查看", "显示", "打开", "看看", "浏览", "读一下", "看一下",
    ],
    patterns: [/what'?s?\s+in/i, /contents?\s+of/i, /look\s+at/i, /check\s+(the\s+)?file/i, /查看.*文件/i, /读.*文件/i, /看看.*内容/i, /打开.*文件/i],
    toolTags: ["read", "grep", "find", "ls"],
    sectionTags: [],
    priority: 80,
  },
  {
    intent: "file_write",
    keywords: [
      "write", "create", "save", "new file", "generate file", "output file",
      "写入", "创建文件", "保存", "新建", "生成文件", "写文件", "新建文件",
    ],
    patterns: [/create\s+a\s+file/i, /write\s+(to|a)/i, /save\s+(to|as)/i, /创建.*文件/i, /新建.*文件/i, /写.*到.*文件/i],
    toolTags: ["write"],
    sectionTags: [],
    priority: 80,
  },
  {
    intent: "file_edit",
    keywords: [
      "edit", "modify", "change", "update", "fix", "replace", "patch", "refactor",
      "编辑", "修改", "更新", "修复", "替换", "重构", "改一下",
    ],
    patterns: [/change\s+(the|this|that)/i, /fix\s+(the|this|that|a)/i, /rename/i, /修改.*文件/i, /替换.*内容/i, /修复.*问题/i, /改一下/i],
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
      "运行", "执行", "安装", "编译", "构建", "测试", "部署", "启动",
      "命令行", "终端", "脚本",
    ],
    patterns: [/run\s+(a|the|this)?\s*(command|script)/i, /execute\s+/i, /start\s+(the\s+)?/i, /运行.*命令/i, /执行.*脚本/i, /安装.*包/i, /编译.*项目/i, /构建.*项目/i],
    toolTags: ["exec", "process"],
    sectionTags: ["sandbox"],
    priority: 70,
  },
  {
    intent: "web_search",
    keywords: [
      "search", "look up", "find", "google", "bing", "brave",
      "搜索", "查找", "搜一下", "找一下", "查询",
    ],
    patterns: [/search\s+(for|on|the|about)/i, /look\s+up/i, /what\s+is/i, /who\s+is/i, /how\s+(to|do|can)/i, /搜索.*关于/i, /查找.*信息/i, /搜一下/i],
    toolTags: ["web_search", "web_fetch"],
    sectionTags: [],
    priority: 60,
  },
  {
    intent: "web_fetch",
    keywords: [
      "fetch", "scrape", "crawl", "url", "website", "webpage", "http", "https://",
      "抓取", "爬取", "网页", "网址",
    ],
    patterns: [/fetch\s+(the\s+)?(url|content|page|data)/i, /get\s+(the\s+)?(content|data|info)\s+from/i, /抓取.*网页/i, /爬取.*内容/i],
    toolTags: ["web_fetch"],
    sectionTags: [],
    priority: 60,
  },
  {
    intent: "browser",
    keywords: [
      "browser", "browse", "navigate", "screenshot", "click", "scroll", "web page",
      "浏览器", "截图", "点击", "滚动", "网页",
    ],
    patterns: [/open\s+(the\s+)?browser/i, /go\s+to\s+(the\s+)?(url|website|page)/i, /take\s+a\s+screenshot/i, /打开浏览器/i, /截.*屏/i],
    toolTags: ["browser"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "message",
    keywords: [
      "send", "message", "dm", "notify", "reply", "channel", "slack", "telegram", "discord", "whatsapp",
      "发送", "消息", "通知", "回复", "频道",
    ],
    patterns: [/send\s+(a\s+)?message/i, /notify\s+/i, /dm\s+/i, /发送.*消息/i, /回复/i, /通知.*我/i],
    toolTags: ["message"],
    sectionTags: ["messaging", "reply_tags"],
    priority: 70,
  },
  {
    intent: "session",
    keywords: [
      "session", "history", "status", "model", "switch model", "reasoning",
      "会话", "历史", "状态", "模型", "切换模型", "推理",
    ],
    patterns: [/session_status/i, /what\s+model/i, /switch\s+(to\s+)?model/i, /toggle\s+reasoning/i, /查看.*状态/i, /切换.*模型/i],
    toolTags: ["session_status", "sessions_list", "sessions_history", "sessions_send"],
    sectionTags: [],
    priority: 65,
  },
  {
    intent: "subagent",
    keywords: [
      "spawn", "subagent", "sub-agent", "delegate", "parallel", "background task",
      "子代理", "委派", "并行", "后台任务",
    ],
    patterns: [/spawn\s+(a\s+)?(sub)?agent/i, /do\s+this\s+in/i, /run\s+(in|as)\s+/i],
    toolTags: ["sessions_spawn", "subagents", "agents_list"],
    sectionTags: [],
    priority: 70,
  },
  {
    intent: "image",
    keywords: [
      "image", "picture", "photo", "analyze image", "vision", "describe image", "ocr",
      "图片", "照片", "图像", "分析图片", "识别图片",
    ],
    patterns: [/analyze\s+(this|the)\s+image/i, /what(?:'s| is)\s+in\s+(this|the)\s+(image|picture|photo)/i, /分析.*图片/i, /看看.*图片/i],
    toolTags: ["image"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "image_generate",
    keywords: [
      "generate image", "create image", "paint", "illustration", "dall-e", "midjourney",
      "生成图片", "创建图片", "绘画", "插图",
    ],
    patterns: [/generate\s+(a|an|the)\s+image/i, /create\s+(a|an|the)\s+(image|picture|illustration)/i, /生成.*图片/i],
    toolTags: ["image_generate"],
    sectionTags: [],
    priority: 75,
  },
  {
    intent: "canvas",
    keywords: [
      "canvas", "plot", "chart", "graph", "visualization", "visualize", "diagram",
      "draw", "画布", "图表", "可视化", "绘图", "画图", "折线图", "柱状图",
    ],
    patterns: [/show\s+(on|in)\s+canvas/i, /plot\s+/i, /draw\s+a\s+(chart|graph|diagram)/i, /画.*图表/i, /画.*折线/i, /画.*柱状/i, /画一个.*图/i],
    toolTags: ["canvas"],
    sectionTags: [],
    priority: 78,
  },
  {
    intent: "nodes",
    keywords: [
      "node", "device", "camera", "screen", "remote", "paired",
      "节点", "设备", "摄像头", "屏幕", "远程", "配对",
    ],
    patterns: [/list\s+nodes/i, /notify\s+nodes/i, /camera\s+(on|capture|stream)/i, /列出.*节点/i],
    toolTags: ["nodes"],
    sectionTags: [],
    priority: 70,
  },
  {
    intent: "gateway",
    keywords: [
      "gateway", "restart", "config", "update", "upgrade", "openclaw",
      "网关", "重启", "配置", "更新", "升级",
    ],
    patterns: [/restart\s+(the\s+)?gateway/i, /apply\s+config/i, /update\s+openclaw/i, /openclaw\s+(status|help)/i, /重启.*网关/i, /更新.*配置/i],
    toolTags: ["gateway"],
    sectionTags: [],
    priority: 65,
  },
  {
    intent: "knowledge",
    keywords: [
      "knowledge", "how to", "help me use", "tool guide", "capability", "what can you",
      "知识", "怎么用", "工具指南", "功能", "你能做什么", "怎么使用",
    ],
    patterns: [/what\s+(tools|can you|are\s+the)/i, /how\s+do\s+i\s+use/i, /help\s+with/i, /怎么.*使用/i, /你能做什么/i, /有什么功能/i],
    toolTags: ["knowledge_search"],
    sectionTags: ["tooling", "tool_call_style"],
    priority: 50,
  },
];

// ── 问候/告别规则（单独处理，始终返回基础工具集） ──────────

const GREETING_KEYWORDS = [
  "hello", "hi", "hey", "good morning", "good afternoon", "good evening",
  "howdy", "greetings", "what's up", "sup", "yo",
  "你好", "您好", "早上好", "下午好", "晚上好", "嗨", "哈喽",
];

const FAREWELL_KEYWORDS = [
  "bye", "goodbye", "see you", "good night", "take care", "later",
  "farewell", "gotta go", "ttyl", "cya",
  "再见", "拜拜", "晚安", "回见", "下次见",
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
    /^(谢谢|感谢|多谢|辛苦了|麻烦了|太好了|不错|好的|没问题|可以|行|嗯|对|是)/,
    /^(再见|拜拜|晚安|回见)/,
    /^(你好|您好|嗨|哈喽|早上好|下午好|晚上好)/,
    /^[.?!。！？]+$/,
  ];
  return simplePatterns.some((pat) => pat.test(lower));
}
