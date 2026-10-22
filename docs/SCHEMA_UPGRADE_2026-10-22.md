# Đồng bộ schema Chấm công / HDoi

Chấm công thêm `Seal`, `Seal2` ở cuối schema VehicleTrips/VehicleLogs. Chỉ đổi file preset không nâng cấp các entity MySQL đã tồn tại: bootstrap dùng INSERT IGNORE.

## Trình tự triển khai

1. Đưa code DataDongBo mới lên VPS, giữ nguyên `.env`, MySQL volume và credential. Tạm dừng ghi từ Chấm công/HDoi trong cửa sổ bảo trì; không chỉnh tay Google Sheets.
2. Kiểm tra schema, mặc định chỉ đọc:

   `docker compose exec -T api node scripts/upgrade-cham-cong-schema.mjs`

3. Xem danh sách `added` và `insertColumns`, rồi áp dụng:

   `docker compose exec -T api node scripts/upgrade-cham-cong-schema.mjs --apply`

4. Restart API/worker DataDongBo nếu code đang nằm trong image cũ. Triển khai HDoi mới với `BUSINESS_DATA_PROVIDER=datadongbo`, URL/token DataDongBo hiện có. Không đổi hoặc xóa payload job cũ.
5. Chạy `node backend/scripts/check-datadongbo.js --env=.env.vercel` ở Chấm công. Chỉ tiếp tục khi `ready:true`; sau đó triển khai backend và mở ghi lại.

Lệnh lấy advisory lock chung với sync worker và khóa entity trong transaction. Nếu có metadata `__dd_*`, cột mới được chèn trước metadata, giữ các giá trị version/ngày đúng vị trí. Entity MySQL chỉ đổi headers sau khi Google xác nhận. Mất phản hồi sau chèn cột có thể chạy lại: nhận diện tiêu đề có cột trống hoặc tiêu đề mới để không chèn hai lần. Lỗi sẽ để trạng thái kiểm tra được, không import/xóa/đánh số lại bản ghi; giữ cửa sổ bảo trì cho đến khi chạy lại thành công.

Code chỉ chấp nhận bổ sung cuối schema theo danh sách trường xe đã biết. Đổi tên, đổi thứ tự, thiếu trường cũ hoặc metadata lạ bị chặn. Job HDoi cũ được đọc bằng chính headers trong payload; các Seal không được gửi giữ theo số container, không gán Seal của container cũ sang container thay thế.

Chưa chạy migration trên production. Unit/fixture tests không thay thế nghiệm thu MySQL và Google Sheets thực tế.
