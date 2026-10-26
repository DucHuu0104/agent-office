# 04 — Agent packages, skills, hooks và model profiles

Mọi định dạng trong tài liệu này là contract đề xuất của sản phẩm mới. Chưa có loader thực thi các mẫu này trong Habblaud gốc.

## 1. AgentDefinition và roster

Definition mô tả vai trò; roster tạo thành viên có danh tính ổn định. Coordinator dùng definition chung nhưng instanceId gắn project; chuyên viên có roster ID như developer-01. Assignment không đổi ID/avatar của người.

Một package định nghĩa:
~~~text
agents/definitions/developer/
  agent.yaml
  system.md
  soul.md
  tools.md
  hooks.yaml
~~~

Mẫu agent.yaml:
~~~yaml
schemaVersion: 1
id: developer
version: 1.0.0
displayName: Developer
kind: specialist
capabilities:
  - code.implement
  - code.test
modelProfile: coding
instructions:
  system: ./system.md
  soul: ./soul.md
  toolNotes: ./tools.md
skills:
  - id: web-development
    version: 1.0.0
  - id: testing
    version: 1.0.0
allowedTools:
  - files.read
  - files.patch
  - shell.exec
memoryScopes: [agent, project, run]
hooks: ./hooks.yaml
limits:
  maxConcurrentAssignments: 1
  maxModelTurns: 16
  maxToolCalls: 40
  runTimeoutSeconds: 1200
~~~

Các con số là giá trị khởi đầu, phải được project/workspace policy thu hẹp nếu cần. Không cho definition tự nới policy hệ thống.

Mẫu agents/roster.yaml:
~~~yaml
schemaVersion: 1
instances:
  - id: developer-01
    definition: developer
    displayName: Linh
    enabled: true
    appearanceSeed: 12450
  - id: reviewer-01
    definition: reviewer
    displayName: An
    enabled: true
    appearanceSeed: 39560
~~~

Coordinator không khai báo một bản dùng chung trong roster. ProjectService tạo instance từ coordinator definition đúng một lần cho từng project.

## 2. Vai trò của các file

| File | Quy tắc nội dung |
| --- | --- |
| system.md | Mục tiêu, quy trình, tiêu chí hoàn thành, output contract, giao tiếp/handoff |
| soul.md | Phong cách, tính cách, cách nói về độ chắc chắn; không cấp quyền |
| tools.md | Tài liệu sử dụng tool; không tạo tool hoặc credential |
| SKILL.md | Khi dùng kỹ năng, inputs/outputs, workflow và cách kiểm tra |
| hooks.yaml | Tham chiếu handler đã đăng ký, có timeout và error policy |
| memory.md | Bản tóm tắt có nguồn/revision được xuất từ MemoryStore; không chứa secret |

Thứ tự xử lý context: policy nền tảng → system/soul của definition đã tin cậy → mục tiêu/task → context và memory đúng scope → skill cần thiết → hội thoại/nguồn dữ liệu được phân loại. Luật nền tảng và quyền thực tế vẫn được kiểm tra bằng code. Tài liệu nguồn và tool output không được diễn giải thành yêu cầu thay policy.

Agent không được sửa definition, hooks, policy, .env hay roster bằng file tool của project. Thay cấu hình qua admin API/CLI được owner thực hiện và ghi version.

## 3. Registry loader

1. Discover thư mục definitions ở root do owner cấu hình.
2. Parse YAML như dữ liệu; giới hạn file size/depth/aliases; không custom executable tags.
3. Validate schema và semantic references: IDs, capabilities, tools, skills, hooks, profiles.
4. Resolve file path bên trong package root; chặn traversal, symlink/junction ra ngoài.
5. Hash manifest + instructions + skill/hook references thành configHash.
6. Ghi definition version immutable; đánh dấu valid/enabled hoặc invalid cùng lỗi có vị trí.
7. Đối chiếu roster; tạo instance còn thiếu, không tạo lại instance đang có.
8. Publish registry.updated; cập nhật routing capability catalog cho Coordinator.

Definition trùng ID/version khác nội dung bị từ chối. Unknown fields bị từ chối để phát hiện typo. Tool/profile không tồn tại không được bỏ qua. Invalid package không làm sập mọi agent khác.

Reload là lệnh rõ ràng, có preview diff. Execution đang chạy dùng config snapshot cũ. Thay role/tool/model của specialist đang bận chỉ áp dụng sau release. Cấu hình có hook code mới phải được tin cậy trước enable; runtime không import tùy ý đường dẫn do model đề xuất.

## 4. Skill package

~~~text
skills/research/
  SKILL.md
  skill.yaml
  templates/report.md
  scripts/normalize-sources.ts
~~~

skill.yaml khai báo schemaVersion, id/version, description, triggers, requiredTools, input/output schemas, entryInstruction và asset paths. SKILL.md mô tả trình tự và verification.

Catalog ngắn của skill được đưa vào context; nội dung đầy đủ chỉ nạp khi task yêu cầu hoặc agent gọi skills.load. Mỗi run ghi skill version đã dùng. File script của skill chỉ được chạy qua executor/policy; việc nạp SKILL.md không tự chạy script.

Discovery không có nghĩa mọi skill được dùng cho mọi agent. Các skill cần tool thiếu credential bị đánh dấu unavailable; Coordinator nhìn thấy lý do.

## 5. Hooks

Mẫu hooks.yaml:
~~~yaml
schemaVersion: 1
hooks:
  before_run:
    - handler: context.load_project
      timeoutMs: 2000
      onError: fail
  before_tool_call:
    - handler: policy.audit_intent
      timeoutMs: 1000
      onError: fail
  after_run:
    - handler: memory.propose_summary
      timeoutMs: 5000
      onError: warn
~~~

Các sự kiện hỗ trợ: before_run, before_model_call, after_model_call, before_tool_call, after_tool_call, on_handoff, after_run, on_error.

Event payload là typed object có eventId/executionId/projectId và dữ liệu tối thiểu. Handler return được validate. Các core checks về quyền, budget và fencing là middleware bắt buộc; hook không thể remove hoặc bypass.

Handler phải khai báo khả năng retry/idempotency, error policy và version. Timeout phải truyền AbortSignal đến tác vụ con; handler không hủy được bị cô lập/terminate. Không để promise đã timeout tiếp tục ghi state bằng execution token cũ. Lỗi handler audit/policy chặn thao tác; lỗi tổng hợp memory sau run không biến kết quả thành thất bại giả, nhưng ghi cảnh báo.

v1 chỉ dùng built-in handlers đã review. Viết handler mới là thay code có test; sửa text hook description không tạo thêm khả năng thực thi.

## 6. Model profiles và .env

Credentials chỉ ở gateway backend. Các agent chọn profile theo ID; không sao chép key vào từng package.

Mẫu .env.example cho repo sản phẩm:
~~~dotenv
OFFICE_HOST=127.0.0.1
OFFICE_PORT=4849
OFFICE_DATA_DIR=
OFFICE_DEFAULT_LOCALE=vi
OFFICE_MAX_RUNNING_EXECUTIONS=4

MODEL_PRIMARY_BASE_URL=https://api.openai.com/v1
MODEL_PRIMARY_API_KEY=
MODEL_PRIMARY_NAME=

MODEL_RESPONSES_BASE_URL=
MODEL_RESPONSES_API_KEY=
MODEL_RESPONSES_NAME=

MODEL_COMPAT_BASE_URL=https://provider.example/v1
MODEL_COMPAT_API_KEY=
MODEL_COMPAT_NAME=

SEARCH_PROVIDER=
SEARCH_API_KEY=
~~~

OFFICE_DATA_DIR rỗng dùng thư mục dữ liệu người dùng của sản phẩm; không ghi vào home Codex. URL provider.example là placeholder, phải được owner thay bằng endpoint thực.

Mẫu config/models.yaml:
~~~yaml
schemaVersion: 1
profiles:
  primary:
    protocol: chat-completions
    baseUrlEnv: MODEL_PRIMARY_BASE_URL
    apiKeyEnv: MODEL_PRIMARY_API_KEY
    modelEnv: MODEL_PRIMARY_NAME
    contextWindowTokens: 32000
    maxOutputTokens: 4000
    requestTimeoutSeconds: 120
    capabilityRequirements: [tool-calling, streaming]
  coding:
    protocol: chat-completions
    baseUrlEnv: MODEL_COMPAT_BASE_URL
    apiKeyEnv: MODEL_COMPAT_API_KEY
    modelEnv: MODEL_COMPAT_NAME
    contextWindowTokens: 32000
    maxOutputTokens: 4000
    requestTimeoutSeconds: 120
    capabilityRequirements: [tool-calling]
  primary-responses:
    protocol: responses
    baseUrlEnv: MODEL_RESPONSES_BASE_URL
    apiKeyEnv: MODEL_RESPONSES_API_KEY
    modelEnv: MODEL_RESPONSES_NAME
    contextWindowTokens: 32000
    maxOutputTokens: 4000
    requestTimeoutSeconds: 120
    capabilityRequirements: [tool-calling, streaming]
~~~

32000/4000 là ví dụ cấu hình, không tuyên bố đặc tính của model chưa chọn. Doctor phải kiểm tra giới hạn do provider công bố và smoke test. coding có thể trỏ cùng profile với primary nếu chỉ có một endpoint, qua alias không chứa secret; alias cycle bị từ chối.

Nạp env: OS process environment ưu tiên hơn .env sản phẩm; .env.example chỉ là mẫu. Parse một lần ở startup, validate và tạo config snapshot; đây là khả năng phải triển khai, không có sẵn từ npm start của Habblaud.

Chỉ HTTPS cho endpoint từ xa; HTTP loopback cho model local do owner chủ động cấu hình. Agent không được đổi endpoint hoặc header để chuyển dữ liệu sang đích khác. Settings trả tên biến và configured=true/false, không trả key. .env, token stores, data và exports nhạy cảm nằm trong gitignore.

## 7. Hợp đồng gateway

Canonical request: modelProfile, instruction/context messages, availableTools, expectedOutputSchema, budget, abortSignal, providerContinuation.
Canonical events: text_delta, tool_call_delta, usage, response_completed, response_error.
Canonical result: responseId, complete tool calls, visible output, usage, finishReason, continuation data.

Responses và Chat Completions có adapter riêng. Registry ánh xạ tool ID dạng files.read sang tên function hợp lệ của protocol bằng mapping duy nhất, có kiểm tra collision. Tool call ID giữ nguyên để trả output đúng call.

Gateway giữ usage của từng attempt; không log raw Authorization. Hỗ trợ stream bị ngắt, fragmented JSON, nhiều tool calls, cancellation và unsupported parameters. Không âm thầm bỏ tool nếu model không hỗ trợ. API compatibility được xác nhận bằng test, không suy ra chỉ từ tên model.

OpenAI Responses tool flow và streaming được đối chiếu với [Function calling](https://developers.openai.com/api/docs/guides/function-calling) và [Streaming](https://developers.openai.com/api/docs/guides/streaming-responses). Không chọn model cụ thể hay giả định quyền truy cập API từ tài khoản Codex hiện có.

## 8. Thêm agent mới

1. Tạo definition package với capability mô tả cụ thể.
2. Tái sử dụng profile/skill/tool có sẵn hoặc khai báo dependency mới.
3. Chạy config validate và xem lỗi references/permissions.
4. Thêm roster instance nếu là specialist; chọn tên/avatar.
5. Reload registry và enable; UI xuất hiện ở pool.
6. Chạy task fixture chứng minh Coordinator route đúng và output đạt schema.
7. Giữ version/configHash trong run để rollback được.

Agent mới dùng công cụ có sẵn không cần sửa scheduler hoặc canvas. Tool/connector/hook code mới vẫn cần implementation, trust và test riêng. Agent mới không được tự nhận mọi tool bằng wildcard.

## 9. CLI cần có

- npm run office:doctor — readiness model/tool/storage/sandbox, chỉ live-call khi owner chọn.
- npm run config:validate — không gọi mạng, báo schema và semantic errors.
- npm run agents:reload — preview rồi áp dụng registry revision.
- npm run agent:check -- <definition-id> — fixture và capability checks.
- npm run memory:export / memory:import — explicit scope và conflict checking.

Đây là lệnh dự kiến, cần tạo trong P0/P1/P6; không được hướng dẫn người dùng chạy trước khi chúng được triển khai.
