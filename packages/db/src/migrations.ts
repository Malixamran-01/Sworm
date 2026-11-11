/**
 * Forward-only, expand-then-contract migrations (SRS 9.6). Every row that
 * belongs to a tenant carries org_id (SRS 8.7). IDs are UUIDv7, made in app code.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: "0001_foundation",
    sql: `
create table orgs (
  id uuid primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  email text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table memberships (
  org_id uuid not null references orgs(id),
  user_id uuid not null references users(id),
  role text not null,
  primary key (org_id, user_id)
);

-- Per-tenant data keys, wrapped by the master key. Destroying one crypto-shreds its data (PRIV-004).
create table data_keys (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  scope text not null,
  wrapped_key text not null,
  created_at timestamptz not null default now(),
  destroyed_at timestamptz
);

create table secrets (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  data_key_id uuid not null references data_keys(id),
  ciphertext text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table connections (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  name text not null,
  module_id text not null,
  module_version text not null,
  dock text not null,
  config jsonb not null default '{}',
  secret_id uuid references secrets(id),
  secret_keys jsonb not null default '[]',
  status text not null default 'unknown',
  status_detail text,
  outside_version text,
  spend_limit_usd numeric(14,6),
  last_checked_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  name text not null,
  description text not null default '',
  template_key text,
  budget_task_usd numeric(14,6) not null,
  budget_month_usd numeric(14,6) not null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table workspace_versions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  version int not null,
  manifest jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, version)
);

create table roles (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  instructions text not null default '',
  port text not null,
  connection_id uuid references connections(id),
  model text,
  effort text,
  unique (workspace_id, key)
);

create table task_types (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  input_fields jsonb not null,
  workflow jsonb not null,
  unique (workspace_id, key)
);

create table runs (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  workspace_id uuid not null references workspaces(id),
  task_type_id uuid not null references task_types(id),
  parent_run_id uuid references runs(id),
  root_run_id uuid not null,
  depth int not null default 0,
  title text not null,
  brief jsonb not null,
  workflow jsonb not null,
  status text not null,
  output text,
  error text,
  budget_usd numeric(14,6) not null,
  cost_usd numeric(14,6) not null default 0,
  call_count int not null default 0,
  trigger_chain jsonb not null default '[]',
  created_by uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index runs_workspace_created on runs (workspace_id, created_at desc);
create index runs_root on runs (root_run_id);
create index runs_task_type_status on runs (task_type_id, status, finished_at desc);

create table run_steps (
  id uuid primary key,
  run_id uuid not null references runs(id) on delete cascade,
  step_key text not null,
  kind text not null,
  attempt int not null default 1,
  status text not null,
  role_key text,
  connection_id uuid,
  node_label text,
  input jsonb,
  output text,
  error text,
  error_code text,
  feedback text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(14,6) not null default 0,
  cost_source text,
  latency_ms int,
  idempotency_key text unique,
  retry_at timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index run_steps_run on run_steps (run_id, step_key);
create index run_steps_live on run_steps (run_id) where status in ('running', 'waiting');

create table approvals (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  run_id uuid not null references runs(id) on delete cascade,
  step_id uuid not null references run_steps(id) on delete cascade,
  title text not null,
  body text not null default '',
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decision text,
  note text,
  decided_at timestamptz
);

create table inbox_items (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  user_id uuid not null references users(id),
  workspace_id uuid,
  run_id uuid,
  approval_id uuid,
  kind text not null,
  title text not null,
  body text not null default '',
  path text not null default '',
  action text,
  resolved boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index inbox_user on inbox_items (user_id, read_at nulls first, id desc);

create table budget_reservations (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  workspace_id uuid not null,
  run_id uuid not null,
  step_id uuid not null,
  connection_id uuid,
  reserved_usd numeric(14,6) not null,
  settled_usd numeric(14,6),
  status text not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index budget_reservations_held on budget_reservations (workspace_id) where status = 'held';

create table usage_ledger (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  workspace_id uuid,
  run_id uuid,
  step_id uuid,
  connection_id uuid,
  role_key text,
  module_id text,
  model text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(14,6) not null,
  cost_source text not null,
  reservation_id uuid,
  at timestamptz not null default now()
);
create index usage_ledger_workspace_at on usage_ledger (workspace_id, at);
create index usage_ledger_connection_at on usage_ledger (connection_id, at);

-- Transactional outbox: every state change writes its event in the same transaction (SRS 8.4).
create table outbox (
  id bigserial primary key,
  topics jsonb not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create index outbox_unpublished on outbox (id) where published_at is null;

-- Built-in durable engine: one advance task per run, leased with SKIP LOCKED.
create table engine_tasks (
  id uuid primary key,
  run_id uuid not null,
  kind text not null default 'advance',
  available_at timestamptz not null default now(),
  generation int not null default 1,
  locked_until timestamptz,
  locked_by text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  unique (run_id, kind)
);
create index engine_tasks_due on engine_tasks (available_at);

create table engine_signals (
  id uuid primary key,
  run_id uuid not null,
  name text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index engine_signals_pending on engine_signals (run_id) where consumed_at is null;

create table audit_log (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  actor uuid,
  action text not null,
  target text,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
`,
  },
  {
    id: "0002_accounts",
    sql: `
alter table users add column password_hash text;
alter table users add column disabled_at timestamptz;
alter table users add column last_sign_in_at timestamptz;

-- Sign-in through an outside identity provider (OIDC, GitHub).
create table identities (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  subject text not null,
  email text,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);

-- Browser sessions. Only a hash of the cookie value is stored.
create table sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  org_id uuid not null references orgs(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text,
  ip text
);

-- Personal access tokens with scopes (ACC-006). Only a hash is stored.
create table api_tokens (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  prefix text not null,
  token_hash text not null unique,
  scopes jsonb not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create table invites (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  email text,
  role text not null,
  token_hash text not null unique,
  created_by uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid
);

-- Per-workspace role overrides (ACC-004). Without a row, the org role applies.
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null,
  primary key (workspace_id, user_id)
);

-- Personal workspaces belong to one user (ACC-003).
alter table workspaces add column created_by uuid;
alter table workspaces add column private boolean not null default false;
`,
  },
  {
    // Notifications (NOTE-003, NOTE-004): channels, quiet hours, per-workspace alert rules, push and digests.
    id: "0003_notifications",
    sql: `
alter table inbox_items add column urgent boolean not null default false;
alter table inbox_items add column delivery text not null default 'pending';
alter table inbox_items add column delivered_at timestamptz;
alter table inbox_items add column digested_at timestamptz;
create index inbox_undelivered on inbox_items (created_at) where delivery = 'pending';

create table notification_prefs (
  user_id uuid primary key references users(id),
  desktop boolean not null default true,
  push boolean not null default false,
  email_digest text not null default 'off',
  digest_hour integer not null default 8,
  quiet_start integer,
  quiet_end integer,
  time_zone text not null default 'UTC',
  last_digest_at timestamptz,
  updated_at timestamptz not null default now()
);

create table notification_rules (
  user_id uuid not null references users(id),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  level text not null,
  primary key (user_id, workspace_id)
);

create table push_subscriptions (
  id uuid primary key,
  user_id uuid not null references users(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text not null default '',
  failures integer not null default 0,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz
);

create table push_keys (
  org_id uuid primary key references orgs(id),
  public_key text not null,
  secret_id uuid not null
);
`,
  },
  {
    // Passkeys and TOTP two-factor (ACC-002). Secrets are sealed or hashed, never stored plain.
    id: "0004_mfa",
    sql: `
create table user_totp (
  user_id uuid primary key references users(id),
  secret_sealed text not null,
  enabled_at timestamptz,
  last_step bigint not null default 0,
  created_at timestamptz not null default now()
);

create table recovery_codes (
  id uuid primary key,
  user_id uuid not null references users(id),
  code_hash text not null,
  used_at timestamptz
);
create index recovery_codes_user on recovery_codes (user_id);

create table passkeys (
  id text primary key,
  user_id uuid not null references users(id),
  public_key text not null,
  counter bigint not null default 0,
  transports jsonb not null default '[]',
  device_type text not null default 'singleDevice',
  backed_up boolean not null default false,
  name text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index passkeys_user on passkeys (user_id);

create table auth_challenges (
  id uuid primary key,
  purpose text not null,
  challenge text not null,
  user_id uuid,
  ticket_hash text,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index auth_challenges_expiry on auth_challenges (expires_at);
`,
  },
  {
    id: "0005_nested_runs",
    sql: `
-- Workspace steps start sub-tasks (WF-008). A sub-task knows the step that started it and its run number.
alter table runs add column parent_step_id uuid;
alter table runs add column iteration int not null default 1;
create index runs_parent_step on runs (parent_step_id) where parent_step_id is not null;
create index runs_parent on runs (parent_run_id) where parent_run_id is not null;

-- Task types edited away are archived when past tasks still point at them.
alter table task_types add column archived_at timestamptz;
`,
  },
  {
    id: "0006_loops",
    sql: `
-- Loop connectors (WF-010): each loop's round and last output, by the step that ends it.
alter table runs add column loops jsonb not null default '{}';
-- Which round of its loop a step row belongs to.
alter table run_steps add column round int not null default 1;
`,
  },
  {
    id: "0007_external",
    sql: `
-- Agent and Workflow ports (SRS 4.11). A one-time callback URL per outside
-- execution: only the token's hash is kept, and it works once.
create table external_callbacks (
  token_hash text primary key,
  org_id uuid not null references orgs(id),
  run_id uuid not null references runs(id) on delete cascade,
  step_id uuid not null references run_steps(id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
-- The ports a dock found its module provides (remote, sidecar and bridge docks).
alter table connections add column ports jsonb;
alter table connections add column remote_manifest jsonb;

-- Local Bridge (SRS 8.8): paired devices and pairings in progress.
create table bridge_devices (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  user_id uuid not null references users(id),
  name text not null,
  public_key text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
create table bridge_pairings (
  id uuid primary key,
  code_hash text not null unique,
  name text not null,
  public_key text not null,
  org_id uuid,
  user_id uuid,
  device_id uuid,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
`,
  },
  {
    id: "0008_policies",
    sql: `
-- What tasks may use (SRS 4.12): a connection, or one tool on it, is allowed, needs a person first, or is never used.
-- workspace_id null means the rule holds for the whole organisation.
create table policies (
  id uuid primary key,
  org_id uuid not null references orgs(id),
  workspace_id uuid references workspaces(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  tool text,
  effect text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index policies_scope on policies (org_id, workspace_id);
-- The limits a sub-task inherits from the workspaces above it. They only ever narrow.
alter table runs add column inherited jsonb not null default '{}';
-- What the rules said about a step's call, kept for the trace.
alter table run_steps add column policy jsonb;
-- When a finished task's trace was sent to an OpenTelemetry collector, if one is set.
alter table runs add column trace_exported_at timestamptz;
`,
  },
];
