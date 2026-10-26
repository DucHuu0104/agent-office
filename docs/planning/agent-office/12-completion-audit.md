# 12 — Kiểm toán hoàn tất implementation

Ngày kiểm tra: 27/10/2026. Phạm vi là toàn bộ P0–P8 trong [07-delivery-backlog.md](07-delivery-backlog.md); P9 được xác định riêng là sau v1. Trạng thái nói về bằng chứng kỹ thuật hiện có, không thay cho nghiệm thu của owner. Ma trận T01–T30 chi tiết nằm trong [báo cáo kiểm thử](../../AGENT-OFFICE-TEST-REPORT.md).

`Đạt` nghĩa là implementation và kiểm tra tương ứng đã có bằng chứng. `Một phần` nghĩa là còn điều kiện đã ghi rõ. `Owner` là thao tác được kế hoạch giao cho người sở hữu sản phẩm.

## P0 — Nền tảng

| ID | Trạng thái | Bằng chứng và việc còn lại |
| --- | --- | --- |
| P0.01 | Đạt | Source nằm trong clone riêng D:\agent-office, branch codex/agent-office-v1, giữ LICENSE/third-party notices và upstream SHA. Remote Habblaud được đặt tên upstream; remote sản phẩm công khai là origin (DucHuu0104/agent-office). |
| P0.02 | Đạt | Lockfile pin dependency; clean install và SQLite native được kiểm tra trên Windows/Node 22.12 trước đó và Linux/Node 22.12 trong lần CI emulation hiện tại. |
| P0.03 | Một phần | Fake/contract tests có cho Responses và Chat Completions; Agnes Chat Completions text/tool chạy live. Agnes không công bố Responses endpoint; live multi-turn Responses trả HTTP 400 nên profile này để chưa cấu hình. |
| P0.04 | Đạt | Canonical schemas, IDs, events, fixtures và quyết định kiến trúc nằm trong `shared/platform/` và các tài liệu 02–06/09. |
| P0.05 | Đạt | Scripts build/test/config validation chạy trên PowerShell và Linux Node 22.12. |
| P0.06 | Đạt | Threat model và policy ghi trong tài liệu 11; Docker executor thật đã qua 12/12 ca với network/resource/mount/cancel/cleanup kiểm chứng. |
| P0.07 | Đạt | Entry point mới chạy runtime độc lập; smoke xác nhận không cần watcher/uplink/installer Habblaud cũ. |
| P0.08 | Một phần | Hosted GitHub run #40373063610: Linux thành công; Windows platform checks thành công nhưng Chromium smoke chưa qua bước offline-indicator. Nhánh hiện tại đã thêm browser-online guard và regression test giữ phản hồi refresh thành công qua lúc offline; local full Chromium smoke và test platform đều qua. Cần chạy lại hosted Windows CI. |

## P1 — Domain và lưu trữ

| ID | Trạng thái | Bằng chứng |
| --- | --- | --- |
| P1.01 | Đạt | Schema/state-transition/domain-error regressions trong platform suite. |
| P1.02 | Đạt | SQLite worker, migrations, repositories và single-instance lock; Node 22.12 install, migration, restart và rollback checks. |
| P1.03 | Đạt | Transactional event/outbox, replay và cursor recovery tests. |
| P1.04 | Đạt | Idempotency, compare-and-swap, CSRF, Host/Origin và stale-command tests. |
| P1.05 | Đạt | Registry loader, hash/revision, invalid config và immutable runtime snapshot tests. |
| P1.06 | Đạt | Env/profile loader, redaction, doctor và missing-credential/no-network tests. |
| P1.07 | Đạt | Tool registry, allowlist, permission and approval broker tests. |
| P1.08 | Đạt | Repository/API fixtures, transaction rollback, migration and restore smoke tests. |

## P2 — Project, roster và chat

| ID | Trạng thái | Bằng chứng |
| --- | --- | --- |
| P2.01 | Đạt | Atomic project/Coordinator creation, duplicate retries and multi-tab regressions. |
| P2.02 | Đạt | Archive/restore preserves IDs and conversations; production browser smoke retains ten projects across restart. |
| P2.03 | Đạt | Shared roster, availability, room counts and office snapshot tests. |
| P2.04 | Đạt | Project picker/create/drawer, required-field validation and keyboard browser checks. |
| P2.05 | Đạt | Persistent chat, validated text attachments, checksums and project-switch draft handling. |
| P2.06 | Đạt | SSE resume/replay/deduplication, stale cursor reset and multi-tab synchronization. |
| P2.07 | Đạt | Pool and Coordinator-ready states work with missing model credentials without background model calls. |
| P2.08 | Đạt | Agent Office has a persistent Vietnamese/English selector; production browser smoke switches EN → VI → EN and verifies translated settings. Keyboard selection, empty/error states and room lifecycle are covered. The shared office catalog also now validates 3,256 entries in VI. |

## P3 — Một agent làm việc thật

| ID | Trạng thái | Bằng chứng |
| --- | --- | --- |
| P3.01 | Đạt | Canonical gateway and fake/Responses adapter contracts, fragmented streams, tool IDs and usage tests. |
| P3.02 | Đạt | Chat Completions adapter capability, multi-tool, cancellation and error tests. |
| P3.03 | Đạt | Skill/context assembly and manifest-scoped user/agent/project/run memory tests. |
| P3.04 | Đạt | Durable transcript/checkpoints, restart recovery and live provider run evidence. |
| P3.05 | Đạt | Intent/approval/receipt, read/write/patch/artifact and ambiguous-outcome reconciliation. |
| P3.06 | Đạt | Pause/cancel, process lifecycle, heartbeat and worker cleanup regressions. |
| P3.07 | Đạt | Turn/tool/token/USD limits, concurrent reservation, unknown usage and retry accounting. |
| P3.08 | Đạt | Live single-agent C10 pair and workspace/tool workflows; execution evidence is separate from human quality scoring. |

## P4 — Điều phối và đội ngũ

| ID | Trạng thái | Bằng chứng |
| --- | --- | --- |
| P4.01 | Đạt | DAG validation, bounded repair and no-dispatch-on-invalid-plan tests. |
| P4.02 | Đạt | Capability matching, ready queue and reservation/fairness regressions. |
| P4.03 | Đạt | Unique live assignment and concurrent reserve/release tests. |
| P4.04 | Đạt | Lease ACK, expiry, fencing tokens and stale-worker rejection. |
| P4.05 | Đạt | Dependency readiness, handoff input and evidence contracts. |
| P4.06 | Đạt | Reviewer findings tied to artifact revisions and bounded repair loop. |
| P4.07 | Đạt | Global/provider limits and atomic token/USD budget reservation under concurrent load. |
| P4.08 | Đạt | Steering/follow-up, cancel cascade, aggregate run state and restart recovery. |

## P5 — Văn phòng trực quan

| ID | Trạng thái | Bằng chứng và việc còn lại |
| --- | --- | --- |
| P5.01 | Đạt | Project IDs and unassigned pool map to distinct canvas areas. |
| P5.02 | Đạt | Persistent rooms, archive/restore and selection fallback after overlapping refresh. |
| P5.03 | Đạt | Assignment events move the one canonical agent character into/out of project rooms. |
| P5.04 | Đạt | Task state, dependencies and assigned/planned counters derive from backend snapshots. |
| P5.05 | Đạt | Project, agent, run, timeline, budget and artifact views are linked to API state. |
| P5.06 | Đạt | Approvals, failure/reconnect, reduced motion and 390px layout pass production Chromium. |
| P5.07 | Đạt | Ten-room/30-project-agent/36-character smoke; latest pan/zoom 37.71 FPS, frame p95 33.4 ms. |
| P5.08 | Một phần | Automated visual smoke verifies sidebar, assignment movement, bubbles, settings, Activity ticker/feed/toast and safe event labels. Pixel-level owner acceptance remains in UAT checklist. |

## P6 — Đa năng và mở rộng

| ID | Trạng thái | Bằng chứng và việc còn lại |
| --- | --- | --- |
| P6.01 | Đạt | Coordinator/Developer/Reviewer packages and role/tool contracts are fixture-backed. |
| P6.02 | Đạt | Docker and local-trusted modes have explicit policy, limits, preview isolation, cancellation and process cleanup; Docker tests passed 12/12. |
| P6.03 | Đạt | Snapshot/patch/check workflow preserves unrelated dirty files, binds approval to hashes, tests evidence and does not deploy. |
| P6.04 | Đạt | Researcher/Writer with keyless DuckDuckGo and source provenance; live search and official-page fetch passed. |
| P6.05 | Đạt | CSV summaries are deterministic and checked against independent fixture arithmetic. Runtime now appends a complete verified metrics table to Analyst task output, Markdown/plain-text artifacts and final Coordinator reply; duplicate reports for the same summary and unsupported report MIME formats are rejected. Integration tests deliberately use an incomplete model answer and verify all three outputs. |
| P6.06 | Đạt | Hooks, memory summaries/revisions, deletion, export/import and retention have restart/idempotency tests. |
| P6.07 | Đạt | Config-added Designer is previewed, applied without scheduler edits, assigned, drained and returned to pool in browser smoke. |
| P6.08 | Đạt | Coding, research, CSV and orchestration workflows are covered by deterministic E2E and live task evidence; output quality is still awaiting manual rubric review. |

## P7 — Độ tin cậy và đánh giá

| ID | Trạng thái | Bằng chứng và việc còn lại |
| --- | --- | --- |
| P7.01 | Đạt | Model/tool/checkpoint/commit hard-kill matrix and recovery tests; see T11/T13 in the test report. |
| P7.02 | Đạt | Duplicate idempotent commands, lost acknowledgments and ambiguous writes are reconciled or quarantined without blind replay. |
| P7.03 | Đạt | Windows traversal/junction/secret, SSRF and prompt-injection suites; path flavor regression is included in the latest Linux run. |
| P7.04 | Đạt | Eight-hour isolated SSE/load soak plus slow-client, replay, lease and repeated-worker-failure tests. |
| P7.05 | Đạt | Hard token/USD limits, unknown/unpriced usage and retries are covered; provider list-rate estimates are not an invoice. |
| P7.06 | Một phần | The 12-task live baseline completed 72/72 runs and 36/36 paired comparisons (298 canonical requests, 680,492 tokens, estimated $0.043602; report `evals/results/agent-office-v1-baseline-live-20261026.json`). A duplicate recovery attempt is disclosed separately. The report-bound human scoring sheet is blank, so quality comparison is not signed off. |
| P7.07 | Đạt | Lifecycle content minimization, retention and memory tombstone/revision regressions. |
| P7.08 | Một phần | Formal sign-off waits on P7.06 human review, owner UAT, and a green hosted Windows browser smoke. Run #40373063610 failed when the offline indicator did not appear within five seconds; the current local fix passes the deterministic stale-refresh regression and full Chromium smoke, pending hosted rerun. |

## P8 — Vận hành và bàn giao

| ID | Trạng thái | Bằng chứng và việc còn lại |
| --- | --- | --- |
| P8.01 | Đạt | Backup/restore integrity, artifact checksums, registry validation and restored-server smoke pass. |
| P8.02 | Đạt | Doctor/readiness and explicit live-probe flow documented; Node 22.12 clean-install and no-key production smoke pass. |
| P8.03 | Đạt | Graceful Ctrl+C/restart, migration backup/rollback and older-package rollback smoke preserve data. |
| P8.04 | Đạt | UAT release package built from this audit is manifest-verified, clean-installs, audits with zero vulnerabilities, starts without `.env`, and omits the unused inherited Habblaud build stamp. |
| P8.05 | Đạt | Windows user/package guides cover setup, projects, approvals, artifacts, memory, backup and recovery. |
| P8.06 | Owner | Windows end-user scenarios and pixel-level visual acceptance are intentionally left for the owner after this implementation handoff. |
| P8.07 | Chờ P8.06 | Freeze/tag `v1` only after UAT results are resolved; current bundle remains a UAT candidate. |
| P8.08 | Chờ P8.07 | Handover materials exist; final versioned registry/tool/memory handoff follows the v1 release gate. |

## Kết quả test hiện tại

- Linux Node 22.12 CI-equivalent: clean `npm ci`, typecheck, full repository suite (2,257 passed, 9 skipped across 214 passing files and one skipped file) and production build passed. This is a local Docker runner, not hosted CI.
- Windows Node 24.17: full repository suite (2,240 passed, 26 skipped across 214 passing files and one skipped file) passed. Targeted Windows path/config/executor regressions passed 15/15 and release-file regression 1/1; browser E2E and Agent Office production build passed.
- Windows serial platform suite: `npm run office:test -- --maxWorkers=1 --pool=threads` passes 327 tests, skips 7, across 43 passing files and one skipped file after Coordinator final-answer repair and Analyst artifact validation. Typecheck and production build pass.
- Previous runtime package: `release/agent-office-0.1.0-uat-r107-20261026` has 168 manifest-listed files and bundle SHA-256 `8323b01c74ed757ad40eb28c2c3683c1f62d824f413c5c70c544282154606888`. It passes manifest verification, clean production install (46 packages), zero-vulnerability audit, offline config validation and isolated package smoke. The live `http://127.0.0.1:4851/office` instance remains on r101 with execution disabled; it has not been switched to r107. The older 4849/4850 local services were left untouched.
- The latest completed runtime package is documented below; the older r107 package predates deterministic Analyst reporting and the Vietnamese shared catalog.
- A second UAT instance at `http://127.0.0.1:4852/office` reports `dockerChecksEnabled: true` with a separate config/data directory; the default instance at 4851 remains execution-disabled. Windows real Docker executor suite passes 12/12, and the synthetic offline workspace baseline yields the two expected failing assertions in an isolated snapshot.
- Exact r101 production CLI live probes passed for both text and function calling: 310 tokens and 611 tokens respectively (921 total), with workspace execution disabled.
- Current browser report: `evals/results/office-browser-smoke-2026-10-26T16-32-56-556Z.json`; 10 projects, 30 project agents, 36 rendered characters, project-isolated message drafts, zero browser errors, Settings/Activity, assignment/return, Designer reload, reconnect/restart, approvals and mobile layout passed at 59.9 FPS.
- Focused live A01/A09 reporting checks: prompt run 4/4 succeeded (19 requests, 40,556 tokens, estimated $0.002946); follow-up same-name artifact guard check 1/1 succeeded (7 requests, 13,322 tokens, estimated $0.000877). Although execution and artifact guard behavior passed, model output still omitted requested numeric metrics and produced two differently named incomplete artifacts in the guard run. These are operational results, not human quality acceptance; review the current live reports in `docs/AGENT-OFFICE-TEST-REPORT.md` and keep P7.06 open.
- Visual continuity from Habblaud remains a P8.06 owner acceptance gate: sidebar, animated assignment movement, safe activity bubbles, persisted visual settings, and bottom Activity ticker/feed/toast are automated-smoke-covered; pixel-level owner UAT has not been signed off.
- Release tests and the reconciled 72-run live-model baseline are summarized in `docs/AGENT-OFFICE-TEST-REPORT.md`; model quality and invoice are not inferred from request success or list-rate estimates.

- Hosted GitHub Actions run #40373063610 on commit 1a5fc8d02b4d68c4acddcd8b5cdb3f45437fdf43: Linux passed; Windows reached the browser smoke after its platform checks and failed at scripts/office-browser-test.mjs:361, waiting for #connection-status.is-offline after Playwright emitted offline. The current branch fix passes the full local Chromium smoke, including a delayed-refresh offline regression, and the serial platform suite (328 passed, 7 skipped); hosted rerun is pending.
- Latest UAT package r108: 169 manifest-listed files, bundle SHA-256 `397e105c0a94de590dadf51cbf471d038c01f7c938c78bded02c8dcb52663086`; manifest verifies, clean install has 46 production packages, audit reports zero vulnerabilities, offline config validation passes with no model credentials and disabled execution, and isolated smoke passes health/office HTTP 200, schema 15 integrity, no provider calls and port release. The live 4851 process remains on r101.

## Gate còn lại trước khi gọi v1 hoàn tất

1. Owner chạy checklist Windows UAT và xác nhận pixel-level UI cùng các workflow end-to-end.
2. Chấm score sheet của live C10 pair và review sheet 72 lượt baseline theo rubric; chỉ kết luận chất lượng so sánh sau đó.
3. The baseline is in the public Agent Office repository. Push the validated local fix, then rerun hosted Windows CI; upstream remains the Habblaud source.
4. Sau khi các gate trên đạt, tạo tag/release v1 và hoàn tất handover P8.08. Đối soát hóa đơn provider cần dữ liệu tài khoản của owner; file báo cáo hiện chỉ có usage và ước tính giá niêm yết.

P9 trong backlog là sau v1 và không thuộc phạm vi release local-first này.

The shared UI now includes Vietnamese translations for the 3,256-string shared catalog; locale checks pass for EN/ES/FR/VI, the Agent Office language switch passes EN → VI → EN browser coverage, and the configured server locale follows `OFFICE_DEFAULT_LOCALE` unless `HABBLAUD_LANG` overrides it. Live A09 now produces one Analyst artifact with its verified metrics table in Vietnamese across the task output, artifact and final response. Manual rubric scoring and owner UAT remain open.
