import type { CostSource } from "./call";
import type { InputField, Step, StepKind, WorkflowDefinition } from "./workflow";
import type { PortRef } from "./ports";

/** Shapes the REST API returns. Shared with the web app so they never drift. */

export interface ModuleDto {
  id: string;
  version: string;
  name: string;
  description: string;
  ports: PortRef[];
  docks: string[];
  configFields: ConfigFieldDto[];
  reference: boolean;
}

export interface ConfigFieldDto {
  key: string;
  label: string;
  type: "string" | "url" | "secret" | "number";
  required: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number;
}

export type ConnectionStatus = "working" | "rate_limited" | "signed_out" | "unreachable" | "unknown";

export interface ConnectionDto {
  id: string;
  name: string;
  moduleId: string;
  moduleVersion: string;
  dock: string;
  /** Non-secret config only; secrets are never returned (CON-002). */
  config: Record<string, unknown>;
  secretKeys: string[];
  status: ConnectionStatus;
  statusDetail: string | null;
  spendLimitUsd: number | null;
  monthSpendUsd: number;
  /** Workspaces whose roles use this connection. */
  usedBy: { workspaceId: string; workspaceName: string }[];
  lastCheckedAt: string | null;
  createdAt: string;
}

export interface ConnectionTestDto {
  ok: boolean;
  status: ConnectionStatus;
  detail: string;
  capabilities: { models?: { id: string; displayName?: string }[]; tools?: { name: string }[] };
}

export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string;
  instructions: string;
  port: PortRef;
  connectionId: string | null;
  model: string | null;
  effort: string | null;
  monthSpendUsd: number;
  monthRuns: number;
  monthFailures: number;
}

export interface TaskTypeDto {
  id: string;
  key: string;
  name: string;
  description: string;
  inputFields: InputField[];
  steps: Step[];
  /** The whole definition, with its output step and editor layout. */
  workflow: WorkflowDefinition;
}

/** A task type another workflow can call as a sub-task. */
export interface CallableTaskTypeDto {
  key: string;
  name: string;
  description: string;
  inputFields: InputField[];
  /** For "run up to this step". */
  steps: { key: string; kind: StepKind; label: string }[];
}

/** A workspace whose task types a workflow step may run (WF-008). */
export interface CallTargetDto {
  workspaceId: string;
  workspaceName: string;
  taskTypes: CallableTaskTypeDto[];
}

/** Body for creating or replacing a task type from the editor. */
export interface TaskTypeInput {
  key: string;
  name: string;
  description?: string;
  inputFields: InputField[];
  workflow: WorkflowDefinition;
}

/** Body for adding a role from the editor. */
export interface RoleInput {
  key?: string;
  name: string;
  description?: string;
  instructions?: string;
  port: "model@1" | "tool@1";
}

export interface WorkspaceDto {
  id: string;
  name: string;
  description: string;
  templateKey: string | null;
  budgetTaskUsd: number;
  budgetMonthUsd: number;
  monthSpendUsd: number;
  version: number;
  createdAt: string;
  /** Tasks waiting on an approval and tasks running now, for status pills. */
  waitingTasks: number;
  runningTasks: number;
  /** Personal workspaces are visible only to the person who made them (ACC-003). */
  private: boolean;
}

export interface WorkspaceDetailDto extends WorkspaceDto {
  roles: RoleDto[];
  taskTypes: TaskTypeDto[];
  /** The caller's effective role here, after any per-workspace override. */
  yourRole?: RoleName;
}

export interface TemplateDto {
  key: string;
  name: string;
  description: string;
  roles: { key: string; name: string; description: string; port: string }[];
  taskTypes: { key: string; name: string; steps: { key: string; kind: StepKind; label: string }[] }[];
  budget: { taskUsd: number; monthUsd: number };
}

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
/** not_taken: no taken connector led to the step, so it never ran (WF-009). */
export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "superseded" | "skipped" | "not_taken";

export interface StepDto {
  id: string;
  key: string;
  kind: Step["kind"];
  attempt: number;
  status: StepStatus;
  nodeLabel: string | null;
  output: string | null;
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSource: CostSource | null;
  latencyMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Sub-tasks a workspace step started, in order. */
  children?: ChildRunDto[];
  /** The loop round this row belongs to (WF-010); 1 outside loops. */
  round: number;
}

export interface ChildRunDto {
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  status: RunStatus;
  /** 1-based run number within a repeat. */
  iteration: number;
  costUsd: number;
}

export interface RunSummaryDto {
  id: string;
  workspaceId: string;
  taskTypeId: string;
  taskTypeName: string;
  title: string;
  status: RunStatus;
  costUsd: number;
  budgetUsd: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  workspaceName: string;
  /** Progress for list rows and progress bars. */
  stepsTotal: number;
  stepsDone: number;
  /** Key of the step running or waiting now, if any. */
  currentStep: string | null;
}

export interface RunDetailDto extends RunSummaryDto {
  brief: Record<string, string>;
  output: string | null;
  steps: StepDto[];
  /** The task whose workspace step started this one, if any. */
  parent: { id: string; workspaceId: string; title: string; stepKey: string } | null;
  depth: number;
}

export type InboxKind = "approval" | "result" | "problem" | "budget";

export interface InboxItemDto {
  id: string;
  kind: InboxKind;
  workspaceId: string | null;
  workspaceName: string | null;
  runId: string | null;
  approvalId: string | null;
  title: string;
  body: string;
  /** Path through nested runs, e.g. "Research brief > Editor > needs approval". */
  path: string;
  action: "approve" | "open" | "retry" | "reconnect" | null;
  resolved: boolean;
  /** A safety check: delivered even during quiet hours. */
  urgent: boolean;
  readAt: string | null;
  createdAt: string;
}

export type Confidence = "none" | "low" | "medium" | "high";

export interface EstimateDto {
  medianUsd: number;
  p90Usd: number;
  /** Based on how many past runs and which cost sources they used (COST-007). */
  confidence: Confidence;
  basis: string;
  medianSeconds: number | null;
}

// ------------------------------------------------------------ accounts (ACC)

export type RoleName = "owner" | "editor" | "runner" | "viewer";
export type PermissionName =
  | "workspace:read"
  | "task:run"
  | "approval:decide"
  | "workspace:edit"
  | "connection:read"
  | "connection:manage"
  | "member:manage"
  | "org:manage";

export interface MeDto {
  user: { id: string; email: string; name: string; hasPassword: boolean };
  org: { id: string; name: string };
  role: RoleName;
  permissions: PermissionName[];
  orgs: { id: string; name: string; role: RoleName }[];
  via: "session" | "token";
}

export interface AuthStateDto {
  setupRequired: boolean;
  setupCodeRequired: boolean;
  providers: { id: string; name: string }[];
  me: MeDto | null;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: RoleName;
  lastSignInAt: string | null;
  you: boolean;
}

export interface WorkspaceMemberDto extends MemberDto {
  override: RoleName | null;
}

export interface InviteDto {
  id: string;
  email: string | null;
  role: RoleName;
  createdAt: string;
  expiresAt: string;
}

export interface TokenDto {
  id: string;
  name: string;
  prefix: string;
  scopes: PermissionName[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ApiErrorDto {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: string[];
}

/** Answers to the guided workspace builder (WS-001). Same answers, same workspace. */
export interface BuilderAnswers {
  goal: "research" | "write" | "summarize" | "answer" | "custom";
  /** For "custom": what the assistant should do, in plain words. */
  customGoal?: string;
  /** Who the results are for. */
  audience?: string;
  /** A person approves before anything is delivered. Default true. */
  approval?: boolean;
  /** A reviewer role checks the work against the brief. Default false. */
  check?: boolean;
  /** Start from a search tool on any MCP server; skipped when none is connected. Default false. */
  search?: boolean;
  name?: string;
  budgetMonthUsd?: number;
  budgetTaskUsd?: number;
}

/** How loudly a workspace may notify one person (NOTE-003). Everything still lands in the inbox. */
export type AlertLevel = "all" | "important" | "none";
export type DigestFrequency = "off" | "daily" | "weekly";

export interface NotificationPrefsDto {
  desktop: boolean;
  push: boolean;
  emailDigest: DigestFrequency;
  /** Local hour (0-23) the digest goes out. */
  digestHour: number;
  /** Minutes after local midnight; both null means no quiet hours. */
  quietStart: number | null;
  quietEnd: number | null;
  timeZone: string;
}

export interface NotificationSettingsDto {
  prefs: NotificationPrefsDto;
  rules: { workspaceId: string; workspaceName: string; level: AlertLevel }[];
  /** What this server can do: push needs its public key, email needs SMTP. */
  server: { pushPublicKey: string | null; email: boolean };
  pushDevices: { id: string; userAgent: string; createdAt: string }[];
  /** True while quiet hours are on for this person right now. */
  quietNow: boolean;
}

export type MfaMethod = "totp" | "recovery" | "passkey";

/** A correct password for an account with a second factor gives this instead of a session (ACC-002). */
export interface MfaChallengeDto {
  ticket: string;
  methods: MfaMethod[];
  /** WebAuthn request options when the person has passkeys (PublicKeyCredentialRequestOptionsJSON). */
  passkeyOptions: unknown | null;
}

export interface PasskeyDto {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Synced by a password manager or platform (multi-device). */
  synced: boolean;
}

export interface SecurityDto {
  totp: { enabled: boolean; recoveryCodesLeft: number };
  passkeys: PasskeyDto[];
}

export interface TotpSetupDto {
  /** Base32 seed for typing in by hand. */
  secret: string;
  uri: string;
  /** QR code of the URI as an SVG data URL. */
  qr: string;
}
