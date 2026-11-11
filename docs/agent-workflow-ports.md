# Agent and Workflow ports, and the docks

This is the first slice of Phase 2 (SRS 4.11, 5, 8.8). Outside agents and outside workflow engines now join a workspace as roles, through the same docking design as models and tools. Any module built with the public Module SDK can run inside Conclave, on its own server, as a process Conclave starts, or on someone's computer through the Local Bridge.

## Steps

| Step | Port | What it does |
| --- | --- | --- |
| **Agent** | `agent@1` | Hands a task (a prompt template plus named data) to the agent filling the role, and waits as long as it takes. Progress shows on the task as it comes. A question from the agent becomes one inbox item, with the full path; the answer goes back to the agent (MESH-006). The step can instead fail on questions. |
| **Automation** | `workflow@1` | Starts a workflow in an outside engine with named inputs, and waits for its result: at once, by polling, or by a one-time callback URL. |

Both steps:
- reserve money before they start: the step's own cap, or the connection's prices (per call, plus per minute) over the whole timeout;
- charge what the outside system reports, or else the connection's prices for the time taken (COST-004, COST-006);
- time out, ask the outside system to stop, and free the held money;
- are cancelled with the task. Where a system cannot cancel, its result is ignored (SRS 5.2);
- can be caught by an On failure connector, and are not retried unless the step asks for it, because an outside run is not idempotent.

### Surviving restarts

An outside run can take hours, so the step does not hold a worker while it waits. It writes what it needs to find the run again (the agent's run handle or the engine's execution) to its checkpoint, and moves to `waiting`.

- **Agents:** a watcher follows the run's events in the worker process. Progress is written to the step as it comes. Questions and the result go through an engine signal, so the run's own worker applies them under its lease. A run with an agent at work is checked every 30 s. A worker that restarted, or a watch that dropped, picks the watch up again; the port contract requires `streamEvents` to work on a run already under way.
- **Workflows:** polls back off from 2 s to once a minute. A callback URL carries a 256-bit token; only its hash is stored, and it stops working when the step ends.

## Port contracts

Both contracts are in `packages/contract/src/ports.ts`.

```ts
interface AgentPortV1 {
  listSkills(): Promise<AgentSkill[]>;
  startRun(input: { skill?; text; data? }, ctx): Promise<AgentRunHandle>;   // handle is plain JSON
  streamEvents(handle, ctx): AsyncIterable<AgentEvent>;                       // progress | needs_input | completed | failed
  provideInput(handle, answer, ctx): Promise<void>;
  cancel(handle): Promise<void>;
}

interface WorkflowPortV1 {
  listWorkflows(): Promise<WorkflowInfo[]>;
  trigger(workflowId, input, ctx & { callbackUrl? }): Promise<{ execution; status }>;
  poll?(execution, ctx): Promise<WorkflowStatus>;                              // running | succeeded | failed | cancelled
  callback?(execution, body, headers): Promise<WorkflowStatus>;
  cancel?(execution): Promise<void>;
}
```

The conformance kit (`runConformance`) now checks both ports (MOD-006):
- skills and workflows are listed;
- a run streams known events to a final one;
- handles survive a JSON round trip;
- watching a finished run again yields its final event, so a restarted host can still finish the step;
- cancel works;
- errors use the contract's codes.

## The Conclave Module Protocol (CMP 1.0)

`packages/module-sdk/src/cmp.ts`. Messages are JSON-RPC 2.0.

| Direction | Methods |
| --- | --- |
| Host → module | `initialize` (the module answers with its manifest), `health`, `outsideVersion`, `discover`, `model.listModels`, `model.generate`, `tool.listTools`, `tool.call`, `agent.listSkills`, `agent.startRun`, `agent.events`, `agent.provideInput`, `agent.cancel`, `workflow.list`, `workflow.trigger`, `workflow.poll`, `workflow.callback`, `workflow.cancel`, and the `$/cancel` notification |
| Module → host (stdio only) | `host.fetch`, so network calls pass the host's allow-list, and `host.log` |

`agent.events` is a long poll over a cursor (up to 20 s), so the same method works over HTTP and stdio.

- `serveHttp(module, { secret })` and `serveStdio(module)` serve any `defineModule` module unchanged.
- `httpClient`, `spawnClient` and `cmpInstance` are the host side.
- `CMP 1.x` is checked at `initialize`. After that, a docked instance shows only the ports its module provides.

**HTTP signing.** Every request carries `x-cmp-timestamp`, `x-cmp-nonce` and `x-cmp-signature: v1=<HMAC-SHA256(secret, "ts.nonce.body")>`.
- The module refuses requests that are more than 5 minutes old, a nonce it has seen in the last 10 minutes, and secrets shorter than 32 characters.
- Every answer is signed over the request's nonce, so a forged or replayed answer is refused too.
- Plain `http` is accepted only for loopback addresses.

The SRS asks (section 13, open question) whether CMP should be an open spec or whether sidecars should speak only MCP and A2A. This keeps CMP small and JSON-RPC based, so publishing it later is cheap. MCP and A2A stay protocol docks.

## Docks

| Dock | Module | Where the module runs | Isolation |
| --- | --- | --- | --- |
| Built-in | any `defineModule` in the server's module list | inside the worker | first-party only |
| Protocol | `conclave/webhook-workflow` (new), `conclave/mcp`, `conclave/openai-compatible` | no module code; a standard protocol | as the endpoint |
| Remote | `conclave/remote` | the author's own server, CMP over HTTPS | signed requests and answers; treated as an outside system |
| Sidecar | `conclave/sidecar` | a process this server starts, in any language, CMP over stdio | see below |
| Bridge | `conclave/bridge` | a user's computer, through the Local Bridge | see below |

**Docked modules.** Testing a remote, sidecar or bridge connection asks its module for its manifest.
- The ports it provides are stored on the connection, so the role pickers offer only fitting connections.
- A later test that finds a different module or version, or wider egress, says so (MOD-011).

**Webhook workflow** (MOD-004). Any engine that starts a workflow from a webhook works with no module code: n8n, Zapier, Make, Activepieces, Windmill and others. Conclave POSTs the step's inputs as JSON.
- In `wait` mode the webhook's response is the result.
- In `callback` mode the workflow posts its result to the `callbackUrl` it was sent.
- With a secret set, requests carry `X-Conclave-Signature: sha256=<HMAC of "timestamp.body">`.

### Sidecar security

Starting a process on the server is the server admin's decision, not an org admin's.

- `CONCLAVE_SIDECARS` lists the exact commands that may be started, separated by `;`, or `*` for any. Empty, the default, turns sidecars off.
- A sidecar gets a bare environment, with no keys and no database URL, and is started without a shell.
- Its module's `ctx.fetch` goes through Conclave, which lets through only the hosts listed on the connection.
- For real isolation (MOD-010), make the allowed command a container with no network. stdio still works, and egress still passes the list:

```
docker run -i --rm --network none --memory 512m --cpus 1 --read-only acme/agent:1.2
```

A plain process can still open sockets itself; only a container or a microVM stops that.

### Local Bridge security (SRS 8.8)

`apps/bridge` is a small CLI: `conclave-bridge pair | target add | target list | target remove | run | status`. The Tauri desktop app (SRS 7, 12) can wrap it later.

- **Pairing.**
  1. The device makes an Ed25519 key pair and shows a one-time code (8 characters, 10 minutes, stored hashed).
  2. A signed-in person enters the code in **Settings → Devices**.
  3. The device shows who claimed it and asks its person to confirm.
  - The person is told in their inbox about every new pairing.
- **Connection.**
  - One outbound WebSocket per device; the bridge never listens on a port.
  - The device proves itself by signing the server's random challenge.
  - Every call the server sends is signed with the server's Ed25519 key. The key is derived from the master key, and the device pinned it at pairing.
  - The bridge checks:
    - the signature;
    - a 5-minute window;
    - that the call has not been seen before on this connection;
    - that the method is a host-to-module CMP call;
    - that the target was added on that computer.
- **Default deny.** Nothing is reachable until the person at the computer adds a target, and the server cannot add or widen one. Targets are:
  - a command started without a shell, which may reach only the hosts listed for it;
  - or an `http` address on loopback.
  - Targets are read from disk on every call, so a removed target stops working at once.
- **Removing a device** in Settings disconnects it at once. The bridge stops instead of reconnecting.
- **Activity log.** Every call is logged locally (time, target, method; no contents) in `activity.log`.

Not built yet, from the SRS:
- the device key in the OS keychain or a hardware key store (it is a `0600` file in `~/.conclave-bridge`);
- mTLS with a pinned instance certificate (calls are signed with a pinned key instead; use `https`);
- OS sandboxing of stdio targets;
- local OS prompts for sensitive actions;
- per-target rate and size limits;
- a daily bridge activity summary in the inbox;
- the tray pause.

These belong with the desktop app.

## Try it

The sample module (`modules/sample-agent`) is built only with the public SDK. Its skills are `brief` and `interview`, and its workflows are `word-count` and `slow-count`.

As a sidecar:

1. Start the server with:

   ```bash
   CONCLAVE_SIDECARS="node --import tsx modules/sample-agent/src/serve.ts --stdio" npm start
   ```

2. Add a **Sidecar module** connection with that command.
3. In a workspace, add a role on the agent port and fill it with the connection and the `interview` skill.
4. Add an **Agent** step in the editor.

As a remote module:

1. Start the module with a secret of your own, at least 32 characters:

   ```bash
   CMP_SECRET=<your secret> npx tsx modules/sample-agent/src/serve.ts --http 8790
   ```

2. Add a **Remote module** connection with `http://127.0.0.1:8790/cmp` and the same secret.

Through the Local Bridge:

```bash
npx conclave-bridge pair http://127.0.0.1:8787
```

```bash
npx conclave-bridge target add sample --stdio "node --import tsx modules/sample-agent/src/serve.ts --stdio"
```

```bash
npx conclave-bridge run
```

Then add a **Local Bridge target** connection with the device's name and target `sample`.

## Tests

| File | What it checks |
| --- | --- |
| `packages/core/src/external.test.ts` | Agent and automation steps: progress, a question to the inbox and its answer, stopping, fail-on-question, On failure, cancel, timeout, picking a watch up again after a restart, the port check on save, synchronous, polled and callback results, and start failures |
| `modules/sample-agent/src/index.test.ts` | The conformance kit in process, over signed HTTP and over stdio; wrong, short, replayed and forged signatures; contract errors across CMP; egress through the host |
| `apps/server/src/docks.test.ts` | End to end over the real API: remote, sidecar, webhook (wait and callback) and Local Bridge (pairing, default deny, an agent run, removal, a wrong pinned key) |
