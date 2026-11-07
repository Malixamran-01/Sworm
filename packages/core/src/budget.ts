import { newId, NodeCallError, type GenerateResult, type ModelInfo, type Pricing } from "@conclave/contract";
import { num, type Queryable } from "@conclave/db";
import { monthStart } from "./workspaces";

/**
 * Budgets are enforced before money is spent (SRS 4.12). A step reserves its
 * p90 cost first; the reservation is settled to the actual cost afterwards.
 */

export function pricingFor(models: ModelInfo[], model: string): Pricing | null {
  return models.find((m) => m.id === model)?.pricing ?? null;
}

/** USD for one call. Cache reads cost 0.1x input and cache writes 1.25x input. */
export function costOf(pricing: Pricing | null, usage: GenerateResult["usage"]): number {
  if (!pricing) return 0;
  const input =
    usage.inputTokens * pricing.inputPerMTok +
    (usage.cacheReadTokens ?? 0) * pricing.inputPerMTok * 0.1 +
    (usage.cacheWriteTokens ?? 0) * pricing.inputPerMTok * 1.25;
  return (input + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;
}

export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/** Worst case for one call: the whole prompt plus every allowed output token. */
export function upperBound(pricing: Pricing | null, promptChars: number, maxTokens: number): number {
  if (!pricing) return 0;
  return (Math.ceil(promptChars / 4) * pricing.inputPerMTok + maxTokens * pricing.outputPerMTok) / 1_000_000;
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** p90 of this step's past costs in this task type, if there is enough history. */
export async function historicalP90(q: Queryable, taskTypeId: string, stepKey: string): Promise<number | null> {
  const rows = await q.query<{ cost_usd: string | number }>(
    `select s.cost_usd from run_steps s join runs r on r.id = s.run_id
      where r.task_type_id = $1 and s.step_key = $2 and s.status = 'succeeded'
      order by s.finished_at desc limit 20`,
    [taskTypeId, stepKey],
  );
  if (rows.length < 5) return null;
  return percentile(rows.map((r) => num(r.cost_usd)), 90);
}

export interface ReservationRequest {
  orgId: string;
  workspaceId: string;
  runId: string;
  stepId: string;
  connectionId: string | null;
  amountUsd: number;
}

/**
 * Reserve budget for one step, checking the run's budget, the workspace's
 * month and the connection's monthly limit (COST-003, WS-003, CON-004).
 * Throws budget_exceeded when the reservation does not fit.
 */
export async function reserve(q: Queryable, req: ReservationRequest): Promise<string> {
  // Lock the run row so concurrent steps of one run cannot both pass the check.
  const [run] = await q.query<{ budget_usd: string; cost_usd: string }>(`select budget_usd, cost_usd from runs where id = $1 for update`, [req.runId]);
  if (!run) throw new NodeCallError("internal", "Run not found while reserving budget.", false);
  const [runHeld] = await q.query<{ held: string }>(
    `select coalesce(sum(reserved_usd), 0) as held from budget_reservations where run_id = $1 and status = 'held'`,
    [req.runId],
  );
  const runLeft = num(run.budget_usd) - num(run.cost_usd) - num(runHeld?.held);
  if (req.amountUsd > runLeft + 1e-9) {
    throw new NodeCallError(
      "budget_exceeded",
      `This step may cost up to $${req.amountUsd.toFixed(4)} but only $${Math.max(0, runLeft).toFixed(4)} of the task budget is left.`,
      false,
    );
  }

  const since = monthStart();
  const [ws] = await q.query<{ budget_month_usd: string; spent: string; held: string }>(
    `select w.budget_month_usd,
            coalesce((select sum(cost_usd) from usage_ledger u where u.workspace_id = w.id and u.at >= $2), 0) as spent,
            coalesce((select sum(reserved_usd) from budget_reservations b where b.workspace_id = w.id and b.status = 'held'), 0) as held
       from workspaces w where w.id = $1`,
    [req.workspaceId, since],
  );
  const monthLeft = num(ws?.budget_month_usd) - num(ws?.spent) - num(ws?.held);
  if (req.amountUsd > monthLeft + 1e-9) {
    throw new NodeCallError("budget_exceeded", `The workspace's monthly budget is reached ($${Math.max(0, monthLeft).toFixed(4)} left).`, false);
  }

  if (req.connectionId) {
    const [conn] = await q.query<{ spend_limit_usd: string | null; spent: string; held: string }>(
      `select c.spend_limit_usd,
              coalesce((select sum(cost_usd) from usage_ledger u where u.connection_id = c.id and u.at >= $2), 0) as spent,
              coalesce((select sum(reserved_usd) from budget_reservations b where b.connection_id = c.id and b.status = 'held'), 0) as held
         from connections c where c.id = $1`,
      [req.connectionId, since],
    );
    if (conn?.spend_limit_usd !== null && conn?.spend_limit_usd !== undefined) {
      const connLeft = num(conn.spend_limit_usd) - num(conn.spent) - num(conn.held);
      if (req.amountUsd > connLeft + 1e-9) {
        throw new NodeCallError("budget_exceeded", `This connection's monthly spend limit is reached ($${Math.max(0, connLeft).toFixed(4)} left).`, false);
      }
    }
  }

  const id = newId();
  await q.query(
    `insert into budget_reservations (id, org_id, workspace_id, run_id, step_id, connection_id, reserved_usd, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'held')`,
    [id, req.orgId, req.workspaceId, req.runId, req.stepId, req.connectionId, req.amountUsd],
  );
  return id;
}

export async function settle(q: Queryable, reservationId: string, actualUsd: number): Promise<void> {
  await q.query(`update budget_reservations set status = 'settled', settled_usd = $2, settled_at = now() where id = $1`, [reservationId, actualUsd]);
}

export async function release(q: Queryable, reservationId: string): Promise<void> {
  await q.query(`update budget_reservations set status = 'released', settled_usd = 0, settled_at = now() where id = $1 and status = 'held'`, [reservationId]);
}
