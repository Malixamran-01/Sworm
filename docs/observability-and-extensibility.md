# One trace, one ledger, and modules nobody planned for

Connecting many AI systems is common now. What is less common is making systems
built by different people behave like one environment that can be watched and
governed from one place. This note covers the four pieces that do that here, and
what was deliberately left out.

## What other products already do

| Product | What it does well | What Conclave does instead |
| --- | --- | --- |
| Agent organisers (roles, budgets, approvals for agents) | Manage agents as a team | Treat agents as one kind of node among models, tools and workflow engines, all behind the same call contract |
| App builders (visual workflows, plugins, publishing) | Build AI apps inside their own runtime | Orchestrate systems that already exist, where they run |
| Durable execution engines | Retries, timers, signals, recovery | Stay above them: the engine sits behind `ExecutionEngine`, and an outside engine is a Workflow-port node |
| Workflow automation tools | Triggers and integrations | Call them as nodes through the webhook dock; no need to replace them |
| MCP and A2A | Standard access to tools and to agents | Adapters into ports, not something to compete with |

So "it connects anything" is not the difference. The difference is the
combination: one call contract for every system, limits that hold across nested
calls, one history for a whole run, and modules that work on arrival.

## 1. One trace per task

**The problem.** A task calls an agent, which a sub-task in another workspace
follows with a model call, which waits on a person. Before, each task showed
its own steps, and a sub-task was a link to another page. Nobody could see the
whole thing, or say where the time and money went.

**What changed.**

- Every call a task tree makes now carries the same W3C trace id: the top
  task's id. Before, each sub-task started a trace of its own, so a nest could
  not be joined. The span id is taken from the random end of the step id;
  the start of a UUIDv7 is a timestamp, and two steps started in the same
  millisecond could have shared it.
- `parentCallId` on the call is the workspace step that started the task, so a
  module can tell where in the nest it was called from.
- `GET /v1/tasks/:id/trace` returns the whole tree from any task in it:
  tasks, sub-tasks, and every attempt of every step (retries and loop rounds
  are spans, not overwritten rows). Each span has the node that did the work,
  cost and its source, tokens, the budget held before it started and what is
  still held, the person's decision, the error and code, the outside system's
  run id, and the `traceparent` that was sent.
- The screen (task panel → "Open trace") shows the timeline, where the time
  went by kind of system, and what each connected system cost.

**Why from the database, not a tracing backend.** The steps, the ledger, the
reservations and the approvals are already the source of truth, written in the
same transactions as the state changes. A trace read from them cannot disagree
with what the budget says, and the Lite profile stays Postgres-only. The ids
are standard, so exporting spans over OpenTelemetry later is a relay, not a
redesign.

**Access.** The caller must be allowed to see the task they ask about. Spans in
someone else's personal workspace stay in the tree, so the timeline and totals
add up, but their names, node labels, errors and notes are left out.

**Cost never counts twice.** A workspace step's cost is its sub-tasks' cost, so
its own share is zero; the per-system totals add up to the task's total. A test
holds this.

## 2. Insights and the audit trail

The usage ledger and the audit log were already written on every call and every
change. Nothing read them across workspaces.

- `GET /v1/insights/usage?days=7|30|90`: spend per day, by workspace, by
  connection and by model; calls and tokens; tasks done and failed; and the
  split by cost source. The last one answers a question other dashboards skip:
  how much of this number was measured, and how much was estimated from prices
  someone typed in.
- Reliability per connection counts every attempt, so a connection that needed
  three tries shows up even when the task ended well.
- `GET /v1/audit`: who did what, newest first, with the target's name, a filter
  by area, and paging by id (ids are UUIDv7, so id order is time order). Owners
  only, because it names people.
- Both leave out other people's personal workspaces.

The sidebar's "This month" figure was a label; it is now the way into Insights.

## 3. Modules without changing Conclave

The test of a module system is a module nobody here has heard of. Until now,
adding one meant editing the server's module list.

- At start the server loads modules from `<data dir>/modules`
  (`CONCLAVE_MODULES_DIR`) and from `CONCLAVE_MODULES` (package names or paths).
  A module is a file or folder whose default export is `{ manifest, create }`.
- The manifest is validated and normalised the same way as a built-in module's.
  A broken module is skipped with the reason in the log; one bad file does not
  stop the server. An installed module cannot take a built-in module's id.
- From there it is an ordinary module: connections, health checks, egress
  limited to the manifest's hosts, per-connection secrets, budgets, traces and
  the audit trail all apply with no extra work.
- The connection form now says, before anything is saved, which hosts the
  module may reach and which secrets it reads, and marks modules the admin
  added.

**Trust.** A module in this folder runs inside the server. A signature or a
valid manifest says where a package came from, not that it is safe, so
installing one is the server admin's decision, like `CONCLAVE_SIDECARS`. Code
that should not be trusted that far goes in the remote, sidecar or Local Bridge
dock, where the process boundary does the isolating. The same module code runs
in any of them.

A smallest module:

```js
// <data dir>/modules/echo.mjs
export default {
  manifest: { id: "acme/echo", version: "1.0.0", name: "Echo", ports: ["tool@1"], docks: ["built-in"] },
  create() {
    return {
      ports: {
        tool: {
          listTools: async () => [{ name: "echo", inputSchema: { type: "object" } }],
          call: async (_name, args) => ({ data: args }),
        },
      },
      health: async () => ({ status: "working", detail: "Ready." }),
    };
  },
};
```

## 4. A2A as a protocol dock

`modules/a2a` makes any Agent2Agent agent an Agent-port node. It is an adapter
into the port, like the MCP and OpenAI-compatible docks.

- It reads the Agent Card (`/.well-known/agent-card.json`, and the older
  `/.well-known/agent.json`) for the endpoint, the protocol version and the
  skills.
- It speaks 1.0 (`SendMessage`, `GetTask`, `CancelTask`, `TASK_STATE_*`, the
  `A2A-Version` header) and 0.3 (`message/send`, `tasks/get`, `tasks/cancel`,
  lower-case states), chosen from the card.
- Messages are sent without waiting, and the task is followed by asking for it
  again. That is what lets a run survive a restart of either side, and it needs
  nothing from the agent beyond the base protocol.
- `input-required` becomes a question in the inbox; the answer goes back as a
  message on the same task. `auth-required`, `rejected`, `failed` and
  `canceled` become contract errors, so On failure connectors and retries
  behave as for any other node.
- The step's `traceparent` goes in the message metadata, so an agent that logs
  it can be matched to the trace.
- Cost comes from `metadata.usage` on the finished task when the agent reports
  it, and otherwise from the prices on the connection.

Not done: streaming (`SendStreamingMessage`) and push notifications. Polling is
enough for correctness; streaming would only make progress lines arrive sooner.

## What was left out on purpose

- **A new protocol.** CMP stays the contract between Conclave and its modules.
  MCP and A2A are adapters into it.
- **More ports.** Model, Tool, Agent and Workflow are implemented. Each further
  port is a contract, a conformance suite and a security surface; they wait for
  a module that needs them.
- **A second execution engine.** The Postgres engine sits behind
  `ExecutionEngine`. Another one is worth it when a deployment needs it.
- **A public marketplace and a no-code module builder.** Private installation
  comes first; the rest waits for module authors to exist.

## How to tell it works

| Gate | Held by |
| --- | --- |
| Different systems through one call path | Model, MCP tool, A2A agent, webhook workflow and docked modules all run through the same step code and conformance kit |
| A module with no change to core | `apps/server/src/modules.test.ts` |
| Nested runs survive restarts | `packages/core/src/external.test.ts`, `nesting.test.ts` |
| Nested calls stay inside the budget | `nesting.test.ts` |
| One trace rebuilds a cross-workspace run | `packages/core/src/insights.test.ts` |
