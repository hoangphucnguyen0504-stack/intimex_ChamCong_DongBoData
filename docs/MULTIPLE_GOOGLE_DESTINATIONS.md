# Đồng bộ nhiều file Sheets và cấu hình Drive dự phòng

## Google Sheets

Trong **Cấu hình đồng bộ**, giữ Spreadsheet ID gốc làm định danh nguồn mà ChamCong sử dụng. Thêm các file dự phòng theo thứ tự, chia sẻ tất cả với Service Account có quyền chỉnh sửa và bật **Tự chuyển sang file kế tiếp khi đầy**. Có thể kiểm tra từng file sau khi lưu.

Một lượt đồng bộ gom bản ghi theo file/tab và ghi theo lô. Chỉ lỗi dung lượng/số ô xác định được mới chuyển các dòng chưa từng gửi sang file tiếp theo. Những dòng đã đồng bộ hoặc có kết quả gửi không rõ vẫn gắn với file cũ để tránh trùng. Các cập nhật lịch sử và truy vấn archive đọc đúng file/tab/dòng đã lưu. File thiếu quyền, lỗi mạng hoặc quota API không kích hoạt chuyển file. Khi hết file dự phòng, dữ liệu vẫn ở MySQL với trạng thái chờ/cần kiểm tra.

Không thay Spreadsheet ID nguồn gốc và không chỉnh thủ công cột ID, metadata hoặc vị trí dòng đang liên kết. File đã chứa dữ liệu không được xóa khỏi cấu hình; có thể tắt nhận bản ghi mới. Đích đã bị đánh dấu đầy sẽ không được tái sử dụng tự động, kể cả sau khi được dọn ô; thêm file mới thay vì sửa trực tiếp trạng thái trong DB.

## Danh sách cấu hình Google Drive

Trong cùng trang, thêm tên nhận diện, OAuth Client ID/Secret, refresh token, thư mục và thứ tự ưu tiên. Mỗi token phải khớp OAuth Client và có quyền thư mục đã chọn. Các cấu hình cùng tài khoản/project không tạo quota độc lập. Dùng **Kiểm tra quyền thư mục** sau khi lưu. GET quản trị chỉ trả cấu hình che token; để trống secret/token khi sửa để giữ giá trị cũ. Thay thông tin tài khoản/token/thư mục tạo mã cấu hình mới để giữ tài khoản sở hữu các file cũ.

ChamCong và HDoi giữ cấu hình đã nhận. Chỉ lỗi `403 userRateLimitExceeded` rõ ràng sau backoff mới xin cấu hình kế tiếp; lỗi quota project, lỗi mạng, thiếu quyền hoặc token bị thu hồi không tự xoay tài khoản. OAuth tự làm mới access token với Google theo cơ chế riêng.

DataDongBo hiển thị **cấu hình đã cấp gần nhất**, thời gian, mã cấu hình và lịch sử. Đây không phải kiểm tra trực tiếp tài khoản đang online. Cấu hình môi trường cũ chưa được cấp từ danh sách không có lịch sử cấp trong DataDongBo. ChamCong hiển thị cấu hình đang giữ tại trang cài đặt lưu trữ. Danh sách Drive trên trang chỉ tải khi mở lần đầu, lưu hoặc bấm làm mới; không polling cấu hình bí mật.

## Lưu bền vững ở HDoi

HDoi giữ cấu hình đã nhận, lịch sử tài khoản và chủ sở hữu file trong volume bền vững. Cấu hình cần có:

```dotenv
DRIVE_CREDENTIAL_ENCRYPTION_KEY=<64 ký tự hex ngẫu nhiên, giữ cố định>
DRIVE_CREDENTIAL_STORAGE_DIR=/data/images/.drive-credentials
DATA_DONG_BO_URL=https://data.example.com
DATA_DONG_BO_TOKEN=<token backend DataDongBo>
```

Không đưa key/token vào frontend. Các process/replica HDoi phải dùng cùng key và cùng volume lưu trữ; giữ lại volume khi restart/redeploy. Không thay key khi còn dữ liệu mã hóa nếu chưa có kế hoạch chuyển khóa. `DRIVE_CREDENTIAL_STORAGE_DIR` mặc định nằm dưới `IMAGE_STORAGE_DIR`; có thể bỏ biến này khi dùng volume ảnh hiện có. URL HTTP chỉ được chấp nhận ở localhost khi phát triển.

ChamCong tiếp tục dùng `HDOI_URL`, `HDOI_TOKEN` và các biến OAuth hiện có làm cấu hình ban đầu. Khi cần, backend đọc cấu hình đã lưu ở HDoi một lần rồi cache trong process. HDoi chỉ gọi DataDongBo khi thực sự cấp/chuyển cấu hình; restart không làm lấy lại cấu hình từ DataDongBo cho từng request. Đổi tài khoản không thay chủ sở hữu file đã tạo; các cấu hình cũ được giữ để đọc/xóa đúng tài khoản.

## Triển khai

1. Sao lưu MySQL DataDongBo và volume HDoi trước khi cập nhật.
2. Cập nhật DataDongBo; migration khởi động thêm bảng đích vật lý và registry mã hóa, cùng cột chủ sở hữu credential ảnh. Không xóa dữ liệu cũ.
3. Cấu hình key và volume HDoi, cập nhật API và worker HDoi cùng phiên bản.
4. Cập nhật backend/frontend ChamCong.
5. Thêm file/token dự phòng bằng giao diện và kiểm tra quyền. Không cần đổi file `.env` của ChamCong cho mỗi lần chuyển.

Việc triển khai, chạy migration trên production, cấp quyền Google và nhập token thật phải được thực hiện trong môi trường vận hành; task code không tự gọi Google hoặc đọc token thật để kiểm tra.
