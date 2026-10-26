# Checklist nghiệm thu Agent Office trên Windows

Checklist này dành cho chủ sản phẩm sau khi nhận build UAT. Cách chạy trên cổng và thư mục dữ liệu riêng nằm trong [hướng dẫn sử dụng](AGENT-OFFICE-USER-GUIDE.md). Model request dùng credential trong `.env`, có thể gửi nội dung đến provider và phát sinh chi phí.

Ghi trạng thái, project/task ID, thời điểm và kết quả mong đợi. Không đưa API key, `.env`, dữ liệu riêng tư hoặc workspace thật vào báo cáo lỗi.

| # | Kiểm tra | Kết quả mong đợi | Trạng thái / ghi chú |
| --- | --- | --- | --- |
| 1 | Mở UAT URL, tạo ba project khác nhau, tải lại trang | Ba phòng còn nguyên, mỗi phòng có Coordinator riêng, chọn được bằng chuột và bàn phím | ☐ |
| 2 | Gửi một yêu cầu viết tài liệu ngắn cần Writer và Reviewer | Coordinator tạo task có phụ thuộc phù hợp; agent hiện đúng phòng/trạng thái; artifact mở và tải được | ☐ |
| 3 | Giao yêu cầu nghiên cứu có nguồn và một bảng CSV cần tổng hợp | Kết quả nêu nguồn; số liệu artifact khớp dữ liệu mẫu; lỗi thiếu connector được báo thật | ☐ |
| 4 | Thử yêu cầu chỉnh một file trong workspace thử nghiệm riêng | Diff hiển thị đúng dòng thêm/xóa so với file có checksum hiện tại; từ chối thì file không đổi; duyệt thì chỉ đúng nội dung đã xem được ghi; tệp lớn/nhị phân báo rõ giới hạn diff | ☐ |
| 5 | Để approval mở rồi sửa file đích từ cửa sổ khác | Quyết định cũ bị từ chối do checksum thay đổi, nội dung mới của owner còn nguyên | ☐ |
| 6 | Tạm ngắt mạng trình duyệt rồi kết nối lại | Room đang chọn được giữ; snapshot/event mới được tải; không sinh run trùng | ☐ |
| 7 | Trong khi run chạy, xếp hàng yêu cầu thứ hai và điều hướng run hiện tại | Yêu cầu xếp hàng chạy sau; lệnh điều hướng áp dụng ở điểm dừng an toàn hoặc được báo chưa áp dụng | ☐ |
| 8 | Dừng server bằng `Ctrl+C` trong khi gửi một lệnh mới, rồi khởi động lại cùng lệnh UAT | Lệnh mới bị từ chối có thể thử lại; project, chat, task, memory và artifact còn nguyên; không dùng lại thư mục dữ liệu khác | ☐ |
| 9 | Drain một specialist đang rảnh rồi giao task mới | Agent đang drain không nhận task mới; resume thì nhận lại; agent đang chạy được phép hoàn tất | ☐ |
| 10 | Tạo project memory note, tải `memory.md`, sửa owner note qua preview/import | Preview chỉ cho sửa owner note; import tạo revision mới; lần tải cũ bị conflict nếu DB đã đổi | ☐ |
| 11 | Thêm ghi chú project A rồi giao task project B cho cùng specialist | B không thấy memory/project attachment của A nếu chưa được cấp quyền | ☐ |
| 12 | Tạo backup UAT và restore vào thư mục mới | Hash và integrity hợp lệ; server mới khởi động được từ bản restore; UAT gốc không bị sửa | ☐ |
| 13 | Xem usage/cost và chạy `npm.cmd run office:doctor` không có `--live` | Usage không báo free khi thiếu giá; doctor báo readiness mà không gọi model hoặc lộ API key | ☐ |
| 14 | Gắn một workspace thử nghiệm rồi mở website preview | Xem đúng script và hooks; quyền mạng cần được xác nhận; trang mở ở tab riêng; stop đóng preview và workspace gốc không bị đổi | ☐ |
| 15 | Mở cùng một project trong hai tab, tạo memory note ở tab thứ hai | Tab đầu nhận cập nhật không cần tải lại; mỗi tin nhắn gửi một lần chỉ tạo một run | ☐ |
| 16 | Tạm dừng run khi một specialist đang làm, tiếp tục sau checkpoint; thử hết ngân sách và tăng hạn mức | Task hiện tại không bị lặp; task tiếp theo chờ đến khi tiếp tục; hết ngân sách cần xác nhận mức token/USD cao hơn; thao tác tool chưa rõ kết quả không thể tiếp tục | ☐ |
| 17 | Dùng overview/zoom; bật/tắt tên agent, đổi mức bong bóng và di chuyển, ánh sáng và chủ đề; reload; giao task cần phê duyệt rồi hoàn tất một task; thử sidebar và panel project ở màn hình 390px | Cài đặt vẫn được giữ; sidebar nhóm Coordinator/specialist theo room và pool chỉ chứa agent chưa được điều phối; pixel agent hiện trạng thái thinking/đang làm/chờ duyệt và task; bong bóng cập nhật thao tác tool đã xác nhận, rồi phản ánh phê duyệt, thành công/lỗi; activity ticker/feed/toast hoạt động; câu trả lời cuối dễ đọc, không lộ cú pháp tool; panel project đóng/mở được, chuyển động idle vẫn sinh động | ☐ |

## Kết quả nghiệm thu

- Ngày và build:
- Người kiểm tra:
- Các mục đạt / chưa đạt:
- Lỗi chặn phát hành:
- Quyết định: ☐ chấp nhận UAT ☐ cần sửa và kiểm tra lại
