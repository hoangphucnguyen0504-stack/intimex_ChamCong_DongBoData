# Địa chỉ public và Google Sheets

## Đã chuẩn bị trong mã/cấu hình

- Public origin: `https://datadongbo.157.66.219.11.sslip.io`; cookie HTTPS bật.
- `.env` dùng Spreadsheet ID và Service Account lấy trực tiếp từ `Cham_cong/backend/.env.vercel`, không in hoặc đưa vào git.
- API/worker seed cấu hình Google vào MySQL ở lần đầu; dữ liệu cấu hình được mã hóa. Giao diện vẫn chỉnh được cấu hình sau đó.
- `config/cham-cong-entities.json`: 17 tài nguyên, lấy tên cột thực tế bằng Sheets API chỉ đọc; bỏ tab trống `Trang tính1`. Chưa đọc các dòng nghiệp vụ, chưa ghi/xóa Google Sheets.
- Tài nguyên vận hành chính được đề xuất retention 7 ngày; chỉ dọn khi finalized và sync thành công. Tài nguyên danh mục/tài khoản/kỹ thuật mặc định giữ vĩnh viễn.
- Đồng bộ tự động mặc định tắt để không sửa Sheet đang dùng trước khi chuyển nguồn dữ liệu.

## VPS đang dùng Caddy trong HDoi

Không tạo Caddy thứ hai chiếm cổng 80/443. Tại thư mục DataDongBo trên VPS, kiểm tra tên network:

```bash
docker network ls
```

Trong `.env`, `CADDY_DOCKER_NETWORK=hdoi_default` phải là network mà container `proxy` của HDoi đang tham gia. Nếu tên khác, chỉnh cho đúng.

Khởi động DataDongBo và nối API vào cùng network:

```bash
cd /opt/datadongbo
docker compose -f docker-compose.yml -f docker-compose.hdoi-proxy.yml up -d --build
```

Nếu dùng MySQL sẵn có, thay `docker-compose.yml` trong lệnh bằng `docker-compose.external.yml`.

**Thêm** block sau vào `/opt/hdoi/deploy/Caddyfile`, giữ nguyên block HDoi đang chạy:

```caddyfile
datadongbo.157.66.219.11.sslip.io {
    encode zstd gzip
    reverse_proxy datadongbo-api:3200
}
```

Block có sẵn tại `deploy/Caddyfile.docker`. Không dùng `127.0.0.1:3200` bên trong container Caddy. Kiểm tra và reload từ thư mục HDoi:

```bash
cd /opt/hdoi
docker compose -f docker-compose.yml -f docker-compose.https.yml exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose -f docker-compose.yml -f docker-compose.https.yml exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Nếu Caddy chạy trực tiếp trên host (không phải Docker), dùng block trong `deploy/Caddyfile` với upstream `127.0.0.1:3200`, rồi validate/reload Caddy trên host.

Sau đó kiểm tra:

```bash
curl -f https://datadongbo.157.66.219.11.sslip.io/health/ready
```

Phải trả HTTP 200 và `{"ok":true}` trước khi kết nối backend chấm công.

## Nạp cấu hình và nhập dữ liệu

Với MySQL mới, cấu hình Google và danh sách tài nguyên được nạp ở lần boot đầu. Nếu database đã có cấu hình UI trước đó và muốn áp dụng cấu hình env đã chuẩn bị:

```bash
cd /opt/datadongbo
docker compose exec -T api node scripts/apply-google-env.mjs
```

Lệnh không import/ghi Google; không cho đổi Sheet đích khi đã có dữ liệu row-map.

1. Mở địa chỉ public, đăng nhập admin.
2. Vào Cấu hình đồng bộ → Kiểm tra kết nối đã lưu.
3. Kiểm tra 17 tài nguyên được seed, điều chỉnh retention nếu cần.
4. Dừng ghi/chỉnh tay Sheet nguồn trong lúc chuyển đổi; vào Tài nguyên dữ liệu → Nhập từ Sheets.
5. Đối chiếu dữ liệu và tích hợp adapter backend chấm công trước khi bật đồng bộ tự động.

Không chạy tác vụ import trên nguồn đang thay đổi nếu cần một ảnh chụp dữ liệu nhất quán. Trong bản này, import thêm bốn cột kỹ thuật vào cuối tab. Việc kiểm tra credential/header đã thực hiện chỉ đọc; chưa kích hoạt bước đó trên Google thật.

## Kết quả kiểm tra ngày 19/10/2026

- Credential đọc được metadata Google Sheets, 18 tab; lấy header của 17 tab nghiệp vụ/kỹ thuật bằng batchGet.
- DNS hostname public trả IP `157.66.219.11`.
- GET HTTPS `/health/ready` từ môi trường kiểm tra thất bại TLS: `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR`. Chưa có bằng chứng dịch vụ DataDongBo đang hoạt động qua HTTPS trên VPS.
- Chưa thay cấu hình Caddy hoặc chạy container trên VPS từ phiên này; các file cần triển khai đã được chuẩn bị ở máy cá nhân.
