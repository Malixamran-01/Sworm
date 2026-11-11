# Conclave

Open-source control plane where AI models, outside agents, workflow engines and knowledge work together as one team, on your own keys. "Conclave" is a placeholder name. The full specification is the [Conclave SRS](https://claude.ai/artifact/WtojbG2iDasDGjkjVk6BKh).

This repository has **Phase 1 (Foundation)**: accounts and access, the module system's contract and SDK, the built-in durable engine, budgets, approvals, the inbox, live events, the API, the web app, and Model and Tool ports with MCP and OpenAI-compatible protocol docks. The Research Brief template runs end to end.

It also has the first slice of **Phase 2**:
- Agent and Workflow ports;
- the Conclave Module Protocol;
- the remote, sidecar and Local Bridge docks;
- a webhook protocol dock for outside workflow engines.

The design is in [docs/agent-workflow-ports.md](docs/agent-workflow-ports.md).

And the pieces that make it one coordinated, governable environment rather than a set of integrations:
- **One trace per task.** A task, its sub-tasks in other workspaces and every outside system they reach share one trace, on one timeline.
- **Insights.** Spend, reliability and the audit trail across every workspace.
- **Modules without touching Conclave.** Drop a module into a folder and it is a node in existing workflows.
- **A2A and n8n.** Any Agent2Agent agent is an Agent-port node; your n8n's published workflows are Workflow-port nodes.
- **Rules that follow the work.** Each connection and tool is allowed, needs a person first, or is never used. A sub-task keeps the limits of every workspace above it.
- **Loop guards.** A node asked the same thing over and over, and workspaces handing the same brief back and forth, are stopped.

The design is in [docs/observability-and-extensibility.md](docs/observability-and-extensibility.md).

## Run it

### With Docker (Lite profile: Conclave + Postgres with pgvector)

```bash
docker compose up -d
```

Open http://localhost:8787. Because the container listens beyond localhost, first-run setup asks for a setup code, printed in the log:

```bash
docker compose logs conclave
```

### With Node only (PGlite, no Postgres server)

Needs Node 22 or newer. PGlite (Postgres compiled to WebAssembly) keeps the data in `./data`.

```bash
npm install
```

```bash
npm run build:web
```

```bash
npm start
```

Open http://127.0.0.1:8787 and create the owner account. Then add a connection (the **Mock model** needs no key and costs nothing), create a workspace from **Research Brief**, and run a task. Invite your team from **Settings → Members**.

For development with hot reload, run the API and the Vite dev server in two terminals, then open http://localhost:5173:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONCLAVE_DATABASE_URL` | `pglite:./data/pglite` | `pglite:<dir>`, `pglite:memory` or `postgres://…` |
| `CONCLAVE_DATA_DIR` | `./data` | Where PGlite and the master key live |
| `CONCLAVE_MASTER_KEY` | generated into `data/master.key` | 32 bytes, base64. Back it up: without it, saved secrets cannot be read |
| `CONCLAVE_PUBLIC_URL` | `http://localhost:<PORT>` | The address people use; invite links and sign-in callbacks are built from it. `https://` turns on Secure cookies |
| `CONCLAVE_SETUP_CODE` | random when listening beyond localhost | Code needed to create the owner account on a reachable server |
| `CONCLAVE_GOOGLE_CLIENT_ID`, `…_SECRET` | none | Sign in with Google (OIDC) |
| `CONCLAVE_GITHUB_CLIENT_ID`, `…_SECRET` | none | Sign in with GitHub |
| `CONCLAVE_OIDC_ISSUER`, `…_CLIENT_ID`, `…_CLIENT_SECRET`, `…_NAME` | none | Any other OpenID Connect provider (Keycloak, Okta, Authentik, Microsoft…) |
| `CONCLAVE_SAML_METADATA` | none | Turns on SAML sign-in. The identity provider's metadata: an `https://` URL (read at start), a file path, or the XML itself |
| `CONCLAVE_SAML_NAME` | `single sign-on` | The button says "Continue with …" |
| `CONCLAVE_SAML_SSO_URL`, `CONCLAVE_SAML_IDP_CERT`, `CONCLAVE_SAML_IDP_ENTITY_ID` | from the metadata | Set these instead of metadata, or to override it. The certificate is a PEM or a file path |
| `CONCLAVE_SAML_SP_KEY`, `CONCLAVE_SAML_SP_CERT` | none | Optional: sign sign-in requests and accept encrypted assertions |
| `CONCLAVE_SAML_ENTITY_ID` | `<public URL>/v1/auth/saml/metadata` | This instance's entity ID |
| `CONCLAVE_SAML_IDP_INITIATED` | `false` | `true` also accepts sign-ins started from the identity provider's dashboard |
| `CONCLAVE_SAML_TRUST_EMAIL` | `true` | `false` stops linking to existing accounts by the email the provider sends |
| `CONCLAVE_SAML_EMAIL_ATTRIBUTE` | common names | The attribute that holds the email, if the provider uses an unusual one |
| `CONCLAVE_SIGNUP_DOMAINS` | none | Comma-separated email domains whose verified users may join as viewers without an invite |
| `CONCLAVE_SMTP_URL` | none | `smtp://user:pass@host:587` or `smtps://…`. Turns on email digests |
| `CONCLAVE_MAIL_FROM` | `Conclave <conclave@localhost>` | Sender of digest emails |
| `CONCLAVE_VAPID_SUBJECT` | the public URL if it is `https://` | Contact for web push (a `mailto:` or `https:` URL) |
| `CONCLAVE_PUSH_HOSTS` | the Google, Mozilla, Microsoft and Apple push services | Comma-separated hosts web pushes may go to. Other hosts are refused |
| `CONCLAVE_WEBAUTHN_ORIGINS` | none | Extra origins passkeys may be used from, such as a dev server at `http://localhost:5173` |
| `CONCLAVE_MODULES_DIR` | `<data dir>/modules` | Folder of modules installed at start: each `.js`, `.mjs` or `.ts` file, and each sub-folder with a `package.json` or an `index` file. They run inside the server, so this is the server admin's call |
| `CONCLAVE_KNOWLEDGE_DIR` | `<data dir>/knowledge` | The one folder Notes folder connections may read. Put or mount notes here, such as an Obsidian vault or a docs folder; a connection names a sub-folder of it |
| `CONCLAVE_MODULE_UPLOADS` | off | `on` lets owners install a module from a file in the app (Connections, "Your own modules"). Each one runs as its own process, not inside the server. Off by default, because it runs their code on this server |
| `CONCLAVE_MODULES` | none | More modules to install: package names or paths, separated by commas |
| `CONCLAVE_OTLP_ENDPOINT` | none (off) | Send each finished task's trace to an OpenTelemetry collector, as OTLP/HTTP JSON to `<endpoint>/v1/traces` |
| `CONCLAVE_OTLP_HEADERS` | none | Headers for the collector, as `name=value,name=value` |
| `CONCLAVE_SIDECARS` | none (sidecars off) | Commands sidecar connections may start, exactly as typed, separated by `;`, or `*` for any. Starting processes on the server is the server admin's call |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Listen address |

Sign-in callbacks for providers are `<CONCLAVE_PUBLIC_URL>/v1/auth/oidc/<google|github|oidc>/callback`.

For SAML, give the identity provider `<CONCLAVE_PUBLIC_URL>/v1/auth/saml/metadata`; Settings → Single sign-on shows each value to copy, and warns when the provider's certificate is close to expiring. Replies must have a signed assertion, answer a sign-in this instance started (within 10 minutes, each once), and name this instance as the audience. People new to the instance still need an invite or an allowed email domain.

Passkeys are tied to the host name in `CONCLAVE_PUBLIC_URL`. If you change it, people need to add their passkeys again. Browsers allow passkeys and web push only over `https://`, or on `localhost`.

### Scripts and agents

Create an access token in **Settings → Access tokens**, pick its scopes, and send it as `Authorization: Bearer cnc_…`. A token can never do more than the role of the person who made it.

## Check it

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint:core-names
```

The same tests on a real Postgres. This uses the throwaway database from `compose.test.yaml`, with one schema per test:

```bash
docker compose -f compose.test.yaml up -d
```

```bash
npm run test:pg
```

Accessibility (UX-001). Opens every screen in a browser and checks it with axe at WCAG 2.2 AA, in light and dark themes and at phone width. It also checks that no page scrolls sideways. Run `npm run build:web` first. Locally it uses Microsoft Edge; set `PW_CHANNEL=chrome` to use Chrome, or run `npx playwright install chromium` and set `PW_CHANNEL=` to use Chromium:

```bash
npm run test:a11y
```

End-to-end check against any running instance (sets up an owner if needed, runs a mock Research Brief, approves it):

```bash
node scripts/smoke.mjs http://127.0.0.1:8787
```

CI (`.github/workflows/ci.yml`) runs all of these, runs the tests on Postgres, boots the server against it, and audits dependencies.

## Layout

| Path | What it is | SRS |
| --- | --- | --- |
| `packages/contract` | Node call contract, the 12 ports, workflow schema, events, API types | 8.3, 4.11 |
| `packages/module-sdk` | `defineModule`, manifest schema, the Conclave Module Protocol (`serveHttp`, `serveStdio` and clients), the Local Bridge wire protocol, conformance kit for the Model, Tool, Agent and Workflow ports | MOD-002, MOD-003, MOD-005, MOD-006 |
| `packages/db` | One query interface over node-postgres and PGlite, migrations | 9 |
| `packages/engine` | `ExecutionEngine` and the built-in Postgres durable engine | 8.2, PROF-001 |
| `packages/core` | Accounts and access, connections, secrets, workspaces, orchestrator, budgets, inbox, outbox. Knows ports, never products | 4, 5.3, 4.12 |
| `modules/anthropic` | Claude through the official SDK: streaming, effort, server-side refusal fallback | 5.1 |
| `modules/openai-compatible` | Protocol dock for any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM…) | MOD-004 |
| `modules/mcp` | Protocol dock for any MCP server over Streamable HTTP or SSE, through the official MCP SDK | MOD-004 |
| `modules/mock-model` | Deterministic free model for tests and demos | |
| `modules/a2a` | Protocol dock for any Agent2Agent (A2A) agent over JSON-RPC, protocol 1.0 and 0.3 | MOD-004 |
| `modules/n8n` | n8n: lists published workflows over its API, starts them through their Webhook node, follows and stops the execution | MOD-004 |
| `modules/notes` | A folder of Markdown and text notes on the server as a knowledge source, searched in place by shared words (BM25); no model, no key | MOD-004 |
| `modules/search-endpoint` | Protocol dock for knowledge that lives elsewhere: any search or retrieval endpoint that answers a query with matching text | MOD-004 |
| `modules/webhook-workflow` | Protocol dock for any workflow started by a webhook, answering at once or by callback | MOD-004 |
| `modules/remote-dock` | Remote dock: a module on its own server, CMP over HTTPS with signed requests | MOD-003 |
| `modules/sidecar-dock` | Sidecar dock: a module process the server starts, CMP over stdio, egress through the server | MOD-003, MOD-010 |
| `modules/sample-agent` | A sample agent and workflow engine built only with the public SDK, servable over HTTP or stdio | MOD-014 |
| `apps/bridge` | The Local Bridge CLI: pairing, local targets (default deny), signed calls over one outbound socket | 8.8 |
| `apps/server` | Fastify API split by feature (`routes/`), access guard and sign-in providers (`auth/`), realtime hub | 8.1, 8.5, 7.3 |
| `apps/web` | React 19 + Vite + TanStack Query/Router + Tailwind, in feature folders, styled from the v2 mockups | 7 |

Every outside system is a module. To add one, write a `defineModule({ manifest, create })` that implements a port and run `runConformance` on it. Then install it without changing Conclave: put the file or folder in `<data dir>/modules` (or name it in `CONCLAVE_MODULES`) and restart. It shows up under Connections, marked as added by your admin, with what it may reach, and its nodes work in existing workflows with budgets, traces and the audit trail. A module that should not run inside the server goes in the remote, sidecar or Local Bridge dock instead. The modules that ship with Conclave are listed in `apps/server/src/main.ts`.

## What is in and what is next

**Built and tested:**
- **Accounts:** owner setup, email and password, Google, GitHub, any OIDC provider and SAML (Okta, Entra ID, Google Workspace…); passkeys for sign-in without a password, and TOTP two-factor with single-use recovery codes. A passkey also works as the second step after a password; organisations, Owner, Editor, Runner and Viewer roles, per-workspace overrides and private workspaces; invite links; scoped access tokens. Every API route declares its access rule, and a test fails if one does not.
- **Connections:** envelope-encrypted secrets, test and kill switch; egress limited to the manifest's hosts.
- **Workspaces:** created by answering a few questions, from a template, blank, or by importing a package. Includes versioning and export. Roles are filled by any Model-port or Tool-port node.
- **Node editor:** build a workflow on a canvas. Add model, tool, approval and workspace steps, and drag from one step's dot to another to say what runs after what. Each step is edited in a side panel: its role and node, prompt, brief fields and result. The panel's "Runs after" list does the same as dragging, and arrow keys move nodes. Undo and redo are included. A blank workspace opens straight in the editor. Saving checks every reference and gives the workspace a new version; running tasks keep the workflow they started with.
- **Branching and connectors:** If / Switch nodes (first match or every match, plus Else), an AI router that picks a category with a model, Merge, Text (no model) and Stop (end as done or failed). Connectors are Always, Only if (rules on the output or a JSON field), Otherwise, or On failure, and can carry an instruction for the next step. Steps where branches meet can wait for all, any, or the first. Steps can be turned off, and the canvas takes sticky notes. Loops send work back to an earlier step until rules hold for the output, up to a round limit, and each round can see the last one. Design and research: [docs/workflow-logic.md](docs/workflow-logic.md).
- **Workspace steps (sub-tasks):** a step can run a task type of another workspace, or of this one, and carry on with its output. It can stop the sub-task after a chosen step ("run up to"), and repeat it a fixed number of times, once for each item of a list, or until an output contains some text. A workflow can call itself, as long as the inner run stops before reaching that call again; the editor refuses one that never would. Guards: sub-tasks nest at most 5 deep and a task starts at most 100 of them. Each sub-task gets a share of what is left of the parent's budget. Cancelling a task cancels everything under it. A sub-task's approvals reach the inbox with the full path, and the parent reports once, at the end.
- **Agents and outside workflows:** Agent and Automation steps hand work to an outside agent or workflow engine and wait for it.
  - The wait survives restarts. Progress shows live, and an agent's questions come to the inbox, where the answer goes back to it.
  - Money is held before the step starts and charged from reported cost or the connection's prices.
  - Steps time out, are cancelled with the task, and can be caught by On failure.
  - Modules run in the remote, sidecar or Local Bridge dock through the Conclave Module Protocol. Any engine with a webhook works through the webhook dock.
  - Pair computers in **Settings → Devices**.
- **A2A agents:** any agent that publishes an Agent Card and answers JSON-RPC, in protocol 1.0 or 0.3. Its skills come from the card, its questions come to the inbox, and a run survives a restart of either side.
- **Knowledge:** a Knowledge port, and a **Look up** step that finds the passages answering a question and passes them on, numbered, each with where it came from, so a later step can cite them.
  - **Notes folder:** Markdown and text files in a folder on the server, such as an Obsidian vault or your docs. They are searched where they are, by the words they share with the question. Nothing is copied, embedded or sent anywhere, so it needs no model and no key. Each sub-folder is a source.
  - **Search endpoint:** knowledge that already lives somewhere else. Any endpoint that takes a query and answers with matching text works; the common ways of naming the text, title, address and score are read.
  - Conclave does not chunk, embed or index anything itself. How a store was filled is the store's business.
  - A lookup is a call like any other: it is priced, held and charged, checked against the rules, and shown in the trace with its own colour.
  - Any module in the remote, sidecar or Local Bridge dock can provide knowledge too; the module protocol carries it.
- **Rules (what tasks may use):** in a workspace's Settings, each connection its roles use, and each tool, is set to Allow, Ask first or Never. Owners can set the same for every workspace on the connection's card.
  - Checked before a step runs and before any money is held. A refusal fails the step with the reason, and the trace shows what the rules said.
  - The strictest rule wins: the organisation's, then every workspace above the task in its nest, then the task's own workspace. Handing work down never gives it more.
  - "Ask first" is met by an approval step earlier in the same task.
  - A tool that can change things outside Conclave (anything an MCP server does not mark read-only) needs a person first until someone allows that tool by name.
- **Loop guards:** a node that already answered exactly the same input three times in one task tree is not asked again, and a workflow that would start a task above it again with the same brief is stopped. Both fail with `loop_detected`.
- **n8n:** connect your n8n with an API key. Its published workflows that have a Webhook node are listed; a run is followed without a callback, its last node's output and its error come back, and cancelling the task stops the execution.
- **Templates:** Research Brief, plus Support Triage (an AI router and three branches), Field Research (an outside agent that may ask you a question) and Content Desk (one sub-task per planned post, side by side).
- **OpenTelemetry:** with `CONCLAVE_OTLP_ENDPOINT` set, each finished task's trace is sent once to a collector, with GenAI attributes for model, tool and agent calls. Span ids are the ones outside calls carried, so an outside system's own spans join the trace.
- **Trace:** every task has a trace of the whole tree it belongs to, opened from the task ("Open trace").
  - One timeline for the task, its sub-tasks in other workspaces, and each step attempt, with retries and loop rounds.
  - Per step: the node that did it, cost and where the figure came from, the money held before it started, who decided what, and the error.
  - Where the time went (models, tools, agents, workflow engines, waiting for people) and what each connected system cost.
  - Every outside call carries the same W3C trace id, so an outside system's own logs can be matched to a step.
- **Insights:** spend per day, by workspace, connection and model; how much of the spend is measured rather than estimated; failures, retries and average time per connection. Owners also get the audit trail: sign-ins, task starts, approvals and every change, with filters.
- **Modules from the app:** with `CONCLAVE_MODULE_UPLOADS=on`, an owner uploads one JavaScript file on the Connections page. Conclave reads what it declares in a separate process and shows its ports, the hosts it may reach and the secrets it reads; nothing is installed until they confirm.
  - An uploaded module never runs inside the server. Each connection starts its own process with none of the server's keys, and its network calls come back through the egress check.
  - That is a process boundary, not a sandbox: the process still runs as the server's operating-system user. For code that must be contained, use a sidecar connection to a container with no network.
  - Uploading the same id again replaces it; one that connections use cannot be removed; installs and removals are in the audit trail; uploads come back after a restart.
- **Remote modules without a shared secret:** this server signs each request to a remote module with its own key (Ed25519, derived from the master key). A request is good for five minutes, once, and only for that module's address. The module is started with the server's public key, shown on the Remote module form; its own public key can be pinned on the connection so answers signed by any other key are refused.
  - Shared secrets still work. A module can accept two at once, and several server keys, so either can be changed without a gap.
- **Installed modules:** modules load from a folder at start, with no change to Conclave. A broken one is skipped with the reason in the log. The connection form shows what any module may reach and which secrets it reads.
- **Tasks:** brief validation and pre-run estimates. Workflows are DAGs with role, tool and approval steps, optional steps, parallel steps, retries with backoff, timeouts and crash recovery.
- **Approvals:** approve, reject, or request changes; only the affected steps re-run.
- **Budgets and guards:** reservations per task, month and connection, a usage ledger with cost-source labels, and per-run and per-node call caps.
- **Inbox and live updates:** the inbox, a transactional outbox with live updates over WebSocket, and idempotency keys.
- **Notifications:** desktop notifications, web push and a daily or weekly email digest. Each person can set quiet hours, and each workspace can be set to all items, important items only, or inbox only. Quiet hours hold ordinary items until they end, but an approval step marked `urgent` (a safety check) still goes through.
- **Accessibility:** axe checks run in CI on every screen, and the layout works at phone width.
- **Packaging:** Dockerfile and Compose for the Lite profile.

**Still to do in Phase 1:**
- a manual WCAG 2.2 AA audit before GA (UX-001's second half)

**Later phases, in order:**
- the rest of the Local Bridge's protections, with the desktop app:
  - keychain keys;
  - OS sandboxing of targets;
  - local prompts;
  - rate limits.
- gateway keys for outside agents
- fuzzy and trigger-chain loop guards
- Hermes and OpenClaw modules
- the trigger port (schedules and inbound webhooks that start tasks)
- knowledge and the Hive
- media and automations
- the marketplace
- the Standard and Scale profiles
