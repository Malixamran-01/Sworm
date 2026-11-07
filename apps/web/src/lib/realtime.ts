import type { ConclaveEvent, InboxItemDto, RunDetailDto, RunSummaryDto, ServerMessage } from "@conclave/contract";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { showDesktop } from "./notify";

/**
 * One WebSocket per client, multiplexed topics (SRS 7.3). Events update the
 * query cache directly, so a step finishing updates the task list, the task
 * panel, Home and the inbox at once.
 */
class Realtime {
  private ws: WebSocket | null = null;
  private readonly counts = new Map<string, number>();
  private lastSeq = 0;
  private retry = 0;
  private client: QueryClient | null = null;
  private readonly deltas = new Map<string, string>();
  private readonly deltaListeners = new Set<() => void>();
  private connected = false;
  private readonly statusListeners = new Set<() => void>();
  private readonly pending = new Map<string, QueryKey>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Opens an app path; the shell sets it so clicking a notification uses the router. */
  navigate: (path: string) => void = (path) => location.assign(path);

  attach(client: QueryClient) {
    this.client = client;
  }

  /** Open the socket; called once someone is signed in (the socket needs the session). */
  start() {
    if (this.running) return;
    this.running = true;
    this.retry = 0;
    this.connect();
  }

  /** Close the socket on sign-out and stop reconnecting. */
  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
  }

  private connect() {
    if (!this.running) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/v1/realtime`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      const topics = [...this.counts.keys()];
      if (topics.length) ws.send(JSON.stringify({ type: "subscribe", topics, lastSeq: this.lastSeq }));
    };
    ws.onmessage = (e) => this.handle(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.setConnected(false);
      if (this.running) this.reconnectTimer = setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
  }

  private setConnected(value: boolean) {
    this.connected = value;
    for (const l of this.statusListeners) l();
  }

  isConnected = () => this.connected;
  onStatus = (fn: () => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };

  subscribe(topics: string[]): () => void {
    const added = topics.filter((t) => {
      const n = this.counts.get(t) ?? 0;
      this.counts.set(t, n + 1);
      return n === 0;
    });
    if (added.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "subscribe", topics: added, lastSeq: this.lastSeq }));
    }
    return () => {
      const removed = topics.filter((t) => {
        const n = (this.counts.get(t) ?? 1) - 1;
        if (n <= 0) this.counts.delete(t);
        else this.counts.set(t, n);
        return n <= 0;
      });
      if (removed.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "unsubscribe", topics: removed }));
    };
  }

  delta(runId: string, stepKey: string): string {
    return this.deltas.get(`${runId}:${stepKey}`) ?? "";
  }
  onDelta = (fn: () => void) => {
    this.deltaListeners.add(fn);
    return () => this.deltaListeners.delete(fn);
  };

  /** Coalesce refetches that many events ask for at once. */
  private invalidateSoon(key: QueryKey) {
    this.pending.set(JSON.stringify(key), key);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      for (const k of this.pending.values()) void this.client?.invalidateQueries({ queryKey: k });
      this.pending.clear();
    }, 250);
  }

  private handle(msg: ServerMessage) {
    const qc = this.client;
    if (!qc) return;
    if (msg.type === "hello") {
      if (this.lastSeq === 0) this.lastSeq = msg.seq;
      return;
    }
    if (msg.type === "refetch") {
      void qc.invalidateQueries();
      return;
    }
    if (msg.envelope.seq > 0) this.lastSeq = Math.max(this.lastSeq, msg.envelope.seq);
    if (msg.envelope.event.type === "notification") {
      showDesktop(msg.envelope.event.item, msg.envelope.at, this.navigate);
      return;
    }
    this.apply(qc, msg.envelope.event);
  }

  private apply(qc: QueryClient, event: ConclaveEvent) {
    switch (event.type) {
      case "run.updated": {
        const run = event.run;
        qc.setQueryData<RunDetailDto>(["task", run.id], (old) => (old ? { ...old, ...run } : old));
        const upsert = (old: RunSummaryDto[] | undefined) => {
          if (!old) return old;
          const i = old.findIndex((r) => r.id === run.id);
          if (i === -1) return [run, ...old];
          const next = [...old];
          next[i] = run;
          return next;
        };
        qc.setQueryData<RunSummaryDto[]>(["tasks", run.workspaceId], upsert);
        qc.setQueryData<RunSummaryDto[]>(["active"], (old) => {
          const next = upsert(old);
          return next?.filter((r) => ["queued", "running", "waiting"].includes(r.status));
        });
        this.invalidateSoon(["workspaces"]);
        if (["succeeded", "failed", "cancelled"].includes(run.status)) {
          this.invalidateSoon(["task", run.id]);
          this.invalidateSoon(["workspace", run.workspaceId]);
          this.invalidateSoon(["connections"]);
        }
        break;
      }
      case "step.updated": {
        qc.setQueryData<RunDetailDto>(["task", event.runId], (old) => {
          if (!old) return old;
          const i = old.steps.findIndex((s) => s.id === event.step.id);
          const steps = [...old.steps];
          if (i === -1) steps.push(event.step);
          else steps[i] = event.step;
          return { ...old, steps };
        });
        if (event.step.status !== "running") {
          this.deltas.delete(`${event.runId}:${event.step.key}`);
          for (const l of this.deltaListeners) l();
        }
        break;
      }
      case "step.delta": {
        const key = `${event.runId}:${event.stepKey}`;
        this.deltas.set(key, (this.deltas.get(key) ?? "") + event.text);
        for (const l of this.deltaListeners) l();
        break;
      }
      case "inbox.updated": {
        qc.setQueryData<InboxItemDto[]>(["inbox"], (old) => {
          if (!old) return old;
          const i = old.findIndex((x) => x.id === event.item.id);
          if (i === -1) return [event.item, ...old];
          const next = [...old];
          next[i] = event.item;
          return next;
        });
        break;
      }
      case "notification":
        break;
    }
  }
}

export const realtime = new Realtime();

export function useTopics(topics: string[]) {
  const key = topics.join("|");
  useEffect(() => realtime.subscribe(key ? key.split("|") : []), [key]);
}

export function useDelta(runId: string, stepKey: string): string {
  return useSyncExternalStore(realtime.onDelta, () => realtime.delta(runId, stepKey));
}

export function useConnected(): boolean {
  return useSyncExternalStore(realtime.onStatus, realtime.isConnected);
}
