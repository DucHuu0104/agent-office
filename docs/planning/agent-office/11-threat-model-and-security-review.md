# 11 — Threat model and security review

Review date: 2026-10-26. This review covers the local-first Agent Office v1 described by the implementation plan. It is an implementation and test-evidence review, not a penetration test, formal security certification, or review by an independent security team.

## Scope and assumptions

The product is a single-owner application bound to loopback. The owner selects model endpoints, agent definitions, workspace roots and execution mode. The server and data directory run under the owner's OS account. The design does not claim isolation from another process running as that same account, a compromised OS account, a compromised Docker daemon/kernel, or malicious model infrastructure. Multi-user access, remote workers, public binding and third-party write connectors are outside v1.

The security objective is to keep model and retrieved content from expanding server-side authority; keep file and network tools within the owner's grants; require review for consequential writes; preserve enough durable evidence to avoid silently repeating ambiguous effects; and keep credentials and unrelated project data out of browser payloads, agent context and subprocess environments.

## Assets and trust boundaries

| Asset | Trusted owner | Untrusted inputs or boundary |
| --- | --- | --- |
| Model credentials and endpoint | Owner configuration, server process | Model output, project text, uploaded files, websites and tool output |
| Project workspace and attached files | Owner-selected root and project policy | Agent-supplied paths and concurrent file changes |
| Agent identity, skills, tools and hooks | Validated, owner-installed registry | User requests cannot add tools or alter policy through workspace files |
| Run/task/approval state | SQLite transactions and fenced runtime | Browser retries, stale tabs, worker crashes and provider failures |
| Public web access | Research adapter and pinned DNS answers | Search results, redirects, DNS answers and page contents |
| Browser session | Local server session map and CSRF token | Cross-origin requests and untrusted event/model content |
| Backup bundle | Owner-selected destination and checksums | Malformed manifests, path traversal, missing/tampered payloads |

## Threat review and evidence

| Threat | Enforced controls | Evidence |
| --- | --- | --- |
| SSRF to loopback, private, link-local, metadata or encoded IPv4 destinations | Research fetch accepts HTTPS on port 443 only; rejects userinfo and local names; resolves every DNS answer and requires every address to be public; pins the validated answer for the connection; revalidates each redirect, limits redirects, body size and time. IPv4-mapped, NAT64, 6to4 and reserved IPv6 ranges are rejected. | `network-policy.test.ts`, `tools.test.ts`: mixed public/private DNS, DNS family mismatch, public-to-private redirects, DNS pinning, credential redirect refusal, numeric IPv4 spellings, IPv4-mapped/NAT64 and IANA dummy-prefix cases. |
| Prompt injection in websites, attachments, memory or tool results | Retrieved content is labeled untrusted reference data; role tool allowlists, schema validation, project scope and approval policy are checked server-side. Model text cannot add a tool or bypass the broker. | `runtime.security.test.ts` exercises web and memory injection through a real runtime and confirms an unauthorized workspace write is not dispatched; `http.test.ts` validates attachment handling; `eval-corpus.test.ts` keeps synthetic injection fixtures. |
| Workspace traversal, secrets, links or overwrite races | Workspace roots are owner-selected. A common path validator rejects traversal, absolute/UNC/device/ADS and sensitive paths. Reads/listings/writes refuse symlinks and junctions; snapshot creation omits symlinks and hard links; writes use checksum-based compare-and-swap and approvals bind to exact arguments. | `tools.test.ts`, `executor.test.ts`, `runtime.approvals.test.ts` and `assignment-leases.test.ts` cover traversal, secret paths, links, hard links, stale checksums, exact approved bytes and stale-worker dispatch. |
| Unauthorized browser mutation or stale approval | Local session cookie is HttpOnly and SameSite=Strict; write routes require the session CSRF token and same-origin checks. Approval decisions bind to a durable operation and arguments hash, expire, and use conditional state transitions. | `http.test.ts` CSRF and pause/resume cases; `runtime.approvals.test.ts` concurrent, expired, stale and changed-argument decisions. |
| Credential leakage through browser, child process, hooks, logs or backup | Credentials remain in server configuration; redacted configuration omits key values; subprocess environments are allowlisted; hook/event payloads omit prompts, raw tool arguments and credential-like content; release packages exclude `.env`; backup rejects secret-like configuration and checksums all payload files. | `config.test.ts`, `hooks.test.ts`, `executor.test.ts`, `operations.test.ts`, `uat-package-smoke.mjs` and release-manifest verification. |
| Duplicate or uncertain side effects after crash/retry | Durable operation IDs and receipts, assignment fencing, checkpoint transactions, approval CAS and `outcome_unknown` pauses prevent blind re-dispatch where the result cannot be reconciled. | `runtime.approvals.test.ts`, `runtime.dispatch-crash.test.ts`, `assignment-leases.test.ts`, `artifacts.crash.test.ts` and `hooks.crash.test.ts`. |
| Malicious or accidental process execution | Execution defaults to disabled. `local-trusted` is an explicit owner choice and is not a filesystem sandbox. Docker checks use an image pinned by digest, a filtered temporary snapshot, no network by default, read-only root, dropped capabilities, no-new-privileges, a non-root user, resource limits and container cleanup. Network-enabled previews and dependency installation require explicit consent and reviewed checksums. | `executor.test.ts`, `workspace-previews.test.ts`, plus the real Docker opt-in suite: 312 passed, 1 skipped; no test containers remained. |
| Resource exhaustion or runaway model work | Request, token, tool, plan, run and output sizes are bounded; HTTP streams have backpressure/replay limits; model usage is reserved before calls; unknown pricing is not shown as zero. | `runtime.concurrency.test.ts`, `runtime.planning.test.ts`, `usage.test.ts`, `http.load.test.ts` and the eight-hour SSE soak report. |
| Malformed or downgraded storage/backup | Database migrations snapshot before schema changes and reject future schemas; backup/restore validates manifest shape, paths, checksums, database integrity, artifacts and registry revision before publishing into a new directory. | `database-migration.test.ts`, `operations.test.ts`; package rollback smoke covers older binary against a schema it supports. |

Public address classification is deliberately conservative. Its deny-list is informed by the current IANA IPv4 and IPv6 special-purpose registries and also rejects transition/translation prefixes that can encode private IPv4 destinations: [IPv4 registry](https://www.iana.org/assignments/iana-ipv4-special-registry), [IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry). The implementation does not claim to block every special-purpose assignment: a few IPv4 reservations marked globally reachable by IANA remain reachable unless covered by another denied range. The registry distinguishes those from non-global destinations, which are the SSRF boundary enforced here.

## Residual risks and operating limits

- Loopback plus browser CSRF controls protect the intended local browser flow. They are not authentication or a boundary against another process running as the same OS user. Keep the service bound to loopback and protect the local account and data directory.
- `local-trusted` scripts execute with the owner's OS privileges. Docker reduces exposure but shares a host kernel and depends on Docker Desktop/Engine; it is not a VM boundary. Review scripts and lockfiles before approval, especially when enabling bridge networking or running `npm ci` lifecycle hooks.
- Model and retrieved content remain probabilistic and can mislead the model. Server-side tool policy limits effects, but owners still review results and approvals. The live multi-task quality baseline has not been manually scored.
- USD ceilings cannot be guaranteed when a model profile has no verified price. Token limits still apply, but configure and verify profile prices before authorizing a cost-bounded live evaluation.
- The application has no multi-user authentication, remote binding, independent penetration-test report, hosted Windows CI result, or external security certification. These remain release gates or post-v1 work; do not infer them from local tests.
- A concurrent process under the same owner account can change files while the application is running. Checksum/CAS checks protect reviewed writes, while the product does not claim protection from a malicious same-account process with equivalent filesystem access.

## Verification record

The security-focused regression command is:

```powershell
npm exec vitest run server/platform/network-policy.test.ts server/platform/tools.test.ts server/platform/runtime.security.test.ts -- --maxWorkers=1 --pool=threads
```

On 2026-10-26 it passed 54/54 tests after adding coverage for decimal, hexadecimal and octal IPv4 loopback spellings, IPv4-mapped IPv6, NAT64 and the IANA dummy IPv6 prefix. The complete platform suite and package smoke are tracked in `docs/AGENT-OFFICE-TEST-REPORT.md`. No real provider call is part of these security tests.
