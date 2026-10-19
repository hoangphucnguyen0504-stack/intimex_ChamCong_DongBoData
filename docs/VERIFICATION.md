# Kiểm chứng DataDongBo — 19/10/2026

Mã nguồn được tạo độc lập với Cham_cong; không sửa cấu hình kết nối hoặc ghi dữ liệu nghiệp vụ của dự án hiện tại. Không dùng credential Google/MySQL production trong kiểm thử.

## Đã chạy

Kết quả cuối: **21/21 unit/API/worker-protocol/Compose tests đạt**, kiểm tra cú pháp đạt; `npm audit --omit=dev` báo 0 vulnerabilities. `scripts/check-env.mjs` xác nhận cấu hình sinh ra hợp lệ, không in secret. `npm run test:mysql` có **1 test bị skip** do chưa đặt kết nối database test; không phải MySQL integration đã đạt.

- Node 24.15.0; npm install tạo lockfile, audit ban đầu không có lỗ hổng được báo.
- Unit/API tests: encryption, password, validation, decimals/zero/JSON, retry delay, SDK, cookie HttpOnly/CSRF, API token, lỗi không lộ SQL/credential, RAW batch write idempotent, nhận biết ID bị di chuyển, quota 429; điều phối nhiều lô thủ công, giữ dirty khi Google lỗi và xác nhận đúng phiên bản gửi. Receipt không giữ lại payload nghiệp vụ sau khi lưu.
- Parse ba file Compose và kiểm tra network binding, MySQL durability option, tmpfs test và worker command. Đây là kiểm tra cấu hình YAML, không phải Docker build/runtime.
- Kiểm tra cú pháp các file JS.
- Giao diện mở trên Chrome bằng server fixture local `127.0.0.1:3209`, dữ liệu giả lập. Đăng nhập/đăng xuất bằng tài khoản test, bốn màn hình điều hướng hoạt động; không dùng tài khoản thật. Không tràn ngang trang ở viewport 375 px (documentWidth 375), 768 px (753) và 1440 px (1425). Khóa Service Account không có trong form sau tải. Request `/admin/me` khi chưa đăng nhập trả 401 theo thiết kế; favicon 404 được sửa bằng SVG riêng.

## Chưa xác nhận

- Docker CLI bị allowlist công cụ chặn; không chạy được build/container tại phiên này. Thử khởi tạo MySQL thử nghiệm riêng cũng bị chặn bởi bộ phân tích allowlist, không can thiệp dịch vụ MySQL80 đang chạy.
- Chưa chạy integration trên MySQL thật. Có `docker-compose.test.yml` để chạy tự động trên VPS với database tmpfs hoàn toàn riêng.
- Chưa import/ghi Google Sheets thật và chưa thử khôi phục backup. Có mock ghi Sheets/429/timeout và mã integration MySQL, nhưng không coi đó là kết quả production.
- Chưa tích hợp adapter/cutover Cham_cong, chưa deploy VPS, chưa đo thời gian khai báo thực tế.
- Chưa có ảnh baseline để kết luận visual regression, chưa kiểm tra đầy đủ accessibility/Core Web Vitals.

Các giới hạn này cần được kiểm tra trước khi dùng dịch vụ làm nguồn dữ liệu production.
