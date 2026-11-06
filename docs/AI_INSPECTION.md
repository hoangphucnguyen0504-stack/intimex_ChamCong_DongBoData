# Danh sách API AI

Trang quản trị → **Danh sách API AI** hiển thị bảng kết nối. Mỗi dòng chỉ cần chọn **nhà cung cấp**, nhập **tên model** và **API key**. Hỗ trợ Google Gemini và OpenAI; nhập tên model thuần, không nhập URL.

- **Thêm API** tạo dòng mới; điền đủ ba trường rồi **Lưu danh sách API**.
- **↑ / ↓** đổi thứ tự ưu tiên. Worker thử lần lượt mỗi API đang bật và sẵn sàng, tối đa một lượt mỗi dòng trong một tác vụ.
- **Đang bật / Tạm dừng** thay đổi trạng thái kết nối; lưu để áp dụng.
- **Kiểm tra** kiểm tra kết nối đã lưu bằng dữ liệu giả. Đây là một lượt gọi thật tới nhà cung cấp.
- **Xoá** gỡ dòng khỏi danh sách sau khi lưu.

API key mã hóa bằng `CONFIG_ENCRYPTION_KEY` hiện có và không trả lại trình duyệt. Để trống giữ key cũ khi nhà cung cấp không đổi. Đổi nhà cung cấp cần key mới. Không đổi khóa mã hóa hiện có.

Không còn cấu hình/tính toán chi phí, giá token, ngân sách, hạn mức lượt gọi/ngày hoặc giới hạn token do ứng dụng đặt. Các cấu hình cũ được bỏ qua ngay khi đọc, không cần lưu lại để gỡ hạn mức. Request gửi nhà cung cấp không kèm `maxOutputTokens`, `max_completion_tokens` hoặc `max_tokens`. Giới hạn riêng của nhà cung cấp/model vẫn áp dụng.

Giữ thời gian chờ kết nối, thời gian tạm nghỉ sau lỗi và cơ chế tránh gửi trùng. Khi timeout hoặc worker bị ngắt mà kết quả chưa rõ, người dùng phải chủ động thử lại. Không gọi vô hạn một API. Nhật ký chỉ ghi trạng thái và mã lỗi; số liệu lịch sử cũ không bị xóa nhưng không hiển thị/tính toán tiếp.

Endpoint quản trị `/admin/ai` dùng session/CSRF hiện có; tích hợp `/v1/ai/jobs` dùng bearer token. Request lưu cấu hình chỉ cần `{revision,providers}`; provider gồm `{id,vendor,model,enabled,apiKey?}`. `name` cũ được giữ để tương thích, không cần nhập. Các trường chi phí/hạn mức của client cũ bị loại bỏ.

Cần triển khai lại DataDongBo web và worker; không cần migration mới hoặc dependency mới. Không tự khởi động worker thật khi kiểm thử. `node --test test/ai.test.mjs` dùng fetch/pool giả, không gọi AI thật. Tài liệu luồng mapping đầy đủ: `Cham_cong/docs/INSPECTION_AI.md`.
