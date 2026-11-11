import type { ChildRunDto, CostSource, InboxItemDto, InboxKind, RunDetailDto, RunStatus, RunSummaryDto, StepDto, StepStatus, WorkflowDefinition } from "@conclave/contract";
import { iso, num, type Queryable } from "@conclave/db";

export interface RunRow {
  id: string;
  org_id: string;
  workspace_id: string;
  task_type_id: string;
  root_run_id: string;
  parent_run_id: string | null;
  parent_step_id: string | null;
  iteration: number;
  depth: number;
  /** Loop state by the step that ends each loop (WF-010). */
  loops?: Record<string, { round: number; previous: string }>;
  /** Limits inherited from the workspaces above this task (SRS 4.12). */
  inherited?: { rules?: { effect: "allow" | "ask" | "deny"; connectionId: string; tool: string | null; source: string }[] } | null;
  title: string;
  brief: Record<string, string>;
  workflow: WorkflowDefinition;
  status: RunStatus;
  output: string | null;
  error: string | null;
  budget_usd: string | number;
  cost_usd: string | number;
  call_count: number;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface StepRow {
  id: string;
  run_id: string;
  step_key: string;
  kind: StepDto["kind"];
  attempt: number;
  status: StepStatus;
  role_key: string | null;
  connection_id: string | null;
  node_label: string | null;
  input: Record<string, unknown> | null;
  output: string | null;
  error: string | null;
  error_code: string | null;
  idempotency_key?: string | null;
  feedback: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string | number;
  cost_source: CostSource | null;
  latency_ms: number | null;
  retry_at: Date | null;
  round?: number;
  policy?: { effect: "allow" | "ask" | "deny"; allowed: boolean; source: string | null; reason: string } | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface InboxRow {
  id: string;
  kind: InboxKind;
  workspace_id: string | null;
  workspace_name?: string | null;
  run_id: string | null;
  approval_id: string | null;
  title: string;
  body: string;
  path: string;
  action: InboxItemDto["action"];
  resolved: boolean;
  urgent?: boolean;
  read_at: Date | null;
  created_at: Date;
}

export function toStepDto(row: StepRow): StepDto {
  return {
    id: row.id,
    key: row.step_key,
    kind: row.kind,
    attempt: row.attempt,
    status: row.status,
    nodeLabel: row.node_label,
    output: row.output,
    error: row.error,
    inputTokens: row.tokens_in,
    outputTokens: row.tokens_out,
    costUsd: num(row.cost_usd),
    costSource: row.cost_source,
    latencyMs: row.latency_ms,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    round: row.round ?? 1,
    ...externalFields(row),
  };
}

/** What agent and automation steps show while they wait (SRS 4.11). */
function externalFields(row: StepRow): Pick<StepDto, "progress" | "question" | "externalId"> {
  if ((row.kind !== "agent" && row.kind !== "automation") || !row.input) return {};
  const input = row.input as {
    progress?: string[];
    asking?: string;
    question?: string;
    handle?: { externalRunId?: string };
    execution?: { executionId?: string };
  };
  const externalId = input.handle?.externalRunId ?? input.execution?.executionId;
  return {
    ...(input.progress?.length ? { progress: input.progress } : {}),
    ...(input.asking && input.question && row.status === "waiting" ? { question: { approvalId: input.asking, prompt: input.question } } : {}),
    ...(externalId ? { externalId: String(externalId) } : {}),
  };
}

type RunListRow = RunRow & { task_type_name: string; workspace_name: string; steps_done: string | number; current_step: string | null };

export function toRunSummary(row: RunListRow): RunSummaryDto {
  return {
    workspaceName: row.workspace_name,
    stepsTotal: row.workflow.steps.length,
    stepsDone: num(row.steps_done),
    currentStep: row.current_step,
    id: row.id,
    workspaceId: row.workspace_id,
    taskTypeId: row.task_type_id,
    taskTypeName: row.task_type_name,
    title: row.title,
    status: row.status,
    costUsd: num(row.cost_usd),
    budgetUsd: num(row.budget_usd),
    createdAt: iso(row.created_at)!,
    finishedAt: iso(row.finished_at),
    error: row.error,
  };
}

export function toInboxDto(row: InboxRow): InboxItemDto {
  return {
    id: row.id,
    kind: row.kind,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name ?? null,
    runId: row.run_id,
    approvalId: row.approval_id,
    title: row.title,
    body: row.body,
    path: row.path,
    action: row.action,
    resolved: row.resolved,
    urgent: row.urgent ?? false,
    readAt: iso(row.read_at),
    createdAt: iso(row.created_at)!,
  };
}

const RUN_SELECT = `select r.*, t.name as task_type_name, w.name as workspace_name,
  (select count(distinct s.step_key) from run_steps s where s.run_id = r.id and s.status in ('succeeded', 'skipped', 'not_taken')
     and not exists (select 1 from run_steps n where n.run_id = r.id and n.step_key = s.step_key and n.attempt > s.attempt and n.status <> 'superseded')) as steps_done,
  (select s.step_key from run_steps s where s.run_id = r.id and s.status in ('running', 'waiting') order by s.created_at desc limit 1) as current_step
  from runs r join task_types t on t.id = r.task_type_id join workspaces w on w.id = r.workspace_id`;

export async function loadRunSummary(q: Queryable, runId: string): Promise<RunSummaryDto | null> {
  const [row] = await q.query<RunListRow>(`${RUN_SELECT} where r.id = $1`, [runId]);
  return row ? toRunSummary(row) : null;
}

/** Runs that are queued, running or waiting, across the org (Home "Running now" and "Needs you"). */
export async function listActiveRuns(q: Queryable, orgId: string, userId: string): Promise<RunSummaryDto[]> {
  const rows = await q.query<RunListRow>(
    `${RUN_SELECT} where r.org_id = $1 and r.status in ('queued', 'running', 'waiting') and r.parent_run_id is null
       and (not w.private or w.created_by = $2) order by r.created_at desc limit 50`,
    [orgId, userId],
  );
  return rows.map(toRunSummary);
}

export async function loadRunDetail(q: Queryable, orgId: string, runId: string): Promise<RunDetailDto | null> {
  const [row] = await q.query<RunListRow>(`${RUN_SELECT} where r.id = $1 and r.org_id = $2`, [runId, orgId]);
  if (!row) return null;
  const steps = await q.query<StepRow>(`select * from run_steps where run_id = $1 order by created_at, attempt`, [runId]);
  const children = await q.query<{ id: string; workspace_id: string; workspace_name: string; title: string; status: RunStatus; iteration: number; cost_usd: string; parent_step_id: string }>(
    `select c.id, c.workspace_id, w.name as workspace_name, c.title, c.status, c.iteration, c.cost_usd, c.parent_step_id
       from runs c join workspaces w on w.id = c.workspace_id where c.parent_run_id = $1 order by c.iteration, c.created_at`,
    [runId],
  );
  const byStep = new Map<string, ChildRunDto[]>();
  for (const c of children) {
    const list = byStep.get(c.parent_step_id) ?? [];
    list.push({ id: c.id, workspaceId: c.workspace_id, workspaceName: c.workspace_name, title: c.title, status: c.status, iteration: num(c.iteration), costUsd: num(c.cost_usd) });
    byStep.set(c.parent_step_id, list);
  }
  let parent: RunDetailDto["parent"] = null;
  if (row.parent_run_id) {
    const [p] = await q.query<{ id: string; workspace_id: string; title: string; step_key: string | null }>(
      `select r.id, r.workspace_id, r.title, (select s.step_key from run_steps s where s.id = $2) as step_key from runs r where r.id = $1`,
      [row.parent_run_id, row.parent_step_id],
    );
    if (p) parent = { id: p.id, workspaceId: p.workspace_id, title: p.title, stepKey: p.step_key ?? "" };
  }
  return {
    ...toRunSummary(row),
    brief: row.brief,
    output: row.output,
    steps: steps.map((s) => ({ ...toStepDto(s), ...(byStep.has(s.id) ? { children: byStep.get(s.id)! } : {}) })),
    parent,
    depth: num(row.depth),
  };
}

export async function listRuns(q: Queryable, orgId: string, workspaceId: string, limit = 50): Promise<RunSummaryDto[]> {
  const rows = await q.query<RunListRow>(
    `${RUN_SELECT} where r.org_id = $1 and r.workspace_id = $2 and r.parent_run_id is null order by r.created_at desc limit $3`,
    [orgId, workspaceId, limit],
  );
  return rows.map(toRunSummary);
}

export async function loadInboxItem(q: Queryable, id: string): Promise<InboxItemDto | null> {
  const [row] = await q.query<InboxRow>(
    `select i.*, w.name as workspace_name from inbox_items i left join workspaces w on w.id = i.workspace_id where i.id = $1`,
    [id],
  );
  return row ? toInboxDto(row) : null;
}
