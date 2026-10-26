# Agent Office release package

This folder contains the prebuilt Agent Office server and browser app. It runs on Windows or Linux with Node.js 22.12 or later. It listens on `127.0.0.1` and stores its database under `%LOCALAPPDATA%\AgentOffice` on Windows or `~/AgentOffice` on Linux by default. The Windows recipe below uses a separate UAT port and data directory so it can run beside another office instance.

## Install and start on Windows

Open PowerShell in this folder and install the locked production dependencies:

```powershell
npm.cmd ci --omit=dev
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
npm.cmd run config:validate
$env:OFFICE_HOST = '127.0.0.1'
$env:OFFICE_PORT = '4851'
$env:OFFICE_DATA_DIR = Join-Path $env:LOCALAPPDATA 'AgentOffice-UAT-__PACKAGE_ID__'
$env:OFFICE_EXECUTION_MODE = 'disabled'
npm.cmd run office:start
```

Set `MODEL_PRIMARY_BASE_URL`, `MODEL_PRIMARY_API_KEY` and `MODEL_PRIMARY_NAME` in `.env` before chatting. Keep `.env` private. `config:validate` checks the bundled agent registry without contacting the provider; use `npm.cmd run office:doctor -- --live` only when you want to make a real model request. Open <http://127.0.0.1:4851/office> and press `Ctrl+C` to stop the server. If port 4851 is in use, select a free port and open its matching URL.

## Useful commands

Run `npm.cmd run office:doctor` to check database and configuration readiness, `npm.cmd run office:backup -- --to "D:\Backups\agent-office.aobackup"` to create an online backup, and `npm.cmd run office:restore -- --from "D:\Backups\agent-office.aobackup" --to-data-dir "D:\AgentOffice-Restored"` to restore into a new data folder. See [the user guide](docs/AGENT-OFFICE-USER-GUIDE.md), [the UAT checklist](docs/AGENT-OFFICE-UAT-CHECKLIST.md), and [the test report](docs/AGENT-OFFICE-TEST-REPORT.md).

The package contains no `.env`, API key, workspace, database, or user data. The `release-manifest.json` records each bundled file's SHA-256 hash and a deterministic hash for the package contents. Run `npm.cmd run config:validate` after changing the model or agent configuration.

## Visual references

These production Chromium captures use synthetic smoke-test data and show the project sidebar and working agent, visual settings, and Activity feed:

- [Working office view](visual-evidence/office-r78-working.png)
- [Visual settings](visual-evidence/office-r78-settings.png)
- [Activity feed](visual-evidence/office-r78-activity.png)

## License and plan

Agent Office reuses artwork and renderer code from [Habblaud](https://github.com/marmottajr/habblaud) under the MIT License; see [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [the implementation plan](docs/planning/agent-office/README.md).
