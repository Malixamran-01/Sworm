import type {
  AuthStateDto,
  InviteDto,
  MeDto,
  MfaChallengeDto,
  PasskeyDto,
  SecurityDto,
  TotpSetupDto,
  MemberDto,
  PermissionName,
  RoleName,
  TokenDto,
  WorkspaceMemberDto,
  ConnectionDto,
  ConnectionTestDto,
  EstimateDto,
  InboxItemDto,
  ModelInfo,
  ToolInfo,
  ModuleDto,
  RunDetailDto,
  RunSummaryDto,
  BuilderAnswers,
  CallTargetDto,
  RoleInput,
  TaskTypeInput,
  TemplateDto,
  AlertLevel,
  NotificationPrefsDto,
  NotificationSettingsDto,
  WorkspaceDetailDto,
  WorkspaceDto,
} from "@conclave/contract";

export class ApiError extends Error {
  readonly status: number;
  readonly errors: string[];

  constructor(message: string, status: number, errors: string[]) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

/** Called when a request finds the session gone, so the app can show sign-in. */
let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    // Browser writes must carry this header; cross-site forms cannot (SEC-001).
    headers: { "x-requested-with": "conclave", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith("/v1/auth/")) onSignedOut();
  if (!res.ok) {
    const errors: string[] = data?.errors ?? (data?.detail ? [data.detail] : []);
    throw new ApiError(data?.title ?? res.statusText, res.status, errors);
  }
  return data as T;
}

export const api = {
  // Accounts
  authState: () => request<AuthStateDto>("GET", "/v1/auth/state"),
  setup: (body: { name: string; email: string; password: string; orgName?: string; setupCode?: string }) => request<MeDto>("POST", "/v1/auth/setup", body),
  /** A session, or a second step when the account has two-factor on (ACC-002). */
  signIn: (body: { email: string; password: string }) => request<MeDto | { mfaRequired: MfaChallengeDto }>("POST", "/v1/auth/sign-in", body),
  completeSignIn: (body: { ticket: string; code?: string; recoveryCode?: string; passkey?: unknown }) => request<MeDto>("POST", "/v1/auth/mfa", body),
  passkeySignInOptions: () => request<{ challengeId: string; options: unknown }>("POST", "/v1/auth/passkey/options", {}),
  passkeySignIn: (body: { challengeId: string; response: unknown }) => request<MeDto>("POST", "/v1/auth/passkey", body),
  security: () => request<SecurityDto>("GET", "/v1/me/security"),
  totpSetup: () => request<TotpSetupDto>("POST", "/v1/me/totp/setup", {}),
  totpEnable: (code: string) => request<{ recoveryCodes: string[] }>("POST", "/v1/me/totp/enable", { code }),
  totpDisable: (body: { code?: string; recoveryCode?: string }) => request<void>("POST", "/v1/me/totp/disable", body),
  newRecoveryCodes: (code: string) => request<{ recoveryCodes: string[] }>("POST", "/v1/me/recovery-codes", { code }),
  passkeyOptions: () => request<{ challengeId: string; options: unknown }>("POST", "/v1/me/passkeys/options", {}),
  addPasskey: (body: { challengeId: string; response: unknown; name?: string }) => request<PasskeyDto>("POST", "/v1/me/passkeys", body),
  renamePasskey: (id: string, name: string) => request<PasskeyDto>("PATCH", `/v1/me/passkeys/${encodeURIComponent(id)}`, { name }),
  removePasskey: (id: string) => request<void>("DELETE", `/v1/me/passkeys/${encodeURIComponent(id)}`),
  signOut: () => request<void>("POST", "/v1/auth/sign-out"),
  inviteInfo: (token: string) => request<{ orgName: string; role: RoleName; email: string | null }>("GET", `/v1/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, body: { name?: string; email?: string; password?: string }) =>
    request<MeDto>("POST", `/v1/auth/invites/${encodeURIComponent(token)}/accept`, body),
  me: () => request<MeDto>("GET", "/v1/me"),
  updateMe: (body: { name: string }) => request<MeDto>("PATCH", "/v1/me", body),
  changePassword: (body: { current?: string; next: string }) => request<void>("POST", "/v1/me/password", body),
  switchOrg: (orgId: string) => request<MeDto>("POST", "/v1/auth/switch-org", { orgId }),
  createOrg: (name: string) => request<{ id: string; name: string }>("POST", "/v1/orgs", { name }),
  members: () => request<MemberDto[]>("GET", "/v1/org/members"),
  setMemberRole: (userId: string, role: RoleName) => request<MemberDto[]>("PATCH", `/v1/org/members/${userId}`, { role }),
  removeMember: (userId: string) => request<void>("DELETE", `/v1/org/members/${userId}`),
  invites: () => request<InviteDto[]>("GET", "/v1/org/invites"),
  createInvite: (body: { email?: string | null; role: RoleName }) => request<{ invite: InviteDto; link: string }>("POST", "/v1/org/invites", body),
  revokeInvite: (id: string) => request<void>("DELETE", `/v1/org/invites/${id}`),
  workspaceMembers: (workspaceId: string) => request<WorkspaceMemberDto[]>("GET", `/v1/workspaces/${workspaceId}/members`),
  setWorkspaceRole: (workspaceId: string, userId: string, role: RoleName | null) =>
    request<WorkspaceMemberDto[]>("PUT", `/v1/workspaces/${workspaceId}/members/${userId}`, { role }),
  tokens: () => request<TokenDto[]>("GET", "/v1/tokens"),
  createToken: (body: { name: string; scopes: PermissionName[]; expiresInDays?: number | null }) => request<{ token: string; info: TokenDto }>("POST", "/v1/tokens", body),
  revokeToken: (id: string) => request<void>("DELETE", `/v1/tokens/${id}`),

  modules: () => request<ModuleDto[]>("GET", "/v1/modules"),
  templates: () => request<TemplateDto[]>("GET", "/v1/templates"),

  connections: () => request<ConnectionDto[]>("GET", "/v1/connections"),
  createConnection: (body: { moduleId: string; name: string; values: Record<string, unknown>; spendLimitUsd?: number | null }) =>
    request<ConnectionDto>("POST", "/v1/connections", body),
  testConnection: (id: string) => request<ConnectionTestDto>("POST", `/v1/connections/${id}/test`),
  setConnectionDisabled: (id: string, disabled: boolean) => request<ConnectionDto>("POST", `/v1/connections/${id}/${disabled ? "disable" : "enable"}`),
  deleteConnection: (id: string) => request<void>("DELETE", `/v1/connections/${id}`),
  models: (id: string) => request<ModelInfo[]>("GET", `/v1/connections/${id}/models`),
  tools: (id: string) => request<ToolInfo[]>("GET", `/v1/connections/${id}/tools`),

  workspaces: () => request<WorkspaceDto[]>("GET", "/v1/workspaces"),
  workspace: (id: string) => request<WorkspaceDetailDto>("GET", `/v1/workspaces/${id}`),
  /** Exactly one of templateKey, answers, blank or package (WS-001, WS-005). */
  createWorkspace: (body: {
    templateKey?: string;
    answers?: BuilderAnswers;
    blank?: boolean;
    package?: unknown;
    name?: string;
    private?: boolean;
    defaultNode?: { connectionId: string | null; model: string | null };
  }) => request<WorkspaceDetailDto>("POST", "/v1/workspaces", body),
  /** What the guided builder would create; creates nothing. */
  composeWorkspace: (answers: BuilderAnswers) => request<TemplateDto>("POST", "/v1/workspaces/compose", answers),
  assignRole: (workspaceId: string, roleKey: string, body: { connectionId: string | null; model: string | null; effort?: string | null }) =>
    request<WorkspaceDetailDto>("PUT", `/v1/workspaces/${workspaceId}/roles/${roleKey}`, body),
  updateBudget: (workspaceId: string, body: { taskUsd?: number; monthUsd?: number }) =>
    request<WorkspaceDetailDto>("PATCH", `/v1/workspaces/${workspaceId}/budget`, body),
  exportWorkspace: (workspaceId: string) => request<unknown>("GET", `/v1/workspaces/${workspaceId}/export`),
  // The node editor (WF-007) and workspace steps (WF-008).
  callTargets: () => request<CallTargetDto[]>("GET", "/v1/call-targets"),
  createTaskType: (workspaceId: string, body: TaskTypeInput) => request<WorkspaceDetailDto>("POST", `/v1/workspaces/${workspaceId}/task-types`, body),
  saveTaskType: (workspaceId: string, key: string, body: TaskTypeInput) =>
    request<WorkspaceDetailDto>("PUT", `/v1/workspaces/${workspaceId}/task-types/${encodeURIComponent(key)}`, body),
  deleteTaskType: (workspaceId: string, key: string) => request<WorkspaceDetailDto>("DELETE", `/v1/workspaces/${workspaceId}/task-types/${encodeURIComponent(key)}`),
  createRole: (workspaceId: string, body: RoleInput) => request<WorkspaceDetailDto>("POST", `/v1/workspaces/${workspaceId}/roles`, body),
  updateRole: (workspaceId: string, key: string, body: { name?: string; description?: string; instructions?: string }) =>
    request<WorkspaceDetailDto>("PATCH", `/v1/workspaces/${workspaceId}/roles/${key}`, body),
  deleteRole: (workspaceId: string, key: string) => request<WorkspaceDetailDto>("DELETE", `/v1/workspaces/${workspaceId}/roles/${key}`),

  notifications: () => request<NotificationSettingsDto>("GET", "/v1/me/notifications"),
  updateNotifications: (patch: Partial<NotificationPrefsDto>) => request<NotificationSettingsDto>("PATCH", "/v1/me/notifications", patch),
  setAlertRule: (workspaceId: string, level: AlertLevel) => request<NotificationSettingsDto>("PUT", `/v1/me/notifications/workspaces/${workspaceId}`, { level }),
  subscribePush: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => request<NotificationSettingsDto>("POST", "/v1/me/push-subscriptions", sub),
  removePush: (id: string) => request<NotificationSettingsDto>("DELETE", `/v1/me/push-subscriptions/${id}`),
  removePushEndpoint: (endpoint: string) => request<NotificationSettingsDto>("POST", "/v1/me/push-subscriptions/remove", { endpoint }),
  testNotification: () => request<{ desktop: boolean; pushes: number; email: boolean }>("POST", "/v1/me/notifications/test"),

  activeTasks: () => request<RunSummaryDto[]>("GET", "/v1/tasks"),
  tasks: (workspaceId: string) => request<RunSummaryDto[]>("GET", `/v1/workspaces/${workspaceId}/tasks`),
  task: (id: string) => request<RunDetailDto>("GET", `/v1/tasks/${id}`),
  estimate: (workspaceId: string, taskTypeId: string, brief: Record<string, string>) =>
    request<EstimateDto>("POST", `/v1/workspaces/${workspaceId}/estimate`, { taskTypeId, brief }),
  startTask: (workspaceId: string, taskTypeId: string, brief: Record<string, string>) =>
    request<RunDetailDto>("POST", `/v1/workspaces/${workspaceId}/tasks`, { taskTypeId, brief }, { "idempotency-key": crypto.randomUUID() }),
  cancelTask: (id: string) => request<RunDetailDto>("POST", `/v1/tasks/${id}/cancel`),

  inbox: () => request<InboxItemDto[]>("GET", "/v1/inbox"),
  markRead: (id: string) => request<InboxItemDto>("POST", `/v1/inbox/${id}/read`),
  decide: (approvalId: string, decision: "approve" | "reject" | "changes", note?: string) =>
    request<RunDetailDto>("POST", `/v1/approvals/${approvalId}`, { decision, ...(note ? { note } : {}) }),
};

/** Only the brief fields that have text; the API rejects empty optional fields as unknown values otherwise. */
export const cleanBrief = (brief: Record<string, string>) => Object.fromEntries(Object.entries(brief).filter(([, v]) => v.trim()));
