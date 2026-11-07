import type { ConclaveEvent, EventEnvelope } from "@conclave/contract";
import { iso, json, num, type Db, type Queryable } from "@conclave/db";

/**
 * Events (SRS 8.4). Durable events are written to the outbox in the same
 * transaction as the change, then relayed to the in-process bus (the Lite
 * EventBus). Text deltas are transient: they go straight to the bus.
 */

export async function emit(q: Queryable, topics: string[], event: ConclaveEvent): Promise<void> {
  await q.query(`insert into outbox (topics, payload) values ($1::jsonb, $2::jsonb)`, [json(topics), json(event)]);
}

type Listener = (envelope: EventEnvelope) => void;

export class EventBus {
  private readonly listeners = new Set<{ topics: Set<string> | "*"; fn: Listener }>();
  private readonly buffer: EventEnvelope[] = [];
  private readonly bufferSize: number;
  private transientSeq = 0;
  /** Highest durable seq published so far. */
  lastSeq = 0;

  constructor(bufferSize = 2_000) {
    this.bufferSize = bufferSize;
  }

  subscribe(topics: string[] | "*", fn: Listener): () => void {
    const entry = { topics: topics === "*" ? ("*" as const) : new Set(topics), fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  publish(envelope: EventEnvelope): void {
    if (envelope.seq > 0) {
      this.lastSeq = Math.max(this.lastSeq, envelope.seq);
      this.buffer.push(envelope);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    for (const l of this.listeners) {
      if (l.topics === "*" || envelope.topics.some((t) => (l.topics as Set<string>).has(t))) {
        try {
          l.fn(envelope);
        } catch (err) {
          console.error("[events] listener failed", err);
        }
      }
    }
  }

  /** Transient events (text deltas) are not replayed after reconnects. */
  publishTransient(topics: string[], event: ConclaveEvent): void {
    this.transientSeq--;
    this.publish({ seq: this.transientSeq, topics, event, at: new Date().toISOString() });
  }

  /** Events after `seq` for these topics, or null when the buffer no longer reaches back that far. */
  replay(topics: string[], afterSeq: number): EventEnvelope[] | null {
    const oldest = this.buffer[0]?.seq;
    if (oldest !== undefined && afterSeq < oldest - 1) return null;
    const wanted = new Set(topics);
    return this.buffer.filter((e) => e.seq > afterSeq && e.topics.some((t) => wanted.has(t)));
  }
}

/** Moves outbox rows to the bus. Consumers are idempotent and track seq. */
export class OutboxRelay {
  private readonly db: Db;
  private readonly bus: EventBus;
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private draining: Promise<number> | undefined;

  constructor(db: Db, bus: EventBus) {
    this.db = db;
    this.bus = bus;
  }

  start(pollMs = 100): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.drain();
      } catch (err) {
        console.error("[outbox] relay failed", err);
      }
      if (!this.stopped) this.timer = setTimeout(loop, pollMs);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.draining;
  }

  /** Publish everything pending. Safe to call concurrently. */
  drain(): Promise<number> {
    this.draining ??= this.drainOnce().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drainOnce(): Promise<number> {
    let total = 0;
    while (true) {
      const rows = await this.db.query<{ id: number | string; topics: string[]; payload: ConclaveEvent; created_at: Date }>(
        `select id, topics, payload, created_at from outbox where published_at is null order by id limit 200`,
      );
      if (rows.length === 0) return total;
      for (const row of rows) {
        this.bus.publish({ seq: num(row.id), topics: row.topics, event: row.payload, at: iso(row.created_at)! });
      }
      await this.db.query(`update outbox set published_at = now() where id = any($1::bigint[])`, [rows.map((r) => num(r.id))]);
      total += rows.length;
    }
  }
}
