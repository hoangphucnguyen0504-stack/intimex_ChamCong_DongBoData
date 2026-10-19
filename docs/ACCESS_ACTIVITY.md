# Theo dõi truy cập

Tổng quan hiển thị các kết nối đã xác thực trong 15 phút gần đây, đánh dấu vừa hoạt động trong 60 giây. Dùng chung request `/admin/status` mỗi 10 giây; không tạo polling hay query MySQL mới.

- Tài khoản quản trị lấy từ cấu hình đã xác thực. API token dùng chung chỉ xác định là kết nối API, không xác định người dùng cuối hoặc phân biệt HDoi với backend khi cùng địa chỉ mạng.
- Mã kết nối là hash địa chỉ peer và loại truy cập; không phải ID người dùng. Reverse proxy có thể khiến nhiều client chung một mã. Không tin `X-Forwarded-For` tùy ý.
- Chỉ lưu bộ nhớ tiến trình, tối đa 200 kết nối; hết hạn 15 phút, xóa khi restart. Đây là hoạt động gần đây, không phải danh sách socket online hay nhật ký kiểm toán bền vững; nhiều replica có danh sách riêng.
- Không lưu token, cookie, mật khẩu, query string, ID bản ghi hoặc nội dung dữ liệu. Chỉ quản trị đã đăng nhập được xem.
- Request theo dõi status/me không làm tăng hoạt động. Không thay đổi CRUD hay dữ liệu nghiệp vụ.

Triển khai: cập nhật source rồi `docker compose up -d --build api` bằng cùng cấu hình Compose đang dùng. Không cần migration hay thay `.env`.
