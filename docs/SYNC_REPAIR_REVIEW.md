# Rà soát đồng bộ DATADONGBO — 03/11/2026

Trạng thái: **87/87 test local đạt, syntax check đạt; còn giới hạn integration và concurrent edit ngoài hệ thống, chưa đủ cơ sở tuyên bố đáp ứng toàn bộ tiêu chí**. Không thực hiện truy vấn hay thay đổi dữ liệu production. Các số liệu 365 bản ghi pending và version gap 1127 là số liệu người dùng cung cấp, chưa được kiểm chứng trực tiếp.

## Nguyên nhân xác định từ source

- `src/sheets.js/writeRows`: trước đây chỉ kiểm tra ID ở vị trí đã lưu; khi sort/insert/delete hàng, vị trí không còn đúng và phát sinh `SHEET_ROW_MOVED`. Không có tra ID để phục hồi. Ô ID rỗng còn được chấp nhận cả với bản ghi đã xác nhận đồng bộ.
- `src/sync.js/syncEntity`, `tick`: một hàng sai làm hỏng batch, và lỗi entity đầu làm dừng các entity tiếp theo. Bản ghi dirty cũ được chọn lại trước; sync tự động không có cách cách ly xung đột theo bản ghi. Đây là đường gây tồn đọng trong source, chưa phải bằng chứng rằng toàn bộ pending production có cùng nguyên nhân.
- `src/chamCong.js/writeRows`, `src/records.js/mutate`: update tăng version ngay cả khi dữ liệu không đổi.
- Phía gọi `Cham_cong/backend/src/services/storage/sheetBusinessState.js/encodeStable`: ID là 24 ký tự đầu SHA-256 của key cộng `:<part>`, nội dung chia tối đa 40.000 UTF-16 code unit mỗi chunk. Mỗi lần encode sinh UUID Revision và CreatedAt mới, kể cả cùng giá trị. Vì vậy cần so sánh cả nhóm chunk đầy đủ, không chỉ so sánh toàn bộ JSON của từng hàng. Không sửa source Cham_cong trong đợt này.
- `src/db.js/migrate`: trước đây gọi `keepLatestState`, tự xóa revision ApplicationState khác revision mới nhất theo updated_at, rồi xóa mapping không còn records. Hành vi này có thể tạo khoảng trống mapping, nhưng không thể suy ra mọi khoảng trống đều do lỗi. Đã bỏ việc xóa tự động; không khôi phục hay sửa dữ liệu đã bị xóa trước đó.
- `src/app.js`: mọi exception không phải Fault đều có thể thành `SERVICE_UNAVAILABLE`; sự kiện cũ không chứa mã dependency nên chưa thể quy nguyên nhân cho MySQL, Sheets, timeout hay cấu hình. Chỉ bổ sung mã kết nối MySQL/network thuộc danh sách cho phép vào log; giữ phản hồi công khai hiện có, không log SQL, body hay credentials.

## Hành vi của bản sửa

1. Đọc cột ID của đúng tab để kiểm tra duy nhất; tìm thấy ID thì dùng vị trí thực. ID trùng, ID đã xác nhận nhưng bị thiếu, hay vị trí mới chứa dữ liệu khác đều được cách ly, không append, không ghi đè.
2. Đổi mapping trong transaction, khóa entity và row_map; dùng vị trí âm tạm thời cho các mapping thay đổi để hỗ trợ hoán đổi mà không vi phạm unique constraint. Thiếu/duplicate owner giữ nguyên mapping; nhóm va chạm bị cách ly, các nhóm độc lập tiếp tục. `next_row` chỉ tăng để bao phủ ID đã thấy.
3. Trước khi ghi vẫn đọc lại ID và metadata version. Không nhận kết quả đọc thiếu số range, không ghi đè metadata version mới hơn MySQL. Chỉ xác nhận phiên bản đã gửi sau HTTP thành công; phiên bản mới phát sinh trong lúc gửi vẫn dirty. Khi preflight phát hiện hàng sai, tách batch có giới hạn để chỉ cách ly hàng lỗi và xác nhận các hàng hợp lệ; không tách/retry ngay lỗi HTTP timeout hay quota.
4. `sync_record_failures` lưu version, số lần thử, mã lỗi và lịch thử tiếp theo. Lỗi tạm thời dùng exponential backoff và Retry-After, tối đa 8 lần cho cùng version. Xung đột không tự thử lại cùng version. Version mới được xét riêng; worker restart giữ lịch lỗi trong MySQL. Entity lỗi không ngăn các entity sau chạy.
5. Cùng dữ liệu và metadata CRUD thì giữ version; với nhóm ApplicationState stable ID đầy đủ, chỉ bỏ qua Revision/CreatedAt mới khi mọi nội dung chunk và metadata còn lại giữ nguyên, nhóm cũ có cùng Revision. Nhóm thiếu/đổi số phần/đổi nội dung vẫn cập nhật bình thường. Không reset dirty hay synced_version.

## Giới hạn quan trọng còn mở

Đọc ID rồi `values.batchUpdate` là hai request khác nhau. Bản sửa chưa bảo đảm chống người dùng hoặc writer ngoài hệ thống sort/chèn/xóa ngay giữa hai request. Khóa MySQL chỉ điều phối worker DataDongBo. Không được coi kiểm tra lại ID hoặc đọc sau ghi là bằng chứng rằng không ghi nhầm trong cửa sổ này. Google cũng lưu ý thay đổi của cộng tác viên có thể ảnh hưởng kết quả: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate.

Cần chốt cơ chế điều phối tất cả writer/khóa chỉnh sửa cấu trúc sheet, hoặc thiết kế định vị ghi phía server có điều kiện phù hợp, rồi kiểm thử trước khi tuyên bố đáp ứng tiêu chí race bên ngoài. Source hiện tại nhập Sheets khi bootstrap và xuất bản ghi dirty sau đó; không có vòng nhập thay đổi Sheets liên tục. Chưa thay đổi quy tắc nguồn dữ liệu nghiệp vụ này thành đồng bộ hai chiều liên tục.

Chưa có snapshot nội dung Sheets đã đồng bộ để nhận diện đầy đủ sửa tay cùng ID/cùng metadata version. Vì vậy trường hợp MySQL và Sheets sửa nội dung cùng lúc vẫn chưa được chứng minh an toàn.

## Kiểm thử và công cụ

Đã thêm test cho unique/moved/missing/duplicate IDs, retry sau mất ACK, hàng có nội dung nhưng thiếu ID, swap mapping, collision propagation, worker lock, bảo toàn lịch sử khi migrate, no-op ApplicationState và nhóm stable chunks. Fixture worker đã được cập nhật theo truy vấn chọn hàng mới.

Đã chạy thực tế sau khi Node/Git hoạt động trở lại:

- `node --test test/*.test.mjs`: **87 pass, 0 fail, 0 skip**.
- `node scripts/check.mjs`: **Syntax check passed**.
- `git diff --check`: đạt, chỉ có thông báo chuyển LF/CRLF của Git.
- Test hồi quy cách ly một hàng xung đột trong batch đã được chứng minh fail trước bản sửa bổ sung, rồi pass sau khi sửa.
- `node --test test/mysql.integration.mjs`: **1 skipped**, vì không có `TEST_MYSQL_HOST`; không coi đây là integration pass.
- Lượt chạy Docker do người dùng cung cấp trên VPS/MySQL 8.4.11: **1 fail**, tại assertion synced_version sau restart (0 thay vì 2). Test chỉ đưa job về hạn chạy, nhưng chưa đưa retry của record về hạn nên worker bỏ qua record đúng cơ chế backoff. Đã cập nhật `test/mysql.integration.mjs` để xác nhận restart giữ backoff, rồi đưa đúng receipt fixture đến hạn và kiểm tra ACK/xóa receipt. **Chưa có kết quả chạy lại MySQL của phiên bản test này.** Sau thay đổi, 87 test local và syntax check tiếp tục đạt.
- Docker không xuất hiện trong `Get-Command` ở môi trường này; chưa build image Docker hay chạy MySQL thật.
- `graphify update .` bị allowlist lean-ctx chặn; không chạy vòng qua hạn chế.

Các lệnh xác minh local, chạy từ thư mục DataDongBo:

```powershell
node scripts/check.mjs
node --test test/*.test.mjs
```

Không có script lint/bundle build riêng trong package.json. Integration MySQL phải dùng database mới có hậu tố `_test`; test có sẵn từ chối database chứa entity. Trên máy có Docker, chạy độc lập:

```powershell
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test
```

Cần bổ sung/chạy xác nhận thực tế đủ 15 tình huống trong yêu cầu, đặc biệt timeout ghi đã commit, restart, hai worker thật, cập nhật mới trong lúc ghi, concurrent edit ngoài worker và đủ nhóm ApplicationState nhiều chunk. Chưa có test Google Sheets thật và chưa chứng minh không mất dữ liệu production.

## Migration, backup, rollback và triển khai

Migration chỉ thêm bảng `sync_record_failures`; không sửa bảng nghiệp vụ, không reset trạng thái, không xóa/rebuild row_map. Bảng mới cần thiết để backoff/cách ly tồn tại qua restart. Hãy sao lưu MySQL nhất quán và lưu bản sao Google spreadsheet trước mọi triển khai. Giữ dump, bản sao sheet và image tag cũ ở nơi riêng, bảo vệ quyền truy cập; kiểm tra phục hồi trong môi trường test.

Chỉ triển khai sau khi hết các giới hạn an toàn và kiểm thử phía trên. Dùng đúng các file Compose của hệ thống đang chạy; dừng worker trước, build API và worker cùng source, chạy migration khi API khởi động, xác nhận API healthy rồi mới bật worker. Không dùng `down -v`, không xóa volume, không chạy import lại entity ready.

Theo dõi dirty/synced_version, sync_runs, jobs needs_review và sync_record_failures. Dùng truy vấn chỉ đọc phân loại từng entity: chưa xác nhận (`synced_version=0`) và cập nhật tồn đọng (`version>synced_version>0`); kiểm tra từng ID trên Sheet trước khi quyết định phục hồi. Khoảng trống mapping tự nó không chứng minh mất dữ liệu.

Với record needs_review: xử lý nguyên nhân trên bản sao trước; xác minh ID duy nhất, nội dung, mapping và version trên production theo quy trình vận hành. Chỉ xóa đúng receipt `sync_record_failures` của entity/id/version đã được duyệt để cho thử lại; không đổi version/synced_version/dirty. Không xóa hàng loạt receipt lỗi.

Rollback: dừng worker; ưu tiên image an toàn đã vô hiệu hóa startup pruning. **Không khởi động nguyên bản code cũ có `keepLatestState`**, vì rollback đó sẽ lại xóa lịch sử ApplicationState. Giữ nguyên bảng sync_record_failures và dữ liệu nghiệp vụ. Việc remap đã commit không cần đảo hàng loạt; chỉ phục hồi có mục tiêu từ backup sau khi đối chiếu Sheet. Không khôi phục toàn DB đè lên giao dịch mới mà chưa có kế hoạch hợp nhất.
