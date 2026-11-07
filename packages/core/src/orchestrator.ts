import {
  connectorTaken,
  downstreamOf,
  edgesOf,
  loopBody,
  loopRound,
  newId,
  NodeCallError,
  testCondition,
  toNodeError,
  topics,
  truncateWorkflow,
  validateBrief,
  type ApprovalStep,
  type BranchStep,
  type ClassifyStep,
  type Edge,
  type Effort,
  type MergeStep,
  type StopStep,
  type TextStep,
  type EstimateDto,
  type InboxItemDto,
  type InputField,
  type RoleStep,
  type ToolStep,
  type RunDetailDto,
  type RunSummaryDto,
  type Step,
  type WorkflowDefinition,
  type WorkspaceStep,
} from "@conclave/contract";
import { json, num, type Db, type Queryable } from "@conclave/db";
import type { AdvanceOutcome, ExecutionEngine, Signal } from "@conclave/engine";
import { Access, isRole, type Principal } from "./access";
import { costOf, historicalP90, percentile, pricingFor, release, reserve, settle, upperBound } from "./budget";
import type { Connections } from "./connections";
import { audit } from "./connections";
import { listActiveRuns, listRuns, loadInboxItem, loadRunDetail, loadRunSummary, toInboxDto, toStepDto, type InboxRow, type RunRow, type StepRow } from "./dto";
import { budgetBlocked, ConclaveError, invalid, notFound, type Actor } from "./errors";
import { emit, type EventBus } from "./events";
import { listItems, render } from "./render";
import { monthStart } from "./workspaces";

export interface OrchestratorOptions {
  /** Loop guard layer 3 (MESH-012): caps per root run. */
  maxCallsPerRun?: number;
  maxCallsPerNode?: number;
  /** How deep sub-tasks may nest, counting the task itself as 0 (WF-008). Bounds recursion. */
  maxDepth?: number;
  /** Sub-tasks one task may start in all, at every depth. */
  maxSubtasks?: number;
  /** Retry policy for role steps that declare none. */
  defaultRetry?: { maxAttempts: number; backoffMs: number; factor: number };
}

type Decision = "approve" | "reject" | "changes";
/** Steps that call a node through a role. */
type CallStep = RoleStep | ToolStep | ClassifyStep;
/** Steps that finish without calling anything: they run inside the advance loop. */
type InstantStep = BranchStep | MergeStep | TextStep | StopStep;
/** Finished states whose output later steps can read. A failed step's output is its error, for "On failure" connectors. */
const READABLE = new Set(["succeeded", "skipped", "failed"]);
const CAN_RETRY = (s: Step): s is CallStep => s.kind === "role" || s.kind === "tool" || s.kind === "classify";

interface RoleRow {
  key: string;
  name: string;
  instructions: string;
  connection_id: string | null;
  model: string | null;
  effort: string | null;
}

interface LoadedRun {
  run: RunRow;
  def: WorkflowDefinition;
  rows: StepRow[];
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_SQL = `('succeeded', 'failed', 'cancelled')`;

/** What a workspace step resolved to when it started; kept in run_steps.input. */
interface CallInput {
  workspaceId: string;
  workspaceName: string;
  taskTypeId: string;
  taskTypeName: string;
  /** Planned runs: the count for times, the items for each, the most for until. */
  total: number;
  items: unknown[] | null;
}

interface CallTarget {
  workspaceId: string;
  workspaceName: string;
  taskTypeId: string;
  taskTypeName: string;
  inputFields: InputField[];
  workflow: WorkflowDefinition;
  budgetTaskUsd: number;
  budgetMonthUsd: number;
}

interface ChildRow {
  id: string;
  status: string;
  output: string | null;
  error: string | null;
  iteration: number;
  cost_usd: string;
}

/**
 * The orchestrator interprets workflow definitions on top of the execution
 * engine. Each step's result is checkpointed in run_steps, so a crashed or
 * redeployed worker resumes from the last finished step (REL-002).
 */
export class Orchestrator {
  private readonly db: Db;
  private readonly engine: ExecutionEngine;
  private readonly connections: Connections;
  private readonly bus: EventBus;
  private readonly opts: Required<OrchestratorOptions>;
  /** In-flight calls per run, so cancel can abort them (TASK-005). */
  private readonly inflight = new Map<string, Set<AbortController>>();
  private readonly access = new Access();

  constructor(db: Db, engine: ExecutionEngine, connections: Connections, bus: EventBus, opts: OrchestratorOptions = {}) {
    this.db = db;
    this.engine = engine;
    this.connections = connections;
    this.bus = bus;
    this.opts = {
      maxCallsPerRun: opts.maxCallsPerRun ?? 200,
      maxCallsPerNode: opts.maxCallsPerNode ?? 10,
      maxDepth: opts.maxDepth ?? 5,
      maxSubtasks: opts.maxSubtasks ?? 100,
      defaultRetry: opts.defaultRetry ?? { maxAttempts: 3, backoffMs: 1_000, factor: 2 },
    };
  }

  // ------------------------------------------------------------------ queries

  async get(actor: Actor, runId: string): Promise<RunDetailDto> {
    const detail = await loadRunDetail(this.db, actor.orgId, runId);
    if (!detail) throw notFound("Task");
    return detail;
  }

  list(actor: Actor, workspaceId: string, limit?: number): Promise<RunSummaryDto[]> {
    return listRuns(this.db, actor.orgId, workspaceId, limit);
  }

  listActive(actor: Actor): Promise<RunSummaryDto[]> {
    return listActiveRuns(this.db, actor.orgId, actor.userId);
  }

  async inbox(actor: Actor, filter: { kind?: string; workspaceId?: string; includeResolved?: boolean } = {}): Promise<InboxItemDto[]> {
    const params: unknown[] = [actor.userId, actor.orgId];
    let where = `i.user_id = $1 and i.org_id = $2`;
    if (filter.kind) {
      params.push(filter.kind);
      where += ` and i.kind = $${params.length}`;
    }
    if (filter.workspaceId) {
      params.push(filter.workspaceId);
      where += ` and i.workspace_id = $${params.length}`;
    }
    if (!filter.includeResolved) where += ` and (i.resolved = false or i.created_at > now() - interval '7 days')`;
    const rows = await this.db.query<InboxRow>(
      `select i.*, w.name as workspace_name from inbox_items i left join workspaces w on w.id = i.workspace_id
        where ${where} order by i.resolved, i.created_at desc limit 200`,
      params,
    );
    return rows.map(toInboxDto);
  }

  async markRead(actor: Actor, itemId: string): Promise<InboxItemDto> {
    await this.db.tx(async (q) => {
      const updated = await q.query(`update inbox_items set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 returning id`, [
        itemId,
        actor.userId,
      ]);
      if (updated.length === 0) throw notFound("Inbox item");
      await this.emitInbox(q, actor.userId, itemId);
    });
    return (await loadInboxItem(this.db, itemId))!;
  }

  /** Cost and time estimate shown before Run (TASK-002, COST-007). */
  async estimate(actor: Actor, workspaceId: string, taskTypeId: string, brief: Record<string, string> = {}): Promise<EstimateDto> {
    const tt = await this.taskType(this.db, actor, workspaceId, taskTypeId);
    const history = await this.db.query<{ cost_usd: string; seconds: string | null }>(
      `select cost_usd, extract(epoch from (finished_at - started_at)) as seconds
         from runs where task_type_id = $1 and status = 'succeeded' order by finished_at desc limit 20`,
      [tt.id],
    );
    if (history.length > 0) {
      const costs = history.map((h) => num(h.cost_usd));
      const seconds = history.map((h) => num(h.seconds)).filter((s) => s > 0);
      return {
        medianUsd: percentile(costs, 50),
        p90Usd: percentile(costs, 90),
        confidence: history.length < 5 ? "low" : history.length < 20 ? "medium" : "high",
        basis: `Median and p90 of the last ${history.length} finished run${history.length === 1 ? "" : "s"}.`,
        medianSeconds: seconds.length ? percentile(seconds, 50) : null,
      };
    }

    // No history: an upper bound from max output tokens and current prices.
    const roles = await this.roles(this.db, workspaceId);
    let upper = 0;
    let unpriced = 0;
    const briefChars = Object.values(brief).join(" ").length;
    for (const step of tt.workflow.steps) {
      if (step.disabled) continue;
      if (step.kind !== "role" && step.kind !== "tool" && step.kind !== "classify" && step.kind !== "workspace") continue;
      // A sub-task's cost depends on the workflow it runs; its own history fills in once it has run.
      if (step.kind === "workspace") {
        unpriced++;
        continue;
      }
      const role = roles.get(step.role);
      if (!role?.connection_id || !role.model) {
        if (!step.optional) unpriced++;
        continue;
      }
      if (step.kind === "tool") {
        const conn = await this.connections.get(actor, role.connection_id).catch(() => null);
        upper += step.pricePerCallUsd ?? Number(conn?.config.pricePerCallUsd ?? 0);
        continue;
      }
      try {
        const pricing = pricingFor(await this.connections.models(actor, role.connection_id), role.model);
        if (!pricing) unpriced++;
        // Earlier steps' outputs feed later prompts, so count their max tokens as prompt text.
        const promptChars = step.kind === "classify" ? step.value.length + 200 * step.categories.length : step.prompt.length;
        upper += upperBound(pricing, promptChars + role.instructions.length + briefChars + 4 * 4_000, step.maxTokens);
      } catch {
        unpriced++;
      }
    }
    return {
      medianUsd: upper * 0.35,
      p90Usd: upper,
      confidence: "none",
      basis:
        unpriced > 0
          ? `No past runs yet. ${unpriced} step${unpriced === 1 ? " has" : "s have"} no known price, so this is a lower figure than the real cost may be.`
          : "No past runs yet: an upper bound from each step's maximum output and current prices.",
      medianSeconds: null,
    };
  }

  // ----------------------------------------------------------------- commands

  /** Start a task (SRS 3.1): validate, check budget, write the run and its event in one transaction. */
  async start(actor: Actor, input: { workspaceId: string; taskTypeId: string; brief: Record<string, string> }): Promise<RunDetailDto> {
    const tt = await this.taskType(this.db, actor, input.workspaceId, input.taskTypeId);
    const errors = validateBrief(tt.input_fields, input.brief ?? {});
    if (errors.length > 0) throw invalid(errors, "The brief is not complete");

    const roles = await this.roles(this.db, input.workspaceId);
    for (const step of tt.workflow.steps) {
      if (step.disabled) continue;
      if (step.kind === "workspace") {
        const target = await this.callTarget(this.db, actor.orgId, input.workspaceId, step);
        if (typeof target === "string") throw invalid([target]);
        continue;
      }
      if (step.kind !== "role" && step.kind !== "tool" && step.kind !== "classify") continue;
      const role = roles.get(step.role);
      if (!role) throw invalid([`The workflow calls role "${step.role}", which this workspace does not have.`]);
      if ((!role.connection_id || !role.model) && !step.optional) {
        throw invalid([`${role.name} has no node yet. Choose a connection and ${step.kind === "tool" ? "tool" : "model"} for it in Team.`]);
      }
    }

    const runId = newId();
    await this.db.tx(async (q) => {
      const [ws] = await q.query<{ budget_task_usd: string; budget_month_usd: string; spent: string; held: string }>(
        `select w.budget_task_usd, w.budget_month_usd,
                coalesce((select sum(cost_usd) from usage_ledger u where u.workspace_id = w.id and u.at >= $2), 0) as spent,
                coalesce((select sum(reserved_usd) from budget_reservations b where b.workspace_id = w.id and b.status = 'held'), 0) as held
           from workspaces w where w.id = $1`,
        [input.workspaceId, monthStart()],
      );
      if (num(ws!.spent) + num(ws!.held) >= num(ws!.budget_month_usd)) {
        throw budgetBlocked(`This workspace has used its $${num(ws!.budget_month_usd).toFixed(2)} monthly budget. Raise it in Settings to run more tasks.`);
      }
      const firstField = tt.input_fields.find((f) => input.brief[f.key]);
      const title = (firstField ? input.brief[firstField.key]! : tt.name).replace(/\s+/g, " ").trim().slice(0, 120);
      await q.query(
        `insert into runs (id, org_id, workspace_id, task_type_id, root_run_id, title, brief, workflow, status, budget_usd, created_by)
         values ($1, $2, $3, $4, $1, $5, $6::jsonb, $7::jsonb, 'queued', $8, $9)`,
        [runId, actor.orgId, input.workspaceId, tt.id, title, json(input.brief), json(tt.workflow), num(ws!.budget_task_usd), actor.userId],
      );
      await this.engine.wake(q, runId);
      await this.emitRun(q, runId);
      await audit(q, actor, "task.started", runId, { taskType: tt.key });
    });
    return this.get(actor, runId);
  }

  /** Cancel a task; in-flight calls are aborted where the provider supports it (TASK-005). */
  async cancel(actor: Actor, runId: string): Promise<RunDetailDto> {
    const cancelled = await this.db.tx(async (q) => {
      const [run] = await q.query<RunRow>(`select * from runs where id = $1 and org_id = $2 for update`, [runId, actor.orgId]);
      if (!run) throw notFound("Task");
      if (TERMINAL.has(run.status)) return [];
      const ids = await this.cancelTree(q, run, "Cancelled by the user.");
      await audit(q, actor, "task.cancelled", runId, {});
      return ids;
    });
    this.abortCalls(cancelled);
    return this.get(actor, runId);
  }

  /** Cancel a run and every sub-task under it, in the caller's transaction. Returns the ids cancelled. */
  private async cancelTree(q: Queryable, run: RunRow, reason: string): Promise<string[]> {
    const runId = run.id;
    await q.query(`update runs set status = 'cancelled', finished_at = now(), error = $2 where id = $1`, [runId, reason]);
    const steps = await q.query<StepRow>(
      `update run_steps set status = 'cancelled', finished_at = now() where run_id = $1 and status in ('pending', 'running', 'waiting') returning *`,
      [runId],
    );
    for (const s of steps) await emit(q, this.runTopics(run), { type: "step.updated", runId, step: toStepDto(s) });
    await q.query(`update budget_reservations set status = 'released', settled_usd = 0, settled_at = now() where run_id = $1 and status = 'held'`, [runId]);
    await q.query(`update approvals set decision = 'cancelled', decided_at = now() where run_id = $1 and decision is null`, [runId]);
    await this.resolveRunInbox(q, runId);
    await this.engine.forget(q, runId);
    await this.emitRun(q, runId);
    const ids = [runId];
    const children = await q.query<RunRow>(`select * from runs where parent_run_id = $1 and status not in ${TERMINAL_SQL} for update`, [runId]);
    for (const child of children) ids.push(...(await this.cancelTree(q, child, "Cancelled because the task that started it stopped.")));
    await this.childFinished(q, run);
    return ids;
  }

  private abortCalls(runIds: string[]): void {
    for (const id of runIds) for (const controller of this.inflight.get(id) ?? []) controller.abort();
  }

  /** Answer an approval gate (TASK-004): approve, reject, or ask for changes in plain words. */
  async decide(actor: Actor, approvalId: string, input: { decision: Decision; note?: string }): Promise<RunDetailDto> {
    if (!["approve", "reject", "changes"].includes(input.decision)) throw invalid([`Unknown decision "${input.decision}".`]);
    if (input.decision === "changes" && !input.note?.trim()) throw invalid(["Say what should change."]);
    let runId = "";
    await this.db.tx(async (q) => {
      const [approval] = await q.query<{ id: string; run_id: string; decision: string | null }>(
        `select id, run_id, decision from approvals where id = $1 and org_id = $2 for update`,
        [approvalId, actor.orgId],
      );
      if (!approval) throw notFound("Approval");
      if (approval.decision) throw new ConclaveError(409, "Already decided", `This approval was already answered (${approval.decision}).`);
      runId = approval.run_id;
      await q.query(`update approvals set decision = $2, note = $3, decided_by = $4, decided_at = now() where id = $1`, [
        approvalId,
        input.decision,
        input.note?.trim() || null,
        actor.userId,
      ]);
      const items = await q.query<{ id: string; user_id: string }>(
        `update inbox_items set resolved = true, read_at = coalesce(read_at, now()) where approval_id = $1 returning id, user_id`,
        [approvalId],
      );
      for (const item of items) await this.emitInbox(q, item.user_id, item.id);
      await this.engine.signal(q, runId, "approval", { approvalId, decision: input.decision, note: input.note?.trim() ?? "" });
      await audit(q, actor, `approval.${input.decision}`, approvalId, {});
    });
    return this.get(actor, runId);
  }

  // ------------------------------------------------------------ the engine side

  /** Engine handler: move a run forward as far as it can go right now. */
  advance = async (runId: string, signals: Signal[], heartbeat: () => Promise<void>): Promise<AdvanceOutcome> => {
    if (signals.length > 0) await this.applySignals(runId, signals);

    for (let round = 0; round < 100; round++) {
      const state = await this.load(runId);
      if (!state || TERMINAL.has(state.run.status)) return { kind: "idle" };

      await this.recoverInterrupted(state);
      // Sub-tasks that finished may complete a workspace step or let the next repeat start.
      if (await this.progressCalls(state)) continue;
      // A finished loop end either sends the run round again or lets it carry on.
      if (await this.progressLoops(state)) continue;
      const plan = this.plan(state);

      if (plan.failed) {
        await this.finishRun(state, "failed", plan.failed);
        return { kind: "idle" };
      }
      // Steps no taken connector leads to are marked "not taken", which may decide more steps.
      if (plan.skips.length) {
        await this.markNotTaken(state, plan.skips);
        continue;
      }
      if (plan.done) {
        await this.finishRun(state, "succeeded", null);
        return { kind: "idle" };
      }
      if (plan.runnable.length === 0) {
        if (plan.waiting || plan.callDeadline) {
          // A task waits on people when it, or a sub-task under it, has an open approval.
          const [child] = plan.callDeadline
            ? await this.db.query<{ id: string }>(`select id from runs where parent_run_id = $1 and status = 'waiting' limit 1`, [runId])
            : [];
          await this.setRunStatus(state.run, plan.waiting || child ? "waiting" : "running");
        }
        const at = [plan.retryAt, plan.callDeadline].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
        return at ? { kind: "reschedule", at } : { kind: "idle" };
      }
      // Independent steps run in parallel; the DAG decides (SRS 11.2). A Stop step ends the task, so it goes alone.
      const stop = plan.runnable.find((r) => r.step.kind === "stop" && !r.step.disabled);
      if (stop) await this.executeStep(state, stop.step, stop.pending, heartbeat);
      else await Promise.all(plan.runnable.map(({ step, pending }) => this.executeStep(state, step, pending, heartbeat)));
    }
    return { kind: "reschedule", at: new Date() };
  };

  private async load(runId: string): Promise<LoadedRun | null> {
    const [run] = await this.db.query<RunRow>(`select * from runs where id = $1`, [runId]);
    if (!run) return null;
    const rows = await this.db.query<StepRow>(`select * from run_steps where run_id = $1 order by step_key, attempt`, [runId]);
    return { run, def: run.workflow, rows };
  }

  /** The latest live (not superseded) row of each step. */
  private current(rows: StepRow[]): Map<string, StepRow> {
    const map = new Map<string, StepRow>();
    for (const row of rows) {
      if (row.status === "superseded") continue;
      const prev = map.get(row.step_key);
      if (!prev || row.attempt > prev.attempt) map.set(row.step_key, row);
    }
    return map;
  }

  /**
   * How a run's graph stands (WF-009): which connectors are taken, and for
   * each step whether it can run, must wait, or will never run.
   */
  private graph(state: LoadedRun) {
    const edges = edgesOf(state.def);
    const current = this.current(state.rows);
    const steps = new Map(state.def.steps.map((st) => [st.key, st]));
    const from = new Map<string, Edge[]>();
    for (const e of edges) from.set(e.from, [...(from.get(e.from) ?? []), e]);
    const catches = (key: string) => (from.get(key) ?? []).some((e) => e.type === "error");
    const source = (key: string) => {
      const row = current.get(key);
      if (!row) return null;
      if (row.status === "succeeded" || row.status === "skipped" || row.status === "not_taken") {
        const chosen = (row.input as { chosen?: string[] } | null)?.chosen;
        return { status: row.status, output: row.output ?? "", ...(chosen ? { chosen } : {}) };
      }
      // A failed row is final here: a retry would be a newer pending row.
      if (row.status === "failed") return { status: "failed" as const, output: row.error ?? "" };
      return null;
    };
    /** true taken, false not taken, null not decided yet. */
    const taken = (e: Edge): boolean | null => {
      const src = source(e.from);
      return src ? connectorTaken(e, src, from.get(e.from) ?? []) : null;
    };
    const decide = (step: Step): "run" | "skip" | "wait" => {
      const incoming = edges.filter((e) => e.to === step.key);
      if (incoming.length === 0) return "run";
      const states = incoming.map(taken);
      switch (step.join ?? "any") {
        case "all":
          return states.includes(false) ? "skip" : states.includes(null) ? "wait" : "run";
        case "first":
          return states.includes(true) ? "run" : states.includes(null) ? "wait" : "skip";
        default:
          return states.includes(null) ? "wait" : states.includes(true) ? "run" : "skip";
      }
    };
    /** Outputs reaching a step through taken connectors, in connector order, with their notes. */
    const inputs = (step: Step) =>
      edges
        .filter((e) => e.to === step.key && taken(e) === true)
        .map((e) => ({ key: e.from, output: source(e.from)?.output ?? "", note: e.note, title: labelOf(steps.get(e.from)!) }));
    return { edges, current, catches, decide, inputs };
  }

  private plan(state: LoadedRun) {
    const g = this.graph(state);
    const now = Date.now();
    const runnable: { step: Step; pending: StepRow | undefined }[] = [];
    const skips: Step[] = [];
    let waiting = false;
    let retryAt: Date | null = null;
    let callDeadline: Date | null = null;
    let failed: string | null = null;
    let done = true;

    for (const step of state.def.steps) {
      const row = g.current.get(step.key);
      if (!row) {
        done = false;
        const d = g.decide(step);
        if (d === "run") runnable.push({ step, pending: undefined });
        else if (d === "skip") skips.push(step);
        continue;
      }
      switch (row.status) {
        case "waiting":
          done = false;
          if (step.kind === "workspace") {
            const due = new Date(new Date(row.started_at ?? row.created_at).getTime() + step.timeoutMs);
            if (!callDeadline || due < callDeadline) callDeadline = due;
          } else waiting = true;
          break;
        case "pending": {
          done = false;
          if (g.decide(step) !== "run") break;
          const due = row.retry_at ? new Date(row.retry_at).getTime() : 0;
          if (due <= now) runnable.push({ step, pending: row });
          else if (!retryAt || due < retryAt.getTime()) retryAt = new Date(due);
          break;
        }
        case "running":
          done = false;
          break;
        case "failed":
          // Handled when an "On failure" connector leads on from it.
          if (!g.catches(step.key)) failed ??= `${labelOf(step)} failed: ${row.error ?? "unknown error"}`;
          break;
        case "cancelled":
          failed ??= `${labelOf(step)} was cancelled.`;
          break;
        default:
          break;
      }
    }
    return { runnable, skips, waiting, retryAt, callDeadline, failed, done };
  }

  private async markNotTaken(state: LoadedRun, steps: Step[]): Promise<void> {
    await this.db.tx(async (q) => {
      for (const step of steps) {
        const attempt = await this.nextAttempt(q, state.run.id, step.key);
        await this.insertStep(q, state.run, step, attempt, { status: "not_taken" });
      }
    });
  }

  /** A step left "running" belongs to a worker that died; count it as a failed attempt (REL-002). */
  private async recoverInterrupted(state: LoadedRun): Promise<void> {
    const stale = [...this.current(state.rows).values()].filter((r) => r.status === "running");
    for (const row of stale) {
      const step = state.def.steps.find((s) => s.key === row.step_key);
      if (!step) continue;
      await this.db.tx(async (q) => {
        await q.query(
          `update run_steps set status = 'failed', error = 'The worker stopped during this step.', error_code = 'unavailable', finished_at = now() where id = $1`,
          [row.id],
        );
        await q.query(`update budget_reservations set status = 'released', settled_usd = 0, settled_at = now() where step_id = $1 and status = 'held'`, [row.id]);
        if (CAN_RETRY(step)) await this.scheduleRetry(q, state.run, step, row, true);
      });
    }
    if (stale.length > 0) state.rows = (await this.load(state.run.id))!.rows;
  }

  private async applySignals(runId: string, signals: Signal[]): Promise<void> {
    for (const signal of signals) {
      if (signal.name !== "approval") continue;
      const { approvalId, decision, note } = signal.payload as { approvalId: string; decision: Decision; note: string };
      await this.db.tx(async (q) => {
        const [run] = await q.query<RunRow>(`select * from runs where id = $1 for update`, [runId]);
        if (!run || TERMINAL.has(run.status)) return;
        const [approval] = await q.query<{ step_id: string }>(`select step_id from approvals where id = $1`, [approvalId]);
        if (!approval) return;
        const [stepRow] = await q.query<StepRow>(`select * from run_steps where id = $1`, [approval.step_id]);
        if (!stepRow || stepRow.status !== "waiting") return;
        const def = run.workflow;
        const step = def.steps.find((s) => s.key === stepRow.step_key) as ApprovalStep | undefined;
        if (!step) return;

        if (decision === "approve") {
          await this.updateStep(q, run, stepRow.id, `status = 'succeeded', output = $2, finished_at = now()`, [note || "Approved."]);
        } else if (decision === "reject") {
          await this.updateStep(q, run, stepRow.id, `status = 'failed', error = $2, error_code = 'refused', finished_at = now()`, [
            note ? `Rejected: ${note}` : "Rejected by the approver.",
          ]);
        } else {
          // Request changes: re-run only the revised steps and what depends on them (TASK-004).
          const affected = downstreamOf(def, step.revises.length ? step.revises : [stepRow.step_key]);
          const live = await q.query<StepRow>(
            `select * from run_steps where run_id = $1 and status <> 'superseded' and step_key = any($2::text[])`,
            [runId, [...affected]],
          );
          for (const row of live) await this.updateStep(q, run, row.id, `status = 'superseded'`, []);
          for (const key of step.revises) {
            const [max] = await q.query<{ attempt: number }>(`select coalesce(max(attempt), 0) as attempt from run_steps where run_id = $1 and step_key = $2`, [
              runId,
              key,
            ]);
            const revised = def.steps.find((s) => s.key === key)!;
            await this.insertStep(q, run, revised, num(max?.attempt) + 1, { status: "pending", feedback: note });
          }
        }
        await q.query(`update runs set status = 'running' where id = $1 and status = 'waiting'`, [runId]);
        await this.emitRun(q, runId);
        await this.touchParent(q, run);
      });
    }
  }

  private async executeStep(state: LoadedRun, step: Step, pending: StepRow | undefined, heartbeat: () => Promise<void>): Promise<void> {
    if (step.disabled) return this.passThrough(state, step, pending);
    switch (step.kind) {
      case "approval":
        return this.openApproval(state, step, pending);
      case "workspace":
        return this.startCall(state, step, pending);
      case "tool":
        return this.runToolStep(state, step, pending, heartbeat);
      case "role":
      case "classify":
        return this.runRoleStep(state, step, pending, heartbeat);
      default:
        return this.runInstant(state, step, pending);
    }
  }

  /** A turned-off step: skipped, passing on what reached it. */
  private async passThrough(state: LoadedRun, step: Step, pending: StepRow | undefined): Promise<void> {
    const output = this.graph(state)
      .inputs(step)
      .map((i) => i.output)
      .filter(Boolean)
      .join("\n\n");
    await this.writeInstant(state.run, step, pending, { status: "skipped", output, error: "Turned off: passed its input on." });
  }

  /** If/Switch, Merge, Text and Stop: decided right here, with no node and no cost (WF-009). */
  private async runInstant(state: LoadedRun, step: InstantStep, pending: StepRow | undefined): Promise<void> {
    const { run } = state;
    const ctx = { input: run.brief, steps: this.stepOutputs(state.rows), ...this.loopVars(state, step.key) };
    const inputs = this.graph(state).inputs(step);
    const first = inputs[0]?.output ?? "";
    switch (step.kind) {
      case "branch": {
        const value = step.value.trim() ? render(step.value, ctx) : first;
        const matches = step.cases.filter((c) => testCondition(c.when, value));
        const chosen = (step.mode === "all" ? matches : matches.slice(0, 1)).map((c) => c.key);
        const keys = chosen.length ? chosen : ["else"];
        const labels = keys.map((k) => step.cases.find((c) => c.key === k)?.label ?? "Else");
        return this.writeInstant(run, step, pending, { status: "succeeded", output: value, chosen: keys, label: `Took ${labels.join(" + ")}` });
      }
      case "merge": {
        const outputs = inputs.map((i) => i.output);
        const output =
          step.mode === "json"
            ? JSON.stringify(Object.fromEntries(inputs.map((i) => [i.key, i.output])))
            : step.mode === "concat"
              ? outputs.filter((o) => o.trim()).join(step.separator)
              : (outputs.find((o) => o.trim()) ?? "");
        return this.writeInstant(run, step, pending, { status: "succeeded", output, label: `Merged ${inputs.map((i) => i.title).join(", ") || "nothing"}` });
      }
      case "text":
        return this.writeInstant(run, step, pending, { status: "succeeded", output: render(step.template, ctx) });
      case "stop": {
        const message = render(step.message, ctx).trim();
        await this.writeInstant(run, step, pending, { status: "succeeded", output: message, label: step.outcome === "succeed" ? "Ended the task" : "Failed the task" });
        const fresh = (await this.load(run.id))!;
        if (step.outcome === "succeed") await this.finishRun(fresh, "succeeded", null, message || first);
        else await this.finishRun(fresh, "failed", message || `Stopped at ${labelOf(step)}.`);
      }
    }
  }

  private async writeInstant(
    run: RunRow,
    step: Step,
    pending: StepRow | undefined,
    r: { status: "succeeded" | "skipped"; output: string; chosen?: string[]; label?: string; error?: string },
  ): Promise<void> {
    await this.db.tx(async (q) => {
      const attempt = pending?.attempt ?? (await this.nextAttempt(q, run.id, step.key));
      const id = pending?.id ?? (await this.insertStep(q, run, step, attempt, { status: "pending" }));
      await this.updateStep(q, run, id, `status = $2, output = $3, input = $4::jsonb, node_label = $5, error = $6, started_at = coalesce(started_at, now()), finished_at = now()`, [
        r.status,
        r.output,
        json(r.chosen ? { chosen: r.chosen } : {}),
        r.label ?? null,
        r.error ?? null,
      ]);
    });
  }

  private stepOutputs(rows: StepRow[]): Record<string, { output: string }> {
    const outputs: Record<string, { output: string }> = {};
    for (const [key, row] of this.current(rows)) if (READABLE.has(row.status)) outputs[key] = { output: (row.status === "failed" ? row.error : row.output) ?? "" };
    return outputs;
  }

  private async openApproval(state: LoadedRun, step: ApprovalStep, pending: StepRow | undefined): Promise<void> {
    const { run } = state;
    const body = render(step.show, { input: run.brief, steps: this.stepOutputs(state.rows), ...this.loopVars(state, step.key) });
    await this.db.tx(async (q) => {
      const attempt = pending?.attempt ?? (await this.nextAttempt(q, run.id, step.key));
      const stepId = pending
        ? (await this.updateStep(q, run, pending.id, `status = 'waiting', started_at = now(), output = $2`, [body]), pending.id)
        : await this.insertStep(q, run, step, attempt, { status: "waiting", output: body, started: true });
      const approvalId = newId();
      await q.query(`insert into approvals (id, org_id, run_id, step_id, title, body) values ($1, $2, $3, $4, $5, $6)`, [
        approvalId,
        run.org_id,
        run.id,
        stepId,
        step.title,
        body,
      ]);
      await this.notify(q, run, {
        kind: "approval",
        title: `${step.title}: ${run.title}`,
        body: body.slice(0, 4_000),
        path: await this.path(q, run, step.title),
        action: "approve",
        approvalId,
        urgent: step.urgent,
      });
      await q.query(`update runs set status = 'waiting', started_at = coalesce(started_at, now()) where id = $1`, [run.id]);
      await this.emitRun(q, run.id);
      await this.touchParent(q, run);
    });
  }

  private async runRoleStep(state: LoadedRun, step: RoleStep | ClassifyStep, pending: StepRow | undefined, heartbeat: () => Promise<void>): Promise<void> {
    const { run } = state;
    const actor: Actor = { orgId: run.org_id, userId: run.created_by ?? "" };
    const [role] = await this.db.query<RoleRow>(`select key, name, instructions, connection_id, model, effort from roles where workspace_id = $1 and key = $2`, [
      run.workspace_id,
      step.role,
    ]);

    if (await this.skipIfOptional(run, step, role, pending)) return;
    // Resolve everything that can fail before any money is reserved.
    const setupError = await this.checkSetup(run, step, role);
    const attempt = pending?.attempt ?? (await this.nextAttempt(this.db, run.id, step.key));
    const stepId = pending?.id ?? newId();
    if (setupError) {
      await this.db.tx(async (q) => {
        if (!pending) await this.insertStep(q, run, step, attempt, { status: "pending", id: stepId });
        await this.failStep(q, run, step, stepId, attempt, setupError, null);
      });
      return;
    }

    const { instance, row: conn } = await this.connections.instance(actor, role!.connection_id!);
    const model = instance.ports.model!;
    const pricing = pricingFor(await this.connections.runtime.models(conn.id, instance).catch(() => []), role!.model!);
    const outputs = this.stepOutputs(state.rows);
    const arriving = this.graph(state).inputs(step);
    let prompt =
      step.kind === "classify"
        ? classifyPrompt(step, step.value.trim() ? render(step.value, { input: run.brief, steps: outputs, ...this.loopVars(state, step.key) }) : (arriving[0]?.output ?? ""))
        : render(step.prompt, { input: run.brief, steps: outputs, ...this.loopVars(state, step.key) });
    // A loop that starts here tells it how the last round ended (WF-010).
    const back = this.carryFor(state, step.key);
    if (back) prompt += `\n\n---\nThis is round ${back.round}. The last round ended with:\n${back.previous}\n\nImprove on it.`;
    // Instructions written on the connectors that brought this step its inputs (WF-009).
    const notes = arriving.filter((i) => i.note?.trim());
    if (notes.length) prompt += `\n\n---\nNotes on your inputs:\n${notes.map((n) => `- From ${n.title}: ${n.note!.trim()}`).join("\n")}`;
    const feedback = pending?.feedback;
    if (feedback) {
      const previous = [...state.rows].reverse().find((r) => r.step_key === step.key && r.status === "superseded" && r.output);
      prompt += `\n\n---\nA reviewer asked for changes to your previous version:\n${feedback}\n\nYour previous version:\n${previous?.output ?? "(not available)"}\n\nWrite the revised version in full.`;
    }
    const system = role!.instructions || undefined;
    const reserveUsd =
      (await historicalP90(this.db, run.task_type_id, step.key)) ??
      (step.pricePerCallUsd ?? upperBound(pricing, prompt.length + (system?.length ?? 0), step.maxTokens));
    const nodeLabel = `${role!.name} · ${conn.name} · ${role!.model}`;
    const idempotencyKey = `${run.id}:${step.key}:${attempt}`;

    await this.db.tx(async (q) => {
      const fields = `status = 'running', started_at = now(), role_key = $2, connection_id = $3, node_label = $4, input = $5::jsonb, idempotency_key = $6`;
      const params = [role!.key, conn.id, nodeLabel, json({ prompt, system: system ?? null, model: role!.model }), idempotencyKey];
      if (!pending) await this.insertStep(q, run, step, attempt, { status: "pending", id: stepId });
      await this.updateStep(q, run, stepId, fields, params);
      await q.query(`update runs set status = 'running', started_at = coalesce(started_at, now()) where id = $1 and status in ('queued', 'waiting')`, [run.id]);
      await this.emitRun(q, run.id);
    });

    // Reserve in its own transaction so a refusal can still mark the step failed.
    let reservationId: string;
    try {
      reservationId = await this.db.tx((q) =>
        reserve(q, { orgId: run.org_id, workspaceId: run.workspace_id, runId: run.id, stepId, connectionId: conn.id, amountUsd: reserveUsd }),
      );
    } catch (err) {
      const nodeError = toNodeError(err);
      await this.db.tx((q) => this.failStep(q, run, step, stepId, attempt, nodeError.message, nodeError.code));
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new NodeCallError("timeout", `No answer within ${Math.round(step.timeoutMs / 1000)} s.`, true)), step.timeoutMs);
    const beat = setInterval(() => void heartbeat().catch(() => {}), 60_000);
    let calls = this.inflight.get(run.id);
    if (!calls) this.inflight.set(run.id, (calls = new Set()));
    calls.add(controller);
    const started = Date.now();
    const topicsForRun = this.runTopics(run);

    try {
      const result = await model.generate(
        {
          model: role!.model!,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
          maxTokens: step.maxTokens,
          ...(role!.effort ? { effort: role!.effort as Effort } : {}),
          responseFormat: step.kind === "classify" ? "text" : step.output,
        },
        {
          call: {
            callId: stepId,
            runId: run.id,
            parentCallId: null,
            depth: run.depth,
            nodeId: conn.id,
            input: { text: prompt },
            budget: { usd: reserveUsd },
            permissions: [`call:node:${conn.id}`],
            trace: { traceparent: `00-${run.id.replace(/-/g, "")}-${stepId.replace(/-/g, "").slice(0, 16)}-01` },
            idempotencyKey,
          },
          signal: controller.signal,
          emit: (event) => {
            if (event.type === "text_delta" && typeof event.data === "string") {
              this.bus.publishTransient(topicsForRun, { type: "step.delta", runId: run.id, stepKey: step.key, text: event.data });
            }
          },
        },
      );
      if (step.kind === "role" && step.output === "json") JSON.parse(result.text);
      const category = step.kind === "classify" ? pickCategory(step, result.text) : null;
      const cost = step.pricePerCallUsd ?? costOf(pricing, result.usage);
      // Conclave made this call itself, so the tokens are metered unless the module had to estimate them.
      const costSource = step.pricePerCallUsd !== undefined || result.usageSource === "estimated" ? "estimated" : "metered";
      await this.db.tx(async (q) => {
        const [live] = await q.query<{ status: string }>(`select status from runs where id = $1 for update`, [run.id]);
        if (live?.status === "cancelled") return;
        await this.updateStep(
          q,
          run,
          stepId,
          `status = 'succeeded', output = $2, tokens_in = $3, tokens_out = $4, cost_usd = $5, cost_source = $6, latency_ms = $7, finished_at = now(),
           input = coalesce(input, '{}'::jsonb) || $8::jsonb`,
          [
            category ?? result.text,
            result.usage.inputTokens,
            result.usage.outputTokens,
            cost,
            costSource,
            Date.now() - started,
            json(step.kind === "classify" ? { chosen: category ? [category] : [], answer: result.text.slice(0, 2_000) } : {}),
          ],
        );
        await settle(q, reservationId, cost);
        await q.query(
          `insert into usage_ledger (id, org_id, workspace_id, run_id, step_id, connection_id, role_key, module_id, model, tokens_in, tokens_out, cost_usd, cost_source, reservation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            newId(),
            run.org_id,
            run.workspace_id,
            run.id,
            stepId,
            conn.id,
            role!.key,
            conn.moduleId,
            result.model,
            result.usage.inputTokens,
            result.usage.outputTokens,
            cost,
            costSource,
            reservationId,
          ],
        );
        await q.query(`update runs set cost_usd = cost_usd + $2, call_count = call_count + 1 where id = $1`, [run.id, cost]);
        // The call is paid for either way; an answer that names no category is a failed, retryable attempt.
        if (step.kind === "classify" && !category) {
          await this.failStep(q, run, step, stepId, attempt, `The model's answer named none of the categories: "${result.text.slice(0, 120)}"`, "invalid_request", true);
        }
        await this.emitRun(q, run.id);
      });
    } catch (err) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof NodeCallError ? controller.signal.reason : err;
      const nodeError = err instanceof SyntaxError ? { code: "invalid_request" as const, message: "The model did not return valid JSON.", retryable: true } : toNodeError(reason);
      await this.db.tx(async (q) => {
        await release(q, reservationId);
        await q.query(`update runs set call_count = call_count + 1 where id = $1`, [run.id]);
        const [live] = await q.query<{ status: string }>(`select status from runs where id = $1`, [run.id]);
        if (live?.status === "cancelled") return;
        await this.failStep(q, run, step, stepId, attempt, nodeError.message, nodeError.code, nodeError.retryable, Date.now() - started);
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(beat);
      calls.delete(controller);
      if (calls.size === 0) this.inflight.delete(run.id);
    }
  }

  /** An optional step whose role has no node is skipped; later steps see an empty output. */
  private async skipIfOptional(run: RunRow, step: CallStep, role: RoleRow | undefined, pending: StepRow | undefined): Promise<boolean> {
    if (!step.optional || (role?.connection_id && role.model)) return false;
    await this.db.tx(async (q) => {
      const attempt = pending?.attempt ?? (await this.nextAttempt(q, run.id, step.key));
      const id = pending?.id ?? (await this.insertStep(q, run, step, attempt, { status: "pending" }));
      await this.updateStep(q, run, id, `status = 'skipped', output = '', error = $2, finished_at = now()`, [`Skipped: ${role?.name ?? step.role} has no node.`]);
    });
    return true;
  }

  /** A tool step calls one tool of the Tool-port node filling the role (WF-001, MOD-004). */
  private async runToolStep(state: LoadedRun, step: ToolStep, pending: StepRow | undefined, heartbeat: () => Promise<void>): Promise<void> {
    const { run } = state;
    const actor: Actor = { orgId: run.org_id, userId: run.created_by ?? "" };
    const [role] = await this.db.query<RoleRow>(`select key, name, instructions, connection_id, model, effort from roles where workspace_id = $1 and key = $2`, [
      run.workspace_id,
      step.role,
    ]);
    if (await this.skipIfOptional(run, step, role, pending)) return;
    const setupError = await this.checkSetup(run, step, role);
    const attempt = pending?.attempt ?? (await this.nextAttempt(this.db, run.id, step.key));
    const stepId = pending?.id ?? newId();
    const failEarly = (message: string, code: string | null) =>
      this.db.tx(async (q) => {
        if (!pending) await this.insertStep(q, run, step, attempt, { status: "pending", id: stepId });
        await this.failStep(q, run, step, stepId, attempt, message, code);
      });
    if (setupError) return void (await failEarly(setupError, null));

    const { instance, row: conn } = await this.connections.instance(actor, role!.connection_id!);
    const tools = instance.ports.tool;
    if (!tools) return void (await failEarly(`${conn.name} does not provide tools.`, "invalid_request"));
    const toolName = role!.model!;
    const outputs = this.stepOutputs(state.rows);
    let args: Record<string, unknown> = Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, render(v, { input: run.brief, steps: outputs, ...this.loopVars(state, step.key) })]));
    // Arguments written for one tool often name the same field differently: map a single value onto
    // the tool's only required text parameter.
    const info = (await this.connections.runtime.tools(conn.id, instance).catch(() => [])).find((t) => t.name === toolName);
    const props = (info?.inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
    const required = ((info?.inputSchema?.required ?? []) as string[]).filter((k) => props[k]?.type === "string");
    const values = Object.values(args);
    if (info && Object.keys(args).some((k) => !(k in props)) && required.length === 1 && values.length === 1) args = { [required[0]!]: values[0] };

    const price = step.pricePerCallUsd ?? (Number(conn.config.pricePerCallUsd ?? 0) || 0);
    const nodeLabel = `${role!.name} · ${conn.name} · ${toolName}`;
    const idempotencyKey = `${run.id}:${step.key}:${attempt}`;
    await this.db.tx(async (q) => {
      if (!pending) await this.insertStep(q, run, step, attempt, { status: "pending", id: stepId });
      await this.updateStep(
        q,
        run,
        stepId,
        `status = 'running', started_at = now(), role_key = $2, connection_id = $3, node_label = $4, input = $5::jsonb, idempotency_key = $6`,
        [role!.key, conn.id, nodeLabel, json({ tool: toolName, args }), idempotencyKey],
      );
      await q.query(`update runs set status = 'running', started_at = coalesce(started_at, now()) where id = $1 and status in ('queued', 'waiting')`, [run.id]);
      await this.emitRun(q, run.id);
    });

    let reservationId: string;
    try {
      reservationId = await this.db.tx((q) =>
        reserve(q, { orgId: run.org_id, workspaceId: run.workspace_id, runId: run.id, stepId, connectionId: conn.id, amountUsd: price }),
      );
    } catch (err) {
      const e = toNodeError(err);
      return void (await this.db.tx((q) => this.failStep(q, run, step, stepId, attempt, e.message, e.code)));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new NodeCallError("timeout", `No answer within ${Math.round(step.timeoutMs / 1000)} s.`, true)), step.timeoutMs);
    const beat = setInterval(() => void heartbeat().catch(() => {}), 60_000);
    let calls = this.inflight.get(run.id);
    if (!calls) this.inflight.set(run.id, (calls = new Set()));
    calls.add(controller);
    const started = Date.now();
    try {
      const result = await tools.call(toolName, args, {
        call: {
          callId: stepId,
          runId: run.id,
          parentCallId: null,
          depth: run.depth,
          nodeId: conn.id,
          input: { data: args },
          budget: { usd: price },
          permissions: [`call:node:${conn.id}`],
          trace: { traceparent: `00-${run.id.replace(/-/g, "")}-${stepId.replace(/-/g, "").slice(0, 16)}-01` },
          idempotencyKey,
        },
        signal: controller.signal,
        emit: () => {},
      });
      const data = result.data as { text?: string } | string | null;
      const text = typeof data === "string" ? data : typeof data?.text === "string" && data.text ? data.text : JSON.stringify(data ?? null);
      await this.db.tx(async (q) => {
        const [live] = await q.query<{ status: string }>(`select status from runs where id = $1 for update`, [run.id]);
        if (live?.status === "cancelled") return;
        // Tools report no token usage; their cost is the per-call price the user set (COST-004, COST-006).
        await this.updateStep(q, run, stepId, `status = 'succeeded', output = $2, cost_usd = $3, cost_source = 'estimated', latency_ms = $4, finished_at = now()`, [
          text,
          price,
          Date.now() - started,
        ]);
        await settle(q, reservationId, price);
        await q.query(
          `insert into usage_ledger (id, org_id, workspace_id, run_id, step_id, connection_id, role_key, module_id, model, cost_usd, cost_source, reservation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'estimated', $11)`,
          [newId(), run.org_id, run.workspace_id, run.id, stepId, conn.id, role!.key, conn.moduleId, toolName, price, reservationId],
        );
        await q.query(`update runs set cost_usd = cost_usd + $2, call_count = call_count + 1 where id = $1`, [run.id, price]);
        await this.emitRun(q, run.id);
      });
    } catch (err) {
      const reason = controller.signal.aborted && controller.signal.reason instanceof NodeCallError ? controller.signal.reason : err;
      const e = toNodeError(reason);
      await this.db.tx(async (q) => {
        await release(q, reservationId);
        await q.query(`update runs set call_count = call_count + 1 where id = $1`, [run.id]);
        const [live] = await q.query<{ status: string }>(`select status from runs where id = $1`, [run.id]);
        if (live?.status === "cancelled") return;
        await this.failStep(q, run, step, stepId, attempt, e.message, e.code, e.retryable, Date.now() - started);
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(beat);
      calls.delete(controller);
      if (calls.size === 0) this.inflight.delete(run.id);
    }
  }

  /** Problems that make a role step impossible, checked before money is reserved. */
  private async checkSetup(run: RunRow, step: CallStep, role: RoleRow | undefined): Promise<string | null> {
    if (!role) return `The workflow calls role "${step.role}", which this workspace does not have.`;
    if (!role.connection_id || !role.model) return `${role.name} has no node. Choose a connection and ${step.kind === "tool" ? "tool" : "model"} in Team.`;
    const [conn] = await this.db.query<{ disabled_at: Date | null; module_id: string; name: string }>(
      `select disabled_at, module_id, name from connections where id = $1`,
      [role.connection_id],
    );
    if (!conn) return `${role.name}'s connection was deleted.`;
    if (conn.disabled_at) return `${conn.name} is turned off by its kill switch.`;
    // Loop guard layer 3 (MESH-012): caps per root run.
    const [counts] = await this.db.query<{ total: string; node: string }>(
      `select (select coalesce(sum(call_count), 0) from runs where root_run_id = $1) as total,
              (select count(*) from run_steps s join runs r on r.id = s.run_id
                where r.root_run_id = $1 and s.connection_id = $2 and s.started_at is not null) as node`,
      [run.root_run_id, role.connection_id],
    );
    if (num(counts?.total) >= this.opts.maxCallsPerRun) return `Stopped: this task reached its cap of ${this.opts.maxCallsPerRun} node calls.`;
    if (num(counts?.node) >= this.opts.maxCallsPerNode) return `Stopped: ${conn.name} was called ${this.opts.maxCallsPerNode} times in this task, its per-node cap.`;
    return null;
  }

  private async failStep(
    q: Queryable,
    run: RunRow,
    step: Step,
    stepId: string,
    attempt: number,
    message: string,
    code: string | null,
    retryable = false,
    latencyMs?: number,
  ): Promise<void> {
    const [row] = await q.query<StepRow>(
      `update run_steps set status = 'failed', error = $2, error_code = $3, latency_ms = $4, finished_at = now() where id = $1 returning *`,
      [stepId, message, code, latencyMs ?? null],
    );
    if (row) await emit(q, this.runTopics(run), { type: "step.updated", runId: run.id, step: toStepDto(row) });
    if (row && retryable && CAN_RETRY(step)) await this.scheduleRetry(q, run, step, row, false);
    if (code === "budget_exceeded") {
      await this.notify(q, run, { kind: "budget", title: `Budget reached: ${run.title}`, body: message, path: await this.path(q, run, labelOf(step)), action: "open" });
    }
  }

  /** Retries with exponential backoff (WF-003). Returns false when attempts are used up. */
  private async scheduleRetry(q: Queryable, run: RunRow, step: CallStep, row: StepRow, interrupted: boolean): Promise<boolean> {
    const policy = step.retry ?? this.opts.defaultRetry;
    if (row.attempt >= policy.maxAttempts) return false;
    const delay = interrupted ? 0 : policy.backoffMs * Math.pow(policy.factor, row.attempt - 1);
    await this.insertStep(q, run, step, row.attempt + 1, {
      status: "pending",
      retryAt: new Date(Date.now() + delay),
      ...(row.feedback ? { feedback: row.feedback } : {}),
    });
    await this.engine.wake(q, run.id, new Date(Date.now() + delay));
    return true;
  }

  private async finishRun(state: LoadedRun, status: "succeeded" | "failed", error: string | null, outputOverride?: string): Promise<void> {
    const { run, def } = state;
    const current = this.current(state.rows);
    // The chosen result step, or else the last writing step that ran: with branches, the one that was taken.
    const writers = [...def.steps].reverse().filter((s) => ["role", "workspace", "merge", "text"].includes(s.kind));
    const outputKey = def.output ?? (writers.find((s) => current.get(s.key)?.status === "succeeded") ?? writers[0])?.key;
    const output = outputOverride ?? (outputKey ? (current.get(outputKey)?.output ?? null) : null);
    let stopped: string[] = [];
    await this.db.tx(async (q) => {
      const [live] = await q.query<{ status: string }>(`select status from runs where id = $1 for update`, [run.id]);
      if (!live || TERMINAL.has(live.status)) return;
      await q.query(`update runs set status = $2, output = $3, error = $4, finished_at = now() where id = $1`, [run.id, status, output, error]);
      // A Stop step can end a task while other branches are still going: stop them too.
      const open = await q.query<StepRow>(
        `update run_steps set status = 'cancelled', finished_at = now() where run_id = $1 and status in ('pending', 'running', 'waiting') returning *`,
        [run.id],
      );
      for (const o of open) await emit(q, this.runTopics(run), { type: "step.updated", runId: run.id, step: toStepDto(o) });
      if (open.length) {
        await q.query(`update budget_reservations set status = 'released', settled_usd = 0, settled_at = now() where run_id = $1 and status = 'held'`, [run.id]);
        await q.query(`update approvals set decision = 'cancelled', decided_at = now() where run_id = $1 and decision is null`, [run.id]);
        stopped = [run.id];
        const children = await q.query<RunRow>(`select * from runs where parent_run_id = $1 and status not in ${TERMINAL_SQL} for update`, [run.id]);
        for (const child of children) stopped.push(...(await this.cancelTree(q, child, "Cancelled because the task that started it ended.")));
      }
      await this.resolveRunInbox(q, run.id);
      // A sub-task reports to the task that started it, which tells the person once, at the end.
      if (run.parent_run_id) {
        await this.emitRun(q, run.id);
        await this.childFinished(q, run);
        return;
      }
      await this.notify(q, run, {
        kind: status === "succeeded" ? "result" : "problem",
        title: status === "succeeded" ? `Done: ${run.title}` : `Failed: ${run.title}`,
        body: status === "succeeded" ? (output ?? "").slice(0, 4_000) : (error ?? ""),
        path: await this.path(q, run, status === "succeeded" ? "finished" : "failed"),
        action: "open",
      });
      await this.emitRun(q, run.id);
    });
    this.abortCalls(stopped);
  }

  private async setRunStatus(run: RunRow, status: string): Promise<void> {
    await this.db.tx(async (q) => {
      const updated = await q.query(`update runs set status = $2 where id = $1 and status <> $2 and status not in ('succeeded', 'failed', 'cancelled') returning id`, [
        run.id,
        status,
      ]);
      if (updated.length > 0) await this.emitRun(q, run.id);
    });
  }

  // ------------------------------------------------- workspace steps (WF-008)

  /**
   * What a workspace step calls, or why it cannot: the workspace (this one for
   * "self"), the task type there, and the step to stop at.
   */
  private async callTarget(q: Queryable, orgId: string, workspaceId: string, step: WorkspaceStep): Promise<CallTarget | string> {
    const targetId = step.workspace === "self" ? workspaceId : step.workspace;
    const [row] = await q.query<{ id: string; name: string; budget_task_usd: string; budget_month_usd: string }>(
      `select id, name, budget_task_usd, budget_month_usd from workspaces where id = $1 and org_id = $2 and archived_at is null`,
      [targetId, orgId],
    );
    const label = labelOf(step);
    if (!row) return `${label} calls a workspace that no longer exists.`;
    const [tt] = await q.query<{ id: string; name: string; input_fields: InputField[]; workflow: WorkflowDefinition }>(
      `select id, name, input_fields, workflow from task_types where workspace_id = $1 and key = $2 and archived_at is null`,
      [row.id, step.taskType],
    );
    if (!tt) return `${label} calls task type "${step.taskType}", which ${row.name} does not have.`;
    if (step.until && !tt.workflow.steps.some((s) => s.key === step.until)) return `${label} runs ${tt.name} up to "${step.until}", but it has no such step.`;
    return {
      workspaceId: row.id,
      workspaceName: row.name,
      taskTypeId: tt.id,
      taskTypeName: tt.name,
      inputFields: tt.input_fields,
      workflow: tt.workflow,
      budgetTaskUsd: num(row.budget_task_usd),
      budgetMonthUsd: num(row.budget_month_usd),
    };
  }

  /** The person who started the task, as a principal, so sub-tasks get exactly their access. */
  private async creator(q: Queryable, run: RunRow): Promise<Principal | null> {
    if (!run.created_by) return null;
    const [m] = await q.query<{ role: string }>(`select role from memberships where org_id = $1 and user_id = $2`, [run.org_id, run.created_by]);
    return m && isRole(m.role) ? { orgId: run.org_id, userId: run.created_by, role: m.role, scopes: null, via: "session" } : null;
  }

  /** Start a workspace step: check the call, plan the runs, and start the first ones, in one transaction. */
  private async startCall(state: LoadedRun, step: WorkspaceStep, pending: StepRow | undefined): Promise<void> {
    const { run } = state;
    const attempt = pending?.attempt ?? (await this.nextAttempt(this.db, run.id, step.key));
    const stepId = pending?.id ?? newId();
    const fail = (message: string, code: string | null = null) =>
      this.db.tx(async (q) => {
        if (!pending) await this.insertStep(q, run, step, attempt, { status: "pending", id: stepId });
        await this.failStep(q, run, step, stepId, attempt, message, code);
      });

    const target = await this.callTarget(this.db, run.org_id, run.workspace_id, step);
    if (typeof target === "string") return void (await fail(target));
    // Loop guards: recursion ends at a depth, and a task tree has a size.
    if (run.depth + 1 > this.opts.maxDepth) {
      return void (await fail(`Stopped: sub-tasks may nest ${this.opts.maxDepth} deep, and this one would be deeper. Check that the workflow does not call itself without a way to stop.`));
    }
    const [tree] = await this.db.query<{ n: string }>(`select count(*) as n from runs where root_run_id = $1 and id <> $1`, [run.root_run_id]);
    if (num(tree?.n) >= this.opts.maxSubtasks) return void (await fail(`Stopped: this task reached its cap of ${this.opts.maxSubtasks} sub-tasks.`));
    const who = await this.creator(this.db, run);
    if (!who || !(await this.access.can(this.db, who, "task:run", target.workspaceId))) {
      return void (await fail(`The person who started this task cannot run tasks in ${target.workspaceName}.`, "refused"));
    }

    const ctx = { input: run.brief, steps: this.stepOutputs(state.rows) };
    let total = 1;
    let items: unknown[] | null = null;
    if (step.repeat?.mode === "times") total = step.repeat.count;
    if (step.repeat?.mode === "until") total = step.repeat.max;
    if (step.repeat?.mode === "each") {
      items = listItems(render(step.repeat.items, ctx));
      if (items.length > step.repeat.max) {
        return void (await fail(`${labelOf(step)} would run ${items.length} times, more than its limit of ${step.repeat.max}.`));
      }
      total = items.length;
    }
    const callInput: CallInput = { workspaceId: target.workspaceId, workspaceName: target.workspaceName, taskTypeId: target.taskTypeId, taskTypeName: target.taskTypeName, total, items };

    try {
      await this.db.tx(async (q) => {
        if (!pending) await this.insertStep(q, run, step, attempt, { status: "pending", id: stepId });
        await this.updateStep(q, run, stepId, `status = 'waiting', started_at = now(), node_label = $2, input = $3::jsonb`, [
          `${target.workspaceName} › ${target.taskTypeName}${step.until ? ` (up to ${step.until})` : ""}`,
          json(callInput),
        ]);
        await q.query(`update runs set status = 'running', started_at = coalesce(started_at, now()) where id = $1 and status in ('queued', 'waiting')`, [run.id]);
        if (total === 0) {
          // Nothing to repeat over: the step is done with an empty list.
          await this.updateStep(q, run, stepId, `status = 'succeeded', output = '[]', finished_at = now()`, []);
        } else {
          const first = step.repeat?.mode === "until" ? 1 : Math.min(total, step.repeat && "parallel" in step.repeat ? step.repeat.parallel : 1);
          for (let i = 1; i <= first; i++) await this.startChild(q, run, step, stepId, target, ctx, i, items?.[i - 1], undefined, first - i + 1);
        }
        await this.emitRun(q, run.id);
      });
    } catch (err) {
      if (!(err instanceof ConclaveError)) throw err;
      await fail(err.detail ?? err.message, err.status === 402 ? "budget_exceeded" : "invalid_request");
    }
  }

  /**
   * Insert one sub-task. Its budget is a share of what the parent has left,
   * held back from the parent until the sub-task finishes and its cost rolls up.
   */
  private async startChild(
    q: Queryable,
    run: RunRow,
    step: WorkspaceStep,
    stepId: string,
    target: CallTarget,
    ctx: { input: Record<string, string>; steps: Record<string, { output: string }> },
    iteration: number,
    item: unknown,
    previous: string | undefined,
    slots: number,
  ): Promise<void> {
    const brief: Record<string, string> = {};
    for (const field of target.inputFields) {
      const template = step.inputs[field.key];
      if (template !== undefined) brief[field.key] = render(template, { ...ctx, loop: { index: iteration, item, ...(previous !== undefined ? { previous } : {}) } });
    }
    const errors = validateBrief(target.inputFields, brief);
    if (errors.length) throw invalid(errors.map((e) => `${labelOf(step)}: ${e}`));

    const [parent] = await q.query<{ budget_usd: string; cost_usd: string; held: string; committed: string }>(
      `select r.budget_usd, r.cost_usd,
              coalesce((select sum(reserved_usd) from budget_reservations b where b.run_id = r.id and b.status = 'held'), 0) as held,
              coalesce((select sum(c.budget_usd) from runs c where c.parent_run_id = r.id and c.status not in ${TERMINAL_SQL}), 0) as committed
         from runs r where r.id = $1 for update`,
      [run.id],
    );
    const left = num(parent?.budget_usd) - num(parent?.cost_usd) - num(parent?.held) - num(parent?.committed);
    const budget = Math.min(target.budgetTaskUsd, left / Math.max(1, slots));
    if (!(budget > 1e-6)) throw budgetBlocked(`No task budget is left for ${labelOf(step)} (${iteration > 1 ? `run ${iteration}` : "its sub-task"}).`);
    const [month] = await q.query<{ spent: string; held: string }>(
      `select coalesce((select sum(cost_usd) from usage_ledger u where u.workspace_id = $1 and u.at >= $2), 0) as spent,
              coalesce((select sum(reserved_usd) from budget_reservations b where b.workspace_id = $1 and b.status = 'held'), 0) as held`,
      [target.workspaceId, monthStart()],
    );
    if (num(month?.spent) + num(month?.held) >= target.budgetMonthUsd) {
      throw budgetBlocked(`${target.workspaceName} has used its $${target.budgetMonthUsd.toFixed(2)} monthly budget.`);
    }

    const id = newId();
    const firstField = target.inputFields.find((f) => brief[f.key]);
    const base = (firstField ? brief[firstField.key]! : target.taskTypeName).replace(/\s+/g, " ").trim();
    const title = (step.repeat ? `#${iteration} · ${base}` : base).slice(0, 120);
    await q.query(
      `insert into runs (id, org_id, workspace_id, task_type_id, parent_run_id, parent_step_id, iteration, root_run_id, depth, title, brief, workflow, status, budget_usd, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, 'queued', $13, $14)`,
      [
        id,
        run.org_id,
        target.workspaceId,
        target.taskTypeId,
        run.id,
        stepId,
        iteration,
        run.root_run_id,
        run.depth + 1,
        title,
        json(brief),
        json(step.until ? truncateWorkflow(target.workflow, step.until) : target.workflow),
        budget,
        run.created_by,
      ],
    );
    await this.engine.wake(q, id);
    await this.emitRun(q, id);
  }

  /**
   * Move waiting workspace steps forward from their sub-tasks: fail on a
   * failed sub-task or the timeout, start the next repeats, or finish with the
   * output. Returns true when anything changed.
   */
  private async progressCalls(state: LoadedRun): Promise<boolean> {
    const { run } = state;
    let changed = false;
    for (const row of this.current(state.rows).values()) {
      if (row.kind !== "workspace" || row.status !== "waiting") continue;
      const step = state.def.steps.find((s) => s.key === row.step_key);
      if (!step || step.kind !== "workspace") continue;
      const info = row.input as unknown as CallInput;
      const children = await this.db.query<ChildRow>(
        `select id, status, output, error, iteration, cost_usd from runs where parent_step_id = $1 order by iteration, created_at`,
        [row.id],
      );
      const active = children.filter((c) => !TERMINAL.has(c.status));
      const of = info.total > 1 && step.repeat?.mode !== "until" ? ` of ${info.total}` : "";
      const stopAll = async (q: Queryable, message: string) => {
        const ids: string[] = [];
        for (const c of active) {
          const [live] = await q.query<RunRow>(`select * from runs where id = $1 and status not in ${TERMINAL_SQL} for update`, [c.id]);
          if (live) ids.push(...(await this.cancelTree(q, live, "Cancelled because a sibling sub-task failed or the call timed out.")));
        }
        await this.failStep(q, run, step, row.id, row.attempt, message, null);
        return ids;
      };

      const bad = children.find((c) => c.status === "failed" || c.status === "cancelled");
      const overdue = Date.now() > new Date(row.started_at ?? row.created_at).getTime() + step.timeoutMs;
      if (bad || overdue) {
        const message = bad
          ? `Sub-task ${bad.iteration}${of} ${bad.status === "cancelled" ? "was cancelled" : "failed"}${bad.error ? `: ${bad.error}` : "."}`
          : `${labelOf(step)} took longer than ${Math.round(step.timeoutMs / 60_000)} min.`;
        this.abortCalls(await this.db.tx((q) => stopAll(q, message)));
        changed = true;
        continue;
      }

      const done = children.filter((c) => c.status === "succeeded");
      const ctx = { input: run.brief, steps: this.stepOutputs(state.rows) };
      const succeed = (output: string) =>
        this.db.tx(async (q) => {
          const cost = children.reduce((n, c) => n + num(c.cost_usd), 0);
          await this.updateStep(q, run, row.id, `status = 'succeeded', output = $2, cost_usd = $3, finished_at = now()`, [output, cost]);
          await this.emitRun(q, run.id);
        });
      const startMore = (from: number, count: number, previous?: string) =>
        this.db.tx(async (q) => {
          const target = await this.callTarget(q, run.org_id, run.workspace_id, step);
          if (typeof target === "string") throw invalid([target]);
          for (let i = 0; i < count; i++) await this.startChild(q, run, step, row.id, target, ctx, from + i, info.items?.[from + i - 1], previous, count - i);
        });
      const tryStart = async (from: number, count: number, previous?: string) => {
        try {
          await startMore(from, count, previous);
        } catch (err) {
          if (!(err instanceof ConclaveError)) throw err;
          this.abortCalls(await this.db.tx((q) => stopAll(q, err.detail ?? err.message)));
        }
        changed = true;
      };

      const repeat = step.repeat;
      if (repeat?.mode === "until") {
        if (active.length > 0) continue;
        const last = children.at(-1);
        if (last && (last.output ?? "").toLowerCase().includes(repeat.stopWhen.toLowerCase())) {
          await succeed(last.output ?? "");
          changed = true;
        } else if (children.length < repeat.max) {
          await tryStart(children.length + 1, 1, last?.output ?? "");
        } else {
          await this.db.tx((q) => this.failStep(q, run, step, row.id, row.attempt, `Ran ${repeat.max} times and no output contained "${repeat.stopWhen}".`, null));
          changed = true;
        }
        continue;
      }

      if (done.length === info.total) {
        await succeed(step.repeat ? JSON.stringify(done.map((c) => c.output ?? "")) : (done[0]?.output ?? ""));
        changed = true;
        continue;
      }
      const parallel = step.repeat && "parallel" in step.repeat ? step.repeat.parallel : 1;
      const room = Math.min(parallel - active.length, info.total - children.length);
      if (room > 0) await tryStart(children.length + 1, room);
    }
    return changed;
  }

  /** A sub-task finished: add its cost to the step and task that started it, and wake that task. */
  private async childFinished(q: Queryable, run: RunRow): Promise<void> {
    if (!run.parent_run_id) return;
    const [live] = await q.query<{ cost_usd: string }>(`select cost_usd from runs where id = $1`, [run.id]);
    const cost = num(live?.cost_usd);
    if (cost > 0) {
      await q.query(`update runs set cost_usd = cost_usd + $2 where id = $1`, [run.parent_run_id, cost]);
      if (run.parent_step_id) await q.query(`update run_steps set cost_usd = cost_usd + $2 where id = $1`, [run.parent_step_id, cost]);
    }
    await this.engine.wake(q, run.parent_run_id);
  }

  /** Let the task that started this sub-task look again (an approval opened or was answered). */
  private async touchParent(q: Queryable, run: Pick<RunRow, "parent_run_id">): Promise<void> {
    if (run.parent_run_id) await this.engine.wake(q, run.parent_run_id);
  }

  // --------------------------------------------------------- loops (WF-010)

  /**
   * The innermost loop a step is part of, as template variables:
   * {{loop.index}} is the round, {{loop.previous}} what the last round ended with.
   */
  private loopVars(state: Pick<LoadedRun, "run" | "def">, key: string): { loop?: { index: number; previous: string } } {
    let best: { size: number; end: string } | null = null;
    for (const step of state.def.steps) {
      if (!step.loop) continue;
      const round = loopRound(state.def, step);
      if (round.has(key) && (!best || round.size < best.size)) best = { size: round.size, end: step.key };
    }
    if (!best) return {};
    const st = state.run.loops?.[best.end];
    return { loop: { index: st?.round ?? 1, previous: st?.previous ?? "" } };
  }

  /** A loop starting at this step, past its first round, that should hear how the last one ended. */
  private carryFor(state: LoadedRun, key: string): { round: number; previous: string } | null {
    for (const step of state.def.steps) {
      const st = state.run.loops?.[step.key];
      if (step.loop?.to === key && step.loop.carry && st && st.round > 1 && st.previous) return st;
    }
    return null;
  }

  /**
   * Decide finished loop ends: when the rules do not hold yet and rounds are
   * left, supersede the loop's steps so they run again. Returns true when the
   * run changed.
   */
  private async progressLoops(state: LoadedRun): Promise<boolean> {
    const { run, def } = state;
    const current = this.current(state.rows);
    for (const step of def.steps) {
      if (!step.loop) continue;
      const row = current.get(step.key);
      if (!row || (row.status !== "succeeded" && row.status !== "skipped")) continue;
      const output = row.output ?? "";
      if (step.loop.until && testCondition(step.loop.until, output)) continue;
      const round = run.loops?.[step.key]?.round ?? 1;
      if (round >= step.loop.max) {
        if (step.loop.onMax === "fail") {
          await this.finishRun(state, "failed", `${labelOf(step)} looped ${step.loop.max} time${step.loop.max === 1 ? "" : "s"} and its rules never held.`);
          return true;
        }
        continue;
      }
      const body = loopBody(def, step);
      await this.db.tx(async (q) => {
        const live = await q.query<StepRow>(`select * from run_steps where run_id = $1 and status <> 'superseded' and step_key = any($2::text[])`, [run.id, [...body]]);
        for (const r of live) {
          if (r.status === "waiting") {
            const gone = await q.query<{ id: string }>(`update approvals set decision = 'cancelled', decided_at = now() where step_id = $1 and decision is null returning id`, [r.id]);
            for (const a of gone) {
              const items = await q.query<{ id: string; user_id: string }>(`update inbox_items set resolved = true where approval_id = $1 returning id, user_id`, [a.id]);
              for (const item of items) await this.emitInbox(q, item.user_id, item.id);
            }
          }
          await this.updateStep(q, run, r.id, `status = 'superseded'`, []);
        }
        // Loops inside this one start over at round 1 next time round.
        const loops = { ...(run.loops ?? {}) };
        for (const inner of def.steps) if (inner.loop && inner.key !== step.key && body.has(inner.key)) delete loops[inner.key];
        loops[step.key] = { round: round + 1, previous: output };
        await q.query(`update runs set loops = $2::jsonb where id = $1`, [run.id, json(loops)]);
        await this.emitRun(q, run.id);
      });
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ helpers

  private async taskType(q: Queryable, actor: Actor, workspaceId: string, taskTypeId: string) {
    const [tt] = await q.query<{ id: string; key: string; name: string; input_fields: InputField[]; workflow: WorkflowDefinition }>(
      `select t.id, t.key, t.name, t.input_fields, t.workflow from task_types t join workspaces w on w.id = t.workspace_id
        where t.id = $1 and t.workspace_id = $2 and w.org_id = $3 and w.archived_at is null and t.archived_at is null`,
      [taskTypeId, workspaceId, actor.orgId],
    );
    if (!tt) throw notFound("Task type");
    return tt;
  }

  private async roles(q: Queryable, workspaceId: string): Promise<Map<string, RoleRow>> {
    const rows = await q.query<RoleRow>(`select key, name, instructions, connection_id, model, effort from roles where workspace_id = $1`, [workspaceId]);
    return new Map(rows.map((r) => [r.key, r]));
  }

  private async nextAttempt(q: Queryable, runId: string, key: string): Promise<number> {
    const [row] = await q.query<{ attempt: number }>(`select coalesce(max(attempt), 0) as attempt from run_steps where run_id = $1 and step_key = $2`, [runId, key]);
    return num(row?.attempt) + 1;
  }

  private async insertStep(
    q: Queryable,
    run: RunRow,
    step: Step,
    attempt: number,
    opts: { status: string; id?: string; output?: string; feedback?: string; retryAt?: Date; started?: boolean },
  ): Promise<string> {
    const id = opts.id ?? newId();
    const [row] = await q.query<StepRow>(
      `insert into run_steps (id, run_id, step_key, kind, attempt, status, output, feedback, retry_at, started_at, role_key, round)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${opts.started ? "now()" : "null"}, $10, $11) returning *`,
      [
        id,
        run.id,
        step.key,
        step.kind,
        attempt,
        opts.status,
        opts.output ?? null,
        opts.feedback ?? null,
        opts.retryAt?.toISOString() ?? null,
        "role" in step ? step.role : null,
        this.loopVars({ run, def: run.workflow }, step.key).loop?.index ?? 1,
      ],
    );
    await emit(q, this.runTopics(run), { type: "step.updated", runId: run.id, step: toStepDto(row!) });
    return id;
  }

  private async updateStep(q: Queryable, run: RunRow, stepId: string, set: string, params: unknown[]): Promise<void> {
    const [row] = await q.query<StepRow>(`update run_steps set ${set} where id = $1 returning *`, [stepId, ...params]);
    if (row) await emit(q, this.runTopics(run), { type: "step.updated", runId: run.id, step: toStepDto(row) });
  }

  private runTopics(run: Pick<RunRow, "id" | "workspace_id">): string[] {
    return [topics.workspaceRuns(run.workspace_id), topics.run(run.id)];
  }

  private async emitRun(q: Queryable, runId: string): Promise<void> {
    const summary = await loadRunSummary(q, runId);
    if (summary) await emit(q, [topics.workspaceRuns(summary.workspaceId), topics.run(runId)], { type: "run.updated", run: summary });
  }

  private async emitInbox(q: Queryable, userId: string, itemId: string): Promise<void> {
    const item = await loadInboxItem(q, itemId);
    if (item) await emit(q, [topics.inbox(userId)], { type: "inbox.updated", item });
  }

  private async notify(
    q: Queryable,
    run: RunRow,
    item: { kind: string; title: string; body: string; path: string; action: string | null; approvalId?: string; urgent?: boolean },
  ): Promise<void> {
    if (!run.created_by) return;
    const id = newId();
    // Delivery beyond the inbox (desktop, push, digest) is the Notifier's job, after commit.
    await q.query(
      `insert into inbox_items (id, org_id, user_id, workspace_id, run_id, approval_id, kind, title, body, path, action, urgent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, run.org_id, run.created_by, run.workspace_id, run.id, item.approvalId ?? null, item.kind, item.title, item.body, item.path, item.action, item.urgent ?? false],
    );
    await this.emitInbox(q, run.created_by, id);
  }

  private async resolveRunInbox(q: Queryable, runId: string): Promise<void> {
    const items = await q.query<{ id: string; user_id: string }>(
      `update inbox_items set resolved = true where run_id = $1 and resolved = false and kind in ('approval', 'budget') returning id, user_id`,
      [runId],
    );
    for (const item of items) await this.emitInbox(q, item.user_id, item.id);
  }

  /** "Workspace > Task > step", so a gate deep in a nest shows where it came from (SRS 5.3). */
  private async path(q: Queryable, run: RunRow, leaf: string): Promise<string> {
    const titles = [run.title];
    let top: Pick<RunRow, "workspace_id" | "parent_run_id"> = run;
    for (let i = 0; i < 20 && top.parent_run_id; i++) {
      const [parent] = await q.query<Pick<RunRow, "workspace_id" | "parent_run_id" | "title">>(`select workspace_id, parent_run_id, title from runs where id = $1`, [top.parent_run_id]);
      if (!parent) break;
      titles.unshift(parent.title);
      top = parent;
    }
    const [ws] = await q.query<{ name: string }>(`select name from workspaces where id = $1`, [top.workspace_id]);
    return [ws?.name, ...titles, leaf].filter(Boolean).join(" > ");
  }
}

/**
 * The AI router's prompt. The text to sort comes first, so the answer can be
 * checked against it; the model answers with one category key.
 */
function classifyPrompt(step: ClassifyStep, value: string): string {
  const options = step.categories.map((c) => `- ${c.key}: ${c.label}${c.description ? ` (${c.description})` : ""}`);
  if (step.other) options.push("- other: fits none of the above");
  return `${value}\n\n---\nSort the text above into exactly one of these categories:\n${options.join("\n")}\n\nAnswer with the category key only.`;
}

/** The category an answer names: its key or label, the earliest one mentioned. */
export function pickCategory(step: ClassifyStep, answer: string): string | null {
  const text = answer.toLowerCase();
  let best: { key: string; at: number } | null = null;
  for (const c of [...step.categories, ...(step.other ? [{ key: "other", label: "other" }] : [])]) {
    for (const name of [c.key, c.label.toLowerCase(), c.key.replace(/_/g, " ")]) {
      const at = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).exec(text)?.index;
      if (at !== undefined && (!best || at < best.at)) best = { key: c.key, at };
    }
  }
  // An answer that names nothing goes to "other" when there is one.
  return best?.key ?? (step.other ? "other" : null);
}

function labelOf(step: Step): string {
  return step.kind === "approval" ? step.title : step.key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
