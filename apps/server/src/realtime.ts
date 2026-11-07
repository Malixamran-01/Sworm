import type { ClientMessage, ServerMessage } from "@conclave/contract";
import type { Conclave, Principal } from "@conclave/core";
import type { FastifyInstance } from "fastify";

/**
 * One WebSocket per client, multiplexed topics (SRS 7.3). The socket is
 * authenticated like any request (session cookie or access token). On
 * reconnect the client sends its last seq; missed events are replayed from
 * the buffer, or the client is told to refetch.
 */
export function registerRealtime(app: FastifyInstance, conclave: Conclave): void {
  app.get("/v1/realtime", { websocket: true, config: { guard: { auth: "user" } } }, (socket, req) => {
    const p = req.principal!;
    const subscribed = new Set<string>();
    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const unsubscribe = conclave.bus.subscribe("*", (envelope) => {
      if (envelope.topics.some((t) => subscribed.has(t))) send({ type: "event", envelope });
    });

    send({ type: "hello", seq: conclave.bus.lastSeq });

    socket.on("message", async (raw: Buffer | string) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "unsubscribe") {
        for (const t of msg.topics) subscribed.delete(t);
        return;
      }
      if (msg.type !== "subscribe" || !Array.isArray(msg.topics)) return;
      const allowed: string[] = [];
      for (const topic of msg.topics.slice(0, 100)) if (await canSee(conclave, p, topic)) allowed.push(topic);
      for (const t of allowed) subscribed.add(t);
      if (typeof msg.lastSeq === "number" && allowed.length > 0) {
        const missed = conclave.bus.replay(allowed, msg.lastSeq);
        if (missed === null) send({ type: "refetch", topics: allowed });
        else for (const envelope of missed) send({ type: "event", envelope });
      }
    });

    socket.on("close", () => unsubscribe());
  });
}

/** Topics follow the same rules as the API: your inbox, and workspaces and tasks you can read (HIVE-006 applies them to the graph too). */
async function canSee(conclave: Conclave, p: Principal, topic: string): Promise<boolean> {
  const [kind, value, rest] = topic.split(":");
  if (!value) return false;
  if (kind === "user") return value === p.userId && rest === "inbox";
  try {
    if (kind === "workspace") return await conclave.access.can(conclave.db, p, "workspace:read", value);
    if (kind === "run") return await conclave.access.can(conclave.db, p, "workspace:read", await conclave.access.workspaceOfRun(conclave.db, p, value));
  } catch {
    return false;
  }
  return false;
}
