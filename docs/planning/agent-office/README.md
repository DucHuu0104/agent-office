# Agent Office — kế hoạch triển khai

Phiên bản kế hoạch: 1.0 — 25/10/2026, múi giờ Asia/Saigon.
Trạng thái: triển khai đang tiếp tục; trạng thái từng work package và bằng chứng nằm trong [10-implementation-status.md](10-implementation-status.md).
Tên Agent Office là tên làm việc, chưa phải quyết định thương hiệu.
Nguồn khảo sát: Habblaud 1.0.3, commit faa1a012b5fbf632c66dc6801c5383e53a542406.

## 1. Sản phẩm sẽ xây

Một trợ lý đa năng có văn phòng pixel art: người dùng tạo project, trò chuyện với Coordinator riêng của project, giao công việc và quan sát các chuyên viên được điều động từ khu chung. Agent dùng model qua API được cấu hình; runtime của sản phẩm quản lý công cụ, tiến độ, kết quả và quyền thực thi.

Các agent trong khu chung có danh tính ổn định, không cần chạy LLM liên tục. Coordinator tồn tại theo project, nhưng chỉ gọi model khi cần xử lý yêu cầu/sự kiện. Project không phụ thuộc việc có phiên Codex/Claude đang mở.

## 2. Quyết định kiến trúc chính

- Sản phẩm mới trong repo riêng, khởi tạo từ fork Habblaud. Giữ LICENSE và ghi nguồn phần tái sử dụng.
- Giữ TypeScript, Node.js, Vite, Canvas và phần mỹ thuật đang hoạt động. Không viết lại UI bằng framework khác ở giai đoạn đầu.
- Xây domain/runtime riêng; các file theo dõi Codex/Claude không làm nguồn sự thật của sản phẩm mới.
- Bản v1: một người dùng, một workspace, Windows trước, chạy localhost. Thiết kế sẵn projectId/workspaceId nhưng không tuyên bố đã có SaaS nhiều tenant.
- SQLite qua better-sqlite3, phiên bản chính xác được khóa sau kiểm chứng Windows/Node 24 ở P0; truy cập DB qua storage worker và repository.
- Scheduler và runtime dùng state machine rõ ràng, checkpoint trong SQLite. Chưa thêm LangGraph/Temporal để tránh hai cơ chế cùng sở hữu trạng thái.
- Gateway có adapter OpenAI Responses và Chat Completions-compatible. Hai giao thức phải có contract test riêng; đổi URL không tự biến giao thức này thành giao thức kia.
- HTTP command + SSE events; transaction ghi state và event cùng lúc.
- Model, skill, tool, hook là những thành phần riêng; backend quyết định quyền và chuyển trạng thái.
- Habblaud World không nằm trong sản phẩm v1: runtime mode không khởi tạo client/uplink của dịch vụ World chính thức. Không ánh xạ agent tự xây thành phiên Codex/Claude để gửi lên đó.
- Docker là lựa chọn thực thi shell có cô lập; local-trusted là lựa chọn riêng có chấp thuận rõ. Subprocess và Git worktree không được gọi là security sandbox.

## 3. Tài liệu để triển khai

| Tài liệu | Nội dung |
| --- | --- |
| [01-product-and-experience.md](01-product-and-experience.md) | Phạm vi, UX, user stories, quy tắc đội ngũ/phòng |
| [02-architecture-and-reuse.md](02-architecture-and-reuse.md) | Module, bố trí repo, phần Habblaud tái sử dụng |
| [03-runtime-and-scheduling.md](03-runtime-and-scheduling.md) | State machine, điều phối, checkpoint, retry, hủy |
| [04-agent-configuration.md](04-agent-configuration.md) | agent.yaml, soul/system/tools, skills, hooks, .env |
| [05-data-api-events.md](05-data-api-events.md) | Dữ liệu, ràng buộc, API, SSE và contracts |
| [06-tools-memory-and-access.md](06-tools-memory-and-access.md) | Công cụ, quyền, memory, artifacts, connectors |
| [07-delivery-backlog.md](07-delivery-backlog.md) | Work packages có ID, phụ thuộc và nghiệm thu |
| [08-validation-and-operations.md](08-validation-and-operations.md) | Kiểm thử, kịch bản đầu cuối, vận hành và phát hành |
| [09-decisions-risks-and-start.md](09-decisions-risks-and-start.md) | ADR, rủi ro, ước lượng, thông tin còn thiếu và cách bắt đầu |
| [10-implementation-status.md](10-implementation-status.md) | Tiến độ thực tế, kiểm chứng đã chạy và công việc còn lại |
| [11-threat-model-and-security-review.md](11-threat-model-and-security-review.md) | Ranh giới tin cậy, kiểm soát an ninh, kiểm thử và rủi ro còn lại |
| [12-completion-audit.md](12-completion-audit.md) | Đối chiếu từng work package P0–P8 với bằng chứng và gate còn mở |

Đọc theo thứ tự: README → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09.
Khi viết code, lấy work package tiếp theo từ 07; các hợp đồng trong 03–06 là điều kiện triển khai.

## 4. Những yêu cầu đã thống nhất

| ID | Yêu cầu | Tài liệu triển khai |
| --- | --- | --- |
| R01 | Đội ngũ chuyên viên xuất hiện ở khu chung khi chưa được giao việc | 01, 02 |
| R02 | Tạo project tạo phòng tồn tại bền vững và một Coordinator riêng | 01, 03, 05 |
| R03 | Chat mặc định vào Coordinator của project được chọn | 01, 05 |
| R04 | Coordinator chọn chuyên viên theo năng lực, giao nhiệm vụ có đầu ra | 03, 04 |
| R05 | Agent được phân công đi vào phòng; hoàn thành và được giải phóng thì trở lại khu chung | 01–03 |
| R06 | Mỗi phòng hiển thị số agent được phân công, đang chạy và đang chờ | 01, 05 |
| R07 | Thêm agent mới chủ yếu bằng package cấu hình, không sửa scheduler | 04, 07 |
| R08 | Agent có system.md, soul.md, tools.md, skills, hooks, memory | 04, 06 |
| R09 | Model profile dùng URL/model/key từ .env ở backend | 04 |
| R10 | Trợ lý đa năng: coding, nghiên cứu, phân tích, viết tài liệu | 01, 06 |
| R11 | Nhiều project, memory và dữ liệu tách theo project | 03, 05, 06 |
| R12 | Đóng tab hoặc mất SSE không làm mất công việc | 03, 08 |
| R13 | Có phê duyệt, giới hạn ngân sách, hủy và khôi phục sau lỗi | 03, 06, 08 |
| R14 | Tiến độ/hoạt ảnh phản ánh trạng thái thực thi thật | 01, 05 |
| R15 | Có thêm agent mà không cần phát sinh lời gọi model khi đang sẵn sàng | 03, 08 |
| R16 | Giữ trải nghiệm Habblaud: sidebar theo project/pool, agent đi theo assignment, trạng thái/bong bóng, camera và settings, Activity ticker/feed/toast | 01, 07, 08 |

### Truy vết yêu cầu đến thực thi và kiểm chứng

| Yêu cầu | Work packages chính | Bài kiểm chứng |
| --- | --- | --- |
| R01 | P2.03, P2.07, P5.01 | T01, T23 |
| R02 | P2.01, P2.02, P5.02 | T02, T03 |
| R03 | P2.05, P3.04, P4.08 | T02, T16 |
| R04 | P4.01, P4.02, P4.05 | T04, T05, T07 |
| R05 | P4.03, P4.04, P5.03 | T04, T12, T23 |
| R06 | P5.04, P5.05 | T05, T22, T23 |
| R07 | P1.05, P6.07 | T26 |
| R08 | P3.03, P6.01, P6.06 | T19, T20, T26 |
| R09 | P1.06, P3.01, P3.02 | T08, T09, T10 |
| R10 | P6.03, P6.04, P6.05, P6.08 | T29 |
| R11 | P1.01, P2.01, P6.06 | T03, T19 |
| R12 | P3.04, P4.04, P2.06 | T11, T12, T22 |
| R13 | P3.05, P3.06, P4.07, P7.02 | T13, T14, T15, T16, T25 |
| R14 | P1.03, P5.03, P5.04 | T22, T23 |
| R15 | P1.05, P2.07, P6.07 | T01, T26 |
| R16 | P5.03, P5.06, P5.08 | T23, owner visual UAT |

## 5. Các mốc phát hành

| Mốc | Phạm vi nghiệm thu | Điều kiện qua mốc |
| --- | --- | --- |
| M0 — nền tảng | Repo mới, CI, schema, cấu hình và bản đồ module | P0–P1 |
| M1 — văn phòng thật | Pool, tạo/phục hồi project, Coordinator sẵn sàng, chat lưu được | P2 |
| M2 — một agent chạy được | Model thật, tools đọc/ghi có giới hạn, checkpoint và hủy | P3 |
| M3 — đội ngũ phối hợp | DAG công việc, scheduler, bàn giao, reviewer, di chuyển giữa khu chung/phòng | P4–P5 |
| M4 — bản beta đa năng | Coding có kiểm tra + research/report + CSV analysis; thêm agent từ cấu hình | P6 |
| M5 — v1 dùng cá nhân | Recovery, policy, backup/restore, eval, tài liệu cài Windows và đóng gói | P7–P8 |
| Sau v1 | Connector email/lịch/Drive thực; nhiều người dùng; remote workers | P9, có mốc riêng |

Beta không được quảng bá là v1 hoàn chỉnh khi chưa qua các bài thử recovery, quyền công cụ và kiểm chứng đầu ra.
Email/lịch thật là extension sau v1; v1 có thể tạo bản nháp và artifacts cục bộ.

## 6. Ranh giới triển khai và giả định

Kế hoạch gốc được giữ trong `D:\habblaud\docs\planning\agent-office`; sản phẩm đang được triển khai trong checkout riêng `D:\agent-office`, nhánh `codex/agent-office-v1`, tái sử dụng artwork/renderer Habblaud theo MIT. Checkout sản phẩm đã có Windows UAT bundle, nhưng chưa được đẩy thành GitHub repository riêng. Owner UAT sẽ bắt đầu sau khi hoàn tất phần triển khai và regression tự động.

Giả định mặc định: 1 workspace; UI vi/en; 5 chuyên viên ban đầu (Developer, Reviewer, Researcher, Analyst, Writer); mỗi chuyên viên một assignment đồng thời; mỗi project một Coordinator; tối đa 4 execution đang gọi model/tool trên toàn workspace, chỉnh được bằng cấu hình. Số project không đồng nghĩa số execution đang chạy.

Provider/model credentials được cấu hình cục bộ trong `.env` bị git-ignore và đã dùng cho các lượt live có giới hạn; không đưa key vào repo, report hoặc package. C10 hiện có paired execution evidence; giá trong report là ước tính theo rate cấu hình, chưa thay hóa đơn provider hoặc human rubric review. Agnes Chat Completions đã được kiểm tra; multi-turn Responses của provider chưa tương thích và profile đó vẫn không được khuyến nghị bật. Brave Search cần key riêng; DuckDuckGo là lựa chọn mặc định. Không dùng key phiên Codex/Claude hoặc quyền connector của ứng dụng làm credential cho sản phẩm.

## 7. Hoàn thành kế hoạch nghĩa là gì

Kế hoạch bàn giao được khi mọi yêu cầu R01–R15 có work package, bài nghiệm thu và nguồn trạng thái rõ; mẫu config hợp lệ về cấu trúc; liên kết tài liệu hoạt động; các giả định/ước lượng được ghi riêng với những điều đã xác minh.

Hoàn thành sản phẩm v1 nghĩa là qua M5 và toàn bộ tiêu chí phát hành trong 08. Việc có demo chuyển động đẹp hoặc agent tự nói "đã xong" không thay cho bằng chứng nghiệm thu.
