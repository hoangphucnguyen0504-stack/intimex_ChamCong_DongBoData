# Danh sách API AI

Thêm tab **Danh sách API AI** trên trang quản trị DataDongBo. Hỗ trợ OpenAI và Google Gemini bằng model do quản trị viên nhập, khóa API mã hóa bằng `CONFIG_ENCRYPTION_KEY` hiện có, thứ tự dự phòng, hạn mức, thống kê ước tính và lịch sử cấu hình.

Khởi động lại web/worker bằng quy trình triển khai hiện có. Hàm migrate bổ sung các bảng AI từ `sql/ai.sql`; không có dependency mới. Không đổi hoặc làm mất khóa mã hóa hiện có.

Luồng: Cham_cong gửi cấu trúc mẫu → `POST /v1/ai/jobs` → worker xử lý → `GET /v1/ai/jobs/:id?scope=...`. Bearer token hiện có bảo vệ các endpoint tích hợp. Endpoint `/admin/ai` dùng session/CSRF quản trị hiện có. Retry qua `POST /v1/ai/jobs/:id/retry` chỉ chấp nhận tác vụ lỗi/cần kiểm tra và còn nội dung.

Đăng nhập quản trị, mở tab mới, thêm nhà cung cấp, model hỗ trợ JSON schema (tên thuần), API key, thứ tự và hạn mức rồi lưu. Nhập đơn giá chính xác nếu đặt giới hạn USD. Giá trị 0 của ngân sách USD tắt giới hạn USD nhưng vẫn giữ giới hạn lượt gọi. Ngày thống kê theo UTC. Bấm kiểm tra kết nối sử dụng dữ liệu giả nhưng là lượt gọi thật có thể tính phí.

429/hết hạn mức/xác thực/5xx có thể chuyển API tiếp theo (tối đa 3); timeout hoặc kết quả tính phí không rõ cần người dùng chủ động thử lại. Khóa không xuất hiện trong JSON quản trị trả về; để trống khi cập nhật giữ key trước đó nếu nhà cung cấp không đổi. Không lưu nội dung lỗi thô của nhà cung cấp.

Payload/kết quả mã hóa của tác vụ đã kết thúc được dọn sau 14 ngày. Nhật ký lượt gọi, giá ước tính và metadata còn giữ. Lượt không rõ mức sử dụng giữ dự trù chi phí. Cấu hình, số token và ước tính không thay hóa đơn thực tế.

Kiểm thử: `node --test test/ai.test.mjs` và `npm test`; sử dụng pool/fetch giả, không gọi AI thật. Chưa chạy kiểm tra nhà cung cấp thật hoặc migration trên MySQL triển khai.

Tài liệu luồng mapping đầy đủ ở dự án Cham_cong: `docs/INSPECTION_AI.md`.
