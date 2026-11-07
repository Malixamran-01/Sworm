import type { InboxItemDto, RunSummaryDto, StepDto } from "./api";

/** Events published through the outbox to every open client (SRS 7.3). */
export type ConclaveEvent =
  | { type: "run.updated"; run: RunSummaryDto }
  | { type: "step.updated"; runId: string; step: StepDto }
  | { type: "step.delta"; runId: string; stepKey: string; text: string }
  | { type: "inbox.updated"; item: InboxItemDto }
  /** Show a desktop notification for this item now (NOTE-003); quiet hours already applied. */
  | { type: "notification"; item: InboxItemDto };

export interface EventEnvelope {
  /** Monotonic per instance; clients send their last seq on reconnect. */
  seq: number;
  topics: string[];
  event: ConclaveEvent;
  at: string;
}

export const topics = {
  inbox: (userId: string) => `user:${userId}:inbox`,
  workspaceRuns: (workspaceId: string) => `workspace:${workspaceId}:runs`,
  run: (runId: string) => `run:${runId}`,
};

/** Messages a client sends over the realtime socket. */
export type ClientMessage =
  | { type: "subscribe"; topics: string[]; lastSeq?: number }
  | { type: "unsubscribe"; topics: string[] };

/** Messages the server sends over the realtime socket. */
export type ServerMessage =
  | { type: "event"; envelope: EventEnvelope }
  | { type: "refetch"; topics: string[] }
  | { type: "hello"; seq: number };
