# 08 — Kiểm chứng, vận hành và phát hành

## 1. Chiến lược kiểm thử

Unit tests cho invariant/domain transitions và parsing; integration tests dùng DB tạm, worker thật và provider giả có fault injection; contract tests cho adapters/API/IPC/SSE; browser E2E kiểm tra hành vi người dùng trên fixtures và backend; live smoke chỉ khi có profile/credential và budget do owner cấp.

Không dùng model thật làm dependency của CI thường ngày. Fake model phải thực hiện tool-call/stream/error theo giao thức thật, không chỉ trả câu cuối cùng hardcode để bỏ qua runtime. Test fixtures không dùng dữ liệu hội thoại cá nhân.

## 2. Ma trận kiểm chứng bắt buộc

| ID | Tình huống | Bằng chứng cần có |
| --- | --- | --- |
| T01 | Khởi động không có project/key | Pool đúng roster, zero model calls, lỗi readiness rõ |
| T02 | Tạo project bị retry/đa tab | Một project, một Coordinator, một conversation |
| T03 | 5 project, restart, archive/restore | IDs/memory/phòng đúng; không giới hạn 2 phòng |
| T04 | Một specialist được hai project yêu cầu | Chỉ một live assignment; bên còn lại chờ |
| T05 | Task có dependency chưa xong | Không giữ specialist; planned và assigned counts khác |
| T06 | Nhiều task independent | Chạy song song trong global/provider limits |
| T07 | Invalid/cyclic/over-budget plan | Bị từ chối trước dispatch, số lượt sửa có giới hạn |
| T08 | Responses tool-call streaming bị chia nhỏ | Chỉ chạy tool khi args hoàn chỉnh; đúng callId |
| T09 | Chat adapter nhiều calls/unsupported tool | Đúng codec/mapping; không âm thầm bỏ tool |
| T10 | Mất stream model, 429/401/5xx | Retry policy đúng, partial text có trạng thái, usage audit |
| T11 | Kill worker trước/sau checkpoint | Khôi phục đúng position; không mất operation intent |
| T12 | Lease hết hạn, worker cũ quay lại | Fencing chặn state/tool writes của epoch cũ |
| T13 | Crash sau external effect trước receipt | outcome_unknown, reconcile; không dispatch lại mù |
| T14 | Quyết định approval từ hai tab/hết hạn | Một quyết định; stale/expired bị từ chối |
| T15 | Tham số thay sau approval | Approval cũ không hợp lệ với args hash mới |
| T16 | Pause/cancel lúc model/tool/child chạy | State cuối đúng; không child downstream chạy lại |
| T17 | Path traversal/UNC/junction/symlink/ADS | Không thoát root; không đọc secret/config |
| T18 | Prompt injection trong web/upload/memory | Không đổi policy/endpoint/permission hoặc chạy lệnh lạ |
| T19 | Project A/B dùng cùng specialist lần lượt | Memory/context không lẫn phạm vi |
| T20 | Sửa/xóa memory, reload, background summary | Không hồi sinh record bị xóa; optimistic conflict đúng |
| T21 | Patch trên file người dùng vừa sửa | CAS conflict, giữ dữ liệu của người dùng |
| T22 | SSE mất/replay/slow consumer/cursor cũ | Dedupe, snapshot reset, không tạo run mới |
| T23 | Agent chuyển room, activity live, settings, mobile | Một nhân vật/ID đi đúng room; sidebar nhóm Coordinator và specialist theo project, pool chỉ hiện agent chưa được điều phối; working/waiting/idle và hành vi đi lại giữ từ Habblaud; bong bóng, sidebar, ticker/feed nhận nhãn task/tool an toàn; camera/settings lưu qua reload; project drawer đóng/mở được trên viewport nhỏ để văn phòng vẫn xem được; raw model reasoning và tool arguments không hiển thị; assignment/reconnect không làm mất activity |
| T24 | Artifact write crash/invalid HTML/oversize | Không final metadata trỏ blob thiếu; preview sandbox |
| T25 | Budget với nhiều in-flight/retry/unknown price | Reservation đúng; không hiển thị giá 0 giả |
| T26 | Thêm agent/skill/config sai trong lúc đang chạy | Busy snapshot giữ version; valid agent xuất hiện, invalid rõ lỗi |
| T27 | Backup/restore + migration lỗi | Khôi phục DB/blobs/config đúng checksum, active state không mất |
| T28 | Graceful shutdown/crash + process cleanup | Worker/process/preview được quản lý; lease không kẹt |
| T29 | Coding, research và CSV workflows | Outputs mở được, tests/nguồn/phép tính có bằng chứng |
| T30 | Accessibility/i18n/keyboard/reduced motion | vi/en, thao tác ngoài canvas, lỗi bằng chữ |

Không ghi "pass" cho mode sandbox hoặc live provider chưa thực sự chạy. Báo cáo phải chỉ rõ môi trường và phần skipped.

## 3. Fault injection matrix

| Điểm dừng | Trạng thái bền đã có | Hành vi khi restart |
| --- | --- | --- |
| Trước commit message/run | Chưa có command hoặc idempotency record | Client retry an toàn |
| Sau commit trước SSE | State + event | Publisher phát lại từ DB |
| Sau reserve trước worker ACK | Assignment/lease | Timeout xác minh worker, fencing rồi requeue |
| Trong model stream | Request intent + checkpoint trước call | interrupted; không chạy args dở; retry có thể phát sinh phí model |
| Sau complete model trước tool | Tool intent chưa dispatched | Resume policy/approval, không gọi lại model nếu checkpoint đủ |
| Hard-kill sau checkpoint tool call nhưng trước dispatch | Pending tool call có operation ID; chưa có tool operation | Khi restart, chèn kết quả “chưa dispatch” vào transcript, cho model quyết định lại và không chạy side effect cũ |
| Sau dispatched tool khi chưa có receipt | Operation ID + tool ID | Pause run và đánh dấu `TOOL_OUTCOME_UNKNOWN`; owner kiểm tra trước khi tiếp tục, không tự chạy lại tool |
| Sau lifecycle audit event commit trước khi complete outbox | Event id ổn định + outbox pending, payload đã được rút gọn | Replay trả event đã có, không tăng revision hoặc tạo bản sao, rồi xóa payload tạm |
| Sau tạo blob trước DB commit | Orphan có journal | GC sau grace period; không hiện artifact thành công |
| Sau result trước release event | Task state và event cùng transaction | Đọc state mới, release/dedupe theo version |
| Trong migration/backup | Version/checksum + previous backup | Dừng readiness, hướng restore; không tiếp tục trên schema nửa chừng |

## 4. Ba kịch bản UAT đầy đủ

### A. Xây một website đơn giản

- Tạo project có approved root; chọn executor Docker hoặc local-trusted rõ ràng.
- Nhắn Coordinator tạo website theo acceptance cụ thể.
- Thấy plan, Developer nhận task, Reviewer kiểm tra đúng output revision.
- Mở preview; có build/test report và patch/base ref.
- Chủ động làm test fail để kiểm tra bounded repair; hết vòng thì báo vấn đề.
- Cancel một lần đang chạy, xác minh process/preview và assignment cleanup.
- Không có thay đổi mất/ghi đè ở workspace gốc; không tự xuất bản ra internet.

### B. Nghiên cứu và tạo báo cáo

- Cấp search provider và nguồn dữ liệu test được phép.
- Coordinator chia nghiên cứu độc lập, Writer tổng hợp, Reviewer đối chiếu.
- Artifact có nguồn hỗ trợ nhận định, ngày lấy và các giới hạn.
- Nguồn trả lệnh "bỏ qua yêu cầu" không thay đổi tool policy.
- Thiếu nguồn hoặc search provider fail thì báo partial/blocked chính xác.

### C. Phân tích CSV

- Upload fixture có missing values, định dạng số và dữ liệu biên.
- Analyst gọi tool deterministic, tạo bảng kết quả.
- So sánh sums/counts/means với kết quả chuẩn độc lập.
- Writer tạo tóm tắt; Reviewer kiểm tra số liệu và assumptions.
- Project khác không đọc được upload/memory này khi chưa được cấp.

## 5. Evals chất lượng và baseline

Tạo corpus tối thiểu 40 task có rubric: 10 coding, 10 research, 10 analysis, 10 orchestration/recovery. Lưu input fixture, expected properties, allowed tools, acceptance, max budget và reviewer rubric. Phân biệt deterministic pass với đánh giá nội dung của con người.

Chọn 12 task đại diện để so sánh cùng model/tool/budget giữa single-agent và multi-agent; lặp tối thiểu 3 lần nếu budget cho phép. Log số lần chạy thực tế, không biến một demo thành kết luận thống kê. Lựa chọn sample có dữ liệu riêng hoặc code thay đổi phải reset bằng fixture tách biệt, không reset repo của owner.

`npm run eval:baseline -- --dry-run` dựng ma trận mặc định C01/C03/C10, R01/R05/R08, A01/A05/A09 và O01/O05/O09: 72 lượt, trần theo corpus là 16,20 USD. Lượt live cần `--live` và `--max-total-tokens`; giới hạn output mặc định 2.048 token mỗi request để dành chỗ cho payload tool và artifact, có thể đổi bằng `--max-output-tokens`. Mặc định harness cách tối thiểu 8 giây giữa các request tới provider để hạn chế 429; có thể chỉnh bằng `--min-request-interval-ms`. Nếu model chưa có giá chính xác trong profile, chỉ chạy khi truyền `--allow-unpriced`, khi đó báo cáo USD là chưa biết. Các lượt được chạy tuần tự, mỗi lượt có database/workspace tạm riêng. `--approve-isolated-operations` chỉ tự duyệt ghi vào workspace tạm do harness tạo; `--docker-checks` chỉ chạy script allowlist trong image Docker đã pin và có sẵn tại máy, không tự tải image. JSON report giữ output, usage, artifact, workspace checksums và rubric để người review chấm thủ công; trạng thái run thành công không tự được tính là chất lượng đạt.

Hồ sơ Agnes `agnes-2.5-flash` dùng giá niêm yết bảo thủ $0.05/M input và $0.15/M output. Trang giá Agnes hiện nêu chương trình $0, nhưng mức áp dụng cuối cùng phụ thuộc tài khoản và hóa đơn; giá niêm yết giữ cho trần cục bộ không dựa vào ưu đãi tạm thời.

Live baseline ghi checkpoint cập nhật theo từng lượt vào `<output>.partial` trước request đầu tiên và sau mỗi lượt hoàn tất. Checkpoint nêu lượt đang chạy để người vận hành biết usage có thể chưa rõ nếu process bị dừng đột ngột. Khi hoàn tất, report cuối được tạo theo kiểu không ghi đè; checkpoint chỉ bị xóa sau khi report cuối được lưu. Nếu `.partial` đã tồn tại, harness giữ nguyên và yêu cầu chọn đường dẫn `--output` mới thay vì ghi mất bằng chứng.

Chấm chất lượng là thao tác của người review, tách khỏi trạng thái thực thi. Tạo score sheet trống từ report:

```powershell
npm.cmd run eval:score -- --report evals/results/baseline.json --template-out evals/results/baseline-review.json
```

Review từng `expectedProperties`, `acceptance` và `reviewerRubric`; đặt `rating` thành `pass`, `partial` hoặc `fail`. Mỗi `partial`/`fail` cần có lý do trong `note`. Không sửa criterion hoặc metadata run. Sau khi điền tất cả tiêu chí của lượt có model request, tạo summary:

```powershell
npm.cmd run eval:score -- --report evals/results/baseline.json --scores evals/results/baseline-review.json --summary-out evals/results/baseline-review-summary.json --reviewer "Tên người review"
```

CLI xác thực SHA-256 của report, ghi hash SHA-256 của score sheet vào summary, giữ nguyên cả hai input, từ chối ghi đè output, tách điểm rubric khỏi execution success, rồi tính trung bình mỗi lượt và cặp theo task/repetition. Summary là mô tả mẫu đã review; không kết luận ưu thế thống kê từ cỡ mẫu nhỏ hoặc thiếu cặp.

Trong baseline này, `single-agent` vẫn có Coordinator và chỉ bật một loại chuyên viên theo nhóm task; Coordinator có thể giao nhiều task cho các instance của cùng chuyên viên. `multi-agent` bật toàn bộ roster chuyên viên. Vì vậy phép so sánh đo tác động của roster chuyên viên, không phải Coordinator so với một agent đơn lẻ.

Mục tiêu pilot đề xuất để owner hiệu chỉnh sau baseline:
- 100% invariant quyền/assignment/idempotency trong bộ deterministic.
- Ít nhất 80% task corpus đạt acceptance mà không cần sửa lớn bằng tay.
- Mọi output numeric trong corpus analysis khớp phép tính chuẩn.
- Mọi claim quan trọng trong báo cáo có evidence hỗ trợ hoặc đánh dấu chưa xác minh.
- Không có finding critical chưa xử lý trong bản được đánh dấu succeeded.
- Báo cáo success rate, manual intervention, latency, token/cost và failure category riêng; không chỉ báo điểm trung bình.

Đây là target nghiệm thu cho bộ test đã biết, không bảo đảm chính xác tuyệt đối ngoài thực tế hoặc cam kết hơn Codex/Claude.

## 6. Performance và reliability targets

Máy tham chiếu P0 cho lần đo ngày 26/10/2026 là Windows 11 Home Single Language (build 10.0.26200), Intel Core i7-13650HX (14 nhân/20 luồng), RAM khả dụng 15,7 GiB, Intel UHD Graphics và NVIDIA RTX 4050 Laptop GPU. Browser là Chromium 156.0.8078.4 đi kèm Playwright 1.64.0; bài đo chạy bằng headless Chromium, nên không khẳng định hiệu năng GPU tăng tốc hoặc thay thế việc duyệt trên màn hình của owner. Mục tiêu ban đầu để đo:
- UI có 10 project/30 nhân vật vẫn dùng được, 30 FPS trở lên trong canvas benchmark.
- API CRUD local p95 dưới 300 ms khi có 4 execution; không tính latency model/provider.
- Event committed đến UI p95 dưới 1 giây trong môi trường local.
- Sau mất stream, snapshot và counters phục hồi trong 5 giây sau kết nối trở lại.
- Worker mất heartbeat được phát hiện theo lease policy; không có hai worker cùng quyền ghi.
- Soak test 8 giờ với fixtures quay vòng: không tăng liên tục process/assignment/handle count.

Kết quả hiện tại: production Chromium smoke trên fixture 10 project/30 project agent (36 nhân vật render) đạt 35,92–36,79 FPS và p95 frame 33,4 ms qua ba lượt có report; ngưỡng 30 FPS đạt cả ba lượt. Screenshot sidebar/agent đang làm việc, setting và Activity nằm ở `visual-evidence/office-r78-{working,settings,activity}.png`.

`npm run office:performance-test` chạy server và database tạm, tạo 10 phòng, giữ bốn run thật ở bốn request của fake provider tại loopback, rồi đo 30 mẫu mỗi thao tác API và 30 lần event chuyển trạng thái tới khi nút agent đổi trên giao diện Chromium. Benchmark không dùng credential hoặc endpoint model thật; `DomainEvent.occurredAt` được tạo ngay trước transaction SQLite, vì vậy event p95 bắt đầu từ timestamp này và kết thúc tại thay đổi DOM nhìn thấy. Chạy sau `npm run office:build` để bảo đảm client/server build hiện hành. Ba lần chạy ngày 26/10 đạt API overall p95 17,71–18,04 ms, operation p95 cao nhất 18,06–19,74 ms, và event-to-visible-UI p95 30–35 ms; mục tiêu API dưới 300 ms và event dưới 1 giây đều đạt trên máy tham chiếu. Các report chi tiết nằm trong `evals/results/office-performance-*.json`.

Browser smoke tạo event `agent.draining` khi tab offline, khôi phục kết nối, rồi xác minh snapshot, trạng thái nút agent, pool counter và phòng đang chọn. Ba report liên tiếp đo thời gian khôi phục 200,9 ms, 187,2 ms và 212,8 ms, đều dưới 5 giây; kết quả đầy đủ ở `evals/results/office-browser-smoke-*.json`. Một lượt trước đó kết thúc với Chromium `ERR_NO_BUFFER_SPACE`; tiến trình test/browser đã thoát, thư mục tạm được dọn, và bốn lượt tiếp theo đều vượt qua. Mục tiêu phục hồi snapshot/counters trong năm giây đạt trên máy tham chiếu; vẫn cần owner UAT trên màn hình thật.

The opt-in SSE soak harness defaults to eight hours and rotates replay/live durable-event fixtures while periodically forcing slow-client eviction. On Windows, run `$env:OFFICE_SOAK_TESTS='1'; npm run office:soak`; use `OFFICE_SOAK_DURATION_MS` for a shorter harness smoke, then retain the full eight-hour result as release evidence. The deterministic load regression remains part of the normal platform suite.

Không tắt validation hoặc bỏ events để đạt số đo. Nếu hardware không đáp ứng, tối ưu/cull sprites/giảm animations hoặc sửa target có lý do trước release.

## 7. Quan sát và logs

Log có requestId, workspace/project/run/task/execution/operation IDs, configHash, duration, outcome và error code. Mặc định không log raw prompts/tool outputs/Authorization. Debug content capture là opt-in có retention và chỉ dữ liệu được phép.

Metrics: queue depth/wait, active executions, specialist utilization, model retries/latency, tool failures, approvals age, budget reserved/spent, stale leases, SSE clients, checkpoint lag. Pool idle không tính là execution hoặc token usage.

Health/readiness phân biệt HTTP sống, DB writable, migrations ready, scheduler healthy, worker available, model configured, tool credentials configured. Không ping model trả phí mỗi healthcheck.

## 8. Lưu trữ và backup

Mặc định đề xuất:
- Artifacts/project memory giữ đến khi owner archive/delete theo thao tác riêng.
- Audit/domain events 30 ngày; active run references được pin.
- Checkpoints terminal 14 ngày; những thứ cần để xem artifact provenance vẫn giữ.
- Debug content capture tối đa 24 giờ khi được bật.
- Backup theo owner kích hoạt trước; lịch tự động chỉ cấu hình khi người dùng chọn.

Backup bằng snapshot SQLite hỗ trợ WAL, không copy riêng file .db khi đang ghi. Bundle gồm DB, artifact manifest/blobs, config definitions/skills và hashes; secret loại khỏi export mặc định, hướng dẫn cấu hình lại hoặc encrypted export riêng.

Restore vào thư mục mới trước, verify checksums/schema, doctor và mở read-only kiểm tra; chỉ switch dữ liệu active sau khi xác nhận. Backup chưa thử restore không được tính là đủ.

## 9. Start/stop, update và rollback

Các lệnh dự kiến của repo sản phẩm:
~~~powershell
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run config:validate
npm.cmd run office:doctor
npm.cmd run build
npm.cmd start
~~~

Chúng là đích của P0/P8, không phải chỉ dẫn chạy tính năng chưa xây ở repo Habblaud hiện tại. Cấu hình thật điền trong .env trước live doctor. Dev script chạy server + UI, PowerShell không cần gán env kiểu Unix.

Stop bằng Ctrl+C: ngừng nhận commands, pause dispatch, checkpoint, cancel/finish workers trong grace period, đóng DB. Nếu buộc kill, startup recovery thực hiện theo 03. Chỉ cleanup processes có recorded identity/start token của app, không kill toàn bộ node.exe.

Upgrade: backup → config validate → schema compatibility → migrate → health/smoke → activate. Nếu migration không tương thích ngược, rollback dùng bản backup và binary cũ; không tự chạy binary cũ trên DB mới.

## 10. Release checklist

- [x] T01–T30 đều có report; mode/provider skipped, trường hợp Partial và giới hạn được ghi rõ trong `docs/AGENT-OFFICE-TEST-REPORT.md`.
- [x] Ba UAT workflows đã chạy trên Windows với model Agnes thật và workspace/artifact tools trong execution mode disabled; báo cáo còn đánh dấu chi phí chưa định giá và human rubric chưa chấm.
- [x] npm run typecheck, npm test, npm run build, i18n check đạt yêu cầu fork.
- [x] Key/secret sentinel không nằm trong browser bundle, network response, prompt payload và logs.
- [x] Config examples, doctor, troubleshooting và add-agent guide đầy đủ.
- [x] Backup/restore và versioned migration đã thử.
- [x] LICENSE/notices/upstream SHA được giữ.
- [x] Runtime không dùng Codex/Claude CLI để thực hiện công việc và không khởi tạo World uplink; production static serving chỉ mở Agent Office entry/assets, kiểm tra resolved path ở đúng thư mục `bundle`/`assets`, còn root redirect, legacy-page 404 và bốn biến thể traversal Windows đều được kiểm tra trong package smoke.
- [x] Known limitations, executor trust mode và credential/provider compatibility được công bố.
- [ ] Hosted Windows CI, human rubric và hóa đơn provider của các lượt live được owner xem xét hoặc ghi nhận quyết định miễn.
- [ ] Owner nghiệm thu trước khi phát hành/publish ra bên ngoài.


