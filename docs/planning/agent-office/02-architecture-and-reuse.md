# 02 — Kiến trúc và phần tái sử dụng

## 1. Hình thức triển khai

Repo mới khởi tạo từ fork Habblaud, giữ một ứng dụng Node và một UI Vite. Backend tổ chức theo module; runtime worker là tiến trình riêng để hủy/khởi động lại độc lập. DB worker sở hữu kết nối SQLite. Chưa chia microservices.

Fork giữ cấu trúc server/, client/, shared/ trong giai đoạn đầu, tránh vừa di chuyển mọi file vừa thay domain. Mã theo dõi phiên bên ngoài vẫn có thể còn trong nguồn kế thừa nhưng runtime mode không khởi động watcher, installer hay CLI bridge.

~~~mermaid
flowchart TD
    UI["Office + chat + tasks"] --> API["HTTP API /platform/v1"]
    API --> PS["Project / Registry / Approval services"]
    PS --> DB["DB worker: state + events + checkpoints"]
    DB --> ES["Event publisher / SSE"]
    ES --> UI
    PS --> SC["Durable scheduler"]
    SC --> RW["Runtime worker"]
    RW --> GW["Model gateway"]
    GW --> MP["Model providers"]
    RW --> TB["Tool broker / policy"]
    TB --> EX["File / Web / Sandbox / Connectors"]
    RW --> DB
    API --> PR["Office projection"]
    PR --> UI
~~~

## 2. Cấu trúc nguồn dự kiến

~~~text
server/platform/
  domain/          entities, transitions, schemas, errors
  persistence/     migrations, repositories, transactions, outbox, db-worker
  registry/        agents, skills, tools, hooks, config snapshots
  projects/        project/conversation/run lifecycle
  scheduling/      DAG, matching, leases, quotas, recovery
  runtime/         agent loop, prompt/context builder, checkpoints, cancellation
  models/          canonical contract, responses-adapter, chat-adapter, fake-adapter
  tools/           broker, policy, local-files, web, analysis, shell
  memory/          retrieval, provenance, revisions, export/import
  artifacts/       immutable versions, validation, downloads
  approvals/       operations, decisions, expiry, reconciliation
  events/          domain events, SSE publishing, office projection
  http/            routing, validation, authorization, upload limits
  cli/             doctor, config validate, backup, restore, agent reload
client/src/platform/
  api/ store/ project/ agents/ chat/ tasks/ approvals/ artifacts/ settings/
shared/platform/
  ids.ts contracts.ts events.ts states.ts schemas/
agents/
  definitions/<definition-id>/
  roster.yaml
skills/<skill-id>/
config/models.yaml tools.yaml hooks.yaml policies.yaml
data/              nằm ngoài checkout theo cấu hình, không commit
~~~

Đường dẫn trên là đích thiết kế trong repo sản phẩm tương lai. Các thư mục chưa có được tạo theo backlog.

## 3. Ranh giới module

| Module | Sở hữu | Không chịu trách nhiệm |
| --- | --- | --- |
| ProjectService | Tạo/archive project, Coordinator, conversations | Chọn model output |
| AgentRegistry | Definition/instance/capability/config versions | Quyết định task đã hoàn thành |
| Scheduler | Ready tasks, matching, leases, concurrency | Nội dung prompt chuyên môn |
| AgentRuntime | Lượt model/tool và checkpoint | Tự cấp thêm quyền |
| ModelGateway | Protocol adapters, stream, usage, timeout | Đọc toàn bộ filesystem |
| ToolBroker | Validate arguments, policy, approval, executor | Tin rằng instructions là quyền |
| MemoryStore | Scope, provenance, retrieval, revision | Ghi nhận mọi suy đoán như fact |
| ArtifactService | File/version/checksum, validation metadata | Tự công bố external output |
| OfficeProjection | Roster/location/status/counters cho canvas | Điều khiển scheduler từ animation |
| EventPublisher | Phát committed events theo cursor | Ghi lại state từ sự kiện của browser |

Modules đi qua interface/repository; UI không ghi SQLite và không biết API key. Worker không đọc toàn bộ DB hoặc .env; nhận execution context tối thiểu, gọi gateway/tool broker qua IPC có schema.

## 4. Phần Habblaud giữ và thay

| Nguồn hiện tại | Kế hoạch |
| --- | --- |
| client/src/art/**, assets, audio | Giữ; bổ sung nhận diện role và trạng thái ready/pool |
| world/layout, pathfinding, camera, renderer | Giữ; thêm các spot của pool và ánh xạ room bằng projectId |
| world/sim/sim.ts và character.ts | Thay lifecycle gắn session bằng roster/location; giữ chuyển động |
| client/src/net/store.ts | Giữ cơ chế reconnect; thêm platform store có snapshot/events mới |
| UI drawer/feed/settings | Giữ avatar pixel, camera, chuyển động, activity bubble/feed/ticker/toast và cài đặt cảnh của Habblaud; dùng lớp điều khiển riêng cho project chat/tasks/artifacts, không đưa account/provider hoặc World-admin cũ vào product UI |
| server/http/guard.ts, static.ts | Giữ nguyên tắc kiểm tra origin/host và phục vụ static; kiểm chứng lại routes mới |
| server/http/sse.ts | Tham khảo streaming, backpressure; bổ sung durable cursor/outbox |
| server/model/office.ts | Không dùng làm database domain mới; tạo projection adapter cho canvas |
| server/sources/source.ts | Tham khảo adapter; không giả mới là claude/codex trong Provider cũ |
| shared/types.ts | Giữ phần kế thừa; canonical contracts mới nằm shared/platform |
| server/world, shared/world | Không nối runtime tự xây vào uplink dịch vụ chính thức |
| scripts/mod/codex installers | Không chạy trong onboarding sản phẩm mới |

Quan sát đã xác minh: room hiện dựa cwd; Character cần roomId; main/sub và Provider bị gắn Claude/Codex; subagent done đi khỏi office; phòng rỗng tự thu gọn. Các điều này cần sửa có chủ đích để hỗ trợ pool và project bền vững.

## 5. Projection cho văn phòng

Định nghĩa PlatformOfficeSnapshot:
- workspace revision, projects active/archived, roster, coordinators;
- location.kind = pool | project, projectId chỉ bắt buộc với project;
- availability và executionStatus là hai trường riêng;
- role, displayName, seed/appearance, assignmentId;
- per-project counters, plannedCapabilities, last activity;
- runtime health và freshness; không có secret/full prompt.

Không tạo room giả "__pool__" trong domain để lách ràng buộc. Adapter canvas có thể dùng areaId nội bộ cho lounge; pool không làm tăng số project, không hiện trong project picker, không được export như một project.

Lưu location logic trên server; tọa độ/đường đi ở client. Reconnect đọc location cuối; animation cũ không ghi ngược membership. Room ordinal ổn định cho đến archive; nhiều phòng tiếp tục mở rộng theo geometry hiện tại.

## 6. Công nghệ được chọn

| Phần | Lựa chọn | Gate |
| --- | --- | --- |
| Runtime | Node 22.12+ và TypeScript; pin patch tested | Windows CI và native SQLite binary |
| Server/UI | Giữ HTTP/Vite/DOM/Canvas | Không đổi framework cùng đợt |
| Schema | Zod + JSON Schema export | Contract tests cả server/worker/UI |
| Config | YAML parser chế độ dữ liệu, không custom executable tags | Giới hạn kích thước/alias/depth |
| Database | SQLite + better-sqlite3, prepared statements, WAL, foreign_keys | Pin exact version có binary Windows/Node 24 |
| DB execution | Một DB worker, giao tiếp RPC/transaction | Không giữ transaction khi gọi network |
| Scheduling | Hàng đợi trong DB, leases + fencing tokens | Race/recovery tests |
| Model | Responses adapter + Chat-compatible adapter | Live smoke cho profile thực |
| Events | HTTP POST + SSE, durable outbox | Reconnect/replay tests |
| Tests | Vitest và browser E2E | Windows là môi trường bắt buộc |

node:sqlite trong tài liệu Node 24 hiện được đánh dấu release candidate và API DatabaseSync chạy đồng bộ; kế hoạch không coi nó là dependency ổn định để thay DB adapter ngay. better-sqlite3 cũng có API đồng bộ nên DB worker vẫn cần thiết. Các phiên bản dependency cụ thể được chốt bằng lockfile sau P0, không dùng nhãn "latest" trong release.

## 7. Chế độ chạy và ranh giới cô lập

- App API chạy loopback, static + API cùng origin; cổng mặc định của sản phẩm mới đề xuất 4849 để không trùng Habblaud 4747.
- Worker subprocess dùng windowsHide, có heartbeat, timeout và kill tree; đây là fault isolation, không phải security sandbox.
- File tools thực thi bằng code kiểm tra đường dẫn và quyền project.
- shell/analysis chạy code động chỉ bật khi có Docker sandbox hoặc người dùng chọn local-trusted với phạm vi cấp quyền rõ.
- Model gateway ở parent/broker; key không truyền xuống shell/worker.
- Docker sandbox mount workspace tối thiểu, không mount home/.env/daemon socket; network theo policy. Cần giới hạn disk/time/process và xử lý output.
- Git worktree giúp tách thay đổi coding; không cung cấp cô lập filesystem/network.

## 8. Dependency direction và thay thế sau này

domain/contracts không import HTTP, Canvas hoặc SDK model. Gateway, storage và executor có interface riêng. Chuyển SQLite sang PostgreSQL, worker local sang remote hoặc orchestration sang framework khác phải đi qua adapter, không đổi ID/semantics của project và assignment.

Không xây remote protocol/Redis/Kubernetes trước khi có nhu cầu vượt một host. Việc nhiều người dùng cần threat model, authorization và migration riêng, không chỉ đổi bind thành 0.0.0.0.

## 9. Nguồn kỹ thuật

- [Habblaud LICENSE](../../../LICENSE): giữ notice khi tái sử dụng.
- [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html): trạng thái module và API đồng bộ.
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3): driver và hướng dẫn sử dụng.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): tham khảo tách checkpoint theo thread và memory xuyên thread; chưa chọn làm engine v1.
