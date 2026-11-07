/**
 * Renders step templates: {{input.topic}}, {{steps.research.output}}, and in
 * a repeated workspace step {{loop.index}}, {{loop.item}}, {{loop.item.field}}
 * and {{loop.previous}}. Unknown references render as an empty string; braces
 * never execute code.
 */
export interface RenderContext {
  input: Record<string, string>;
  steps: Record<string, { output: string }>;
  loop?: { index: number; item?: unknown; previous?: string };
}

const text = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

export function render(template: string, ctx: RenderContext): string {
  return template.replace(/\{\{\s*(input|steps|loop)\.([a-z0-9_]+)(?:\.([a-z0-9_]+))?\s*\}\}/gi, (match, scope: string, key: string, sub: string | undefined) => {
    switch (scope.toLowerCase()) {
      case "input":
        return sub ? match : (ctx.input[key] ?? "");
      case "steps":
        return sub && sub.toLowerCase() !== "output" ? match : (ctx.steps[key]?.output ?? "");
      default: {
        if (!ctx.loop) return "";
        if (key === "index") return String(ctx.loop.index);
        if (key === "previous") return ctx.loop.previous ?? "";
        if (key !== "item") return "";
        const item = ctx.loop.item;
        if (!sub) return text(item);
        return item && typeof item === "object" ? text((item as Record<string, unknown>)[sub]) : "";
      }
    }
  });
}

/** Step keys a template reads from, for validation and estimates. */
export function referencedSteps(template: string): string[] {
  return [...template.matchAll(/\{\{\s*steps\.([a-z0-9_]+)/gi)].map((m) => m[1]!);
}

/** Turn a rendered list into items: a JSON array, or one item per non-empty line. */
export function listItems(rendered: string): unknown[] {
  const trimmed = rendered.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON: fall through to lines
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}
