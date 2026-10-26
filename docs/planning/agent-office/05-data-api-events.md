# 05 — Dữ liệu, API và sự kiện

## 1. Quy ước

ID dùng UUID, agent definition/skill/tool IDs dùng slug ổn định. DB timestamps UTC epoch milliseconds; API dùng ISO 8601 UTC; client hiển thị theo múi giờ người dùng. Schema và events có schemaVersion. Mọi entity thay đổi có version dùng optimistic concurrency.

Tất cả bảng domain có workspaceId trực tiếp hoặc được kiểm tra qua FK parent. Scope check diễn ra trước query/retrieval, không lọc sau khi đã lấy nội dung. Bản v1 chỉ có một workspace nhưng vẫn kiểm tra scope.

## 2. Entity model

~~~mermaid
erDiagram
    PROJECT ||--o{ CONVERSATION : contains
    PROJECT ||--|| COORDINATOR_BINDING : owns
    AGENT_INSTANCE ||--o| COORDINATOR_BINDING : represents
    CONVERSATION ||--o{ RUN : executes
    RUN ||--o{ TASK : contains
    TASK ||--o{ EXECUTION : attempts
    AGENT_INSTANCE ||--o{ ASSIGNMENT : receives
    ASSIGNMENT ||--o{ EXECUTION : runs
    EXECUTION ||--o{ TOOL_OPERATION : requests
    TOOL_OPERATION ||--o| APPROVAL : awaits
    TASK ||--o{ ARTIFACT_VERSION : produces
    PROJECT ||--o{ MEMORY_RECORD : remembers
~~~

AgentDefinition và AgentInstance tách nhau; một task retry có execution mới; execution không phải nhân vật mới. Task dependencies là bảng nối, không biểu diễn bằng cây parentId đơn thuần.

Control task của Coordinator dùng binding project thay vì assignment specialist; agentInstanceId luôn bắt buộc, assignmentId chỉ nullable cho execution Coordinator. Khi chờ child, execution waiting_children không giữ slot chạy. API không cho caller lợi dụng assignmentId null để chạy specialist ngoài scheduler.

## 3. Các bảng tối thiểu

| Bảng | Trường quan trọng |
| --- | --- |
| workspaces | id, name, settingsRevision, createdAt |
| projects | id, workspaceId, name, goal, status, roomOrdinal, workspaceRootRef, version |
| conversations | id, projectId, title, status, version |
| messages | id, conversationId, runId, speakerType, agentInstanceId?, contentRef, sequence |
| agent_definitions | id, version, manifestJson, configHash, enabled, validationErrors |
| agent_instances | id, workspaceId, definitionId/version, displayName, appearanceSeed, availability, version |
| coordinator_bindings | projectId PK, instanceId UNIQUE |
| config_snapshots | hash PK, definition/skill/hook/model/policy references, redactedConfigJson |
| runs | id, conversationId, status, planRevision, budgetId, cancellationRequestedAt, version |
| tasks | id, runId, taskKey, kind(coordinator/specialist/review), objective, requiredCapabilities, status, outputSchemaRef, version |
| task_dependencies | taskId, dependsOnTaskId; unique pair |
| assignments | id, agentInstanceId, projectId, taskId, status, reservedAt, releasedAt |
| executions | id, taskId, agentInstanceId, assignmentId?, configHash, attempt, status, leaseEpoch, leaseUntil, workerId |
| checkpoints | id, executionId, position, stateRef, schemaVersion, createdAt |
| tool_operations | id, executionId, toolId/version, argumentsRef/hash, policyRevision, status, receiptRef |
| approvals | id, operationId UNIQUE, scope, decision, expiresAt, decidedBy, version |
| artifacts | id, projectId, logicalName, currentVersionId, type |
| artifact_versions | id, artifactId, taskId, storageKey, checksum, size, validationRef |
| handoffs | id, taskId, outputRefs, evidenceRefs, checks, openIssues, createdAt |
| memory_records | id, workspaceId, scopeType/id, contentRef, provenance, status, revision, expiresAt? |
| budget_accounts | id, runId/projectId, tokenLimit, moneyLimit?, priceRevision, spent/reserved |
| usage_ledger | id, executionId, providerRequestId?, attempt, tokens, cost?, costStatus |
| domain_events | sequence PK, eventId UNIQUE, workspaceId, type, aggregateId/version, payload, createdAt |
| idempotency_keys | actorId, method, route, key, bodyHash, responseRef, expiresAt |
| workers | id, status, heartbeatAt, capabilities, processInfoRef |
| schema_migrations | version PK, checksum, appliedAt |

external_connections/operation_receipts xuất hiện khi làm connector P9; secret material ở OS credential store riêng, không lưu raw vào bảng cấu hình.

## 4. Ràng buộc và indexes

- coordinator_bindings bảo đảm một binding/project và một project/Coordinator. Repository không cho active project tồn tại thiếu binding sau commit.
- agent_definitions unique(id, version), config snapshot hash immutable.
- tasks unique(runId, taskKey); dependency không tự trỏ và không cross-run trái policy; validate cycle.
- roomOrdinal unique trong workspace active; archive giữ ordinal lịch sử, mở lại dùng layout policy.
- messages unique(conversationId, sequence).
- executions unique(taskId, attempt), checkpoint có FK execution.
- domain_events unique(eventId), aggregate version theo CAS.
- idempotency unique(actorId, method, route, key), bodyHash khác trả conflict.
- indexes: tasks(status, runId, priority), executions(status, leaseUntil), assignments(agentInstanceId, status), events(workspaceId, sequence), memory(scopeType, scopeId, status), artifacts(projectId, type).

Mẫu ràng buộc quan trọng:
~~~sql
CREATE UNIQUE INDEX one_live_assignment_per_agent
ON assignments(agent_instance_id)
WHERE status IN ('reserved', 'active', 'releasing');
~~~

availability và logical location được suy ra từ assignment/binding/health; không có một field roomId độc lập cho phép chuyển người mà chưa chuyển assignment. Cache projection có thể lưu location nhưng luôn rebuild được.

Giữ foreign_keys=ON, WAL và busy timeout phù hợp. Transactions không chứa network calls. Migrations có checksum và backup trước migration phá cấu trúc. Không tự down-migrate dữ liệu mới khi rollback binary.

## 5. API chung

Base: /platform/v1. JSON UTF-8; schema validation ở biên; body có giới hạn. Mutating routes cần same-origin session + CSRF protection. Session secret không đặt trong URL hoặc SSE query string.

Request tạo/thực thi dùng Idempotency-Key. Retry cùng key/body trả cùng operation/entity. Update dùng If-Match hoặc expectedVersion; mismatch trả 409/412 có currentVersion. API không cho client tùy ý gán running/succeeded.

Errors:
~~~json
{
  "error": {
    "code": "AGENT_UNAVAILABLE",
    "message": "Chuyên viên hiện đang bận.",
    "retryable": true,
    "requestId": "request-id",
    "details": { "capability": "code.review" }
  }
}
~~~

Các mã khác: INVALID_CONFIG, INVALID_PLAN, CAPABILITY_MISSING, MODEL_NOT_CONFIGURED, PERMISSION_DENIED, APPROVAL_EXPIRED, BUDGET_EXCEEDED, OPERATION_OUTCOME_UNKNOWN, VERSION_CONFLICT, PROJECT_ARCHIVED.

## 6. Routes

| Method và route | Input chính | Kết quả |
| --- | --- | --- |
| GET /health | — | DB/scheduler/worker/gateway readiness đã che thông tin nhạy cảm |
| GET /office | — | PlatformOfficeSnapshot + cursor |
| GET /projects | status, cursor, limit | Danh sách project, không transcript |
| POST /projects | name, goal, workspaceRootRef? | 201 project + Coordinator + conversation |
| GET /projects/:id | — | Project detail/counters |
| PATCH /projects/:id | goal/name, expectedVersion | Project mới |
| POST /projects/:id/archive | expectedVersion, activeRunPolicy | 202 lifecycle operation |
| POST /projects/:id/restore | expectedVersion | Cùng projectId/Coordinator |
| DELETE /projects/:id | confirmationToken, expectedVersion | 202 deletion operation có phạm vi |
| GET /projects/:id/conversations | pagination | Conversations |
| POST /conversations/:id/messages | text, attachmentIds, mode | 202 message + run/follow-up ID |
| GET /conversations/:id/messages | before, limit | Lịch sử được phân trang |
| GET /runs/:id | — | Plan revision, tasks, budgets, outputs |
| POST /runs/:id/pause | expectedVersion | 202 request |
| POST /runs/:id/resume | expectedVersion, approvedBudget? | 202 tiếp tục |
| POST /runs/:id/cancel | expectedVersion, reason? | 202 cancelling |
| POST /runs/:id/steer | text, expectedVersion | Command có sequence |
| GET /tasks/:id | — | Task detail, attempts, dependencies, handoff |
| GET /agents | role/status | Roster + capability availability |
| GET /agents/:id | — | Definition/version/model profile đã che key |
| POST /registry/validate | configRevision? | Validation report, không enable |
| POST /registry/reload | expectedRevision | Revision mới, busy agents dùng snapshot cũ |
| POST /agents/:id/enable | expectedVersion | Ready hoặc lỗi dependency |
| POST /agents/:id/disable | mode: drain/cancel, expectedVersion | Draining hoặc disabled |
| GET /approvals | status, projectId | Pending approvals đúng scope |
| POST /approvals/:id/decision | approve/deny, expectedVersion, argumentsHash | Một quyết định có audit |
| POST /uploads | multipart + projectId | Opaque attachment ID, quarantine/validated |
| GET /artifacts/:id/versions | — | Metadata versions |
| GET /artifact-versions/:id/content | — | Inline/download theo MIME policy |
| GET /memory | scope, query | Records đúng scope/provenance |
| PATCH /memory/:id | text, expectedRevision | Revision mới, có nguồn owner edit |
| DELETE /memory/:id | expectedRevision | Tombstone + index invalidation |
| GET /usage | projectId/runId, period | Usage/cost không tự suy giá |
| GET /events | Last-Event-ID header | SSE durable events + volatile deltas |

Tên route trong bảng đã bỏ base /platform/v1. Cursor opaque, limit mặc định 50, tối đa 200. Upload đề xuất mặc định 20 MB/file, cấu hình theo MIME; zip có giới hạn giải nén riêng.

Tạo project mẫu:
~~~json
{
  "name": "Website giới thiệu",
  "goal": "Thiết kế và triển khai website giới thiệu sản phẩm",
  "workspaceRootRef": "approved-root-id"
}
~~~

Nhắn tin mẫu:
~~~json
{
  "text": "Tạo landing page và nhờ reviewer kiểm tra",
  "attachmentIds": [],
  "mode": "new-run"
}
~~~

mode của message: new-run chỉ khi không có root active; enqueue và steer xử lý trường hợp đang chạy. Chưa chọn mode mà active run tồn tại thì trả 409 kèm lựa chọn, không ngầm chạy song song.

## 7. Event envelope

~~~json
{
  "schemaVersion": 1,
  "eventId": "uuid",
  "sequence": 1024,
  "workspaceId": "uuid",
  "projectId": "uuid",
  "runId": "uuid",
  "type": "assignment.created",
  "aggregateId": "uuid",
  "aggregateVersion": 3,
  "occurredAt": "2026-10-25T02:00:00.000Z",
  "payload": {
    "agentInstanceId": "developer-01",
    "assignmentId": "uuid",
    "taskId": "uuid"
  }
}
~~~

eventId dùng dedupe; sequence là thứ tự committed trong workspace. Trường projectId/runId không có thì bỏ, ví dụ registry.updated. Không dùng timestamp để quyết định thứ tự khi có sequence.

Event catalog tối thiểu:
- registry.updated; agent.enabled/disabled/availability_changed;
- project.created/updated/archived/restored;
- message.accepted/completed; run.created/status_changed/plan_revised;
- task.created/status_changed; assignment.created/released;
- execution.started/checkpointed/interrupted/completed;
- tool.proposed/authorized/dispatched/completed/outcome_unknown;
- approval.requested/decided/expired;
- artifact.version_created/validated; memory.updated; usage.recorded;
- worker.health_changed; system.snapshot_required.

## 8. SSE consistency

Transaction cập nhật entity và append event trong cùng DB. Publisher đọc committed events theo sequence, không có khoảng mất sự kiện giữa cập nhật DB và notify.

GET /office trả snapshot revision + cursor. SSE tiếp tục từ cursor hoặc Last-Event-ID. Client dedupe eventId, kiểm tra aggregateVersion; thấy gap không tự đoán state mà reload snapshot.

Text deltas có messageId/attemptId/chunkIndex và là volatile; không gán durable sequence giả. Message completed/checkpoint chứa nội dung cuối có thể phục hồi. Sau reconnect tải lại message đang dở từ checkpoint nếu cần; không replay delta thành tin nhắn mới.

Retention events đề xuất 30 ngày. Cursor quá cũ nhận snapshot_required. Heartbeat không làm tăng revision. Slow consumer bị ngắt có thông báo; browser reconnect bằng cursor, không tạo run mới.

## 9. Artifacts và blobs

DB giữ metadata; blobs lưu dưới storageKey ngẫu nhiên, tách khỏi filename gốc. Write temp → hash/validate → atomic rename → commit metadata. Crash có orphan blob được GC theo journal và grace period; không báo artifact thành công khi file chưa có.

Version immutable; review chạy trên checksum/version cụ thể. Download kiểm tra project scope; HTML/code preview được sandbox, không render active script trong origin app. Backup phải bao gồm manifest blob và checksum.

## 10. Kiểm chứng hợp đồng

Sinh types/schema từ một nguồn shared/platform; contract tests cho HTTP, IPC và SSE. Test unknown fields, overflow, invalid IDs, stale versions, duplicate requests, replay sau retention, tenant/project scope mismatch. Golden fixtures có version; nâng schema cần migration và compatibility note.
