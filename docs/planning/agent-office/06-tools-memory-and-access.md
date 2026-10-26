# 06 — Công cụ, quyền, memory và kết quả

## 1. Tool registry

Mỗi tool có id/version, description, JSON input/output schema, effectClass, requiredCapabilities, credentialRef, timeout, cancellation, retrySafety và executor.

effectClass: read_only, local_write, external_write, process_exec. Tool docs không phải implementation; skill không tự cấp quyền. Core policy/fencing chạy trước mọi dispatch kể cả hook/script gọi tool.

| Tool v1 | Kết quả | Quyền/giới hạn |
| --- | --- | --- |
| projects.context | Mục tiêu/quyết định/tài liệu đúng project | Read-only đúng project |
| tasks.plan / tasks.revise | Đề xuất plan revision | Coordinator; validate schema/DAG |
| tasks.status | Trạng thái task/availability | Scope theo project |
| skills.load | Hướng dẫn skill version đã cho phép | Chỉ package trusted |
| files.list/read | Metadata/nội dung bounded | Approved root; deny secrets và traversal |
| files.patch | Patch + before/after checksum | CAS; scope project; audit diff |
| artifacts.create | Immutable version | MIME/size/checksum/schema |
| memory.search/propose | Records có nguồn | Scope/provenance rules |
| web.search | Kết quả có URL/title/snippet | Search provider adapter; budget riêng |
| web.fetch | Nội dung + source metadata | SSRF protection, size/redirect limits |
| analysis.csv | Kết quả phép tính deterministic | Bounded input; ghi phương pháp và schema |
| shell.exec | Exit code, stdout/stderr, output refs | Docker hoặc local-trusted được chọn rõ |
| preview.open | Local preview reference | Port/session owner kiểm soát; không public publish |

v1 analysis.csv dùng tập phép tính được định nghĩa: counts, filter, group, sum, mean, min/max, missing values. Code phân tích tùy ý chỉ qua sandbox executor như shell. Model không tự thực hiện phép tính rồi gắn nhãn deterministic.

Tool ID được version hóa; output có truncation flags. Kết quả quá lớn tạo artifact/reference và excerpt; không lặng lẽ cắt mất phần quyết định.

## 2. Effective permissions

Effective permissions = platform policy ∩ user grants ∩ project scope ∩ definition allowlist ∩ connection scopes.
Thiếu quyền ở bất kỳ lớp nào thì deny hoặc yêu cầu grant phù hợp. Model chỉ đề xuất thao tác.

- Project cấp workspace folder bằng opaque root ID, không nhận arbitrary absolute path từ model.
- Canonical path phải nằm trong root; kiểm tra cả Windows drive, UNC, alternate data streams, junction/symlink và case-insensitive path.
- Filesystem tool không đọc .env, credential stores, runtime config, agent packages và thư mục home chưa được cấp.
- files.patch kiểm tra base checksum để không ghi đè thay đổi của người dùng hoặc task khác.
- Hai writer vào cùng tài nguyên phải có resource lock/optimistic check, kể cả hai agent khác nhau.
- UI/API đều kiểm tra quyền; ẩn nút không phải lớp bảo vệ.
- Lệnh shell chạy trong cwd project không tạo ra sandbox filesystem.
- Agent không chỉnh policy/roster/hook bằng file tool; admin commands có audit riêng.

Chỉ localhost trong v1. Browser session cookie HttpOnly/SameSite và CSRF; kiểm tra Host/Origin. Không quảng bá loopback là bảo vệ khỏi mọi chương trình cùng OS user; giới hạn threat model phải được ghi rõ.

## 3. Approval

Operation intent lưu tool/version, target, normalized args hash, configHash, policyRevision, project/run/task ID và effectClass.

Approval UI cho thấy thao tác cụ thể và đích tác động, không chỉ "Agent muốn quyền". Quyết định gắn với đúng intent; thay recipient/path/args/version phải phê duyệt lại theo policy. Mặc định expiry đề xuất 10 phút; dùng durable continuation, không giữ HTTP request chờ vô hạn.

approve không thay mọi grant tương lai. deny trở thành tool result có lý do để Coordinator đổi kế hoạch. Decision race chỉ một bên thắng bằng CAS; stale tab nhận trạng thái đã quyết định.

Read-only trong scope có thể tự chạy; local writes theo grant project; external send/publish theo quyền người dùng đã cấp cho thao tác. Request approval phải nêu lý do và thao tác thật; tránh yêu cầu lặp cho cùng operation đã được cấp.

## 4. Secrets và model endpoints

Gateway đọc .env lúc khởi động và giữ key phía backend; worker/shell nhận environment allowlist. Không truyền toàn bộ process.env xuống child process. Không cho browser đọc API key qua settings, health, SSE, download hoặc logs.

Key thật không ở agent.yaml/system/soul/tools/memory. Config snapshots chỉ giữ tên biến credential và configured flag. Redaction trong log là lớp bổ sung, không thay việc tách key khỏi payload.

Model endpoint do owner cấu hình và validate. Public web tools không được tự truy cập loopback/private ranges, metadata endpoints hoặc lấy credential qua redirect/DNS rebinding. Local model endpoint được cấp riêng cho gateway; không tự trở thành đích web.fetch.

## 5. Skill/hook và nội dung không tin cậy

Agent packages do owner cài/version. Tài liệu web/upload/retrieved memory được đánh dấu nguồn và trust level; instructions trong nội dung đó không đổi system policy.

Script skill/hook là code thực thi; cần registry và executor với quyền rõ. Không thực thi shell command chỉ vì một trang web hoặc memory record yêu cầu. Hooks không có raw gateway key và không bypass broker.

Audit: ai/cấu hình nào đã yêu cầu gì, tool nào thực hiện, kết quả và receipt. Lưu tóm tắt hành động/decision và nguồn chứng minh; không yêu cầu model xuất nội bộ suy luận riêng để làm log.

## 6. MemoryStore

Nguồn sự thật là DB; memory.md là materialized summary có record IDs/revision, cập nhật atomic. Chỉnh file bằng owner phải import có expectedRevision và diff; không có hai nguồn tự ghi đè nhau.

Scopes:
- user: sở thích được owner xác nhận, ví dụ tiếng Việt và định dạng báo cáo;
- agent: quy ước chuyên môn tổng quát được chấp nhận; không tự hút bí mật từ các project;
- project: quyết định, tài liệu và kết quả có nguồn của project;
- run: scratch/handoff/checkpoint của lượt thực thi.

Record có content, sourceType/sourceRef, sourceVersion/checksum, createdBy, createdAt, status(proposed/accepted/rejected), confidenceLabel, expiresAt?, revision. Độ tin cậy là metadata để kiểm tra, không chứng minh fact đúng.

Project memory có thể tự cập nhật theo workflow có nguồn; nâng nội dung từ project sang agent/user scope cần policy owner cho phép. Không tự đem thông tin project A vào B chỉ vì cùng specialist.

Retrieval v1: scope filter trước → lexical/FTS search → provenance/freshness → token cap. Embeddings là extension sau khi đo chất lượng. Bắt đầu đề xuất top 8 records, tối đa 4000 token memory, điều chỉnh theo model context.

Pinned project decisions và task requirements được ưu tiên; không silently truncate input bắt buộc. Compaction giữ task state/evidence refs/tool call-output pairs và ghi version. Không coi summary model là nguồn gốc thay thế tài liệu.

Delete memory phải invalidation index/cache/materialized summary; tombstone ngăn background job hồi sinh record. Retention không xóa memory đang được run active tham chiếu.

## 7. Artifacts và verification

Artifact là sản phẩm có thể mở/tải, không chỉ thông điệp "đã tạo". Mỗi version có checksum, MIME, size, creator execution, source refs và verification report.

| Artifact | Kiểm tra tự động tối thiểu |
| --- | --- |
| Báo cáo Markdown/HTML | Link/nguồn tồn tại trong evidence set; cấu trúc bắt buộc; sandbox preview |
| CSV/kết quả phân tích | Schema, số dòng, tính lại các phép tính trên fixture |
| Code patch | Áp dụng trên base đúng; diff inspectable; typecheck/test/build theo project |
| Website preview | Process/port tracked, tải được, screenshot/E2E; không tự public |
| Email/calendar draft | Dữ liệu đủ, người nhận/thời gian rõ; chưa gửi khi chỉ tạo draft |

Reviewer đánh giá nội dung và trả finding theo phiên bản artifact. Những kiểm tra deterministic không bị thay bằng đánh giá "có vẻ đúng" của LLM.

Ghi blob: temp → validate → checksum → rename → metadata transaction. Version cũ giữ được để so sánh. Một artifact fail validation vẫn có thể giữ dưới trạng thái failed để debug, không xuất hiện như final output.

## 8. Coding workspace

- Gắn approved root, xác định base commit/snapshot trước khi chạy.
- Workspace có thay đổi chưa commit: bảo toàn và tạo isolated snapshot bao gồm thay đổi; không reset/clean working tree của người dùng.
- Mỗi run coding có worktree/copy riêng khi phù hợp; worktree không cung cấp security isolation.
- Chạy build/test theo scripts được phát hiện và policy; dependency install là thao tác có thể chạy script, cần đúng executor/grant.
- Output gồm patch/commit ref, base ref, tests và limitations. Áp dụng vào workspace gốc là thao tác riêng có kiểm tra conflict.
- Merge/commit không thành công phải giữ patch và nêu conflict; không force push hoặc tự deploy production.
- Preview process có TTL/cancel/cleanup và port allowlist; không trở thành process nền không quản lý.

## 9. Research/report workflow

Search provider là dependency có cấu hình riêng; model không mặc nhiên có internet. web.search và web.fetch adapter phải được nghiệm thu với provider thật trước M4.

Researcher trả claims + source URL + fetchedAt + excerpt/content hash. Analyst/Writer giữ liên hệ giữa nhận định và nguồn. Reviewer kiểm tra nguồn hỗ trợ nhận định, đánh dấu thiếu/không chắc chắn. Không bảo đảm độ đúng chỉ vì có URL.

Giới hạn crawl/tool calls và domain policy; không dùng bất kỳ credential trong máy ngoài connection được owner cấp. Nội dung nguồn được giữ theo retention và quyền truy cập, không xuất tất cả transcript vào báo cáo.

## 10. Connectors sau v1

Mỗi connector có OAuth/API setup, least-privilege scopes, encrypted token storage/OS keychain, refresh/revoke, health, tool schemas và retry/reconciliation.

Làm theo thứ tự: đọc/search → draft → update → send/create bên ngoài. external_write có provider receipt/idempotency nếu hỗ trợ; mất receipt thì reconcile. Mock connector kiểm tra cơ chế approval trong v1 nhưng không được quảng bá là đã có Gmail/Calendar thực.

Không tái sử dụng ngầm token của Codex, tài khoản browser hoặc connector đang có trong cuộc trò chuyện này.

## 11. Nghiệm thu

File traversal/junction/secrets bị chặn; developer ở A không đọc memory B; hook timeout không tiếp tục ghi state; user thay file giữa read/patch gây conflict; approval sửa args bị từ chối; key sentinel không xuất hiện trong UI/log/prompt; CSV được tính lại đúng; email mock ambiguous outcome không gửi lại lần hai.
