import {
  traceIdOf,
  traceparent,
  type AuditEntryDto,
  type AuditPageDto,
  type CostSource,
  type NodeHealthDto,
  type RunStatus,
  type SpanSystem,
  type StepKind,
  type TraceDto,
  type TraceSpanDto,
  type TraceSystemDto,
  type UsageInsightsDto,
  type UsageSliceDto,
} from "@conclave/contract";
import { iso, num, type Db } from "@conclave/db";
import { invalid, notFound, type Actor } from "./errors";
import type { RunRow, StepRow } from "./dto";

/** Which kind of system a step hands its work to. Core knows kinds, never products. */
const SYSTEM_OF: Record<string, SpanSystem> = {
  role: "model",
  classify: "model",
  tool: "tool",
  lookup: "knowledge",
  agent: "agent",
  automation: "workflow",
  approval: "person",
  workspace: "workspace",
};

const systemOf = (kind: string): SpanSystem => SYSTEM_OF[kind] ?? "logic";
const label = (key: string): string => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

type TraceRunRow = RunRow & { workspace_name: string; private: boolean; ws_owner: string | null; task_type_name: string };
type TraceStepRow = StepRow & { connection_name: string | null; module_id: string | null };

const USAGE_DAYS = [7, 30, 90];
const AUDIT_PAGE = 50;

/**
 * Reading what happened: one trace for a whole task tree, spend and
 * reliability across workspaces, and the audit trail. Read-only; the
 * orchestrator and the ledger stay the source of truth.
 */
export class Insights {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * The whole tree a task belongs to as one trace: every task, sub-task and
   * step attempt, with the node that did it, what it cost, what was held for
   * it and who decided what. The caller must already be allowed to see `runId`.
   */
  async trace(actor: Actor, runId: string): Promise<TraceDto> {
    const [focus] = await this.db.query<{ root_run_id: string }>(`select root_run_id from runs where id = $1 and org_id = $2`, [runId, actor.orgId]);
    if (!focus) throw notFound("Task");
    const rootId = focus.root_run_id;

    const runs = await this.db.query<TraceRunRow>(
      `select r.*, w.name as workspace_name, w.private, w.created_by as ws_owner, t.name as task_type_name
         from runs r join workspaces w on w.id = r.workspace_id join task_types t on t.id = r.task_type_id
        where r.root_run_id = $1 and r.org_id = $2 order by r.created_at, r.id`,
      [rootId, actor.orgId],
    );
    const steps = await this.db.query<TraceStepRow>(
      `select s.*, c.name as connection_name, c.module_id
         from run_steps s join runs r on r.id = s.run_id left join connections c on c.id = s.connection_id
        where r.root_run_id = $1 and r.org_id = $2 order by s.created_at, s.attempt, s.id`,
      [rootId, actor.orgId],
    );
    const held = await this.db.query<{ step_id: string; reserved: string; held: string }>(
      `select b.step_id, sum(b.reserved_usd) as reserved, sum(case when b.status = 'held' then b.reserved_usd else 0 end) as held
         from budget_reservations b join runs r on r.id = b.run_id where r.root_run_id = $1 and r.org_id = $2 group by b.step_id`,
      [rootId, actor.orgId],
    );
    const decisions = await this.db.query<{ step_id: string; decision: string | null; note: string | null; decided_at: Date | null; name: string | null }>(
      `select a.step_id, a.decision, a.note, a.decided_at, u.name
         from approvals a join runs r on r.id = a.run_id left join users u on u.id = a.decided_by
        where r.root_run_id = $1 and a.org_id = $2 order by a.requested_at`,
      [rootId, actor.orgId],
    );

    const heldBy = new Map(held.map((h) => [h.step_id, h]));
    // The latest request on a step is the one that counts: an agent may ask more than once.
    const decisionBy = new Map(decisions.map((d) => [d.step_id, d]));
    const hiddenRun = new Map(runs.map((r) => [r.id, r.private && r.ws_owner !== actor.userId]));
    const runById = new Map(runs.map((r) => [r.id, r]));

    const spans: TraceSpanDto[] = [];
    for (const r of runs) {
      const hidden = hiddenRun.get(r.id) ?? false;
      spans.push({
        id: r.id,
        parentId: r.parent_step_id ?? r.parent_run_id,
        type: "run",
        kind: "run",
        system: "workspace",
        name: hidden ? "Task in a personal workspace" : r.title,
        runId: r.id,
        workspaceId: r.workspace_id,
        workspaceName: hidden ? "Personal workspace" : r.workspace_name,
        depth: num(r.depth),
        status: r.status,
        startedAt: iso(r.started_at ?? r.created_at)!,
        finishedAt: iso(r.finished_at),
        attempt: 1,
        round: 1,
        iteration: num(r.iteration) || 1,
        node: null,
        costUsd: num(r.cost_usd),
        selfCostUsd: 0,
        costSource: null,
        inputTokens: 0,
        outputTokens: 0,
        reservedUsd: 0,
        heldUsd: 0,
        error: hidden ? null : r.error,
        errorCode: null,
        externalId: null,
        traceparent: null,
        policy: null,
        decision: null,
        hidden,
      });
    }
    for (const s of steps) {
      const run = runById.get(s.run_id)!;
      const hidden = hiddenRun.get(s.run_id) ?? false;
      const system = systemOf(s.kind);
      const money = heldBy.get(s.id);
      const decided = decisionBy.get(s.id);
      const input = (s.input ?? {}) as { handle?: { externalRunId?: unknown }; execution?: { executionId?: unknown } };
      const externalId = input.handle?.externalRunId ?? input.execution?.executionId;
      const outside = system === "model" || system === "tool" || system === "agent" || system === "workflow" || system === "knowledge";
      const cost = num(s.cost_usd);
      spans.push({
        id: s.id,
        parentId: s.run_id,
        type: "step",
        kind: s.kind as StepKind,
        system,
        name: label(s.step_key),
        runId: s.run_id,
        workspaceId: run.workspace_id,
        workspaceName: hidden ? "Personal workspace" : run.workspace_name,
        depth: num(run.depth),
        status: s.status,
        startedAt: iso(s.started_at ?? s.created_at)!,
        finishedAt: iso(s.finished_at),
        attempt: num(s.attempt) || 1,
        round: num(s.round) || 1,
        iteration: 1,
        node:
          s.connection_id || s.node_label
            ? { label: hidden ? null : s.node_label, connectionId: s.connection_id, connectionName: hidden ? null : s.connection_name, moduleId: s.module_id }
            : null,
        costUsd: cost,
        selfCostUsd: system === "workspace" ? 0 : cost,
        costSource: s.cost_source,
        inputTokens: num(s.tokens_in),
        outputTokens: num(s.tokens_out),
        reservedUsd: num(money?.reserved),
        heldUsd: num(money?.held),
        error: hidden ? null : s.error,
        errorCode: s.error_code,
        externalId: externalId === undefined || externalId === null || hidden ? null : String(externalId),
        traceparent: outside ? traceparent(rootId, s.id) : null,
        policy: hidden ? null : (s.policy ?? null),
        decision: decided ? { decision: decided.decision, by: decided.name, at: iso(decided.decided_at), note: hidden ? null : decided.note } : null,
        hidden,
      });
    }

    const systems = new Map<string, TraceSystemDto>();
    const stepSpans = spans.filter((s) => s.type === "step");
    for (const s of stepSpans) {
      const id = s.node?.connectionId;
      if (!id || s.system === "workspace" || s.system === "logic" || s.system === "person") continue;
      if (s.status === "skipped" || s.status === "not_taken" || s.status === "pending") continue;
      const entry = systems.get(id) ?? {
        connectionId: id,
        connectionName: s.node?.connectionName ?? "A connection",
        moduleId: s.node?.moduleId ?? "",
        system: s.system,
        calls: 0,
        failures: 0,
        costUsd: 0,
        busyMs: 0,
      };
      entry.calls += 1;
      if (s.status === "failed") entry.failures += 1;
      entry.costUsd += s.selfCostUsd;
      entry.busyMs += Math.max(0, new Date(s.finishedAt ?? Date.now()).getTime() - new Date(s.startedAt).getTime());
      systems.set(id, entry);
    }

    const root = runById.get(rootId) ?? runs[0]!;
    return {
      traceId: traceIdOf(rootId),
      rootRunId: rootId,
      focusRunId: runId,
      title: hiddenRun.get(root.id) ? "Task in a personal workspace" : root.title,
      status: root.status as RunStatus,
      startedAt: iso(root.started_at ?? root.created_at)!,
      finishedAt: iso(root.finished_at),
      costUsd: num(root.cost_usd),
      budgetUsd: num(root.budget_usd),
      spans,
      systems: [...systems.values()].sort((a, b) => b.costUsd - a.costUsd || b.busyMs - a.busyMs),
      counts: {
        tasks: runs.length,
        calls: [...systems.values()].reduce((n, s) => n + s.calls, 0),
        retries: stepSpans.filter((s) => s.attempt > 1 && s.round <= 1 && s.system !== "person").length,
        failures: stepSpans.filter((s) => s.status === "failed").length,
        decisions: decisions.filter((d) => d.decision).length,
        workspaces: new Set(runs.map((r) => r.workspace_id)).size,
      },
    };
  }

  /** Spend and reliability over the last `days` days, in the workspaces the caller can see. */
  async usage(actor: Actor, days = 30): Promise<UsageInsightsDto> {
    if (!USAGE_DAYS.includes(days)) throw invalid([`Choose ${USAGE_DAYS.join(", ")} days.`]);
    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1)));
    const since = start.toISOString();
    const before = new Date(start.getTime() - days * 86_400_000).toISOString();
    // Ledger rows of workspaces the caller may see; other people's personal workspaces stay out.
    const visible = `from usage_ledger u join workspaces w on w.id = u.workspace_id
      where u.org_id = $1 and u.at >= $2 and (not w.private or w.created_by = $3)`;
    const params = [actor.orgId, since, actor.userId];
    type Slice = { id: string | null; name: string | null; detail?: string | null; cost: string; calls: string; tin: string; tout: string };
    const sums = `coalesce(sum(u.cost_usd), 0) as cost, count(*) as calls, coalesce(sum(u.tokens_in), 0) as tin, coalesce(sum(u.tokens_out), 0) as tout`;
    const slice = (r: Slice, fallback: string): UsageSliceDto => ({
      id: r.id ?? "none",
      name: r.name ?? fallback,
      ...(r.detail ? { detail: r.detail } : {}),
      costUsd: num(r.cost),
      calls: num(r.calls),
      inputTokens: num(r.tin),
      outputTokens: num(r.tout),
    });

    const [totals] = await this.db.query<Slice>(`select null as id, null as name, ${sums} ${visible}`, params);
    const [previous] = await this.db.query<{ cost: string; calls: string }>(
      `select coalesce(sum(u.cost_usd), 0) as cost, count(*) as calls from usage_ledger u join workspaces w on w.id = u.workspace_id
        where u.org_id = $1 and u.at >= $2 and u.at < $4 and (not w.private or w.created_by = $3)`,
      [actor.orgId, before, actor.userId, since],
    );
    const daily = await this.db.query<{ day: string; cost: string; calls: string }>(
      `select to_char(u.at at time zone 'UTC', 'YYYY-MM-DD') as day, coalesce(sum(u.cost_usd), 0) as cost, count(*) as calls ${visible} group by 1 order by 1`,
      params,
    );
    const byWorkspace = await this.db.query<Slice>(
      `select w.id::text as id, w.name, ${sums} ${visible} group by w.id, w.name order by cost desc, calls desc limit 12`,
      params,
    );
    const byConnection = await this.db.query<Slice>(
      `select c.id::text as id, c.name, max(coalesce(c.module_id, u.module_id)) as detail, ${sums}
         from usage_ledger u join workspaces w on w.id = u.workspace_id left join connections c on c.id = u.connection_id
        where u.org_id = $1 and u.at >= $2 and (not w.private or w.created_by = $3)
        group by c.id, c.name order by cost desc, calls desc limit 12`,
      params,
    );
    const byModel = await this.db.query<Slice>(
      `select coalesce(u.model, 'unknown') as id, coalesce(u.model, 'Unknown') as name, max(u.module_id) as detail, ${sums} ${visible}
        group by u.model order by cost desc, calls desc limit 12`,
      params,
    );
    const bySource = await this.db.query<{ source: CostSource; cost: string; calls: string }>(
      `select u.cost_source as source, coalesce(sum(u.cost_usd), 0) as cost, count(*) as calls ${visible} group by u.cost_source order by cost desc`,
      params,
    );
    const tasks = await this.db.query<{ status: string; n: string }>(
      `select r.status, count(*) as n from runs r join workspaces w on w.id = r.workspace_id
        where r.org_id = $1 and r.created_at >= $2 and r.parent_run_id is null and (not w.private or w.created_by = $3) group by r.status`,
      params,
    );
    // Every attempt at a node counts, so retries and failures show even when the task ended well.
    const health = await this.db.query<{ id: string; name: string; module_id: string; calls: string; failures: string; retries: string; latency: string | null }>(
      `select c.id::text as id, c.name, c.module_id, count(*) as calls,
              sum(case when s.status = 'failed' then 1 else 0 end) as failures,
              sum(case when s.attempt > 1 and s.round <= 1 then 1 else 0 end) as retries,
              avg(s.latency_ms) as latency
         from run_steps s join runs r on r.id = s.run_id join workspaces w on w.id = r.workspace_id join connections c on c.id = s.connection_id
        where r.org_id = $1 and s.created_at >= $2 and (not w.private or w.created_by = $3)
          and s.kind in ('role', 'classify', 'tool', 'lookup', 'agent', 'automation') and s.status in ('succeeded', 'failed', 'superseded', 'cancelled')
        group by c.id, c.name, c.module_id order by failures desc, calls desc limit 20`,
      params,
    );

    const byDay = new Map(daily.map((d) => [d.day, d]));
    const series: UsageInsightsDto["daily"] = [];
    for (let i = 0; i < days; i += 1) {
      const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const hit = byDay.get(day);
      series.push({ day, costUsd: num(hit?.cost), calls: num(hit?.calls) });
    }
    const count = (status: string) => num(tasks.find((t) => t.status === status)?.n);
    const all = slice(totals!, "");
    return {
      days,
      since,
      totals: {
        costUsd: all.costUsd,
        calls: all.calls,
        inputTokens: all.inputTokens,
        outputTokens: all.outputTokens,
        tasks: tasks.reduce((n, t) => n + num(t.n), 0),
        tasksFailed: count("failed"),
        tasksDone: count("succeeded"),
      },
      previous: { costUsd: num(previous?.cost), calls: num(previous?.calls) },
      daily: series,
      byWorkspace: byWorkspace.map((r) => slice(r, "Workspace")),
      byConnection: byConnection.map((r) => slice(r, "Removed connection")),
      byModel: byModel.map((r) => slice(r, "Unknown")),
      bySource: bySource.map((r) => ({ source: r.source, costUsd: num(r.cost), calls: num(r.calls) })),
      health: health.map(
        (h): NodeHealthDto => ({
          connectionId: h.id,
          connectionName: h.name,
          moduleId: h.module_id,
          calls: num(h.calls),
          failures: num(h.failures),
          retries: num(h.retries),
          avgLatencyMs: h.latency === null ? null : Math.round(num(h.latency)),
        }),
      ),
    };
  }

  /**
   * The audit trail, newest first: who did what, to what. `area` is the part
   * before the dot of an action, such as "task" or "connection".
   */
  async audit(actor: Actor, filter: { area?: string; before?: string; limit?: number } = {}): Promise<AuditPageDto> {
    const limit = Math.max(1, Math.min(200, filter.limit ?? AUDIT_PAGE));
    if (filter.area && !/^[a-z_]{1,40}$/.test(filter.area)) throw invalid(["Unknown area."]);
    const where = ["a.org_id = $1"];
    const params: unknown[] = [actor.orgId];
    if (filter.area) {
      params.push(`${filter.area}.%`);
      where.push(`a.action like $${params.length}`);
    }
    if (filter.before) {
      params.push(filter.before);
      where.push(`a.id < $${params.length}::uuid`);
    }
    params.push(limit + 1);
    const rows = await this.db.query<{
      id: string;
      at: Date;
      action: string;
      actor: string | null;
      target: string | null;
      detail: Record<string, unknown> | null;
      actor_name: string | null;
      actor_email: string | null;
      target_name: string | null;
    }>(
      // Ids are UUIDv7, so id order is time order and works as a cursor.
      `select a.id, a.at, a.action, a.actor, a.target, a.detail, u.name as actor_name, u.email as actor_email,
              coalesce(
                (select r.title from runs r where r.id::text = a.target and r.org_id = a.org_id),
                (select w.name from workspaces w where w.id::text = a.target and w.org_id = a.org_id),
                (select c.name from connections c where c.id::text = a.target and c.org_id = a.org_id),
                (select r.title from approvals p join runs r on r.id = p.run_id where p.id::text = a.target and p.org_id = a.org_id),
                (select m.name from users m join memberships ms on ms.user_id = m.id and ms.org_id = a.org_id where m.id::text = a.target)
              ) as target_name
         from audit_log a left join users u on u.id = a.actor
        where ${where.join(" and ")} order by a.id desc limit $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const entries = page.map(
      (r): AuditEntryDto => ({
        id: r.id,
        at: iso(r.at)!,
        action: r.action,
        actor: r.actor && r.actor_name ? { id: r.actor, name: r.actor_name, email: r.actor_email ?? "" } : null,
        target: r.target,
        targetName: r.target_name,
        detail: r.detail ?? {},
      }),
    );
    return { entries, next: rows.length > limit ? page[page.length - 1]!.id : null };
  }
}
