# Conclave

Open-source control plane where AI models, outside agents, workflow engines and knowledge work together as one team, on your own keys. "Conclave" is a placeholder name. The full specification is the [Conclave SRS](https://claude.ai/artifact/WtojbG2iDasDGjkjVk6BKh).

This repository is **Phase 1 (Foundation)**: accounts and access, the module system's contract and SDK, the built-in durable engine, budgets, approvals, the inbox, live events, the API, the web app, and Model and Tool ports with MCP and OpenAI-compatible protocol docks. The Research Brief template runs end to end.

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
| `CONCLAVE_SIGNUP_DOMAINS` | none | Comma-separated email domains whose verified users may join as viewers without an invite |
| `CONCLAVE_SMTP_URL` | none | `smtp://user:pass@host:587` or `smtps://…`. Turns on email digests |
| `CONCLAVE_MAIL_FROM` | `Conclave <conclave@localhost>` | Sender of digest emails |
| `CONCLAVE_VAPID_SUBJECT` | the public URL if it is `https://` | Contact for web push (a `mailto:` or `https:` URL) |
| `CONCLAVE_PUSH_HOSTS` | the Google, Mozilla, Microsoft and Apple push services | Comma-separated hosts web pushes may go to. Other hosts are refused |
| `CONCLAVE_WEBAUTHN_ORIGINS` | none | Extra origins passkeys may be used from, such as a dev server at `http://localhost:5173` |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Listen address |

Sign-in callbacks for providers are `<CONCLAVE_PUBLIC_URL>/v1/auth/oidc/<google|github|oidc>/callback`.

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
| `packages/module-sdk` | `defineModule`, manifest schema, conformance kit for Model and Tool ports | MOD-002, MOD-005, MOD-006 |
| `packages/db` | One query interface over node-postgres and PGlite, migrations | 9 |
| `packages/engine` | `ExecutionEngine` and the built-in Postgres durable engine | 8.2, PROF-001 |
| `packages/core` | Accounts and access, connections, secrets, workspaces, orchestrator, budgets, inbox, outbox. Knows ports, never products | 4, 5.3, 4.12 |
| `modules/anthropic` | Claude through the official SDK: streaming, effort, server-side refusal fallback | 5.1 |
| `modules/openai-compatible` | Protocol dock for any OpenAI-compatible endpoint (OpenAI, Ollama, vLLM…) | MOD-004 |
| `modules/mcp` | Protocol dock for any MCP server over Streamable HTTP or SSE, through the official MCP SDK | MOD-004 |
| `modules/mock-model` | Deterministic free model for tests and demos | |
| `apps/server` | Fastify API split by feature (`routes/`), access guard and sign-in providers (`auth/`), realtime hub | 8.1, 8.5, 7.3 |
| `apps/web` | React 19 + Vite + TanStack Query/Router + Tailwind, in feature folders, styled from the v2 mockups | 7 |

Every outside system is a module. To add one, write a `defineModule({ manifest, create })` that implements a port, run `runConformance` on it, and add it to the module list in `apps/server/src/main.ts`.

## What is in and what is next

**Built and tested:**
- **Accounts:** owner setup, email and password, Google, GitHub and any OIDC provider; passkeys for sign-in without a password, and TOTP two-factor with single-use recovery codes. A passkey also works as the second step after a password; organisations, Owner, Editor, Runner and Viewer roles, per-workspace overrides and private workspaces; invite links; scoped access tokens. Every API route declares its access rule, and a test fails if one does not.
- **Connections:** envelope-encrypted secrets, test and kill switch; egress limited to the manifest's hosts.
- **Workspaces:** created by answering a few questions, from a template, blank, or by importing a package. Includes versioning and export. Roles are filled by any Model-port or Tool-port node.
- **Node editor:** build a workflow on a canvas. Add model, tool, approval and workspace steps, and drag from one step's dot to another to say what runs after what. Each step is edited in a side panel: its role and node, prompt, brief fields and result. The panel's "Runs after" list does the same as dragging, and arrow keys move nodes. Undo and redo are included. A blank workspace opens straight in the editor. Saving checks every reference and gives the workspace a new version; running tasks keep the workflow they started with.
- **Branching and connectors:** If / Switch nodes (first match or every match, plus Else), an AI router that picks a category with a model, Merge, Text (no model) and Stop (end as done or failed). Connectors are Always, Only if (rules on the output or a JSON field), Otherwise, or On failure, and can carry an instruction for the next step. Steps where branches meet can wait for all, any, or the first. Steps can be turned off, and the canvas takes sticky notes. Loops send work back to an earlier step until rules hold for the output, up to a round limit, and each round can see the last one. Design and research: [docs/workflow-logic.md](docs/workflow-logic.md).
- **Workspace steps (sub-tasks):** a step can run a task type of another workspace, or of this one, and carry on with its output. It can stop the sub-task after a chosen step ("run up to"), and repeat it a fixed number of times, once for each item of a list, or until an output contains some text. A workflow can call itself, as long as the inner run stops before reaching that call again; the editor refuses one that never would. Guards: sub-tasks nest at most 5 deep and a task starts at most 100 of them. Each sub-task gets a share of what is left of the parent's budget. Cancelling a task cancels everything under it. A sub-task's approvals reach the inbox with the full path, and the parent reports once, at the end.
- **Tasks:** brief validation and pre-run estimates. Workflows are DAGs with role, tool and approval steps, optional steps, parallel steps, retries with backoff, timeouts and crash recovery.
- **Approvals:** approve, reject, or request changes; only the affected steps re-run.
- **Budgets and guards:** reservations per task, month and connection, a usage ledger with cost-source labels, and per-run and per-node call caps.
- **Inbox and live updates:** the inbox, a transactional outbox with live updates over WebSocket, and idempotency keys.
- **Notifications:** desktop notifications, web push and a daily or weekly email digest. Each person can set quiet hours, and each workspace can be set to all items, important items only, or inbox only. Quiet hours hold ordinary items until they end, but an approval step marked `urgent` (a safety check) still goes through.
- **Accessibility:** axe checks run in CI on every screen, and the layout works at phone width.
- **Packaging:** Dockerfile and Compose for the Lite profile.

**Still to do in Phase 1:**
- SAML sign-in
- a manual WCAG 2.2 AA audit before GA (UX-001's second half)

**Later phases, in order:**
- Agent and Workflow ports, with sidecar, remote and bridge docks
- gateway keys for outside agents
- fuzzy, ping-pong and trigger-chain loop guards
- Hermes, OpenClaw, n8n and A2A modules
- knowledge and the Hive
- the workflow editor
- media and automations
- the marketplace
- the Standard and Scale profiles
