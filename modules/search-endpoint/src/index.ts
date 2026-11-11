import { NodeCallError, type KnowledgeSource, type Passage } from "@conclave/contract";
import { defineModule, httpError, requireString, statusForError } from "@conclave/module-sdk";

/**
 * Protocol dock (MOD-004) for knowledge that already lives somewhere else: any
 * search or retrieval endpoint that takes a query and answers with matching
 * text. A vector database's query API, a search service, your own retrieval
 * service in front of an index. Conclave sends the query; how the store was
 * filled is not its business.
 *
 * The request is JSON: { query, limit, sources? }. The answer is read
 * generously, because these APIs all name things a little differently:
 * - the list is `passages`, `results`, `matches`, `documents`, `hits`, `data`
 *   or `items`, or the body itself when it is a list;
 * - each item's text is `text`, `content`, `chunk`, `page_content`,
 *   `snippet` or `body` (also under `document`, `metadata` or `payload`);
 * - its name is `title` or `name`, its address `url`, `uri`, `link` or `path`,
 *   and its fit `score`, `similarity` or `relevance` (or `distance`, where
 *   smaller is better).
 */

const first = (obj: Record<string, unknown> | undefined, keys: string[]): unknown => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  return undefined;
};
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Turn one item of an answer into a passage, or nothing when it carries no text. */
function toPassage(item: unknown, n: number): (Passage & { rawScore?: number; lowerIsBetter?: boolean }) | null {
  if (typeof item === "string") return item.trim() ? { text: item, source: { id: `result-${n + 1}` } } : null;
  const top = record(item);
  if (!top) return null;
  const nests = [top, record(top.document), record(top.metadata), record(top.payload), record(top.fields)].filter((r): r is Record<string, unknown> => !!r);
  const pick = (keys: string[]) => {
    for (const r of nests) {
      const v = first(r, keys);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const text = pick(["text", "content", "chunk", "page_content", "pageContent", "snippet", "body", "passage"]);
  if (typeof text !== "string" || !text.trim()) return null;
  const title = pick(["title", "name", "heading"]);
  const uri = pick(["url", "uri", "link", "path", "source_url"]);
  const id = pick(["id", "document_id", "doc_id", "source"]);
  const score = pick(["score", "similarity", "relevance", "relevance_score"]);
  const distance = pick(["distance"]);
  const raw = typeof score === "number" ? score : typeof distance === "number" ? distance : undefined;
  return {
    text,
    source: {
      id: String(typeof id === "string" || typeof id === "number" ? id : typeof uri === "string" ? uri : `result-${n + 1}`),
      ...(typeof title === "string" && title ? { title } : {}),
      ...(typeof uri === "string" && uri ? { uri } : {}),
    },
    ...(raw !== undefined ? { rawScore: raw, lowerIsBetter: typeof score !== "number" } : {}),
  };
}

/** Read an endpoint's answer into passages, best first, with scores brought into 0 to 1. */
export function readPassages(body: unknown, limit: number): Passage[] {
  const top = record(body);
  const list = Array.isArray(body) ? body : (first(top, ["passages", "results", "matches", "documents", "hits", "data", "items"]) as unknown);
  // Some services nest once more: { hits: { hits: [...] } }.
  const items = Array.isArray(list) ? list : Array.isArray(record(list)?.hits) ? (record(list)!.hits as unknown[]) : [];
  const found = items.map(toPassage).filter((p): p is NonNullable<ReturnType<typeof toPassage>> => !!p);
  const scores = found.map((p) => p.rawScore).filter((s): s is number => typeof s === "number");
  const lowerIsBetter = found.some((p) => p.lowerIsBetter);
  const max = Math.max(...scores, 0);
  const min = Math.min(...scores, 0);
  const inRange = scores.every((s) => s >= 0 && s <= 1);
  const scored = found.map(({ rawScore, lowerIsBetter: _low, ...p }): Passage => {
    if (rawScore === undefined) return p;
    // Distances turn into "closer is higher"; scores outside 0 to 1 are scaled to the best one.
    const score = lowerIsBetter ? 1 / (1 + Math.max(0, rawScore)) : inRange ? rawScore : max > min ? (rawScore - min) / (max - min) : 1;
    return { ...p, score: Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000 };
  });
  // Keep the service's own order unless every passage has a score to sort by.
  if (scored.length && scored.every((p) => p.score !== undefined)) scored.sort((a, b) => b.score! - a.score!);
  return scored.slice(0, limit);
}

export default defineModule({
  manifest: {
    id: "conclave/search-endpoint",
    version: "1.0.0",
    name: "Search endpoint",
    description: "Knowledge that lives somewhere else: any search or retrieval endpoint that takes a query and answers with matching text.",
    ports: ["knowledge@1"],
    docks: ["protocol"],
    config: [
      { key: "url", label: "Search URL", type: "url", required: true, placeholder: "https://search.example.com/query", help: 'Receives a POST with JSON: { "query", "limit", "sources" }.' },
      { key: "token", label: "Access token", type: "secret", help: "Sent as Authorization: Bearer, when the endpoint needs one." },
      { key: "queryField", label: "Name of the query field", type: "string", default: "query", help: 'For endpoints that call it something else, such as "q" or "text".' },
      { key: "limitField", label: "Name of the limit field", type: "string", default: "limit", help: 'Such as "top_k" or "k".' },
      { key: "sources", label: "Sources", type: "string", placeholder: "handbook, policies", help: "Optional, comma-separated: the collections or indexes it has. The chosen one is sent as the sources field." },
      { key: "pricePerCallUsd", label: "Price per search (USD)", type: "number", default: 0 },
    ],
    permissions: { egress: ["{config.url}"], secrets: ["token"] },
    reference: true,
  },
  create(ctx) {
    const named = String(ctx.config.sources ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sources: KnowledgeSource[] = [{ id: "*", name: "Everything it has" }, ...named.map((id) => ({ id, name: id }))];
    const queryField = String(ctx.config.queryField || "query");
    const limitField = String(ctx.config.limitField || "limit");

    return {
      ports: {
        knowledge: {
          listSources: async () => sources,

          async search(req, call) {
            if (call.signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
            const query = (req.query ?? "").trim();
            if (!query) throw new NodeCallError("invalid_request", "Give something to look for.", false);
            const url = requireString(ctx.config.url, "Search URL");
            const limit = Math.max(1, Math.min(50, Math.floor(req.limit) || 5));
            const wanted = (req.sources ?? []).filter((s) => s !== "*");
            let res: Response;
            try {
              res = await ctx.fetch(url, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json",
                  traceparent: call.call.trace.traceparent,
                  ...(ctx.secrets.token ? { authorization: `Bearer ${ctx.secrets.token}` } : {}),
                },
                body: JSON.stringify({ [queryField]: query, [limitField]: limit, ...(wanted.length ? { sources: wanted } : {}) }),
                signal: AbortSignal.any([call.signal, AbortSignal.timeout(60_000)]),
              });
            } catch (err) {
              if (call.signal.aborted || err instanceof NodeCallError) throw err;
              throw new NodeCallError("unavailable", `Could not reach the search endpoint: ${err instanceof Error ? err.message : String(err)}`, true);
            }
            const raw = await res.text();
            if (!res.ok) throw httpError(res.status, `The search endpoint answered ${res.status}${raw ? `: ${raw.slice(0, 300)}` : ""}`);
            let body: unknown;
            try {
              body = JSON.parse(raw);
            } catch {
              throw new NodeCallError("invalid_request", "The search endpoint did not answer with JSON.", false);
            }
            const usage = record(record(body)?.usage);
            return {
              passages: readPassages(body, limit),
              ...(typeof usage?.costUsd === "number" ? { usage: { costUsd: usage.costUsd } } : {}),
            };
          },
        },
      },
      async health() {
        try {
          requireString(ctx.config.url, "Search URL");
          // A real search could cost money or be logged as a user's query, so a test only checks the settings.
          return { status: "working", detail: `Ready to search${named.length ? ` ${named.length} source${named.length === 1 ? "" : "s"}` : ""}.` };
        } catch (err) {
          return statusForError(err);
        }
      },
      discover: async () => ({ sources: sources.map((s) => ({ id: s.id, ...(s.name ? { name: s.name } : {}) })) }),
    };
  },
});
