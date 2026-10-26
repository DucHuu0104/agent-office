<p align="center"><img src="client/public/assets/brand/logo-mark@4x.png" width="96" alt="Pixel-art office" /></p>

<h1 align="center">Agent Office</h1>

<p align="center"><b>A local-first workspace for a team of AI agents.</b><br />Persistent project rooms, one Coordinator per project, and shared specialists that join when their work is ready.</p>

## What it is

Agent Office is a general-purpose multi-agent assistant for coding, research, writing, and data analysis. It starts from the MIT-licensed Habblaud codebase to reuse its pixel-art assets and office renderer. Its project, roster, model, storage, and agent runtime are separate from Habblaud's Claude Code and Codex session tracking. See [LICENSE](LICENSE) and [the implementation plan](docs/planning/agent-office/README.md).

The product is under active development. Each feature is considered ready only after it has implementation and acceptance evidence.

For project workflows, specialist management, approvals, artifacts, memory, backup and troubleshooting, see the [Agent Office user guide](docs/AGENT-OFFICE-USER-GUIDE.md).

## Run on Windows

Requires Node.js 22.12 or later and npm. Install dependencies and create `.env` if this is a fresh checkout:

```powershell
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
npm.cmd run config:validate
```

Set `MODEL_PRIMARY_BASE_URL`, `MODEL_PRIMARY_API_KEY` and `MODEL_PRIMARY_NAME` in `.env` for the Coordinator's OpenAI-compatible provider. Keep `.env` private. `config:validate` checks the agent registry without opening the database or making a model request. Start the office once to initialize the local database:

```powershell
npm.cmd run office:dev
```

Open `http://127.0.0.1:4849/office`. The server binds to loopback. Press `Ctrl+C` to stop it. The SQLite database is created under `%LOCALAPPDATA%\AgentOffice` on first start.

The usage panel always reports token usage. It reports money only when you configure a matching owner price profile. Transient connection failures and HTTP 429/5xx responses retry up to three attempts; every attempt reserves its own token budget, and calls without confirmed provider usage remain conservatively reserved.

To enforce a USD limit, add an owner-maintained `pricing` block to every model profile used by your agents in `config/models.yaml`. Set its `modelName` to the exact model ID in that profile's `.env` variable, give it a manually versioned `version`, and copy input/output prices per million tokens from your provider's current pricing page. Then set `moneyBudgetUsd` in `config/policies.yaml`. Agent Office does not assume or invent provider prices. If a price is missing or its model ID does not match, calls are marked unpriced; a run with a USD limit stops before sending a request unless it has a matching price. Restart Agent Office after changing model or policy configuration.

In another PowerShell window, run `npm.cmd run office:doctor` to check SQLite integrity, required tables, foreign keys, registry and Coordinator model readiness. Doctor opens the database read-only, so it can run while the office is active. To explicitly test text generation, run `npm.cmd run office:doctor -- --live`; that sends a small request to the Coordinator's configured model profile and may incur provider usage. Add `--tools` to also test function calling, or `--profile primary-responses` to probe another registered profile without changing the Coordinator configuration. A profile using its own environment variable names requires those values to be configured explicitly; it will not inherit the primary profile's credentials.

Only one Agent Office server can use a data directory at a time. A second start exits with an “already running” error; the operating system releases the lock if the owning process exits unexpectedly.

For the production bundle:

```powershell
npm.cmd run office:build
npm.cmd run office:start
```

To stage a self-contained Windows/Linux release directory after building, run `npm.cmd run office:package`. The output is `release/agent-office-<version>`; see its generated README for install and start instructions. Use `-- --output-dir <path>` to choose a new output directory.

Validate the agent registry without opening the database:

```powershell
npm.cmd run config:validate
```

Run the checks used for the Agent Office product on Windows:

```powershell
npm.cmd run typecheck
npm.cmd run office:test
npm.cmd run office:client-test
npm.cmd run eval:validate
npm.cmd run i18n:check
npm.cmd run office:build
node node_modules/playwright-core/cli.js install chromium
npm.cmd run office:browser-test
```

The model-free `eval:validate` command checks the fixture-backed 40-task v1 quality corpus: ten coding, research, analysis, and orchestration/recovery tasks, each with expected properties, tool grants, acceptance criteria, a cost cap, and a reviewer rubric. It validates corpus structure; single-agent versus multi-agent quality and cost measurements still require recorded model runs.

The agent roster shows ready, busy, and draining specialists. Use the pause control to stop an agent receiving new tasks; its active task can finish. Use the resume control to return it to the pool. Drain state is stored locally and survives registry reloads and server restarts.

The browser smoke starts temporary production and development servers with isolated storage, creates ten project rooms with distinct Coordinators, checks keyboard selection and archive/restore, recovers from a simulated offline/online transition while preserving the selected room, then renders a 30-agent room fixture and records pan/zoom frame timing. It also tests draining and resuming a specialist, stale approval recovery and approve/deny actions, failed-task details, reduced motion, a 390px mobile viewport, invalid project-form input and reload persistence. A local fake model provider drives one real scheduler assignment through to a verified artifact; a second isolated server checks workspace website preview consent, separate-tab isolation, cookie filtering and stop cleanup. The smoke makes no external model calls.

Workspace checks are disabled by default. To use Docker, set `OFFICE_EXECUTION_MODE=docker` in `.env` and set `approvals.shell: docker` in `config/policies.yaml`. Pull the configured image yourself before running checks; Agent Office never pulls or builds an image automatically. Docker images must be pinned by SHA-256 digest; the default image is pinned. Docker runs use a temporary filtered workspace copy, a read-only container root, no Linux capabilities, no host environment variables, and resource limits for CPU, memory, processes, output and time. The default network is disabled; `OFFICE_DOCKER_NETWORK=bridge` explicitly allows network access and is shown in the approval.

Docker copies existing `node_modules` by default. To install platform-compatible dependencies inside the Linux container, set `OFFICE_DOCKER_INSTALL_DEPENDENCIES=npm-ci` and `OFFICE_DOCKER_NETWORK=bridge`. Agent Office then excludes host `node_modules`, verifies and shows the package lock hash, and previews the project's npm install hooks. `npm ci` and dependency lifecycle scripts run only after approval, inside the same resource-limited container policy; no Agent Office keys or host environment are passed in. The exact scripts, lifecycle hooks, image, network access and limits appear before approval. The container and temporary copy are removed after the run.

You can instead opt into `OFFICE_EXECUTION_MODE=local-trusted` while `approvals.shell: local-trusted` remains enabled. That mode runs the approved scripts with the current Windows account's permissions and network access; it is not a security sandbox. Both modes run on a temporary workspace copy, and the user approves every run.

Projects attached to a workspace can also open a managed website preview by selecting a reviewed `dev`, `preview`, `start` or `serve` script. The UI shows the command and lifecycle hooks, then requires network-access confirmation. Docker previews use bridge networking with configured CPU, memory and process limits; local-trusted previews use the current Windows account. The preview runs from a filtered temporary copy, has a 30-minute TTL, opens in its own loopback tab, strips cookies and cannot be embedded. When Docker `npm ci` is enabled, the exact lockfile checksum must still match the one reviewed before installation starts. See the [user guide](docs/AGENT-OFFICE-USER-GUIDE.md#ph%C3%AA-duy%E1%BB%87t-thao-t%C3%A1c-v%C3%A0-xem-k%E1%BA%BFt-qu%E1%BA%A3) for the complete flow.

Research uses DuckDuckGo HTML results by default. To use Brave Search, set `OFFICE_RESEARCH_PROVIDER=brave` and provide `RESEARCH_BRAVE_API_KEY` in `.env`; the key stays on the server and is sent only in the provider's authentication header. The app reports when the selected provider is not configured, and provider requests reject redirects so the key cannot be forwarded to another host.

The memory section supports four isolated scopes: user preferences, conventions for one agent definition, project decisions, and scratch notes for one run. The form lets the owner create user, agent, or project notes and edit or delete them with revision checks. Agents can propose project notes for owner review and write scratch notes that stay inside the current run. Each Coordinator or specialist receives only the scopes declared in its `memoryScopes`; deleted notes are replaced by content-free tombstones. The owner can export long-term memory with its revision history and import it into matching existing projects and agent definitions. Imports add records, skip identical IDs and reject conflicts without overwriting; run scratch notes are excluded.

Agent definitions may also configure lifecycle hooks in `hooks.yaml`. The current built-in handlers load project context before a run, audit a tool's intent by storing only its argument hash before execution, and propose a successful run summary as project memory for owner review. Hook configuration is validated against an event/handler allowlist and each hook has a timeout and `fail` or `warn` policy; arbitrary hook code is not loaded.

Create an online backup bundle while the office is running, or restore it into a new data directory:

```powershell
npm.cmd run office:backup -- --to "D:\Backups\agent-office.aobackup"
npm.cmd run office:restore -- --from "D:\Backups\agent-office.aobackup" --to-data-dir "D:\AgentOffice-Restored"
```

The bundle includes an online SQLite snapshot, referenced artifact files, and the `agents/`, `skills/`, and `config/` trees. It records file hashes and the registry revision. Restore verifies every hash, SQLite integrity, artifact checksums, and the agent registry before publishing the new directory. Existing destinations are refused. Secrets and environment files are excluded; move credentials into `.env` environment variables and back up that file securely separately. After restore, set both `OFFICE_DATA_DIR` and `OFFICE_CONFIG_DIR` in `.env` to the paths printed by the restore command. Older `.sqlite` backups remain restorable, but do not contain artifacts or configuration.

For local data minimization, the office prunes terminal-run checkpoints and raw tool receipts after 14 days, and removes the old prefix of domain events after 30 days. It runs on startup and once a day. Active-run recovery evidence, conversations, artifacts and long-term memory are retained. A client whose event cursor predates the retained history is told to reload the current office snapshot.

To add a specialist while the office is running, add its package under `agents/definitions/`, add any skills under `skills/`, and append an instance to `agents/roster.yaml`. Use existing model profiles and tools, then run `npm.cmd run config:validate`. In the office sidebar, choose **Carregar novos agentes** and review the confirmation. Hot loading accepts new specialist definitions and roster entries; changes to installed definitions, tools, profiles, or policy need a server restart. The roster pause/resume control drains or reactivates a specialist while preserving an active assignment.

Model protocol is selected by the agent's `modelProfile` and the explicit `protocol` in `config/models.yaml`; the URL never determines the protocol. The built-in `primary` and `coding` profiles use Chat Completions. `primary-responses` uses separate `MODEL_RESPONSES_BASE_URL`, `MODEL_RESPONSES_API_KEY`, and `MODEL_RESPONSES_NAME` variables so it can target a Responses-compatible provider without changing the primary model. Assign an agent to `primary-responses` only after `npm.cmd run office:doctor -- --live --tools --profile primary-responses` succeeds, then restart the server.

The plan, including product scope, architecture, work packages, and acceptance scenarios, is in [docs/planning/agent-office](docs/planning/agent-office/README.md).

## Reused artwork and license

The initial office artwork and renderer come from [Habblaud](https://github.com/marmottajr/habblaud), copyright (c) 2026 Márcio Junior, under the MIT License. The upstream license, attribution, and source revision are retained in this repository; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Agent Office has its own project rooms, agent roster, runtime, storage, and model configuration; it does not report its agents as Claude Code or Codex sessions.
