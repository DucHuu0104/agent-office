# Hướng dẫn sử dụng Agent Office

> Tài liệu này hướng dẫn bản local-first đang được phát triển. Agent Office giữ dữ liệu trên máy của bạn; model provider nhận nội dung được gửi trong request chat hoặc tool theo cấu hình bạn chọn.

## Khởi động lần đầu trên Windows

Cài Node.js 22.12 trở lên (khuyến nghị Node 24) và npm. Trong thư mục repo, chạy:

```powershell
npm.cmd ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
npm.cmd run config:validate
npm.cmd run office:dev
```

Mở <http://127.0.0.1:4849/office>. Server chỉ lắng nghe trên máy này theo mặc định. `config:validate` kiểm tra agent, model profile, tool và skill; lệnh này không gọi model. Để chat, điền endpoint, API key và model name cho profile Coordinator trong `.env`. Không chia sẻ file `.env`.

## Giá model và giới hạn chi phí

Nếu muốn đặt trần USD cho một lượt chạy hoặc baseline live, hãy nhập giá hiện hành theo tài khoản từ trang billing/provider vào `config/models.yaml`. Mỗi `profiles.<id>.pricing` gồm `version`, `modelName` khớp chính xác với model ID trong `.env`, `inputUsdPerMillionTokens` và `outputUsdPerMillionTokens`. Cập nhật mọi profile mà Coordinator và specialist sẽ dùng; giá thiếu hoặc model ID không khớp sẽ bị xem là chưa định giá. Chỉ đặt rates bằng `0` khi billing của tài khoản xác nhận model hiện được tính $0; bỏ trống pricing mới có nghĩa là giá chưa biết.

Profile Agnes `agnes-2.5-flash` đang dùng giá niêm yết bảo thủ $0.05/M input và $0.15/M output trong `config/models.yaml`. Trang giá Agnes hiện công bố khuyến mãi $0, nhưng thời hạn và quyền áp dụng có thể tùy tài khoản; hóa đơn tài khoản mới là số tiền thực tế. Giá niêm yết giúp USD cap còn hiệu lực cả khi tài khoản không được hưởng khuyến mãi. Kiểm tra billing của bạn và cập nhật `pricing.version` cùng hai rates khi thay đổi model hoặc giá.

`eval:baseline --live --max-total-usd ...` dừng trước khi gọi provider nếu không có đơn giá khớp, vì khi đó runner không thể bảo đảm trần USD. Chỉ dùng `--allow-unpriced --max-total-tokens ...` khi chấp nhận chi phí USD chưa biết; token cap không phải là trần USD. Giá profile được lưu trong cấu hình cục bộ, không đặt API key ở đây hoặc gửi key qua chat.

Database và artifact mặc định nằm dưới `%LOCALAPPDATA%\AgentOffice`. Chỉ một server được dùng một thư mục dữ liệu tại cùng thời điểm. Dừng server bằng `Ctrl+C`; đóng trang web không dừng server.

## Chạy bản UAT với dữ liệu tách biệt

Khi nhận được gói UAT dựng sẵn, giải nén và mở PowerShell trong thư mục gói. Lệnh dưới đây cài dependency production, dùng cổng UAT riêng và lưu dữ liệu trong thư mục riêng. Gói không chứa `.env`; chỉ sao chép và điền file này nếu bạn muốn chat với model:

```powershell
npm.cmd ci --omit=dev
if (!(Test-Path .env)) { Copy-Item .env.example .env; notepad .env }
$env:OFFICE_HOST = '127.0.0.1'
$env:OFFICE_PORT = '4851'
$env:OFFICE_DATA_DIR = Join-Path $env:LOCALAPPDATA 'AgentOffice-UAT-r73'
$env:OFFICE_EXECUTION_MODE = 'disabled'
npm.cmd run office:start
```

Mở <http://127.0.0.1:4851/office>. Chọn một cổng còn trống nếu 4851 đang được dùng. Server dùng `.env` để kết nối model; mỗi tin nhắn có thể phát sinh chi phí provider và gửi nội dung chat đến endpoint đã cấu hình. Với `OFFICE_EXECUTION_MODE=disabled`, agent không chạy lệnh hay sửa workspace. Dừng bằng `Ctrl+C`; cùng thư mục UAT sẽ giữ dữ liệu để bạn tiếp tục nghiệm thu ở lần chạy sau.

Sau khi build UAT được bàn giao, dùng [checklist nghiệm thu Windows](AGENT-OFFICE-UAT-CHECKLIST.md) để kiểm tra luồng chính và ghi lại các lỗi còn mở.

## Tạo project và giao việc

Chọn **Tạo project**, nhập tên và mục tiêu, rồi tạo. Mỗi project có một Coordinator riêng và một phòng tồn tại qua các lần khởi động. Tạo project không gọi model; lời gọi model bắt đầu khi bạn gửi tin nhắn.

Mở project trong danh sách hoặc bấm vào phòng trên canvas để vào hội thoại với Coordinator. Mô tả kết quả mong muốn, giới hạn và cách kiểm tra. Coordinator có thể lập task và giao chuyên viên phù hợp. Task, trạng thái, người được giao, artifact và mức dùng token xuất hiện trong bảng project.

Khi một lượt đang chạy, chọn **Xếp hàng sau run hiện tại** để xếp yêu cầu tiếp theo, **Điều hướng run hiện tại** để gửi chỉ dẫn vào điểm dừng an toàn kế tiếp, hoặc **Tạm dừng** để dừng sau checkpoint hiện tại. Run đang chờ sẽ dừng ngay; model/tool đang hoạt động được phép hoàn tất và các tool đang chờ được lưu trạng thái mà không chạy lặp. Chọn **Tiếp tục** để chạy tiếp từ task chưa hoàn tất. Nếu run hết ngân sách token/USD, nút **Tăng ngân sách & tiếp tục** yêu cầu bạn nhập hạn mức mới cao hơn trước khi xếp run lại. Không thể tiếp tục run có kết quả tool chưa xác định; hãy kiểm tra thao tác đó trước. Nút **Dừng lượt chạy** hủy lượt; đợi trạng thái cuối trước khi gửi lại cùng một việc.

Chuyên viên dùng chung như Developer, Reviewer, Researcher, Analyst và Writer sẽ ở pool cho đến khi có assignment. Sau khi hoàn thành, họ được trả về pool. Room và Coordinator vẫn còn khi project không có task đang chạy. Dùng **Lưu trữ project** để đưa room vào danh sách lưu trữ; có thể mở danh sách đó và khôi phục project cùng lịch sử.

## Quan sát đời sống trong văn phòng

Project sidebar hiển thị avatar pixel của các agent trong từng phòng và hoạt động gần nhất. Khi được giao việc, agent đi vào phòng; canvas và sidebar cập nhật task, trạng thái đang làm hoặc chờ bạn phê duyệt. Trong lúc chạy tool, bong bóng và activity ticker nêu thao tác thực tế như đọc file, tìm web, chuẩn bị sửa hoặc kiểm tra workspace. Chuyển động khi rảnh và các hành vi xã hội tiếp tục chạy trong mô phỏng văn phòng.

Thanh công cụ phía trên canvas có overview, zoom, bộ đếm phòng/agent, activity, cài đặt hiển thị và trợ giúp. Trong cài đặt, bạn có thể bật tên agent, chọn mức bong bóng, độ sinh động, theo camera agent đã chọn, ánh sáng và chủ đề theo mùa; lựa chọn được lưu trong trình duyệt. Activity ticker ở dưới canvas mở feed các sự kiện gần nhất. Feed và bong bóng chỉ cho biết hoạt động vận hành đã xác nhận; chúng không hiển thị suy luận riêng của model, prompt, nội dung file hay tham số thô của tool.

## Phê duyệt thao tác và xem kết quả

Các thao tác ghi workspace hoặc chạy kiểm tra cần bạn phê duyệt. Đọc đường dẫn đích, nội dung hoặc scripts, cấu hình executor và giới hạn trước khi chọn **Phê duyệt** hoặc **Từ chối**. Nếu file thay đổi sau khi nội dung được xem trước, kiểm tra checksum sẽ từ chối ghi thay vì ghi đè phiên bản mới. Approval đã hết hạn hoặc đã có quyết định không thể dùng lại.

Artifact được liệt kê trong project và có thể mở hoặc tải về từ liên kết của artifact. Kiểm tra task, phiên bản artifact và kết quả kiểm tra trước khi dùng output bên ngoài Agent Office. Một task thất bại hoặc tool có kết quả không xác định không phải là bằng chứng rằng công việc đã hoàn tất.

Workspace execution tắt theo mặc định. Để dùng Docker, đặt `OFFICE_EXECUTION_MODE=docker` và `approvals.shell: docker` trong `config/policies.yaml`. Để dùng quyền Windows hiện tại, có thể chọn `local-trusted` ở cả `.env` và policy; chế độ này không phải sandbox. Cả hai chế độ đều yêu cầu phê duyệt lệnh và chạy trên workspace snapshot tạm.

Project đã gắn workspace có nút **Mở xem trước website**. Agent Office liệt kê các script `dev`, `preview`, `start` và `serve` cùng lifecycle hooks trước khi chạy. Preview dùng bản sao tạm của workspace, giữ tối đa 30 phút và có nút dừng; trang được mở trong tab riêng trên loopback với CSP chặn nhúng và không nhận cookie của Office. Preview cần bạn xác nhận quyền truy cập mạng: Docker dùng bridge network và có thể ra Internet; `local-trusted` chạy bằng quyền Windows của bạn và không phải sandbox. Nếu bật `npm ci`, hãy kiểm tra lockfile và lifecycle hooks; checksum lockfile sẽ được đối chiếu lại trước khi chạy.

## Ghi nhớ và thêm chuyên viên

Project có ghi nhớ riêng. Bạn có thể thêm ghi chú user, agent hoặc project; xem xét rồi chấp nhận/từ chối đề xuất ghi nhớ của agent; sửa hoặc xóa ghi chú. Agent chỉ nhận scope được cấp trong manifest. Mục **Ghi nhớ** có lệnh xuất/nhập dữ liệu dài hạn dạng JSON; run scratch notes không nằm trong export.

Với ghi nhớ của project đang mở, **Tải memory.md** tải bản Markdown có ID, trạng thái và revision để bạn đọc hoặc sửa ghi chú do mình tạo. Dùng **Nhập memory.md** để xem trước phần thay đổi rồi xác nhận áp dụng. Tệp phải chứa đủ các mục hiện tại; chỉ ghi chú của owner đã chấp nhận được sửa trong tệp. Nếu ghi nhớ đổi sau khi tải, hãy tải lại bản mới để tránh ghi đè dữ liệu mới. Mỗi lần nhập tạo revision mới và lưu nội dung cùng lịch sử trong một giao dịch.

Để thêm specialist:

1. Tạo `agents/definitions/<id>/` với `agent.yaml`, `system.md`, `soul.md`, `tools.md` và `hooks.yaml`.
2. Khai báo một hoặc nhiều skill đã có trong `agent.yaml`. Nếu tạo skill mới, thêm `skills/<id>/skill.yaml` và `SKILL.md`.
3. Thêm roster instance mới vào cuối `agents/roster.yaml`. Không đổi ID của agent đang được dùng.
4. Chạy `npm.cmd run config:validate` và xử lý hết lỗi.
5. Trong sidebar chọn **Nạp agent mới**, xem danh sách thay đổi rồi xác nhận nạp.

Hot reload chỉ nhận package và roster specialist mới theo kiểu append-only. Sửa definition, tool, model profile, policy hoặc hook đã cài cần dừng rồi khởi động lại server. Không đặt API key trong agent package, skill hay project files; credential chỉ nằm ở `.env`.

Danh sách agent ở sidebar hiển thị agent sẵn sàng, đang bận và đang drain. Chọn nút tạm dừng để agent ngừng nhận task mới; task đang chạy vẫn được phép hoàn thành. Nút khôi phục cho agent nhận task mới trở lại. Trạng thái drain được lưu trong database và giữ nguyên sau khi nạp registry hoặc khởi động lại server.

## Khi kết nối hoặc lượt chạy gặp lỗi

Chỉ báo kết nối trong sidebar cho biết trạng thái hiện tại. Khi trình duyệt mất mạng, nội dung project vẫn còn trên màn hình; khi SSE nối lại, Agent Office nạp snapshot mới và giữ project đang chọn. Tải lại trang nếu trình duyệt báo cần đồng bộ snapshot.

Để kiểm tra registry, SQLite và khả năng sẵn sàng mà không gọi model, mở cửa sổ PowerShell khác và chạy:

```powershell
npm.cmd run office:doctor
```

`doctor --live` gửi một request thử đến provider và có thể phát sinh chi phí; chỉ chạy khi bạn chủ động muốn kiểm tra kết nối. Thêm `--tools` để kiểm tra function calling hoặc `--profile primary-responses` để kiểm tra profile Responses API mà không đổi profile của Coordinator. Profile có tên biến môi trường riêng cần đủ URL, key và model; doctor không mượn credential từ profile chính. Agnes hiện công bố workflow chat qua `/v1/chat/completions`; lượt Responses nhiều vòng với tool chưa được xác nhận: trong thử nghiệm ngày 26/10/2026, C01 nhận HTTP 400 khi gửi lịch sử tool continuation. Hãy dùng `primary`/`coding` Chat Completions với Agnes cho đến khi provider xác nhận Responses stateless. [Tài liệu Agnes](https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/docs/FAQ.md) mô tả endpoint chat chính thức. HTTP 429/5xx có thể được retry theo giới hạn cấu hình; HTTP 401 cần kiểm tra credential. Không gửi lại một thao tác ghi đang ở trạng thái kết quả không xác định cho đến khi đã đối chiếu workspace.

Model/profile và policy được đọc khi server khởi động. Sau khi sửa `.env`, `config/models.yaml` hoặc `config/policies.yaml`, dừng server bằng `Ctrl+C` rồi khởi động lại.

Khi mở database có schema cũ, server tạo `agent-office.pre-migration-...sqlite` trong thư mục dữ liệu và kiểm tra integrity cùng phiên bản trước khi áp dụng migration. Nếu snapshot không hợp lệ, startup dừng trước khi sửa database; giữ snapshot cho đến khi bản nâng cấp vượt qua healthcheck và smoke test.

## Build, backup và restore

Để chạy production bundle thay cho chế độ development:

```powershell
npm.cmd run office:build
npm.cmd run office:start
```

Tạo backup đầy đủ bằng `npm.cmd run office:backup`. Bundle gồm SQLite, artifact được tham chiếu và agent configuration; credential và `.env` bị loại trừ. Cất `.env` riêng ở nơi an toàn.

Khôi phục bundle vào thư mục dữ liệu mới:

```powershell
npm.cmd run office:restore -- --from "D:\backups\agent-office.aobackup" --to-data-dir "D:\AgentOffice-restored"
```

Sau khi lệnh khôi phục thành công, đặt `OFFICE_DATA_DIR` và `OFFICE_CONFIG_DIR` theo các đường dẫn trong kết quả restore, rồi khởi động server. Không chạy hai server cùng một thư mục dữ liệu.

## Kiểm tra trước khi báo lỗi

```powershell
npm.cmd run typecheck
npm.cmd run office:test
npm.cmd run office:client-test
npm.cmd run eval:validate
npm.cmd run i18n:check
npm.cmd run office:build
node node_modules/playwright-core/cli.js install chromium
npm.cmd run office:browser-test
```

`office:browser-test` dùng database tạm và server production/development, kiểm tra room, reconnect, recovery approval, task lỗi và giao diện mobile. Một fake model server chạy tại máy tạo assignment thật cho Writer và kiểm tra artifact sau khi task xong; không có request gửi ra dịch vụ model bên ngoài và dữ liệu sản phẩm không bị sửa. Khi báo lỗi, ghi lại bước vừa làm, tên project/task, thời điểm và mã lỗi; không đưa API key, prompt riêng tư hay file `.env` vào báo cáo.

`eval:validate` kiểm tra cấu trúc bộ corpus chất lượng 40 tình huống có fixture: 10 coding, 10 research, 10 analysis và 10 orchestration/recovery. Lệnh chỉ xác thực dữ liệu, không gọi model; đánh giá chất lượng single-agent so với multi-agent cần những lượt chạy model riêng có ghi nhận chi phí.
