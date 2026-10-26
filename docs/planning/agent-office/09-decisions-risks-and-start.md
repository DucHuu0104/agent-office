# 09 — Quyết định, rủi ro, ước lượng và cách bắt đầu

## 1. Decision register

| ADR | Quyết định mặc định | Lý do và đánh đổi |
| --- | --- | --- |
| A01 | Repo riêng từ fork Habblaud | Giữ renderer/assets; domain mới không bị ép thành session watcher; phải bảo trì phần fork |
| A02 | Local-first, một user/workspace | Đúng môi trường Windows hiện tại; SaaS cần auth/isolation/ops riêng |
| A03 | Project bền vững + Coordinator riêng | Tiếp tục công việc qua nhiều lượt, không mất phòng khi idle |
| A04 | Definition / instance / assignment / execution tách riêng | Giữ danh tính, cho routing/queue và audit chính xác |
| A05 | Một live assignment/specialist ở v1 | Tránh một nhân vật ở hai phòng; throughput mở rộng bằng thêm instance |
| A06 | Reserve specialist khi dependency ready | Tránh khóa tài nguyên và deadlock; planned role khác assigned person |
| A07 | SQLite + DB worker, backend modular | Ít hạ tầng để vận hành; DB single-writer và driver native cần kiểm chứng |
| A08 | State machine/scheduler có checkpoint riêng | Quyền sở hữu state rõ; tự chịu trách nhiệm recovery, bắt buộc fault tests |
| A09 | Model adapters theo protocol | Đổi provider bằng config trong phạm vi compatibility đã thử; không giả mọi URL tương thích |
| A10 | Cấu hình Markdown/YAML, code policy trong backend | Dễ thêm vai trò nhưng không để prompt tự cấp quyền |
| A11 | SSE + durable events/outbox | Tái dùng mô hình UI, reconnect được; phải quản lý cursor/retention/backpressure |
| A12 | Memory DB authoritative, Markdown summary | Tránh hai nguồn ghi đè; cần import/export có revision |
| A13 | Shell Docker hoặc explicit local-trusted | Cần nói đúng ranh giới Windows/process/worktree; không giả cwd là sandbox |
| A14 | Chưa tích hợp World chính thức | Giao thức và ý nghĩa dữ liệu gắn sản phẩm upstream; dữ liệu đội ngũ mới không được giả làm phiên nguồn |
| A15 | vi/en, giữ quy ước i18n của fork | UI phù hợp người dùng và giảm rewrite; có chi phí bổ sung locale |
| A16 | v1 generalist qua 3 workflow hữu hạn | Đủ kiểm chứng platform; chưa tuyên bố mọi loại tác vụ/connector đều có |

Các ADR là quyết định đề xuất để thực hiện, được đổi bằng ghi lý do + migration/impact, không âm thầm thay trong lúc coding.

## 2. Những điểm cần đầu vào của owner

Không cần trả lời toàn bộ để lập xong kế hoạch. Trước gate liên quan phải xác nhận:

| Nội dung | Mặc định đề xuất | Cần trước |
| --- | --- | --- |
| Tên và vị trí repo sản phẩm | Agent Office; repo mới từ fork | P0.01 |
| Provider/model/credentials | Profile primary + coding, có thể dùng chung | P0.03 live / M2 |
| Search provider/API | Adapter search riêng, endpoint/credential owner cấp | P6.04 |
| Budget pilot | Owner đặt token và tiền; không tự lấy hạn mức tài khoản Codex | Live tests |
| Dữ liệu mẫu | Repo/CSV/tài liệu test không có dữ liệu riêng chưa được phép | P6/P7 |
| Exec mode Windows | Docker nếu sẵn; local-trusted opt-in riêng | P6.02 |
| Tên/avatar roster | 5 specialist, một instance mỗi vai trò | P2/P5 |
| Definition of done coding | Theo scripts/acceptance từng project | P6.03 |
| Ngân sách tài nguyên/máy tham chiếu | Ghi CPU/RAM/SSD/browser | P0/P7 |
| Email/calendar thật | Sau v1; bắt đầu read-only rồi draft/send | P9 |

Không cần hardcode model mới nhất hoặc mua hạ tầng cloud trước khi thử các contracts và workflow chính.

## 3. Ước lượng effort

Ước lượng để lập nguồn lực, chưa phải deadline. Giả định một kỹ sư full-stack có kinh nghiệm chịu trách nhiệm chính, QA/UX hỗ trợ bán thời gian; reuse fork và các thư viện thay vì tự xây tất cả.

| Giai đoạn | Ngày công kỹ sư chính |
| --- | --- |
| P0 Repo và khảo sát | 6–8 |
| P1 Domain/persistence/config | 7–10 |
| P2 Project/roster/chat | 6–9 |
| P3 Single-agent runtime | 9–14 |
| P4 Điều phối/queue/recovery | 10–16 |
| P5 Văn phòng và UX | 8–12 |
| P6 Đa năng/extensibility | 12–18 |
| P7 Reliability/evals | 10–16 |
| P8 Release/ops | 6–10 |
| Tổng cơ sở | 74–113 |
| Có dự phòng tích hợp 20–30% | Khoảng 90–145 |

Nếu một người làm toàn thời gian 5 ngày/tuần, quy đổi khoảng 18–29 tuần công; thời gian lịch có thể dài hơn do credential, phản hồi, nghỉ và nguồn lực QA. Hai người không tự chia đôi critical path. Agent hỗ trợ coding có thể giảm phần lặp lại nhưng không bỏ các gate recovery và verification.

Sau P0 và M2 cần re-estimate bằng throughput thực tế. Chi phí API tính riêng: số input/output tokens từng profile × price version + search/tool fees; chưa có provider/budget nên không bịa giá tiền.

## 4. Risk register

| Rủi ro | Dấu hiệu | Giảm thiểu / chủ sở hữu |
| --- | --- | --- |
| Fork UI gắn chặt session/room | Pool bị coi là room/project hoặc agent bị xóa khi idle | Platform snapshot + canvas adapter; FE |
| Agent definition hợp lệ nhưng model không gọi được tool | Profile chỉ trả text/format sai | Capability probes + contract/live test; BE |
| Native SQLite cài lỗi Windows | npm ci fallback compile | Pin phiên bản có prebuilt, clean CI trước core build; DevEx |
| Multi-agent tốn phí hơn lợi ích | Nhiều task trùng, Coordinator/review loop dài | Bounded fan-out và paired baseline; BE/QA |
| Project tranh chuyên viên/deadlock | Hàng đợi không giảm dù agents chờ dependency | Just-in-time reservation/fairness; BE |
| Worker stale gây hai tác vụ | Worker cũ còn trả output sau restart | Fencing tại broker/DB và terminate trước reassign; BE |
| Tool thực hiện xong nhưng mất receipt | Restart gửi/làm lại | Durable intent + reconcile/outcome_unknown; BE |
| Rò rỉ giữa project/secret | Memory truy vấn sai scope hoặc raw env vào shell | Scope trước retrieval, env allowlist, sentinel tests; QA |
| Runtime state và animation lệch | Người ở hai phòng/count sai | Server authoritative, UI revision/dedupe; FE |
| Chất lượng chỉ tốt ở demo | Outputs không có evidence/test | Corpus, acceptance validators và UAT; QA/owner |
| Scope tăng thành SaaS quá sớm | Auth/remote/mobile chen trước M3 | Scope gates, ADR và backlog P9; owner |
| Memory bị nhiễm hoặc phình | Thông tin cũ/không nguồn lấn context | Provenance, budget, revision/deletion; BE |
| Chọn công cụ chủ quan không đo | Thay toàn stack liên tục | P0 spikes + ADR; giữ API domain ổn định |
| Local-trusted bị hiểu như sandbox | Người dùng cấp exec nhưng không hiểu giới hạn | Nhãn mode rõ, Docker option và tài liệu; product/BE |

## 5. Thứ tự bắt đầu

Lượt triển khai đầu chỉ thực hiện P0.01, P0.02 và P0.04:
1. Xác định tên/đường dẫn repo mới, tạo fork/copy giữ notice và ghi upstream commit.
2. Chạy baseline typecheck/test/build, ghi failures có sẵn.
3. Tạo shared/platform contracts, fixtures và ADR; chưa thay toàn bộ renderer.
4. Spike SQLite Windows và một model adapter bằng fake stream; live call chỉ khi được cấp profile/key/budget.
5. Viết report gate và cập nhật estimates/backlog.

Lượt tiếp theo chọn work package có dependencies đã hoàn tất. Không giao một yêu cầu quá lớn như "xây toàn bộ multi-agent" rồi cho từng agent tự sửa contracts riêng.

Mẫu brief cho một work package:
~~~text
Mục tiêu: hoàn thành P2.01.
Đọc: README, 01 mục tạo project, 03 invariants, 05 tables/API.
Input: contracts + repositories từ P1 đã nghiệm thu.
Phạm vi: atomic create project/conversation/Coordinator, idempotency.
Output: implementation, migration nếu cần, integration tests và report.
Nghiệm thu: retry/đa tab chỉ tạo 1 project và 1 Coordinator; restart còn dữ liệu.
Không mở rộng sang: model runtime, canvas animation, external connector.
~~~

Mẫu báo cáo sau mỗi lát cắt:
- Work package IDs và commit.
- Những hành vi đã chạy được với bằng chứng.
- Contracts/migrations/config thay đổi.
- Tests thực sự đã chạy; skipped/pending và lý do.
- Rủi ro/defects còn lại; rollback.
- Work package tiếp theo đủ dependencies.

## 6. Checklist cho thiết kế trước khi code

Các quyết định thiết kế dưới đây đã được đối chiếu với module hiện hành và ma trận kiểm thử T01–T30. Đây là checklist xác nhận thiết kế, không thay thế các cổng live-provider hoặc nghiệm thu của owner.

- [x] Room/project có ID riêng, không dùng cwd hoặc transcript ID.
- [x] Mỗi project một Coordinator, specialists giữ identity khi chuyển phòng.
- [x] Definition, instance, assignment và execution không nhập làm một.
- [x] Policy, approval, idempotency và durable state có owner/module rõ.
- [x] Config/skills/hooks versioned; runtime đang chạy không bị reload nửa chừng.
- [x] Có fake adapter và explicit live gate.
- [x] Pool và Coordinator ready không gọi model nền.
- [x] Có outcome_unknown/reconcile, không hứa exactly-once ngoài khả năng provider.
- [x] Thêm Designer bằng cấu hình dùng tools có sẵn là một bài nghiệm thu.
- [x] V1 scope và P9 extensions tách rõ.

## 7. Cơ sở khảo sát và giới hạn nguồn

Nguồn repo đã đọc: package.json, LICENSE, CONTRIBUTING.md, server/sources/source.ts, server/model/office.ts, server/model/rooms.ts, shared/types.ts, client/src/net/store.ts, client/src/world/sim/{sim,character}.ts, client/src/world/layout/geometry.ts, shared/world/README.md.

Tài liệu chính thức đối chiếu ngày 25/10/2026:
- [Anthropic multi-agent research](https://www.anthropic.com/research/multi-agent-research-system): tham khảo orchestrator/workers và hợp đồng giao việc; không lấy benchmark research làm cam kết cho sản phẩm.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): giao thức đề xuất tool và trả output có call ID.
- [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses): xử lý event stream qua adapter.
- [OpenClaw agent runtime](https://docs.openclaw.ai/concepts/agent): tham khảo workspace/persona files; schema trong kế hoạch này là quy ước riêng.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): tham khảo scope checkpoint/store; không chọn làm dependency bắt buộc.
- [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html): trạng thái module/API đồng bộ.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3): driver được chọn để spike và pin phiên bản.

Phần API/domain/limits/estimates là thiết kế đề xuất của tài liệu, không phải tính năng hiện có hoặc thông số được nhà cung cấp bảo đảm. Mọi compatibility cần kiểm tra lại tại P0 và khi nâng version.
