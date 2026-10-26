# 07 — Backlog triển khai và thứ tự giao việc

Mỗi hàng là một work package để chuyển thành issue/PR. Trạng thái ban đầu là planned; tiến độ và bằng chứng hiện tại được theo dõi trong [10-implementation-status.md](10-implementation-status.md).

Vai trò đề xuất: BE = backend/runtime; FE = UI/canvas; QA = kiểm thử; DevEx = CI/vận hành. Đây là phân công triển khai tương lai, không yêu cầu tạo các agent hoặc chat mới.

## 1. Quy tắc thực hiện

- Mỗi PR hoàn thành một lát cắt có nghiệm thu, nêu test và migration/config mới.
- Làm dependencies trước; thiếu credential live không được thay bằng fake rồi đánh dấu live pass.
- Sửa visible behavior theo quy ước i18n/changelog của fork; screenshot dùng fixture/demo.
- Không lấy animation hoặc câu trả lời tự báo thành công làm bằng chứng runtime.
- Không mở tool ghi/shell thật trước core policy, operation intent và cancellation.
- Không phải mọi PR đều cần chạy mọi loại test; chạy bộ bắt buộc repository và targeted tests theo thay đổi, tránh lặp không có lý do.

## 2. P0 — Repo và khảo sát kỹ thuật, 6–8 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P0.01 | Khởi tạo fork/repo riêng, giữ LICENSE, upstream SHA, tên làm việc | — | DevEx | Repo mới chạy baseline; nguồn gốc và quyền tái sử dụng ghi rõ |
| P0.02 | Pin Node/dependencies; kiểm chứng SQLite native binary trên Windows sạch | P0.01 | BE | Lockfile và CI clean install không cần C++ toolchain ngoài dự kiến |
| P0.03 | Spike Responses/Chat adapters với fake stream và profile live được cấp | P0.01 | BE | Text/tool/usage/cancel capability matrix; không chọn model ngầm |
| P0.04 | Chốt canonical IDs, enums, command/event envelope, ADR | P0.01 | BE/FE | Shared schemas và fixtures được review |
| P0.05 | Thêm scripts cross-platform dev/build/test/config:validate | P0.02 | DevEx | Chạy được PowerShell; không dùng gán env kiểu Unix |
| P0.06 | Threat model và chính sách exec local-trusted/Docker | P0.04 | BE/QA | Các ranh giới và giới hạn được ghi, smoke test executor |
| P0.07 | Bootstrap runtime mode, không khởi tạo watchers/World/installer cũ | P0.01 | BE | App mới mở UI, không gửi uplink hoặc sửa cấu hình Codex |
| P0.08 | CI Windows + Linux baseline, browser test runner | P0.02,P0.05 | DevEx | Typecheck/test/build green trên môi trường hỗ trợ |

Gate M0a: baseline hoạt động, quyết định core được chốt; native dependency/provider không còn là giả định chưa thử.

## 3. P1 — Domain và persistence, 7–10 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P1.01 | Entity schemas, state transitions, domain errors | P0.04 | BE | Invalid transition/cross-scope bị từ chối |
| P1.02 | DB worker, migrations, repositories, single-instance lock | P0.02,P1.01 | BE | Migrate/khởi động lại giữ dữ liệu, FK/index đúng |
| P1.03 | Transactional events/outbox và projection cursor | P1.02 | BE | Không mất event giữa commit và publish |
| P1.04 | Idempotency/CAS/session/Host/Origin middleware | P1.02,P0.06 | BE | Duplicate/stale/foreign origin có kết quả đúng |
| P1.05 | Definition/roster registry loader và immutable snapshots | P1.01,P1.02 | BE | Valid/invalid packages, hash/version và references |
| P1.06 | Env/profile loader, redacted config, doctor sơ bộ | P0.03,P1.05 | BE | Thiếu key rõ lỗi; key sentinel không xuất API |
| P1.07 | Tool registry và core broker policy contract | P0.06,P1.01 | BE | Tool thiếu quyền/version bị chặn trước dispatch |
| P1.08 | Repository/API contract fixtures và smoke DB recovery | P1.03,P1.04,P1.05 | QA | Snapshot/replay và rollback transaction nhất quán |

Gate M0: shared contracts, storage, config và policy foundation qua test; API chưa gọi model tùy ý.

## 4. P2 — Project, roster và chat, 6–9 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P2.01 | Create project + conversation + Coordinator atomic | P1.02,P1.04,P1.05 | BE | Gửi request lặp không tạo hai Coordinator |
| P2.02 | List/update/archive/restore project | P2.01 | BE | Restore giữ ID/memory; active runs được xử lý rõ |
| P2.03 | Roster/availability query và office snapshot | P1.05,P2.01 | BE | Pool tồn tại khi không có project; counts đúng |
| P2.04 | Project picker/create form/Coordinator drawer | P2.01,P2.03 | FE | Nhiều phòng có thể chọn, không phụ thuộc cwd |
| P2.05 | Chat/history/attachments metadata lưu bền | P2.01,P1.04 | BE/FE | Refresh có lịch sử; file đi qua upload validation |
| P2.06 | SSE store reconnect/dedupe/snapshot reset | P1.03,P2.03 | FE | Mất mạng/đa tab không tạo thêm run |
| P2.07 | Pool cards + Coordinator ready + model missing states | P2.03,P2.04,P1.06 | FE | Không có credential vẫn hiện đội ngũ, không gọi LLM |
| P2.08 | UI vi/en và product smoke U01/U02/U06/U07 | P2.04,P2.05,P2.06,P2.07 | QA/FE | 3 project qua restart, keyboard và empty/error states |

Gate M1: project/roster/chat tồn tại thật. Pool có danh sách trực quan; animation di chuyển hoàn thiện tại P5.

## 5. P3 — Một agent làm việc thật, 9–14 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P3.01 | Gateway canonical contract, fake + Responses adapter | P1.06,P0.03 | BE | Full text, tool IDs, fragmented stream, usage/cancel |
| P3.02 | Chat-compatible adapter và capability validation | P3.01 | BE | Không suy compatibility từ URL; contract suite riêng |
| P3.03 | Context builder, skill loading, scoped memory reads | P1.05,P1.07 | BE | Required context không bị cắt ngầm; token caps |
| P3.04 | Single-agent loop, durable transcript/checkpoints | P3.01,P3.03,P1.02 | BE | Model→tool→model với exact call IDs qua restart |
| P3.05 | Operation intent/approval/receipt; file read/patch + artifacts | P1.07,P1.04,P3.04 | BE | Tool thật đúng root, patch CAS, artifact có checksum |
| P3.06 | Pause/cancel/worker lifecycle và heartbeat | P3.04 | BE | Không có zombie tool khi UI báo đã hủy |
| P3.07 | Max turns/tool calls/token limits + usage ledger | P3.01,P3.04 | BE | Dừng khi chạm giới hạn, tính mọi attempt |
| P3.08 | UI stream/tool/approval/artifact và live single-agent smoke | P3.05,P3.06,P3.07,P2.05 | FE/QA | Một task model thật giao file có kiểm chứng |

Gate M2: gọi model thật và công cụ thực qua broker, có checkpoint/cancel. Không chấp nhận chỉ fake transcript.

## 6. P4 — Điều phối và đội ngũ, 10–16 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P4.01 | Coordinator plan tool + DAG validation/revisions | P3.04,P1.01 | BE | Cycle/unknown capabilities/over-budget bị từ chối |
| P4.02 | Capability matcher, ready queue và fairness | P4.01,P2.03 | BE | Đúng người đúng capability; không starvation |
| P4.03 | Assignment reserve/release, partial unique lock | P4.02,P1.02 | BE | Hai dispatcher không giữ cùng người |
| P4.04 | Leases/fencing/worker ACK/recovery | P4.03,P3.06 | BE | Worker cũ bị chặn trước tool/state write |
| P4.05 | Dependency readiness, handoff/evidence contract | P4.01,P4.03 | BE | Chỉ dispatch khi input đủ; không khóa worker chờ dependency |
| P4.06 | Reviewer + needs_revision + bounded repair loop | P4.05 | BE | Finding gắn artifact version, tối đa vòng sửa |
| P4.07 | Global/provider concurrency và budget reservation | P3.07,P4.03 | BE | Chạy song song không vượt reservation policy |
| P4.08 | Steering/follow-up/cancel cascade/aggregate run state | P4.04,P4.05,P4.06 | BE/QA | Không root succeeded khi child còn chạy hoặc review fail |

Gate M3a: task độc lập chạy song song, task phụ thuộc chạy đúng thứ tự, specialist được giải phóng đúng.

## 7. P5 — Văn phòng và điều khiển trực quan, 8–12 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P5.01 | Canvas adapter cho project IDs và pool area | P2.03,P4.03 | FE | Pool không thành project giả, room count đúng |
| P5.02 | Persistent project room lifecycle | P5.01,P2.02 | FE | Idle không tháo phòng; archive/restore có animation hợp lý |
| P5.03 | Agent move/handoff/return theo assignment events | P5.01,P4.05 | FE | Không hai nhân vật cùng ID ở hai phòng |
| P5.04 | Task board/dependencies/assigned vs planned counters | P4.08,P2.06 | FE | Waiting dependency khác waiting user; counts từ state |
| P5.05 | Project/agent/run details, timeline, budget và artifacts | P3.08,P5.04 | FE | Các nút điều khiển đi qua API có CAS |
| P5.06 | Approvals/failure/reconnect/reduced motion/mobile layout | P5.03,P5.05 | FE/QA | Sử dụng được khi bỏ canvas; tab reconnect giữ state |
| P5.07 | Nhiều phòng và performance fixtures | P5.02,P5.03 | QA | 10 project/30 nhân vật fixture, đo pan/zoom |
| P5.08 | Visual E2E U03/U04/U05 và giữ trải nghiệm Habblaud | P5.03,P5.04,P5.06 | QA | Sidebar nhóm project/pool, assignment thật đưa nhân vật vào phòng và release đưa về pool; pose/nhãn/bong bóng theo event thật; camera/zoom, visual settings có lưu, Activity ticker/feed/toast hoạt động; event visual không chứa prompt, suy luận model hoặc tham số công cụ; owner duyệt pixel-level |

Gate M3: user chọn project, Coordinator gọi đội ngũ, UI phản ánh trạng thái backend thực.

## 8. P6 — Đa năng và mở rộng agent, 12–18 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P6.01 | Package Coordinator/Developer/Reviewer và fixture riêng | P4.06,P3.03 | BE | Đầu ra theo schema, không hardcode tên instance |
| P6.02 | Sandbox/local-trusted exec, resource limits và preview manager | P0.06,P3.05,P3.06 | BE | Kiểm soát process, mounts, env, network và cleanup |
| P6.03 | Coding workspace snapshot/patch/test workflow | P6.01,P6.02 | BE/QA | Bảo toàn dirty files; diff approval dựa trên snapshot/checksum; test/build evidence; không tự deploy |
| P6.04 | Web search/fetch adapter và Researcher/Writer packages | P3.05,P4.05 | BE | Search provider thật, provenance và report có nguồn |
| P6.05 | Analyst CSV tools và package | P3.05,P4.05 | BE/QA | Kết quả khớp phép tính độc lập trên fixture |
| P6.06 | Hooks built-in + memory summaries/revisions/export/import | P3.03,P3.05,P4.05 | BE | Hooks timeout/idempotency và memory scope đúng |
| P6.07 | Agent reload/drain, add Designer fixture bằng config | P1.05,P5.01,P6.06 | BE/FE | Thêm agent dùng tools có sẵn không sửa scheduler/canvas |
| P6.08 | End-to-end coding + research/report + analysis | P6.03,P6.04,P6.05,P6.07 | QA | Artifacts mở được; missing connector không bị giả là thành công |

Gate M4: beta đa năng và config extensibility. Connector email/calendar mock chỉ kiểm tra cơ chế, không tính đã tích hợp thật.

## 9. P7 — Độ tin cậy và đánh giá, 10–16 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P7.01 | Fault injection tại model/tool/checkpoint/commit | P4.04,P6.08 | QA/BE | Recovery matrix trong 08 đạt yêu cầu |
| P7.02 | Ambiguous write reconciliation và duplicate-command tests | P3.05,P4.04 | BE/QA | Không gửi/làm lại external effect mù |
| P7.03 | Windows path/junction/secret/SSRF/prompt-injection suite | P6.02,P6.04,P6.06 | QA | Ranh giới quyền đúng trong mode đã chọn |
| P7.04 | Event replay/load/soak, slow client và worker failures | P5.07,P4.07 | QA | Không leak lease/process, reconnect phục hồi |
| P7.05 | Usage accuracy/unknown price/hard limits | P4.07,P6.08 | QA | Không báo free khi thiếu giá; chi phí retry có audit |
| P7.06 | Eval corpus và single-agent baseline | P6.08 | QA/BE | Có cặp chạy và checkpoint phục hồi; đo chất lượng/thời gian/chi phí, không tuyên bố hơn khi chưa chấm |
| P7.07 | Content/tool audit, retention và memory deletion | P6.06,P7.03 | BE | Không hồi sinh record bị xóa; audit có kiểm soát dữ liệu |
| P7.08 | Bugfix và release candidate sign-off | P7.01,P7.02,P7.03,P7.04,P7.05,P7.06,P7.07 | Tất cả | Không còn defect chặn v1 |

Gate M5a: các tiêu chí phát hành trong 08 có bằng chứng, không chỉ checklist được tick.

## 10. P8 — Vận hành và bàn giao, 6–10 ngày công

| ID | Công việc | Phụ thuộc | Vai trò | Đầu ra/nghiệm thu |
| --- | --- | --- | --- | --- |
| P8.01 | Backup/restore DB + blobs/config, integrity check | P7.07 | BE/DevEx | Restore sang thư mục mới và chạy tiếp được |
| P8.02 | Doctor/readiness/live model opt-in, Windows onboarding | P1.06,P6.08 | DevEx | Máy sạch cài theo hướng dẫn không cần Codex/Claude |
| P8.03 | Start/stop/graceful shutdown/upgrade/rollback | P7.08,P8.01 | DevEx | Không hủy nhầm process; migration có backup và compatibility |
| P8.04 | Package release, notices/license, config examples | P8.02,P8.03 | DevEx | Reproducible build, .env.example không secret |
| P8.05 | User guide cho projects/agents/approvals/artifacts | P5.06,P6.07 | FE | Thêm agent và khôi phục lỗi theo tài liệu được |
| P8.06 | UAT trên Windows với credential/dữ liệu được cấp | P7.08,P8.04,P8.05 | Owner/QA | Toàn bộ release scenarios có bằng chứng |
| P8.07 | Freeze schema, tag v1, release notes và known limitations | P8.06 | DevEx | Bundle, docs, migrations có version đồng bộ |
| P8.08 | Handover registry/tool/memory extension và backlog tiếp | P8.07 | Tất cả | Người khác có thể tiếp tục mà không đọc toàn bộ lịch sử chat |

Gate M5: v1 hoàn chỉnh trong phạm vi local-first đã mô tả.

## 11. P9 — Sau v1, ước lượng riêng

| ID | Công việc | Phụ thuộc | Nghiệm thu |
| --- | --- | --- | --- |
| P9.01 | Connector đọc Drive/email/calendar theo OAuth riêng | P8.07 | Scope/revoke/refresh và fixtures + live test |
| P9.02 | Draft/send/create với approval và receipts | P9.01,P7.02 | Không gửi trùng khi lỗi mạng/restart |
| P9.03 | MCP tool connector có permission mapping | P8.07 | Schema/trust/cancel/capability tests |
| P9.04 | Multi-user/tenant auth + PostgreSQL | P8.07 | Isolation/RBAC/migrations được review riêng |
| P9.05 | Remote worker protocol và secure pairing | P9.04 | Authn/authz/lease/fencing/network threat model |
| P9.06 | Desktop packaging, remote mobile và schedules | P8.07 | Mỗi khả năng có lifecycle/quyền/ops riêng |

## 12. Critical path và điểm kiểm tra

P0.01 → P0.02/P0.04 → P1.02/P1.05/P1.07 → P2.01 → P3.04/P3.05 → P4.03/P4.04/P4.05 → P5/P6 → P7 → P8.

P5 UI chi tiết có thể phát triển từ fixtures sau khi contracts ổn định, nhưng chỉ nghiệm thu sau khi nối backend thật. Không tách người làm song song vào cùng file chưa có owner; thay shared contracts cần cập nhật cả consumer và tests cùng PR.

Mỗi gate lưu: commit, config hashes, test report, artifacts demo, defects còn lại, quyết định tiếp tục. Nếu chưa có credential live, gate liên quan được ghi pending, không suy ra pass từ mock.
