# Sửa SHEET_ROW_MOVED của AuditLogs

Công cụ `scripts/repair-audit-rows.mjs` chỉ dành cho AuditLogs (append-only), đã nhập xong, retention=0. Không dịch tất cả dòng thêm 1 và không ghi/xóa Google Sheets.

1. Cập nhật source DataDongBo rồi build API bằng đúng các file Compose đang dùng: `docker compose up -d --build api`.
2. Tạm dừng thao tác ghi trên chấm công và chỉnh sửa trực tiếp Sheets trong thời gian sửa. Các backend/worker cũ ghi thẳng vào Sheets phải được dừng; công cụ không kiểm soát writer bên ngoài.
3. Chạy xem trước: `docker compose exec -T api node scripts/repair-audit-rows.mjs`.
4. Nếu `ok:true`, áp dụng: `docker compose exec -T api node scripts/repair-audit-rows.mjs --apply`.
5. Mở DataDongBo, bấm Đồng bộ ngay nếu tự động đang tắt hoặc tác vụ tổng hợp đang cần kiểm tra; theo dõi pending của AuditLogs về 0, kiểm tra ID trên Sheet. Mở lại thao tác ghi sau đối chiếu.

Khi worker đang giữ khóa, công cụ trả busy:true, không sửa; chờ worker hết lượt rồi chạy lại. Công cụ không cần dừng MySQL hoặc xóa volume.

Các ID có trên Sheets nhưng chưa có trong MySQL được nhập bổ sung với dữ liệu nguyên trạng. ID đã có được ánh xạ theo vị trí thực tế. ID chưa từng đồng bộ và chưa có trên Sheets được cấp chỗ sau dữ liệu hiện hữu. Không tự đánh dấu pending là đã ghi thành công; worker vẫn kiểm tra ID và ghi bình thường.

Giữ khóa đồng bộ toàn cục và khóa entity trong giao dịch MySQL; cập nhật row_map qua vị trí tạm âm để tránh đụng unique key khi đổi chỗ, commit cùng import/next_row. Lỗi sẽ rollback. Đọc lại Sheet trước khi sửa để phát hiện thay đổi. Cần tạm dừng writer bên ngoài vì Google Sheets không có giao dịch chung với MySQL.

Dừng khi ID trùng, nội dung cùng ID khác nhau, bản ghi đã đồng bộ bị thiếu, đã archive, hoặc cấu trúc cột sai. Không tự bỏ kiểm tra SHEET_ROW_MOVED. Log chỉ có số lượng và mã lỗi, không in credential hoặc nội dung nhật ký.

Kiểm thử fixture không thay thế nghiệm thu MySQL thật; công cụ chưa được chạy trên VPS từ phiên này.
