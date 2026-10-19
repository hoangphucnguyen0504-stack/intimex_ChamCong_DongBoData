# DataĐồngBộ

Dịch vụ dữ liệu riêng cho backend chấm công: **MySQL là nguồn dữ liệu chính**, Google Sheets là bản đồng bộ/lịch sử. Gồm giao diện quản trị tiếng Việt, API, worker và cấu hình Docker. Không cần Neon/Redis để chạy dịch vụ này.

## 1. Chạy trên VPS bằng Docker

Đưa thư mục dự án lên VPS, ví dụ `/opt/datadongbo`. File `.env` đã được tạo với khóa ngẫu nhiên riêng; không commit hoặc chia sẻ file này.

```bash
cd /opt/datadongbo
docker compose up -d --build
docker compose ps
docker compose logs --tail 100 api worker
```

MySQL không mở cổng ra Internet. API/UI chỉ mở `127.0.0.1:3200` trên VPS; địa chỉ công khai đã cấu hình là **https://datadongbo.157.66.219.11.sslip.io**. Cần áp dụng block Caddy tương ứng theo [hướng dẫn địa chỉ public và Google](docs/PUBLIC_GOOGLE_SETUP.md).

Nếu dùng SSH tunnel thay vì HTTPS, đổi `PUBLIC_ORIGIN=http://localhost:3200`, `COOKIE_SECURE=false` rồi tạo lại container. Trên máy cá nhân mở tunnel:

```bash
ssh -L 3200:127.0.0.1:3200 remoteuser@157.66.219.11
```

Mở **http://localhost:3200** khi đã cấu hình chế độ tunnel như trên. Tài khoản mặc định **admin**; mật khẩu ở biến **ADMIN_INITIAL_PASSWORD** trong `.env`. Giữ cửa sổ SSH mở khi sử dụng tunnel. Khi dùng tên miền public, giữ `COOKIE_SECURE=true`.

Nếu chưa có `.env`, tạo bằng Node có sẵn hoặc bằng container Node, không cần cài npm trên VPS:

```bash
node scripts/setup.mjs
# Hoặc:
docker run --rm -v "$PWD:/work" -w /work node:24-alpine node scripts/setup.mjs
```

Setup không ghi đè `.env` có sẵn. Đổi mật khẩu: tạo hash bằng lệnh bên dưới rồi điền `ADMIN_PASSWORD_HASH`, thay `SESSION_SECRET` để vô hiệu hóa phiên cũ, sau đó tạo lại container. Không truyền mật khẩu thật qua tham số dòng lệnh/log.

```bash
# Chạy trên máy cá nhân đã npm ci; đặt PASSWORD_TO_HASH trong môi trường riêng trước.
node --input-type=module -e "import {passwordHash} from './src/core.js'; console.log(passwordHash(process.env.PASSWORD_TO_HASH))"
```

## 2. Dùng MySQL sẵn có trên VPS

Không cần chạy container MySQL đi kèm. Tạo database/user riêng bằng tài khoản quản trị MySQL của bạn, cấp quyền chỉ trên database này. MySQL cần InnoDB và `innodb_flush_log_at_trx_commit=1`; dịch vụ kiểm tra trước khi khởi động.

Điền `.env`:

```dotenv
MYSQL_HOST=host.docker.internal
MYSQL_PORT=3306
MYSQL_DATABASE=datadongbo
MYSQL_USER=datadongbo
MYSQL_PASSWORD=<mật khẩu user riêng>
```

`host.docker.internal` trỏ về Docker host. MySQL trên host phải lắng nghe giao diện mạng mà container truy cập được và cho phép user từ mạng Docker. Không cần mở MySQL ra Internet. Nếu MySQL nằm trong container/máy khác, điền hostname/IP mạng riêng phù hợp. Chỉ bật `MYSQL_SSL=true` khi máy chủ có chứng chỉ tin cậy.

```bash
docker compose -f docker-compose.external.yml up -d --build
```

Không chạy cả hai file Compose như hai cụm khác nhau trên cùng database. Khi đổi từ MySQL đi kèm sang MySQL có sẵn, phải sao lưu/chuyển dữ liệu trước; thay hostname không tự di chuyển dữ liệu.

## 3. HTTPS và kết nối từ Vercel

Backend chấm công trên Vercel cần URL HTTPS công khai đến DataDongBo; SSH tunnel chỉ phục vụ quản trị từ máy của bạn. Dùng Caddy đang có trên VPS, thêm site riêng dựa trên `deploy/Caddyfile`.

Ví dụ hostname riêng: `data.tenmien.vn`. Caddy cài trên host dùng upstream `127.0.0.1:3200`. Nếu Caddy chạy trong Docker, cần nối cùng Docker network và dùng hostname container API; `127.0.0.1` trong Caddy container không phải VPS.

Trong `.env`:

```dotenv
PUBLIC_ORIGIN=https://data.tenmien.vn
COOKIE_SECURE=true
```

`PUBLIC_ORIGIN` phải đúng origin người quản trị dùng để mở UI, không có dấu `/` cuối. Tạo lại container sau khi sửa env:

```bash
docker compose up -d --build
```

## 4. Thiết lập Google Sheets trong giao diện

Cấu hình Google của backend chấm công đã được đưa vào `.env` riêng của DataDongBo. Khi database chưa có cấu hình, API/worker tự mã hóa và lưu Google settings vào MySQL. Khi đã cấu hình qua giao diện, khởi động lại không ghi đè lựa chọn trên UI. Muốn áp dụng lại env một cách chủ động: `docker compose exec -T api node scripts/apply-google-env.mjs` (giữ nguyên URL Sheet khi đã có row-map).

17 tài nguyên đã được chuẩn bị theo tên tab và hàng tiêu đề thực tế, chỉ seed cấu hình còn thiếu. Chưa tự import bản ghi hoặc ghi thêm cột vào Sheets khi khởi động; bấm Nhập sau khi đã dừng chỉnh sửa nguồn và sẵn sàng chuyển đổi. `SYNC_ENABLED=false` tránh ghi nền vào Sheet đang phục vụ ứng dụng cũ.

1. Tạo Google Service Account, bật Sheets API và tải JSON credential.
2. Chia sẻ **Sheet dùng cho DataDongBo** với email Service Account, quyền Editor.
3. Trong **Cấu hình đồng bộ**, điền Spreadsheet ID, JSON Service Account; lịch mặc định **60 phút**, lô mặc định **100 bản ghi**. Bấm Lưu, rồi Kiểm tra kết nối.
4. Trong **Tài nguyên dữ liệu**, thêm một tài nguyên cho từng tab cần kết nối. Tên tài nguyên ví dụ `VehicleTrips`, `Attendance`, `TripItems`. Tên tab phải tồn tại trên Sheets. Danh sách cột phải đúng thứ tự thực tế và chứa một cột `ID` duy nhất. Có thể bấm **Lấy cột từ tab** sau khi điền tên tab.
5. Cấu hình số ngày lưu: **0 giữ vĩnh viễn**, **7 lưu cuốn chiếu**. Danh mục/tài khoản/dữ liệu liên kết dài hạn nên để 0.
6. Bấm **Nhập từ Sheets** một lần cho từng tài nguyên, kể cả tab trống; theo dõi trạng thái ở Tổng quan. Dịch vụ đọc từng lô 500 dòng, lưu tiến độ để tiếp tục khi bị gián đoạn. Không nhập lại tài nguyên đã sẵn sàng.
7. Bật đồng bộ tự động khi cấu hình hoàn tất. “Đồng bộ ngay” chỉ lưu tác vụ, không bắt trình duyệt chờ Google.

Private key được mã hóa AES-256-GCM trong MySQL bằng `CONFIG_ENCRYPTION_KEY` từ `.env`; API quản trị không trả lại khóa này. Để trống JSON khi lưu cấu hình tiếp theo sẽ giữ credential hiện có. Không làm mất khóa mã hóa khi triển khai lại/khôi phục.

## 5. Kết nối dự án chấm công

Đặt trong **backend** chấm công, không dùng tiền tố VITE_:

```dotenv
DATA_DONG_BO_URL=https://data.tenmien.vn
DATA_DONG_BO_TOKEN=<API_TOKEN trong .env DataDongBo>
```

Copy `client/datadongbo.mjs` vào backend hoặc import như module nội bộ:

```js
import {randomUUID} from 'node:crypto';
import {DataDongBoClient} from './datadongbo.mjs';
const db = new DataDongBoClient({url:process.env.DATA_DONG_BO_URL,token:process.env.DATA_DONG_BO_TOKEN});
// Tạo requestId một lần, lưu cùng yêu cầu; mọi lần thử lại dùng cùng ID và payload.
const batch = {
  requestId: randomUUID(),
  operations: [{action:'create',entity:'Attendance',id:randomUUID(),data:{FullName:'Nguyễn Văn A'}}]
};
const receipt = await db.commit(batch);
// receipt.durable === true: giao dịch MySQL đã commit.
// receipt.sheetsStatus === 'pending': Google được ghi sau ở nền.
```

Sửa/xóa (optimistic concurrency):

```js
const {record} = await db.get('Attendance', id);
await db.commit({requestId:randomUUID(),operations:[{
  action:'update',entity:'Attendance',id,expectedVersion:record.version,data:{FullName:'Tên mới'}
}]});
// Xóa mềm: action:'delete', expectedVersion bắt buộc, không cần data.
// Khi kết thúc nghiệp vụ: gửi finalizedAt:new Date().toISOString().
```

Khi timeout, chưa biết kết quả: `await db.result(batch.requestId)` trước khi gửi lại **nguyên batch**. Không sinh requestId mới cho cùng thao tác. Cùng requestId nhưng payload khác bị từ chối. Nhiều thao tác trong batch commit/rollback cùng một giao dịch; tối đa 200 thao tác và 2 MB request.

Receipt lưu lâu dài chỉ chứa ID/phiên bản và metadata xác nhận, không giữ bản sao `data` nghiệp vụ để tránh vô hiệu hóa chính sách lưu 7 ngày. Response lần ghi đầu có `data`; receipt hoặc response replay không có `data`. Sau khôi phục từ receipt, dùng `get()` hoặc `archive()` để lấy nội dung nếu cần. Metadata đồng bộ trong receipt mô tả thời điểm tiếp nhận, không phải trạng thái Sheets hiện tại.

**Dịch vụ mới chưa tự thay adapter dữ liệu của Cham_cong.** Không đổi env Neon/HDoi thành MySQL URL rồi coi là tích hợp xong. Backend hiện tại cần adapter gọi API này, ánh xạ nghiệp vụ, phiên bản và trạng thái hoàn tất; giữ nguyên xác thực/phân quyền ở backend chấm công và kiểm thử trước khi chuyển nguồn dữ liệu. API_TOKEN là quyền toàn dịch vụ, chỉ giao cho backend tin cậy.

## 6. API

Mọi `/v1/*` yêu cầu `Authorization: Bearer <API_TOKEN>`; không hỗ trợ gọi trực tiếp từ frontend.

| Endpoint | Ý nghĩa |
|---|---|
| `POST /v1/batch` | Lưu create/update/delete nguyên tử, chống trùng bằng requestId |
| `GET /v1/requests/:requestId` | Lấy receipt đã commit khi mất phản hồi |
| `GET /v1/entities/:entity/records` | Danh sách MySQL, phân trang theo ID |
| `GET /v1/entities/:entity/records/:id` | Chi tiết/phiên bản/trạng thái đồng bộ |
| `GET /v1/entities/:entity/archive` | Lịch sử đã dọn khỏi MySQL, đọc từ Sheets theo lô |
| `GET /v1/entities/:entity/archive/:id` | Chi tiết lịch sử từ Sheets |
| `GET /health/live` | API đang sống |
| `GET /health/ready` | MySQL truy cập được |

Danh sách hỗ trợ `limit` tối đa 200, `after` = nextAfter của trang trước, `from`/`to` dạng ISO có timezone, `includeDeleted=true`. `hasMore` cho biết cần trang tiếp theo. `records` chỉ trả dữ liệu còn trong MySQL; dùng thêm `archive` cho dữ liệu đã lưu trữ. Không có cursor delta/snapshot cố định ở phiên bản này; adapter cache hiện tại của chấm công cần được tích hợp riêng.

Ví dụ response:

```json
{"ok":true,"durable":true,"requestId":"fixed-request-id","records":[{"id":"ATT-1","entity":"Attendance","version":1,"syncedVersion":0,"syncStatus":"pending","data":{"ID":"ATT-1","FullName":"A"}}],"sheetsStatus":"pending"}
```

409 `VERSION_CONFLICT` trả bản ghi hiện tại trong `current`; người dùng cần đối chiếu, không tự ghi đè. 410 `RECORD_ARCHIVED` hướng sang endpoint archive. Dữ liệu lịch sử đã dọn chỉ đọc; muốn sửa phải có quy trình khôi phục/migration riêng, không tạo lại cùng ID.

## 7. Đồng bộ, retry và xóa sau 7 ngày

- Bản ghi MySQL lưu `version`, `synced_version`, `dirty`. Đây là ý định đồng bộ bền vững trong cùng giao dịch ghi, không phải queue trong RAM.
- Một worker điều phối bằng MySQL advisory lock; không chạy nhiều worker riêng trên các database khác nhau mà cùng ghi một Sheet.
- Khóa vị trí dòng trong MySQL **trước khi gọi Google**, ghi `values.batchUpdate` theo dải với `RAW`. Timeout/thử lại ghi cùng dòng, không append lần nữa. Gộp các phiên bản chưa gửi thành trạng thái mới nhất.
- Chỉ xác nhận phiên bản đã gửi; nếu người dùng sửa trong lúc worker ghi thì bản mới vẫn còn dirty để ghi tiếp.
- Điều tiết HTTP Sheets tập trung bằng MySQL, mặc định tối đa 40 request/phút cho dịch vụ này. Các ứng dụng khác dùng chung Google Service Account cũng tiêu quota; nên dùng tài khoản riêng cho DataDongBo.
- Google 429/5xx/network được giữ chờ với exponential backoff, jitter và Retry-After. Tác vụ thủ công/import lỗi 8 lần chuyển `needs_review`, có nút Thử lại. Lịch tự động tiếp tục thử các bản ghi dirty với khoảng chờ tăng dần, không xóa dữ liệu lỗi.
- Các lô dirty tiếp theo chạy tiếp ở tick sau, không đợi thêm 60 phút. Độ trễ tối đa còn phụ thuộc backlog, Google quota và mạng; 60 phút là lịch bắt đầu khi worker không còn backlog.
- Lịch sử chạy/sessions cũ được dọn; receipt chống trùng và row-map được giữ lại để không tạo lại ID đã lưu trữ. Cần theo dõi dung lượng các bảng kỹ thuật khi vận hành dài hạn.
- Chỉ dọn record khi: tài nguyên có retention > 0, bản ghi đã finalized, businessAt/finalizedAt/updatedAt đều quá thời hạn, phiên bản mới nhất đã sync và không dirty. Xóa mềm **không mặc nhiên có nghĩa đã hoàn tất nghiệp vụ**.
- Không bao giờ xóa dòng lịch sử trên Sheets khi dọn MySQL. Nhật ký xóa mềm nằm ở `__dd_deleted_at`.

Sheets có thêm bốn cột cuối: `__dd_version`, `__dd_deleted_at`, `__dd_business_at`, `__dd_finalized_at`. Không đổi tên/di chuyển/xóa cột, không sắp xếp/xóa/thêm dòng trực tiếp vào các tab đang liên kết. Dịch vụ kiểm tra ID vị trí dòng trước khi ghi và dừng khi phát hiện lệch; không hỗ trợ đồng bộ hai chiều với chỉnh tay Sheets.

Muốn làm báo cáo sắp xếp tự do, dùng tab báo cáo riêng. Đổi Sheet đích khi đã có row-map bị khóa để tránh ghi sang một Sheet khác theo vị trí cũ. Tạo dự án/database riêng hoặc làm migration có đối chiếu nếu cần đổi.

## 8. Sao lưu MySQL

Google Sheets không thay thế bản sao lưu MySQL: có thể chậm 60 phút hoặc lâu hơn nếu đồng bộ lỗi. Sao lưu database và giữ bản sao ngoài VPS, cùng bản sao `.env`/khóa mã hóa được bảo vệ. Script `scripts/backup.sh` dành cho cấu hình MySQL đi kèm Docker, tạo file gzip và đặt quyền riêng; cần chuyển file sang nơi khác và thử phục hồi định kỳ. MySQL có sẵn trên host cần dùng công cụ backup của máy chủ đó.

```bash
bash scripts/backup.sh
```

Volume `mysql-data` tồn tại qua việc tạo lại container. Khi triển khai lại, giữ nguyên `.env` và volume. Mã nguồn không tự thay đổi mật khẩu của MySQL volume đã khởi tạo.

## 9. Kiểm thử

```bash
npm ci
npm test
npm run check
```

Các test mặc định dùng fixtures/mock HTTP, không gọi Sheets/MySQL production. Test Docker/MySQL riêng:

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test
docker compose -f docker-compose.test.yml down
```

Cụm test dùng database `datadongbo_test` trong tmpfs, không mount `.env` hay volume production, Google được giả lập. Bao gồm replay đồng thời, rollback nhiều thao tác, phiên bản cũ, timeout sau khi ghi Google, worker restart, ID không trùng và retention. Đây là lệnh cần chạy để xác nhận tích hợp MySQL; không coi unit test là bằng chứng đã thử database thật.

Nếu có DB test riêng: đặt `TEST_MYSQL_HOST`, `TEST_MYSQL_DATABASE` kết thúc `_test`, `TEST_MYSQL_USER`, `TEST_MYSQL_PASSWORD`, rồi `npm run test:mysql`. Bộ test yêu cầu database test chưa có tài nguyên.

## 10. Giới hạn và nghiệm thu trước chuyển đổi

- Đây là dịch vụ lưu trữ/đồng bộ, không thay thế xác thực, phân quyền, xử lý cân/duyệt/ra cổng của chấm công.
- Lấy mẫu dữ liệu cũ, so sánh ID, số kg/bao, liên kết phiếu trước khi cutover; chạy test MySQL Docker và thử Sheet **bản sao**.
- Import không tự đoán trạng thái hoàn tất của các dòng cũ. Các dòng thiếu `__dd_finalized_at` được giữ lại, không tự xóa sau 7 ngày.
- Lần nhập đầu không có snapshot giao dịch trên Google Sheets. Tạm dừng ghi/chỉnh tay nguồn khi import và đối chiếu xong rồi mới chuyển ứng dụng.
- Chưa có đo tốc độ production, chưa thể cam kết <2 giây. Luồng ghi API đã loại Sheets khỏi đường phản hồi nhưng cần đo với adapter backend và VPS thật.

Chi tiết kiểm chứng tại `docs/VERIFICATION.md`.

Tham khảo triển khai: [Google Sheets batchUpdate](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate), [ghi RAW](https://developers.google.com/workspace/sheets/api/samples/writing), [MySQL transaction durability](https://dev.mysql.com/doc/refman/8.4/en/optimizing-innodb-transaction-management.html).
