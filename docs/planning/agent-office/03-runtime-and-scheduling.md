# 03 — Runtime, điều phối và khôi phục

## 1. Các bất biến

1. Mỗi project active có đúng một CoordinatorInstance.
2. Mỗi specialist chỉ có một assignment chưa released; khóa bằng unique constraint/transaction.
3. Mỗi conversation có tối đa một root run chưa kết thúc ở v1; follow-up có số thứ tự.
4. Task ở blocked_dependencies chưa giữ worker; plan không phải bằng chứng assignment.
5. Coordinator đề xuất thay đổi; runtime kiểm tra schema, dependency, quyền và budget trước khi commit.
6. Model output không trực tiếp thay state hoặc gọi tool.
7. Một lần hoàn thành phải có output đáp ứng schema/acceptance; câu "done" không đủ.
8. Chỉ committed state được phát cho UI; animation không điều khiển nghiệp vụ.
9. Worker cũ sau mất lease không được ghi output hoặc phát tool action mới.
10. Không retry mù thao tác có tác động bên ngoài khi kết quả chưa rõ.
11. Không ghi key vào checkpoint/prompt/log; mỗi execution giữ config version cố định.
12. Đóng tab không ảnh hưởng scheduler.

## 2. State machines

| Entity | Trạng thái |
| --- | --- |
| Project | active, archiving, archived, deleting, deleted |
| Instance availability | ready, reserved, busy, draining, unavailable, disabled |
| Logical location | pool hoặc project(projectId) |
| Run | queued, planning, executing, waiting_input, waiting_approval, paused, cancelling, succeeded, failed, cancelled, interrupted |
| Task | proposed, blocked_dependencies, ready, assigned, running, waiting_children, waiting_input, waiting_approval, needs_revision, succeeded, failed, cancelled |
| Execution | queued, running_model, running_tool, waiting_children, waiting_input, waiting_approval, paused, succeeded, failed, cancelled, interrupted |
| Tool operation | proposed, pending_approval, authorized, dispatched, succeeded, failed, outcome_unknown, cancelled |
| Assignment | reserved, active, releasing, released |

Run là aggregate: còn child đang chạy thì không kết thúc succeeded. Có waiting_approval không tự biến mọi child thành chờ; các child độc lập vẫn có thể chạy trong budget.

Mỗi run có một control task loại coordinator để chứa các execution lập kế hoạch/tổng hợp. Control task không được đưa vào mẫu số tiến độ task nghiệp vụ. Execution của Coordinator liên kết instance qua coordinator binding, assignmentId có thể null; specialist execution luôn cần assignment hợp lệ. Quan hệ parent/control tách khỏi dependency DAG để không tạo cycle.

Khi chờ chuyên viên, Coordinator chuyển waiting_children và trả execution slot; không giữ kết nối model hoặc polling LLM. Committed child completion event đánh thức continuation đúng một lần theo version. Mọi trạng thái waiting không chiếm slot gọi model/tool, dù vẫn có context/assignment được giữ. Quy tắc này ngăn các Coordinator chờ chiếm hết slot khiến specialist không thể chạy.

Assignment không được released khi tool operation còn dispatched/outcome_unknown. Runtime xác minh/hủy/reconcile trước khi trả specialist về pool. Run tạm dừng chờ người dùng có thể giải phóng execution slot nhưng giữ assignment/context; pause dài chỉ chuyển assignment theo quy trình checkpoint rõ ràng.

## 3. Tiếp nhận yêu cầu

1. API kiểm tra project/conversation active, quyền và idempotency key.
2. Transaction lưu user message, run queued và event.
3. Nếu conversation đã có root run active, tạo follow-up queued hoặc steering command theo lựa chọn người dùng.
4. Dispatcher cấp slot cho Coordinator, lấy snapshot config và context.
5. Model có thể trả lời trực tiếp, hỏi thông tin cần thiết hoặc gọi task.plan.
6. Plan được validate trước khi đưa tasks vào DB.
7. Không có credential/capability thì trả trạng thái blocked có lý do, không gọi fake model.

## 4. Hợp đồng plan

Plan có goal, successCriteria, tasks, budget, assumptions và revision. Mỗi task có:
- key duy nhất trong run; objective cụ thể;
- requiredCapabilities và preferredDefinition tùy chọn;
- dependencies theo task key; inputRefs đến dữ liệu được phép đọc;
- outputSchema/artifactTypes; acceptanceChecks;
- toolScope hẹp hơn policy project; maxTurns, timeout và tokenBudget;
- reviewRequirement, priority, stopCondition.

Validation: không cycle, không dependency ngoài scope, không role/tool không tồn tại, không vượt giới hạn fan-out/depth/budget. Mọi leaf phải có đầu ra; task gọi lại chính nó bị từ chối. Invalid plan có tối đa 2 lượt sửa tự động; sau đó hỏi người dùng hoặc fail có giải thích.

Thay plan đang chạy phải có revision và CAS; không xóa task đã có side effect. Task bị thay thế được đánh dấu superseded trong metadata, hủy theo state machine và giữ audit.

## 5. Scheduler

Thuật toán vòng dispatch:
1. Lấy task ready theo priority rồi createdAt, có aging chống starvation.
2. Lọc project/run active, dependency đã đáp ứng, capability/tool/model đã sẵn sàng.
3. Kiểm tra quota provider/workspace và budget reservation.
4. Tìm specialist ready phù hợp capability; không cố định theo tên người.
5. Transaction reserve specialist + assignment + execution lease + event; một dispatcher thắng.
6. Gửi command có executionId, leaseEpoch, configHash cho worker.
7. Worker ACK; thiếu ACK/heartbeat thì recovery xử lý trước khi reassign.
8. Hoàn thành task, lưu handoff/artifacts, đánh giá acceptance, giải phóng assignment.
9. Đưa downstream tasks từ blocked_dependencies sang ready theo cùng revision.

SQLite: một DB writer; dùng transaction ngắn và CAS/version. Gọi network nằm ngoài transaction. Partial unique index ngăn hai assignment active trên một specialist.

Mặc định đề xuất: tối đa 4 execution running toàn workspace, trong đó 3 specialist; max 12 task/run, delegation depth 2, reviewer sửa tối đa 2 vòng. Đây là giới hạn khởi đầu có thể đổi sau đo lường, không phải khả năng tối đa của sản phẩm.

Lease heartbeat đề xuất 5 giây, expiry 30 giây; fake-clock tests quyết định con số cuối. Khi mất lease, parent chặn mọi broker request có epoch cũ, terminate worker/process group trước khi cấp lại. Nếu có operation mơ hồ thì đưa vào reconciliation, chưa reassign.

## 6. Agent loop

~~~text
load checkpoint + immutable config snapshot
build context under token budget
reserve model request budget
call adapter → stream text/tool-call fragments
wait completed response → validate complete tool arguments
persist assistant turn + call IDs + usage
for each approved tool:
    create durable operation intent
    policy check → approval nếu cần
    dispatch executor with operationId + fencing token
    persist result/artifact + checkpoint
feed tool result with matching call ID into next model turn
finish when output valid, blocked, cancelled or limits reached
~~~

Chỉ thực thi tool call khi đã có payload hoàn chỉnh và response hợp lệ; không chạy từ JSON arguments đang stream dở. Provider-specific continuation items phải được adapter lưu/khôi phục đúng, kể cả opaque items cần cho lượt tiếp theo.

Nhiều tool call trong một lượt: read-only độc lập có thể parallel với giới hạn; write/shell mặc định tuần tự. Kết quả giữ đúng callId ngay cả khi tool hoàn thành khác thứ tự. Không ghép lại hai calls khác nhau thành một thao tác khó audit.

Các hook có budget/timeout riêng; lỗi hook không được âm thầm bỏ qua security policy. Hook lặp lại không được nhân đôi state transition.

## 7. Handoff và review

Handoff có taskId, summary, outputRefs, evidenceRefs, checksPerformed, openIssues, proposedNextActions. Không cần gửi toàn bộ transcript cho agent kế tiếp.

Task implementation và task review là hai task riêng. Reviewer đọc yêu cầu gốc và evidence/artifacts, trả findings có severity và vị trí. Finding critical chưa giải quyết ngăn root run succeeded theo policy. Model review hỗ trợ kiểm tra; acceptance test/objective checks vẫn do tool thực hiện khi có thể.

Không yêu cầu review mọi câu trả lời đơn giản. Coordinator không tự tạo vô hạn specialist/review loop; fan-out và vòng sửa bị runtime giới hạn.

## 8. Pause, cancel và follow-up

- Pause: không dispatch task mới, chờ model/tool đến safe boundary; checkpoint, xác nhận paused.
- Cancel: lưu cancellationRequested trước, AbortSignal đến model/tool, kill tree nếu executor cho phép; chờ xác định kết quả rồi lưu cancelled/partial.
- Công cụ không hỗ trợ hủy: hiển thị cancelling, không báo cancelled sớm; lấy kết quả muộn và audit.
- User input/approval dùng continuation token đã lưu; restart có thể tiếp tục đúng execution.
- Steering có sequence; inject tại safe boundary, Coordinator được biết. Không viết trực tiếp vào RAM của worker.
- Follow-up sau terminal run tạo run mới cùng conversation và memory project.

Nếu output về sau khi run bị cancel hoặc leaseEpoch cũ, lưu dưới audit late_result khi cần đối chiếu; không làm run bật lại hoặc công bố artifact là kết quả hiện tại.

## 9. Checkpoint và recovery

Checkpoint gồm execution position, transcript/context references, pending calls, config/policy versions, artifact refs, budget reservations, run/task revision. Không dựa vào stack frame trong RAM.

Điểm ghi: trước model request, sau complete model turn, trước tool dispatch, sau tool result, trước khi chờ input, sau handoff. DB event và state update cùng transaction.

Khi khởi động:
1. Chạy migration, kiểm tra single-instance lock và DB integrity cơ bản.
2. Tải executions chưa terminal, assignments, leases và pending operations.
3. Thu hồi leases hết hạn bằng fencing; xác minh worker cũ đã dừng.
4. Model call đang dở: interrupted; có thể retry có giới hạn, ghi nhận chi phí có thể chưa rõ.
5. Read-only operation an toàn: retry sau backoff.
6. Write/external action dispatched mà chưa có kết quả: outcome_unknown, reconcile trước.
7. Chờ approval/input: giữ nguyên và phát lại UI; token approval hết hạn thì xin lại.
8. Đồng bộ projection từ DB, không replay animation thành model call mới.

Không hứa exactly-once cho provider bên ngoài. Bảo đảm mục tiêu là nhận lệnh idempotent, dispatch được theo dõi, dedupe/reconcile ở những nơi provider hỗ trợ.

## 10. Retry, hạn mức và chi phí

Retry mạng/429/5xx theo retry policy và Retry-After; tối đa 3 attempts với jitter/backoff. Không retry validation/401/403 như lỗi mạng. Chuyển model/endpoint chỉ theo fallback profile đã cấu hình và phải ghi lại.

Token usage lưu mỗi attempt, kể cả retry. Giá là price profile có version do owner cấu hình; thiếu giá hiển thị unpriced, không báo 0 USD. Hard money budget cần giá và reservation cho tổng max input/output của mọi in-flight request; nếu thiếu giá chuyển sang token budget hoặc yêu cầu cấu hình.

Compaction/reviewer/Coordinator đều tính vào ngân sách. Hết budget thì pause có checkpoint; không sinh thêm agent để né hạn mức.

## 11. Nghiệm thu kỹ thuật

Race 2 dispatcher chỉ tạo 1 assignment; worker epoch cũ bị chặn; cycle plan bị từ chối; cancel không chạy downstream; retry không nhân đôi artifact; restart tại từng checkpoint phục hồi đúng; tool outcome_unknown không tự retry; reviewer fail giữ đúng task needs_revision; prompt injection không sửa policy.
