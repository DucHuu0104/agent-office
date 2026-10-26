# 01 — Sản phẩm và trải nghiệm

## 1. Người dùng và công việc

Bản đầu phục vụ một người dùng Windows quản lý nhiều project. Một project có thể là repo code, chiến dịch nội dung, báo cáo nghiên cứu hoặc phân tích dữ liệu; thư mục làm việc là tài nguyên gắn vào project, không phải ID của project.

Luồng chính: chọn/tạo project → nhắn Coordinator → quan sát kế hoạch và các nhiệm vụ → phê duyệt khi cần → xem/tải sản phẩm đầu ra → tiếp tục cùng project.

### Những việc v1 phải làm được

- Tạo, đổi tên, lưu trữ, mở lại project; giữ lịch sử qua restart.
- Có pool agent đã cấu hình kể cả khi chưa có project.
- Trò chuyện với Coordinator, stream câu trả lời và dừng lượt đang chạy.
- Phân công theo capability, phụ thuộc, availability và budget.
- Công việc coding tạo thay đổi + kết quả kiểm tra; công việc research tạo báo cáo kèm nguồn; Analyst xử lý CSV có phương pháp tính.
- Reviewer kiểm tra đầu ra theo tiêu chí; kết quả review có thể yêu cầu sửa hoặc báo còn thiếu.
- Xem cấu hình agent, model profile, skills, tools được phép và tình trạng kết nối.
- Tải artifact có version; duyệt lời gọi công cụ; xem log thao tác và chi phí/token.

### Ngoài v1

SaaS nhiều người dùng, chạy tùy ý trên internet, tự huấn luyện model, chợ cài code không kiểm duyệt, điện thoại điều khiển máy từ xa, email/calendar thực, auto-deploy production, tích hợp Habblaud World chính thức. Có extension points nhưng chưa được tính là tính năng hoàn thiện.

## 2. Đội ngũ và danh tính

- AgentDefinition là package khả năng có version; ví dụ developer.
- AgentInstance là thành viên có tên/avatar ổn định; ví dụ developer-01, dùng definition developer.
- Pool là tập AgentInstance chuyên viên được bật; tạo thêm definition chưa tự tăng số thành viên.
- CoordinatorDefinition được dùng để tạo CoordinatorInstance riêng trong transaction tạo project.
- Coordinator không chiếm một chuyên viên dùng chung. Project A/B có Coordinator/context riêng.
- Một specialist có tối đa một assignment chưa giải phóng; kiểm soát bằng DB, không chỉ biến trong RAM.
- Đang sẵn sàng = không có model loop nền. Sinh avatar không đồng nghĩa tạo một phiên model.
- Agent được disable khi đang bận phải chuyển draining: hoàn thành/hủy có kiểm soát rồi mới disable.
- Mở thêm tab không tạo thêm agent hoặc Coordinator.

## 3. Tạo project

1. Nhập tên, mục tiêu; mô tả và workspace folder là tùy chọn.
2. Backend tạo projectId UUID; phòng dùng chính ID này.
3. Trong cùng transaction: project, conversation mặc định, CoordinatorInstance, room ordinal, sự kiện project.created.
4. Coordinator ở phòng với trạng thái ready; không gọi API model ở bước tạo.
5. UI chọn project vừa tạo và mở chat. Có thể thay mục tiêu/quyền trước khi giao việc.
6. Nếu request bị gửi lại với cùng idempotency key, trả cùng project; không nhân đôi phòng.
7. Registry/config lỗi phải trả lỗi rõ, không tạo project thiếu Coordinator.

Project tồn tại đến khi archive/delete. Phòng không tự biến mất vì Coordinator idle hoặc mọi task đã xong. Archive yêu cầu hủy/hoàn tất runs trước; undo archive phục hồi cùng ID, memory và lịch sử. Delete dữ liệu là thao tác khác, có xem trước phạm vi và xác nhận.

## 4. Chuyển người thành việc

Coordinator đề xuất plan gồm task cụ thể, capability, dependencies, inputs, outputs và acceptance criteria. Runtime kiểm tra plan rồi mới đưa vào scheduler.

Để tránh khóa nhân sự và deadlock, task chưa đủ dependency chưa giữ specialist. UI hiển thị "Dự kiến cần Reviewer", không cộng người chưa nhận assignment vào số thành viên phòng. Nếu muốn Reviewer vào ngay, giao task độc lập "chuẩn bị tiêu chí review", giải phóng sau khi hoàn thành và mời lại khi bản triển khai sẵn sàng.

Ví dụ xây web:
- Coordinator làm rõ phạm vi nếu thiếu thông tin thiết yếu.
- Developer triển khai trong workspace riêng của run.
- Reviewer có thể chuẩn bị checklist trước; review kết quả sau.
- Developer sửa nếu có finding cụ thể, tối đa số vòng cho phép.
- Coordinator tổng hợp artifacts, kết quả test và các giới hạn để giao người dùng.

## 5. Số đếm và trạng thái trên UI

| Chỉ số | Cách tính |
| --- | --- |
| Thành viên hiện tại | Coordinator + specialist có assignment gắn project và chưa released |
| Đang thực thi | Execution ở running_model/running_tool; không suy ra từ pose |
| Chờ bạn | Execution waiting_approval hoặc waiting_input |
| Chờ nguồn lực | Task ready chưa được cấp specialist/slot/budget |
| Chờ phụ thuộc | Task blocked_dependencies; specialist vẫn ở pool nếu chưa có assignment |
| Nhu cầu đội ngũ | Các capability trong plan; không giả làm người đang làm |
| Tiến độ | Số task đạt acceptance / tổng task của plan revision hiện tại |

Coordinator có thể đang ready trong khi Developer chạy. Biểu diễn riêng availability, execution và location. Không báo phần trăm do LLM tự ước lượng. Hiển thị thay đổi plan khi mẫu số task thay đổi.

## 6. Vòng đời specialist

~~~text
ready ở pool
  → scheduler cấp assignment
  → assigned vào project, UI vẽ đi vào phòng
  → chạy model/tool hoặc chờ phê duyệt
  → bàn giao kết quả, task được kiểm tra
  → released, trở về pool
~~~

Agent được giải phóng khi không còn execution/tool action mơ hồ. UI có thể vẽ animation bàn giao vài giây sau sự kiện backend; việc chạy không chờ animation. UI bỏ qua/sắp lại animation cũ theo revision mới nhất sau reconnect.

Nếu agent vừa được trả pool đã có assignment mới, animation ưu tiên địa điểm mới, không tạo hai bản sao. Audit vẫn lưu cả hai assignment.

## 7. Màn hình và thao tác

| Màn hình | Thành phần và trạng thái bắt buộc |
| --- | --- |
| Office | Pool + project rooms; project sidebar có avatar pixel, agent đang làm và trạng thái task; canvas chuyển động, bong bóng hoạt động, camera/zoom, settings hiển thị, ticker/feed sự kiện; nút tạo project, tìm/lọc; empty/loading/reconnecting |
| Project | Mục tiêu, Coordinator chat, tasks theo trạng thái, thành viên, artifacts, usage |
| Agent | Vai trò, availability, assignment hiện tại, skills/tools, version config, model |
| Task | Đầu vào, dependency, assignee, timeline, output, review, lỗi và retry |
| Approval | Tool, tham số/đích tác động, lý do, approve/deny, expiry, trạng thái đã quyết định |
| Artifact | Preview, tải xuống, phiên bản, nguồn/tác giả, checksum, finding review |
| Settings | Model profiles đã che key, kết nối, ngân sách, agent registry, doctor |
| History | Project archive, runs cũ; mặc định chỉ đọc đối với execution đã kết thúc |

### Giữ trải nghiệm văn phòng Habblaud

Agent Office giữ lại ngôn ngữ hình ảnh và hành vi văn phòng pixel art của Habblaud: sidebar nhóm agent theo project và hiển thị pool dùng chung; nhân vật di chuyển vào phòng khi nhận assignment và trở lại pool khi được giải phóng; pose, nhãn việc và bong bóng ngắn phản ánh trạng thái thực cùng hoạt động được cho phép. Thanh camera/zoom, bảng visual settings, ticker Activity ở cạnh dưới, feed có thể mở rộng và toast sự kiện tiếp tục là các phần chính của màn hình Office. Lựa chọn hiển thị như tên agent, mức lọc bong bóng, tốc độ di chuyển, theo dõi nhân vật, ánh sáng và theme được lưu qua lần tải lại.

Các hoạt động như lập kế hoạch, đọc/tìm, chờ phê duyệt, hoàn tất hoặc lỗi có thể hiện thành nhãn/bong bóng khi có event tương ứng. Feed chỉ nhận loại event được allow-list và tóm tắt ngắn; không hiển thị chain-of-thought, prompt riêng, nội dung file hay đối số công cụ. Chuyển động thư giãn của nhân vật có thể trang trí cho văn phòng, nhưng trạng thái làm việc và vị trí project luôn lấy từ assignment/backend, không suy ra từ animation hoặc bịa thêm sự kiện.

Chat vào Coordinator là mặc định. Chat với specialist trong v1 là lệnh steering có gắn project/task và được Coordinator nhận thông báo; không có đường gửi bí mật bỏ qua lịch sử. Yêu cầu mới khi run đang chạy cho chọn bổ sung vào run hiện tại hoặc xếp run tiếp theo; không tự tạo hai root run tranh context.

Pause dừng ở safe boundary và giữ checkpoint. Cancel cố gắng hủy model/tool; UI phải phân biệt "đang hủy" và "đã hủy". Đóng cửa sổ chat không phải cancel.

## 8. Các tình huống lỗi người dùng nhìn thấy

- Chưa cấu hình model: agent vẫn sẵn sàng; chat hiển thị bước cấu hình, không giả lập câu trả lời.
- Thiếu skill/tool/connector: nêu thiếu thành phần nào và công việc nào chưa làm được.
- Chuyên viên đang bận: có hàng đợi và vị trí dự kiến; không hiện ETA chính xác nếu chưa đủ dữ liệu.
- Hết token/budget: pause cùng hướng tiếp tục; không âm thầm đổi model/endpoint.
- Mất model stream: giữ phần đã nhận, đánh dấu interrupted; xử lý bằng recovery policy.
- Tool timeout không rõ đã tác động chưa: trạng thái outcome_unknown, yêu cầu đối chiếu trước retry.
- Reviewer không xác nhận được: trả kết quả có giới hạn hoặc xin thêm dữ liệu; không tự đánh dấu pass.
- Tạo 5 project: hiện 5 phòng; pan/zoom/overview và sidebar vẫn truy cập được.

## 9. Ngôn ngữ và khả năng sử dụng

v1 ưu tiên tiếng Việt và Anh; giữ các bản dịch hiện có của phần kế thừa. Tuân thủ quy ước tr() hiện tại của fork, thêm locale vi và kiểm tra missing keys. Chưa đổi toàn bộ ngôn ngữ khóa gốc trong cùng đợt xây runtime.

Giữ nét trình bày Habblaud của văn phòng: sprite pixel và chuyển động/hoạt động xã hội khi rảnh; sidebar nhóm Coordinator và specialist theo project; nhân vật đi vào đúng phòng khi nhận việc; bong bóng trực tiếp cho lập kế hoạch, đang làm, chờ phê duyệt, hoàn tất, lỗi và thao tác tool đã xác nhận; camera overview/zoom; thanh cài đặt tên, bong bóng, nhịp di chuyển, ánh sáng và chủ đề; activity ticker, feed và toast. Trạng thái “thinking” luôn có biểu hiện trực quan và cập nhật theo tiến độ công việc. Nhãn chỉ tóm tắt trạng thái vận hành đã xác nhận; không hiển thị suy luận riêng của model, prompt hoặc tham số thô của công cụ.

Có thao tác bằng bàn phím, label cho screen reader, trạng thái lỗi bằng chữ, chế độ giảm chuyển động. Drawer, chat và tasks dùng được khi canvas tắt hoặc bị lỗi GPU.

## 10. Nghiệm thu sản phẩm

- U01: mở lần đầu, 5 chuyên viên xuất hiện trong pool, không có lời gọi model.
- U02: tạo 3 project, có 3 phòng và 3 Coordinator ID khác nhau; restart giữ nguyên.
- U03: project A có Developer thì project B chờ; sau release B nhận đúng người.
- U04: lúc Reviewer chưa được giao, chỉ hiện planned role; không tăng assigned count.
- U05: job xong, specialist trở pool; phòng và Coordinator vẫn còn.
- U06: archive/mở lại giữ cùng project và lịch sử; không tạo Coordinator thứ hai.
- U07: mất SSE, mở tab khác, refresh đều không tạo task/agent trùng.
- U08: task research/analysis/coding tạo artifacts có bằng chứng kiểm tra tương ứng.
