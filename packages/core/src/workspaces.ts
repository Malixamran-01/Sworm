import {
  newId,
  portForStep,
  resolveNeeds,
  taskTypeTemplateSchema,
  upstreamOf,
  type CallTargetDto,
  type Effort,
  type InputField,
  type RoleInput,
  type Step,
  type TaskTypeInput,
  type RoleDto,
  type TaskTypeDto,
  type TemplateDto,
  type WorkflowDefinition,
  type WorkspaceDetailDto,
  type WorkspaceDto,
  type WorkspaceTemplate,
  workspaceTemplateSchema,
} from "@conclave/contract";
import { iso, json, num, type Db, type Queryable } from "@conclave/db";
import { audit } from "./connections";
import { conflict, invalid, notFound, type Actor } from "./errors";
import { referencedSteps } from "./render";
import { blankWorkspace, composeWorkspace, type BuilderAnswers } from "./builder";
import { builtInTemplates, findTemplate } from "./templates";

interface WorkspaceRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  template_key: string | null;
  budget_task_usd: string | number;
  budget_month_usd: string | number;
  version: number;
  created_at: Date;
  private?: boolean;
}

interface RoleRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  description: string;
  instructions: string;
  port: string;
  connection_id: string | null;
  model: string | null;
  effort: string | null;
}

interface TaskTypeRow {
  id: string;
  workspace_id: string;
  key: string;
  name: string;
  description: string;
  input_fields: InputField[];
  workflow: WorkflowDefinition;
}

export interface RoleAssignment {
  connectionId: string | null;
  model: string | null;
  effort?: Effort | null;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** First day of the current month in UTC, for monthly budgets and stats. */
export const monthStart = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

export class Workspaces {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  templates(): TemplateDto[] {
    return builtInTemplates.map(toTemplateDto);
  }

  /** What the guided builder would create for these answers, without creating it (WS-001 preview). */
  compose(answers: BuilderAnswers): TemplateDto {
    return toTemplateDto(composeWorkspace(answers));
  }

  async list(actor: Actor): Promise<WorkspaceDto[]> {
    const rows = await this.db.query<WorkspaceRow & { month_spend: string | number } & RunCounts>(
      `select w.*, coalesce((select sum(cost_usd) from usage_ledger u where u.workspace_id = w.id and u.at >= $2), 0) as month_spend, ${RUN_COUNTS}
         from workspaces w where w.org_id = $1 and w.archived_at is null and (not w.private or w.created_by = $3) order by w.created_at`,
      [actor.orgId, monthStart(), actor.userId],
    );
    return rows.map((r) => toWorkspaceDto(r, num(r.month_spend)));
  }

  async get(actor: Actor, id: string): Promise<WorkspaceDetailDto> {
    const ws = await this.row(this.db, actor, id);
    const since = monthStart();
    const [spend] = await this.db.query<{ total: string | number }>(
      `select coalesce(sum(cost_usd), 0) as total from usage_ledger where workspace_id = $1 and at >= $2`,
      [id, since],
    );
    const roles = await this.db.query<RoleRow & { spend: string | number; runs: string | number; failures: string | number }>(
      `select r.*,
              coalesce((select sum(u.cost_usd) from usage_ledger u where u.workspace_id = r.workspace_id and u.role_key = r.key and u.at >= $2), 0) as spend,
              (select count(*) from run_steps s join runs x on x.id = s.run_id
                 where x.workspace_id = r.workspace_id and s.role_key = r.key and s.status in ('succeeded', 'failed') and s.created_at >= $2) as runs,
              (select count(*) from run_steps s join runs x on x.id = s.run_id
                 where x.workspace_id = r.workspace_id and s.role_key = r.key and s.status = 'failed' and s.created_at >= $2) as failures
         from roles r where r.workspace_id = $1 order by r.name`,
      [id, since],
    );
    const taskTypes = await this.db.query<TaskTypeRow>(`select * from task_types where workspace_id = $1 and archived_at is null order by name`, [id]);
    return {
      ...toWorkspaceDto(ws, num(spend?.total)),
      roles: roles.map((r) => toRoleDto(r, num(r.spend), num(r.runs), num(r.failures))),
      taskTypes: taskTypes.map(toTaskTypeDto),
    };
  }

  async row(q: Queryable, actor: Actor, id: string): Promise<WorkspaceRow & RunCounts> {
    const rows = await q.query<WorkspaceRow & RunCounts>(
      `select w.*, ${RUN_COUNTS} from workspaces w where w.id = $1 and w.org_id = $2 and w.archived_at is null and (not w.private or w.created_by = $3)`,
      [id, actor.orgId, actor.userId],
    );
    const row = rows[0];
    if (!row) throw notFound("Workspace");
    return row;
  }

  /**
   * Create a workspace (WS-001, WS-005) from one of: a built-in template key, the
   * guided builder's answers, "blank", or an exported package. Roles start unfilled
   * unless a default node is given.
   */
  async create(
    actor: Actor,
    input: {
      templateKey?: string;
      answers?: BuilderAnswers;
      blank?: boolean;
      package?: unknown;
      name?: string;
      defaultNode?: RoleAssignment;
      private?: boolean;
    },
  ): Promise<WorkspaceDetailDto> {
    const sources = [input.templateKey, input.answers, input.blank || undefined, input.package].filter((x) => x !== undefined);
    if (sources.length !== 1) throw invalid(["Choose exactly one way to start: a template, the guided builder, blank, or a package."]);
    let template: WorkspaceTemplate;
    if (input.templateKey) {
      const found = findTemplate(input.templateKey);
      if (!found) throw invalid([`Unknown template "${input.templateKey}".`]);
      template = found;
    } else if (input.answers) {
      template = composeWorkspace(input.answers);
    } else if (input.blank) {
      template = blankWorkspace();
    } else {
      const parsed = workspaceTemplateSchema.safeParse(input.package);
      if (!parsed.success) {
        throw invalid(parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "package"}: ${i.message}`), "This is not a valid workspace package");
      }
      template = parsed.data;
    }
    return this.createFromTemplateObject(actor, template, input);
  }

  /** Create from a built-in template key. */
  createFromTemplate(actor: Actor, input: { templateKey: string; name?: string; defaultNode?: RoleAssignment; private?: boolean }): Promise<WorkspaceDetailDto> {
    return this.create(actor, input);
  }

  private async createFromTemplateObject(
    actor: Actor,
    template: WorkspaceTemplate,
    input: { name?: string; defaultNode?: RoleAssignment; private?: boolean },
  ): Promise<WorkspaceDetailDto> {
    // Every step's role must exist, so a package cannot smuggle in a workflow nobody can fill.
    const roleKeys = new Set(template.roles.map((r) => r.key));
    const missing = template.taskTypes.flatMap((tt) =>
      tt.workflow.steps.flatMap((s) => ("role" in s && !roleKeys.has(s.role) ? [`${tt.name} → ${s.key} calls role "${s.role}"`] : [])),
    );
    if (missing.length) throw invalid(missing.map((m) => `${m}, which the package does not define.`));
    // Calls to other workspaces only work inside the organisation they were made in.
    const keys = new Set(template.taskTypes.map((t) => t.key));
    const calls = template.taskTypes.flatMap((tt) => tt.workflow.steps.flatMap((s) => (s.kind === "workspace" ? [{ tt, s }] : [])));
    const problems: string[] = [];
    for (const { tt, s } of calls) {
      if (s.workspace === "self") {
        if (!keys.has(s.taskType)) problems.push(`${tt.name} → ${s.key} calls task type "${s.taskType}", which the package does not define.`);
        continue;
      }
      const [found] = await this.db.query(`select 1 from task_types t join workspaces w on w.id = t.workspace_id where w.id = $1 and w.org_id = $2 and t.key = $3 and t.archived_at is null and w.archived_at is null`, [
        s.workspace,
        actor.orgId,
        s.taskType,
      ]);
      if (!found) problems.push(`${tt.name} → ${s.key} calls a workspace that is not in this organisation. Point it at one of yours after importing, or edit the package.`);
    }
    if (problems.length) throw invalid(problems);
    if (input.defaultNode?.connectionId) await this.assertConnection(this.db, actor, input.defaultNode.connectionId);
    const id = newId();
    await this.db.tx(async (q) => {
      await q.query(
        `insert into workspaces (id, org_id, name, description, template_key, budget_task_usd, budget_month_usd, created_by, private)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          actor.orgId,
          input.name?.trim() || template.name,
          template.description,
          template.key,
          template.budget.taskUsd,
          template.budget.monthUsd,
          actor.userId,
          input.private ?? false,
        ],
      );
      for (const role of template.roles) {
        // The default node is a model, so it only fills roles on the Model port.
        const node = role.port === "model@1" ? input.defaultNode : undefined;
        await q.query(
          `insert into roles (id, workspace_id, key, name, description, instructions, port, connection_id, model, effort)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            newId(),
            id,
            role.key,
            role.name,
            role.description,
            role.instructions,
            role.port,
            node?.connectionId ?? null,
            node?.model ?? null,
            node?.effort ?? role.effort ?? null,
          ],
        );
      }
      for (const tt of template.taskTypes) {
        await q.query(
          `insert into task_types (id, workspace_id, key, name, description, input_fields, workflow)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [newId(), id, tt.key, tt.name, tt.description, json(tt.inputFields), json(tt.workflow)],
        );
      }
      await this.snapshot(q, actor, id, 1);
      await audit(q, actor, "workspace.created", id, { template: template.key });
    });
    return this.get(actor, id);
  }

  /** Point a role at a node. Workflows are untouched (ROLE-003); the workspace gets a new version. */
  async assignRole(actor: Actor, workspaceId: string, roleKey: string, assignment: RoleAssignment): Promise<WorkspaceDetailDto> {
    if (assignment.effort && !EFFORTS.has(assignment.effort)) throw invalid([`Unknown effort "${assignment.effort}".`]);
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      if (assignment.connectionId) await this.assertConnection(q, actor, assignment.connectionId);
      const updated = await q.query(
        `update roles set connection_id = $3, model = $4, effort = coalesce($5, effort) where workspace_id = $1 and key = $2 returning id`,
        [workspaceId, roleKey, assignment.connectionId, assignment.model, assignment.effort ?? null],
      );
      if (updated.length === 0) throw notFound("Role");
      const [ws] = await q.query<{ version: number }>(`update workspaces set version = version + 1 where id = $1 returning version`, [workspaceId]);
      await this.snapshot(q, actor, workspaceId, ws!.version);
      await audit(q, actor, "role.assigned", workspaceId, { role: roleKey, connection: assignment.connectionId });
    });
    return this.get(actor, workspaceId);
  }

  async updateBudget(actor: Actor, workspaceId: string, budget: { taskUsd?: number; monthUsd?: number }): Promise<WorkspaceDetailDto> {
    const errors: string[] = [];
    if (budget.taskUsd !== undefined && !(budget.taskUsd > 0)) errors.push("The per-task budget must be above zero.");
    if (budget.monthUsd !== undefined && !(budget.monthUsd > 0)) errors.push("The monthly budget must be above zero.");
    if (errors.length) throw invalid(errors);
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      await q.query(
        `update workspaces set budget_task_usd = coalesce($2, budget_task_usd), budget_month_usd = coalesce($3, budget_month_usd),
                version = version + 1 where id = $1`,
        [workspaceId, budget.taskUsd ?? null, budget.monthUsd ?? null],
      );
      const [ws] = await q.query<{ version: number }>(`select version from workspaces where id = $1`, [workspaceId]);
      await this.snapshot(q, actor, workspaceId, ws!.version);
    });
    return this.get(actor, workspaceId);
  }

  /** Portable package with no secrets or node choices (WS-005). Importing it gives the same roles and task types. */
  async exportPackage(actor: Actor, workspaceId: string): Promise<WorkspaceTemplate> {
    const ws = await this.get(actor, workspaceId);
    const rows = await this.db.query<TaskTypeRow>(`select * from task_types where workspace_id = $1 and archived_at is null order by name`, [workspaceId]);
    await audit(this.db, actor, "workspace.exported", workspaceId, {});
    return workspaceTemplateSchema.parse({
      key: ws.templateKey ?? "custom",
      name: ws.name,
      description: ws.description,
      budget: { taskUsd: ws.budgetTaskUsd, monthUsd: ws.budgetMonthUsd },
      roles: ws.roles.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        instructions: r.instructions,
        port: r.port,
        ...(r.effort ? { effort: r.effort as Effort } : {}),
      })),
      taskTypes: rows.map((t) => ({
        key: t.key,
        name: t.name,
        description: t.description,
        inputFields: t.input_fields,
        workflow: t.workflow,
      })),
    });
  }

  // ------------------------------------------------ editing (WF-007, WF-008)

  /** Workspaces and task types the caller may point a workspace step at. */
  async callTargets(actor: Actor): Promise<CallTargetDto[]> {
    const rows = await this.db.query<{ workspace_id: string; workspace_name: string } & TaskTypeRow>(
      `select w.id as workspace_id, w.name as workspace_name, t.* from task_types t join workspaces w on w.id = t.workspace_id
        where w.org_id = $1 and w.archived_at is null and t.archived_at is null and (not w.private or w.created_by = $2)
        order by w.created_at, t.name`,
      [actor.orgId, actor.userId],
    );
    const out = new Map<string, CallTargetDto>();
    for (const r of rows) {
      const target = out.get(r.workspace_id) ?? { workspaceId: r.workspace_id, workspaceName: r.workspace_name, taskTypes: [] };
      target.taskTypes.push({
        key: r.key,
        name: r.name,
        description: r.description,
        inputFields: r.input_fields,
        steps: r.workflow.steps.map((s) => ({ key: s.key, kind: s.kind, label: stepName(s) })),
      });
      out.set(r.workspace_id, target);
    }
    return [...out.values()];
  }

  /**
   * Create a task type, or replace one (by its current key), from the editor.
   * The workspace gets a new version; tasks already running keep the
   * workflow they started with.
   */
  async saveTaskType(actor: Actor, workspaceId: string, currentKey: string | null, input: TaskTypeInput): Promise<WorkspaceDetailDto> {
    const parsed = taskTypeTemplateSchema.safeParse({ ...input, description: input.description ?? "" });
    if (!parsed.success) {
      throw invalid(parsed.error.issues.slice(0, 12).map((i) => `${i.path.join(".") || "task type"}: ${i.message}`), "This workflow cannot be saved yet");
    }
    const tt = parsed.data;
    // Positions only for steps that exist, so a stale layout never grows.
    const layout = tt.workflow.layout
      ? Object.fromEntries(Object.entries(tt.workflow.layout).filter(([k]) => k === "_brief" || tt.workflow.steps.some((s) => s.key === k)))
      : undefined;
    const workflow = { ...tt.workflow, ...(layout ? { layout } : {}) };
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      const problems = await this.checkWorkflow(q, actor, workspaceId, tt.key, tt.inputFields, workflow);
      if (problems.length) throw invalid(problems, "This workflow cannot be saved yet");
      const [clash] = await q.query<{ key: string }>(`select key from task_types where workspace_id = $1 and key = $2 and archived_at is null`, [workspaceId, tt.key]);
      if (currentKey === null) {
        if (clash) throw conflict(`This workspace already has a task type with the key "${tt.key}".`);
        await q.query(
          `insert into task_types (id, workspace_id, key, name, description, input_fields, workflow) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [newId(), workspaceId, tt.key, tt.name, tt.description, json(tt.inputFields), json(workflow)],
        );
      } else {
        if (clash && tt.key !== currentKey) throw conflict(`This workspace already has a task type with the key "${tt.key}".`);
        const updated = await q.query(
          `update task_types set key = $3, name = $4, description = $5, input_fields = $6::jsonb, workflow = $7::jsonb
            where workspace_id = $1 and key = $2 and archived_at is null returning id`,
          [workspaceId, currentKey, tt.key, tt.name, tt.description, json(tt.inputFields), json(workflow)],
        );
        if (updated.length === 0) throw notFound("Task type");
      }
      await this.bump(q, actor, workspaceId);
      await audit(q, actor, currentKey ? "task_type.updated" : "task_type.created", workspaceId, { key: tt.key });
    });
    return this.get(actor, workspaceId);
  }

  /** Remove a task type. One that past tasks ran is archived instead, so their history stays readable. */
  async deleteTaskType(actor: Actor, workspaceId: string, key: string): Promise<WorkspaceDetailDto> {
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      const live = await q.query<{ id: string; key: string }>(`select id, key from task_types where workspace_id = $1 and archived_at is null`, [workspaceId]);
      const tt = live.find((t) => t.key === key);
      if (!tt) throw notFound("Task type");
      if (live.length === 1) throw invalid(["A workspace needs at least one task type."]);
      const callers = await this.callersOf(q, actor, workspaceId, key);
      if (callers.length) throw invalid([`${callers.join(", ")} ${callers.length === 1 ? "runs" : "run"} this task type. Change ${callers.length === 1 ? "that step" : "those steps"} first.`]);
      const [used] = await q.query(`select 1 from runs where task_type_id = $1 limit 1`, [tt.id]);
      if (used) await q.query(`update task_types set archived_at = now(), key = key || '~' || substr(id::text, 1, 8) where id = $1`, [tt.id]);
      else await q.query(`delete from task_types where id = $1`, [tt.id]);
      await this.bump(q, actor, workspaceId);
      await audit(q, actor, "task_type.deleted", workspaceId, { key });
    });
    return this.get(actor, workspaceId);
  }

  /** Add a role from the editor. It starts unfilled; fill it in Team or right in the editor. */
  async createRole(actor: Actor, workspaceId: string, input: RoleInput): Promise<WorkspaceDetailDto> {
    const name = input.name?.trim();
    if (!name) throw invalid(["A role needs a name."]);
    if (!(input.port in PORT_WORDS)) throw invalid([`Unknown port "${String(input.port)}".`]);
    const key = input.key?.trim() || slug(name, "role");
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw invalid(["Role keys are lowercase letters, digits and underscores, starting with a letter."]);
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      const [clash] = await q.query(`select 1 from roles where workspace_id = $1 and key = $2`, [workspaceId, key]);
      if (clash) throw conflict(`This workspace already has a role with the key "${key}".`);
      await q.query(`insert into roles (id, workspace_id, key, name, description, instructions, port) values ($1, $2, $3, $4, $5, $6, $7)`, [
        newId(),
        workspaceId,
        key,
        name.slice(0, 120),
        input.description?.trim() ?? "",
        input.instructions?.trim() ?? "",
        input.port,
      ]);
      await this.bump(q, actor, workspaceId);
      await audit(q, actor, "role.created", workspaceId, { role: key });
    });
    return this.get(actor, workspaceId);
  }

  /** Rename a role or change its instructions. Workflows refer to the key, which stays. */
  async updateRole(actor: Actor, workspaceId: string, key: string, input: { name?: string; description?: string; instructions?: string }): Promise<WorkspaceDetailDto> {
    if (input.name !== undefined && !input.name.trim()) throw invalid(["A role needs a name."]);
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      const updated = await q.query(
        `update roles set name = coalesce($3, name), description = coalesce($4, description), instructions = coalesce($5, instructions)
          where workspace_id = $1 and key = $2 returning id`,
        [workspaceId, key, input.name?.trim().slice(0, 120) ?? null, input.description ?? null, input.instructions ?? null],
      );
      if (updated.length === 0) throw notFound("Role");
      await this.bump(q, actor, workspaceId);
      await audit(q, actor, "role.updated", workspaceId, { role: key });
    });
    return this.get(actor, workspaceId);
  }

  /** Remove a role no workflow uses. */
  async deleteRole(actor: Actor, workspaceId: string, key: string): Promise<WorkspaceDetailDto> {
    await this.db.tx(async (q) => {
      await this.row(q, actor, workspaceId);
      const tts = await q.query<TaskTypeRow>(`select name, workflow from task_types where workspace_id = $1 and archived_at is null`, [workspaceId]);
      const users = tts.filter((t) => t.workflow.steps.some((s) => "role" in s && s.role === key)).map((t) => t.name);
      if (users.length) throw invalid([`${users.join(", ")} still ${users.length === 1 ? "uses" : "use"} this role.`]);
      const deleted = await q.query(`delete from roles where workspace_id = $1 and key = $2 returning id`, [workspaceId, key]);
      if (deleted.length === 0) throw notFound("Role");
      await this.bump(q, actor, workspaceId);
      await audit(q, actor, "role.deleted", workspaceId, { role: key });
    });
    return this.get(actor, workspaceId);
  }

  /**
   * Everything a saved workflow refers to must exist: roles on the right
   * port, inputs, earlier steps, and the workspaces and task types it calls.
   * A step that runs its own workflow must stop before reaching itself.
   */
  private async checkWorkflow(
    q: Queryable,
    actor: Actor,
    workspaceId: string,
    key: string,
    inputFields: InputField[],
    workflow: WorkflowDefinition,
  ): Promise<string[]> {
    const problems: string[] = [];
    const roles = new Map((await q.query<{ key: string; name: string; port: string }>(`select key, name, port from roles where workspace_id = $1`, [workspaceId])).map((r) => [r.key, r]));
    const fields = new Set(inputFields.map((f) => f.key));
    const needs = resolveNeeds(workflow);
    const known = new Set(workflow.steps.map((s) => s.key));

    for (const step of workflow.steps) {
      const name = stepName(step);
      const port = portForStep(step);
      if (port && "role" in step) {
        const role = roles.get(step.role);
        if (!role) problems.push(`${name} calls role "${step.role}", which this workspace does not have.`);
        else if (role.port !== port) problems.push(`${name} is ${PORT_WORDS[port]} step, but ${role.name} is filled by ${PORT_WORDS[role.port as keyof typeof PORT_WORDS] ?? role.port}.`);
      }
      // Templates may read the brief and steps that finish before this one.
      const before = new Set([...upstreamOf(workflow, step.key)].filter((k) => k !== step.key));
      for (const t of templatesOf(step)) {
        for (const ref of new Set(referencedSteps(t))) {
          if (!known.has(ref)) problems.push(`${name} uses the output of "${ref}", which is not a step.`);
          else if (!before.has(ref)) problems.push(`${name} uses the output of "${ref}", which does not run before it. Connect ${ref} to ${step.key}.`);
        }
        for (const m of t.matchAll(/\{\{\s*input\.([a-z0-9_]+)/gi)) if (!fields.has(m[1]!)) problems.push(`${name} uses input "${m[1]}", which the brief does not have.`);
      }
      if (step.kind === "approval") {
        for (const r of step.revises) if (!before.has(r)) problems.push(`${name} sends changes back to "${r}", which does not run before it.`);
      }
      if (step.kind !== "workspace") continue;

      // The called task type: this workflow itself when it calls its own key here.
      const self = step.workspace === "self" || step.workspace === workspaceId;
      let target: { name: string; inputFields: InputField[]; workflow: WorkflowDefinition } | undefined;
      if (self && step.taskType === key) target = { name: "this workflow", inputFields, workflow };
      else {
        const targetWs = self ? workspaceId : step.workspace;
        try {
          if (!self) await this.row(q, actor, targetWs);
          const [row] = await q.query<TaskTypeRow>(`select name, input_fields, workflow from task_types where workspace_id = $1 and key = $2 and archived_at is null`, [targetWs, step.taskType]);
          if (row) target = { name: row.name, inputFields: row.input_fields, workflow: row.workflow };
          else problems.push(`${name} runs task type "${step.taskType}", which ${self ? "this workspace" : "that workspace"} does not have.`);
        } catch {
          problems.push(`${name} runs a task in a workspace you cannot see, or one that no longer exists.`);
        }
      }
      if (!target) continue;
      const targetFields = new Set(target.inputFields.map((f) => f.key));
      for (const f of target.inputFields) if (f.required && !step.inputs[f.key]?.trim()) problems.push(`${name}: fill in "${f.label}" for ${target.name}.`);
      for (const k of Object.keys(step.inputs)) if (!targetFields.has(k)) problems.push(`${name}: ${target.name} has no input "${k}".`);
      if (step.until && !target.workflow.steps.some((s) => s.key === step.until)) problems.push(`${name} runs ${target.name} up to "${step.until}", which is not one of its steps.`);
      if (self && step.taskType === key) {
        const reached = step.until ? upstreamOf(workflow, step.until) : known;
        if (reached.has(step.key)) {
          problems.push(`${name} runs this same workflow and would reach itself again, with no end. Set "Run up to" to a step that comes before it.`);
        }
      }
    }
    if (workflow.output && !needs.has(workflow.output)) problems.push(`The result step "${workflow.output}" is not a step.`);
    return [...new Set(problems)];
  }

  /** Steps anywhere in the organisation that run this task type, as "Workspace › Task type › step". */
  private async callersOf(q: Queryable, actor: Actor, workspaceId: string, key: string): Promise<string[]> {
    const rows = await q.query<{ workspace_id: string; workspace_name: string; name: string; key: string; workflow: WorkflowDefinition }>(
      `select w.id as workspace_id, w.name as workspace_name, t.name, t.key, t.workflow from task_types t join workspaces w on w.id = t.workspace_id
        where w.org_id = $1 and w.archived_at is null and t.archived_at is null`,
      [actor.orgId],
    );
    const out: string[] = [];
    for (const r of rows) {
      if (r.workspace_id === workspaceId && r.key === key) continue;
      for (const s of r.workflow.steps) {
        if (s.kind !== "workspace" || s.taskType !== key) continue;
        const target = s.workspace === "self" ? r.workspace_id : s.workspace;
        if (target === workspaceId) out.push(`${r.workspace_name} › ${r.name} › ${s.key}`);
      }
    }
    return out;
  }

  private async bump(q: Queryable, actor: Actor, workspaceId: string): Promise<void> {
    const [ws] = await q.query<{ version: number }>(`update workspaces set version = version + 1 where id = $1 returning version`, [workspaceId]);
    await this.snapshot(q, actor, workspaceId, ws!.version);
  }

  private async assertConnection(q: Queryable, actor: Actor, connectionId: string) {
    const rows = await q.query(`select id from connections where id = $1 and org_id = $2`, [connectionId, actor.orgId]);
    if (rows.length === 0) throw invalid(["That connection does not exist."]);
  }

  private async snapshot(q: Queryable, actor: Actor, workspaceId: string, version: number) {
    const roles = await q.query<RoleRow>(`select key, name, instructions, port, connection_id, model, effort from roles where workspace_id = $1 order by key`, [workspaceId]);
    const taskTypes = await q.query<TaskTypeRow>(`select key, name, input_fields, workflow from task_types where workspace_id = $1 and archived_at is null order by key`, [workspaceId]);
    const [ws] = await q.query<WorkspaceRow>(`select budget_task_usd, budget_month_usd from workspaces where id = $1`, [workspaceId]);
    await q.query(
      `insert into workspace_versions (id, workspace_id, version, manifest, created_by) values ($1, $2, $3, $4::jsonb, $5)
       on conflict (workspace_id, version) do nothing`,
      [newId(), workspaceId, version, json({ roles, taskTypes, budget: { task: num(ws?.budget_task_usd), month: num(ws?.budget_month_usd) } }), actor.userId],
    );
  }
}

interface RunCounts {
  waiting_tasks?: string | number;
  running_tasks?: string | number;
}

const RUN_COUNTS = `(select count(*) from runs r where r.workspace_id = w.id and r.status = 'waiting') as waiting_tasks,
  (select count(*) from runs r where r.workspace_id = w.id and r.status in ('queued', 'running')) as running_tasks`;

export function toTemplateDto(t: WorkspaceTemplate): TemplateDto {
  return {
    key: t.key,
    name: t.name,
    description: t.description,
    roles: t.roles.map((r) => ({ key: r.key, name: r.name, description: r.description, port: r.port })),
    taskTypes: t.taskTypes.map((tt) => ({
      key: tt.key,
      name: tt.name,
      steps: tt.workflow.steps.map((s) => ({
        key: s.key,
        kind: s.kind,
        label:
          s.kind === "approval"
            ? s.title
            : s.kind === "workspace"
              ? `Runs ${s.workspace === "self" ? (t.taskTypes.find((x) => x.key === s.taskType)?.name ?? s.taskType) : `"${s.taskType}" in another workspace`}${s.until ? ` up to ${s.until}` : ""}`
              : "role" in s
                ? `${t.roles.find((r) => r.key === s.role)?.name ?? s.role}: ${s.key.replace(/_/g, " ")}${s.optional ? " (optional)" : ""}`
                : `${s.key.replace(/_/g, " ")} (${s.kind === "branch" ? "if / switch" : s.kind})`,
      })),
    })),
    budget: t.budget,
  };
}

function toWorkspaceDto(row: WorkspaceRow & RunCounts, monthSpend: number): WorkspaceDto {
  return {
    private: !!row.private,
    waitingTasks: num(row.waiting_tasks),
    runningTasks: num(row.running_tasks),
    id: row.id,
    name: row.name,
    description: row.description,
    templateKey: row.template_key,
    budgetTaskUsd: num(row.budget_task_usd),
    budgetMonthUsd: num(row.budget_month_usd),
    monthSpendUsd: monthSpend,
    version: row.version,
    createdAt: iso(row.created_at)!,
  };
}

function toRoleDto(row: RoleRow, spend: number, runs: number, failures: number): RoleDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    port: row.port as RoleDto["port"],
    connectionId: row.connection_id,
    model: row.model,
    effort: row.effort,
    monthSpendUsd: spend,
    monthRuns: runs,
    monthFailures: failures,
  };
}

function toTaskTypeDto(row: TaskTypeRow): TaskTypeDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    inputFields: row.input_fields,
    steps: row.workflow.steps,
    workflow: row.workflow,
  };
}

const slug = (name: string, fallback: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "r_$1")
    .slice(0, 40) || fallback;

const PORT_WORDS = { "model@1": "a model", "tool@1": "a tool", "agent@1": "an agent", "workflow@1": "an outside workflow", "knowledge@1": "a knowledge source" } as const;

const stepName = (s: Step) => (s.kind === "approval" ? s.title : s.key.replace(/_/g, " "));

/** Templates a step reads, for checking what it refers to. */
function templatesOf(s: Step): string[] {
  switch (s.kind) {
    case "role":
      return [s.prompt];
    case "approval":
      return [s.show];
    case "tool":
      return Object.values(s.args);
    case "lookup":
      return [s.query];
    case "agent":
      return [s.prompt, ...Object.values(s.data)];
    case "automation":
      return Object.values(s.inputs);
    case "workspace":
      return [...Object.values(s.inputs), ...(s.repeat?.mode === "each" ? [s.repeat.items] : [])];
    case "branch":
    case "classify":
      return [s.value];
    case "text":
      return [s.template];
    case "stop":
      return [s.message];
    case "merge":
      return [];
  }
}
