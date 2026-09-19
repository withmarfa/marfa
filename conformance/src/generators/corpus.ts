/**
 * Text corpus for generating FTS-searchable content in load tests.
 * Uses a seeded PRNG for reproducible output across runs.
 */

// Seeded PRNG — mulberry32, deterministic from a single 32-bit seed.
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  // Common nouns
  "meeting",
  "project",
  "team",
  "report",
  "review",
  "update",
  "plan",
  "budget",
  "deadline",
  "schedule",
  "client",
  "customer",
  "product",
  "service",
  "system",
  "process",
  "strategy",
  "analysis",
  "research",
  "development",
  "design",
  "interface",
  "database",
  "network",
  "server",
  "application",
  "feature",
  "component",
  "module",
  "library",
  "framework",
  "platform",
  "dashboard",
  "workflow",
  "pipeline",
  "deployment",
  "release",
  "version",
  "patch",
  "ticket",
  "issue",
  "task",
  "milestone",
  "sprint",
  "backlog",
  "story",
  "requirement",
  "specification",
  "documentation",
  "tutorial",
  "guide",
  "reference",
  "example",
  "template",
  "pattern",
  "architecture",
  "model",
  "controller",
  "handler",
  "middleware",
  "plugin",
  "extension",
  "widget",
  "element",
  "container",
  "wrapper",
  "adapter",
  "bridge",
  "factory",
  "provider",
  "consumer",
  "observer",
  "listener",
  "dispatcher",
  "router",
  "validator",
  "formatter",
  "parser",
  "serializer",
  "transformer",
  "mapper",
  "reducer",
  "selector",
  "resolver",
  "loader",
  "fetcher",
  "cache",
  "queue",
  "stack",
  "tree",
  "graph",
  "table",
  "index",
  "collection",
  "record",
  "entry",
  "field",
  "column",
  "row",
  "cell",
  "page",
  "section",
  "chapter",
  "article",
  "post",
  "comment",
  "reply",
  "message",
  "thread",
  "conversation",
  "discussion",
  "feedback",
  "suggestion",
  "proposal",
  "decision",
  "agreement",
  "contract",
  "invoice",
  "receipt",
  "payment",
  "transaction",
  "account",
  "balance",
  "credit",
  "deposit",
  "transfer",
  "report",
  "summary",
  "overview",
  "insight",
  "metric",
  "indicator",
  "benchmark",
  "target",
  "goal",
  "objective",
  "outcome",
  "result",
  "performance",
  "quality",
  "efficiency",
  "productivity",
  "capacity",
  "resource",
  "asset",
  "inventory",
  "supply",
  "demand",
  "market",
  "competition",
  "advantage",
  "opportunity",
  "challenge",
  "risk",
  "solution",
  "approach",
  "method",
  "technique",
  "practice",
  "standard",
  "policy",
  "procedure",
  "guideline",
  "principle",
  "concept",
  "theory",
  "hypothesis",
  "experiment",
  "observation",
  "measurement",
  "data",
  "information",
  "knowledge",
  "wisdom",
  "experience",
  "skill",
  "talent",
  "ability",
  "competence",
  "expertise",
  "proficiency",
  "mastery",
  "training",
  "education",
  "learning",
  "growth",
  "improvement",
  "progress",
  "achievement",
  "success",
  "failure",
  "mistake",
  "error",
  "problem",
  "morning",
  "afternoon",
  "evening",
  "night",
  "weekend",
  "holiday",
  "travel",
  "conference",
  "workshop",
  "seminar",
  "presentation",
  "lecture",
  "interview",
  "assessment",
  "evaluation",
  "certification",
  "diploma",
  "portfolio",
  "resume",
  "profile",
  "biography",
  "history",
  "timeline",
  "calendar",
  "agenda",
  "notebook",
  "journal",
  "diary",
  "log",
  "archive",
  "folder",
  "document",
  "spreadsheet",
  "chart",
  "diagram",
  "sketch",
  "prototype",
  "mockup",
  "wireframe",
  "layout",
  "theme",
  "style",
  "color",
  "font",
  "image",
  "icon",
  "logo",
  "banner",
  "header",
  "footer",
  "sidebar",
  "menu",
  "toolbar",
  "button",
  "link",
  "form",
  "input",
  "output",
  "display",
  "screen",
  "window",
  "panel",
  "modal",
  "dialog",
  "notification",
  "alert",
  "warning",
  "status",
  "progress",
  "loading",
  "error",
  "success",
  "pending",
  "complete",
  "active",
  "health",
  "fitness",
  "nutrition",
  "recipe",
  "ingredient",
  "cooking",
  "garden",
  "plant",
  "flower",
  "weather",
  "temperature",
  "season",
  "book",
  "author",
  "chapter",
  "story",
  "character",
  "scene",
  "plot",
  "music",
  "song",
  "artist",
  "album",
  "playlist",
  "podcast",
  "episode",
  "film",
  "series",
  "documentary",
  "photography",
  "camera",
  "lens",
  // Verbs
  "create",
  "build",
  "develop",
  "implement",
  "deploy",
  "launch",
  "release",
  "update",
  "upgrade",
  "migrate",
  "refactor",
  "optimize",
  "improve",
  "fix",
  "resolve",
  "debug",
  "test",
  "validate",
  "verify",
  "review",
  "approve",
  "reject",
  "merge",
  "revert",
  "rollback",
  "configure",
  "install",
  "setup",
  "initialize",
  "bootstrap",
  "provision",
  "scale",
  "monitor",
  "track",
  "measure",
  "analyze",
  "investigate",
  "diagnose",
  "plan",
  "design",
  "architect",
  "prototype",
  "sketch",
  "draft",
  "write",
  "document",
  "describe",
  "explain",
  "illustrate",
  "demonstrate",
  "present",
  "share",
  "publish",
  "distribute",
  "deliver",
  "ship",
  "manage",
  "organize",
  "coordinate",
  "facilitate",
  "lead",
  "mentor",
  "collaborate",
  "communicate",
  "discuss",
  "negotiate",
  "decide",
  "prioritize",
  "schedule",
  "assign",
  "delegate",
  "automate",
  "simplify",
  "integrate",
  "connect",
  "sync",
  "transform",
  "convert",
  "export",
  "import",
  "backup",
  "restore",
  "archive",
  "delete",
  "remove",
  "clean",
  "search",
  "filter",
  "sort",
  "group",
  "aggregate",
  "summarize",
  "calculate",
  "estimate",
  "forecast",
  "predict",
  "recommend",
  "suggest",
  "evaluate",
  "compare",
  "contrast",
  "benchmark",
  "assess",
  "audit",
  "secure",
  "encrypt",
  "authenticate",
  "authorize",
  "protect",
  "guard",
  "consider",
  "explore",
  "discover",
  "learn",
  "understand",
  "remember",
  "capture",
  "record",
  "note",
  "bookmark",
  "highlight",
  "annotate",
  "tag",
  "label",
  "categorize",
  "classify",
  "index",
  "catalog",
  // Adjectives
  "important",
  "critical",
  "urgent",
  "essential",
  "primary",
  "secondary",
  "major",
  "minor",
  "significant",
  "relevant",
  "useful",
  "valuable",
  "effective",
  "efficient",
  "optimal",
  "ideal",
  "perfect",
  "excellent",
  "good",
  "great",
  "outstanding",
  "remarkable",
  "exceptional",
  "superior",
  "advanced",
  "complex",
  "sophisticated",
  "comprehensive",
  "thorough",
  "detailed",
  "specific",
  "general",
  "broad",
  "narrow",
  "deep",
  "shallow",
  "fast",
  "slow",
  "quick",
  "rapid",
  "gradual",
  "steady",
  "stable",
  "reliable",
  "robust",
  "resilient",
  "flexible",
  "scalable",
  "portable",
  "secure",
  "safe",
  "protected",
  "encrypted",
  "private",
  "public",
  "internal",
  "external",
  "local",
  "remote",
  "distributed",
  "centralized",
  "automated",
  "manual",
  "interactive",
  "responsive",
  "dynamic",
  "static",
  "temporary",
  "permanent",
  "persistent",
  "volatile",
  "mutable",
  "immutable",
  "new",
  "old",
  "current",
  "previous",
  "next",
  "latest",
  "upcoming",
  "weekly",
  "monthly",
  "quarterly",
  "annual",
  "daily",
  "regular",
  // Adverbs
  "also",
  "however",
  "therefore",
  "meanwhile",
  "furthermore",
  "additionally",
  "specifically",
  "particularly",
  "especially",
  "generally",
  "typically",
  "currently",
  "recently",
  "previously",
  "subsequently",
  "finally",
  "initially",
  "gradually",
  "significantly",
  "substantially",
  "considerably",
  // Topic words for search testing
  "kubernetes",
  "docker",
  "terraform",
  "ansible",
  "jenkins",
  "grafana",
  "prometheus",
  "elasticsearch",
  "postgresql",
  "redis",
  "kafka",
  "rabbitmq",
  "typescript",
  "javascript",
  "python",
  "rust",
  "golang",
  "swift",
  "react",
  "angular",
  "vue",
  "svelte",
  "nextjs",
  "remix",
  "astro",
  "tailwind",
  "bootstrap",
  "material",
  "figma",
  "sketch",
  "canva",
  "github",
  "gitlab",
  "bitbucket",
  "jira",
  "confluence",
  "notion",
  "slack",
  "discord",
  "teams",
  "zoom",
  "calendar",
  "email",
  "api",
  "rest",
  "graphql",
  "grpc",
  "websocket",
  "webhook",
  "oauth",
  "jwt",
  "token",
  "session",
  "cookie",
  "header",
  "endpoint",
  "microservice",
  "monolith",
  "serverless",
  "container",
  "orchestration",
  "cicd",
  "devops",
  "sre",
  "oncall",
  "incident",
  "postmortem",
  "runbook",
];

/**
 * Marker phrases for deterministic search validation.
 * Each marker appears in a known fraction of items, enabling
 * tests to verify search result counts.
 */
export const SEARCH_MARKERS = {
  /** Appears in ~1% of items */
  rare: "alpha-cardinal-nine",
  /** Appears in ~5% of items */
  uncommon: "bravo-falcon-seven",
  /** Appears in ~0.1% of items (very rare, for testing empty-ish results) */
  veryRare: "zulu-phantom-zero",
  /** Appears in ~10% of items */
  common: "quarterly review notes",
} as const;

export interface CorpusOptions {
  seed?: number;
}

/**
 * Corpus generator — produces reproducible text content for load test items.
 * All output is deterministic for a given seed.
 */
export class Corpus {
  private rand: () => number;

  constructor(options: CorpusOptions = {}) {
    this.rand = mulberry32(options.seed ?? 42);
  }

  word(): string {
    return WORDS[Math.floor(this.rand() * WORDS.length)];
  }

  sentence(): string {
    const len = 5 + Math.floor(this.rand() * 11);
    const words = Array.from({ length: len }, () => this.word());
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    return words.join(" ") + ".";
  }

  paragraph(): string {
    const len = 3 + Math.floor(this.rand() * 6);
    return Array.from({ length: len }, () => this.sentence()).join(" ");
  }

  body(targetWords: number): string {
    const paragraphs: string[] = [];
    let wordCount = 0;
    while (wordCount < targetWords) {
      const p = this.paragraph();
      paragraphs.push(p);
      wordCount += p.split(" ").length;
    }
    return paragraphs.join("\n\n");
  }

  title(): string {
    const len = 3 + Math.floor(this.rand() * 6);
    const words = Array.from({ length: len }, () => this.word());
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  url(): string {
    const domains = [
      "example.com",
      "docs.dev",
      "blog.io",
      "wiki.org",
      "news.net",
    ];
    const domain = domains[Math.floor(this.rand() * domains.length)];
    const path = Array.from({ length: 2 + Math.floor(this.rand() * 3) }, () =>
      this.word(),
    );
    return `https://${domain}/${path.join("/")}`;
  }

  /** Empty string when this index carries no marker. */
  markerForIndex(index: number, total: number): string {
    const _frac = index / total;
    if (index % 100 === 0) return SEARCH_MARKERS.rare;
    if (index % 20 === 0) return SEARCH_MARKERS.uncommon;
    if (index % 1000 === 0) return SEARCH_MARKERS.veryRare;
    if (index % 10 === 0 && _frac < 0.1) return SEARCH_MARKERS.common;
    return "";
  }

  noteProperties(index: number, total: number): Record<string, unknown> {
    const wordCount = 100 + Math.floor(this.rand() * 4900);
    let bodyText = this.body(wordCount);
    const marker = this.markerForIndex(index, total);
    if (marker) {
      bodyText += `\n\n${marker}`;
    }
    return { title: this.title(), body: bodyText };
  }

  bookmarkProperties(index: number, total: number): Record<string, unknown> {
    const marker = this.markerForIndex(index, total);
    const desc = this.paragraph() + (marker ? ` ${marker}` : "");
    return {
      url: this.url(),
      title: this.title(),
      description: desc,
    };
  }

  taskProperties(index: number, total: number): Record<string, unknown> {
    const marker = this.markerForIndex(index, total);
    const desc = this.sentence() + (marker ? ` ${marker}` : "");
    return {
      title: this.title(),
      description: desc,
      status: "pending",
      priority: ["low", "medium", "high"][Math.floor(this.rand() * 3)],
    };
  }

  personProperties(): Record<string, unknown> {
    const names = [
      "Alice",
      "Bob",
      "Charlie",
      "Diana",
      "Eve",
      "Frank",
      "Grace",
      "Henry",
    ];
    const name = names[Math.floor(this.rand() * names.length)];
    const surname = this.word().charAt(0).toUpperCase() + this.word().slice(1);
    return {
      name: `${name} ${surname}`,
      given_name: name,
      family_name: surname,
      email: `${this.word()}@example.com`,
    };
  }

  workProperties(index: number, total: number): Record<string, unknown> {
    const marker = this.markerForIndex(index, total);
    const desc = this.paragraph() + (marker ? ` ${marker}` : "");
    return {
      title: this.title(),
      author:
        this.word().charAt(0).toUpperCase() +
        this.word().slice(1) +
        " " +
        this.word().charAt(0).toUpperCase() +
        this.word().slice(1),
      description: desc,
    };
  }

  customProperties(index: number, total: number): Record<string, unknown> {
    const marker = this.markerForIndex(index, total);
    const text = this.paragraph() + (marker ? ` ${marker}` : "");
    return { content: text, category: this.word() };
  }
}

/**
 * Pool order is the frequency order `pickTags` weights against, so the named
 * categories come first and generated filler follows.
 */
export function generateTagPool(size: number, seed: number = 42): string[] {
  const rand = mulberry32(seed);
  const categories = [
    "work",
    "personal",
    "research",
    "learning",
    "project",
    "meeting",
    "review",
    "design",
    "bug",
    "feature",
    "urgent",
    "follow-up",
    "reference",
    "idea",
    "draft",
    "planning",
    "retro",
    "onboarding",
    "security",
    "performance",
  ];
  const tags: string[] = [];

  for (const cat of categories) {
    if (tags.length >= size) break;
    tags.push(cat);
  }

  let counter = 0;
  while (tags.length < size) {
    const prefix = WORDS[Math.floor(rand() * WORDS.length)];
    const tag = `${prefix}-${counter}`;
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
    counter++;
  }

  return tags;
}

/**
 * Power-law: a tag earlier in the pool is exponentially likelier to be picked,
 * which is what gives a corpus a few hot tags and a long tail.
 */
export function pickTags(
  pool: string[],
  count: number,
  rand: () => number,
): string[] {
  const selected: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.pow(rand(), 2) * pool.length);
    const tag = pool[idx];
    if (!selected.includes(tag)) {
      selected.push(tag);
    }
  }
  return selected;
}
