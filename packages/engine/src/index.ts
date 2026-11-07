import { newId } from "@conclave/contract";
import { iso, json, type Db, type Queryable } from "@conclave/db";

/**
 * ExecutionEngine (SRS 8.2, PROF-001). The built-in implementation keeps
 * all execution state in Postgres: one leased "advance" task per run, plus
 * signals. Workflow semantics live in core; the engine only guarantees that
 * exactly one worker advances a run at a time, that work survives crashes
 * (expired leases are picked up again), and that timers and signals wake runs.
 */

export interface Signal {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type AdvanceOutcome =
  /** The run is finished, or waiting for a signal: drop the task. */
  | { kind: "idle" }
  /** Wake the run again at this time (retry backoff, timers). */
  | { kind: "reschedule"; at: Date };

export type AdvanceHandler = (runId: string, signals: Signal[], heartbeat: () => Promise<void>) => Promise<AdvanceOutcome>;

export interface EngineWorker {
  /** Claim and process at most one due task. Returns false when nothing was due. */
  tick(): Promise<boolean>;
  /** Process due tasks until none are left (tests and drains). */
  drain(maxTasks?: number): Promise<number>;
  stop(): Promise<void>;
}

export interface WorkerOptions {
  workerId?: string;
  /** Concurrent runs this worker advances. */
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  onError?: (err: unknown, runId: string) => void;
  /** Start the polling loop. Tests set false and call tick() or drain(). */
  autoStart?: boolean;
}

export interface ExecutionEngine {
  /** Ask for the run to be advanced, now or at `at`. Call inside the caller's transaction. */
  wake(q: Queryable, runId: string, at?: Date): Promise<void>;
  /** Deliver a signal (an approval answer, for example) and wake the run. */
  signal(q: Queryable, runId: string, name: string, payload: Record<string, unknown>): Promise<void>;
  /** Forget every task and signal of a run. */
  forget(q: Queryable, runId: string): Promise<void>;
  startWorker(handler: AdvanceHandler, opts?: WorkerOptions): EngineWorker;
}

export class PostgresEngine implements ExecutionEngine {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  async wake(q: Queryable, runId: string, at: Date = new Date()): Promise<void> {
    // One row per run. A wake during processing bumps the generation, so the
    // worker that holds the lease knows to run again instead of deleting it.
    await q.query(
      `insert into engine_tasks (id, run_id, kind, available_at)
       values ($1, $2, 'advance', $3)
       on conflict (run_id, kind) do update
         set available_at = least(engine_tasks.available_at, excluded.available_at),
             generation = engine_tasks.generation + 1`,
      [newId(), runId, at.toISOString()],
    );
  }

  async signal(q: Queryable, runId: string, name: string, payload: Record<string, unknown>): Promise<void> {
    await q.query(`insert into engine_signals (id, run_id, name, payload) values ($1, $2, $3, $4::jsonb)`, [
      newId(),
      runId,
      name,
      json(payload),
    ]);
    await this.wake(q, runId);
  }

  async forget(q: Queryable, runId: string): Promise<void> {
    await q.query(`delete from engine_tasks where run_id = $1`, [runId]);
    await q.query(`update engine_signals set consumed_at = now() where run_id = $1 and consumed_at is null`, [runId]);
  }

  startWorker(handler: AdvanceHandler, opts: WorkerOptions = {}): EngineWorker {
    return new PostgresWorker(this.db, handler, opts);
  }
}

class PostgresWorker implements EngineWorker {
  private readonly db: Db;
  private readonly handler: AdvanceHandler;
  private readonly id: string;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly onError: (err: unknown, runId: string) => void;
  private running = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(db: Db, handler: AdvanceHandler, opts: WorkerOptions) {
    this.db = db;
    this.handler = handler;
    this.id = opts.workerId ?? `worker-${newId().slice(-8)}`;
    this.concurrency = opts.concurrency ?? 4;
    this.pollMs = opts.pollMs ?? 200;
    this.leaseMs = opts.leaseMs ?? 15 * 60_000;
    this.onError = opts.onError ?? ((err, runId) => console.error(`[engine] run ${runId} failed to advance`, err));
    if (opts.autoStart !== false) this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  private async loop() {
    if (this.stopped) return;
    let claimed = false;
    try {
      while (!this.stopped && this.running < this.concurrency) {
        const task = await this.claim();
        if (!task) break;
        claimed = true;
        const p = this.process(task).finally(() => {
          this.inflight.delete(p);
          this.schedule(0);
        });
        this.inflight.add(p);
      }
    } catch (err) {
      this.onError(err, "(claim)");
    }
    this.schedule(claimed ? 0 : this.pollMs);
  }

  async tick(): Promise<boolean> {
    const task = await this.claim();
    if (!task) return false;
    await this.process(task);
    return true;
  }

  async drain(maxTasks = 1_000): Promise<number> {
    let n = 0;
    while (n < maxTasks && (await this.tick())) n++;
    return n;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.inflight]);
  }

  private async claim(): Promise<{ id: string; runId: string; generation: number } | null> {
    const rows = await this.db.query<{ id: string; run_id: string; generation: number }>(
      `update engine_tasks
          set locked_until = now() + ($2::int * interval '1 millisecond'), locked_by = $1, attempts = attempts + 1
        where id = (
          select id from engine_tasks
           where available_at <= now() and (locked_until is null or locked_until < now())
           order by available_at
           limit 1
           for update skip locked)
        returning id, run_id, generation`,
      [this.id, this.leaseMs],
    );
    const row = rows[0];
    return row ? { id: row.id, runId: row.run_id, generation: Number(row.generation) } : null;
  }

  private async process(task: { id: string; runId: string; generation: number }) {
    this.running++;
    try {
      const signalRows = await this.db.query<{ id: string; name: string; payload: Record<string, unknown>; created_at: Date }>(
        `select id, name, payload, created_at from engine_signals
          where run_id = $1 and consumed_at is null order by created_at, id`,
        [task.runId],
      );
      const signals: Signal[] = signalRows.map((r) => ({ id: r.id, name: r.name, payload: r.payload, createdAt: iso(r.created_at)! }));
      const heartbeat = async () => {
        await this.db.query(
          `update engine_tasks set locked_until = now() + ($2::int * interval '1 millisecond') where id = $1 and locked_by = $3`,
          [task.id, this.leaseMs, this.id],
        );
      };

      let outcome: AdvanceOutcome;
      try {
        outcome = await this.handler(task.runId, signals, heartbeat);
      } catch (err) {
        this.onError(err, task.runId);
        // Back off and try again; the handler is idempotent per step attempt.
        outcome = { kind: "reschedule", at: new Date(Date.now() + 5_000) };
      }

      await this.db.tx(async (q) => {
        if (signals.length > 0) {
          await q.query(`update engine_signals set consumed_at = now() where id = any($1::uuid[])`, [signals.map((s) => s.id)]);
        }
        if (outcome.kind === "idle") {
          // Delete only if nobody woke the run while we worked; otherwise release it to run again.
          const deleted = await q.query(`delete from engine_tasks where id = $1 and generation = $2 returning id`, [task.id, task.generation]);
          if (deleted.length === 0) await q.query(`update engine_tasks set locked_until = null, locked_by = null where id = $1`, [task.id]);
        } else {
          await q.query(
            `update engine_tasks
                set available_at = case when generation = $3 then $2::timestamptz else now() end,
                    locked_until = null, locked_by = null
              where id = $1`,
            [task.id, outcome.at.toISOString(), task.generation],
          );
        }
      });
    } finally {
      this.running--;
    }
  }
}
