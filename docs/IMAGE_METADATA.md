# ChamCong image metadata API

Run `npm run setup` before enabling HDoi image synchronization. The existing migration lock and schema migration create `image_metadata` and `image_links` idempotently. No existing business rows are changed. Both tables contain metadata only, never image bytes, base64, temporary URLs, filesystem paths or service credentials.

Both endpoints require the existing `Authorization: Bearer <API_TOKEN>` service credential, accept JSON bodies up to 16 KiB, and reject unknown fields. Browser cookies do not grant integration access.

## Metadata

`POST /v1/cham-cong/images/upsert`

```json
{
  "namespace": "cham-cong",
  "imageId": "0123456789abcdef0123456789abcdef",
  "version": 3,
  "state": "COMPLETED",
  "driveFileId": "example_drive_file_id",
  "mime": "image/jpeg",
  "size": 12345,
  "checksum": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "verifiedAt": "2026-10-22T10:00:00.000Z",
  "updatedAt": "2026-10-22T10:00:01.000Z"
}
```

`checksum` is the lowercase SHA-256 of the original bytes. Size must be 1–50 MiB. Allowed states are `HOLD`, `UPLOADING`, `RETRY`, `FAILED`, `COMPLETED`; supported media types are JPEG, PNG, WebP. Non-completed metadata may have a reserved Drive ID, but must have null `verifiedAt`. Completion requires both Drive ID and verification timestamp; later state regression is rejected.

## Business link

`POST /v1/cham-cong/images/link`

```json
{
  "namespace": "cham-cong",
  "imageId": "0123456789abcdef0123456789abcdef",
  "entity": "VehicleTrips",
  "recordId": "trip-example",
  "field": "PhotoIn",
  "slot": 0,
  "version": 1,
  "updatedAt": "2026-10-22T10:00:02.000Z"
}
```

Send only after the business operation has been durably accepted. Link version is monotonic for the business slot `(namespace, entity, recordId, field, slot)`, independent of image-state version. Replacing the image in a slot requires a higher link version. Other slots are unaffected. Metadata and links are independent and persist in either arrival order, including when the business record has not reached this service yet. No callback rewrites business JSON.

Responses are `{ "ok": true, "applied": true, "version": 3 }`. Older deliveries and identical retries return `applied: false` and the stored version. A conflicting payload at the same version returns HTTP 409 `IMAGE_VERSION_CONFLICT`; do not mutate timestamps when retrying the same event. Versions are positive safe integers. Invalid payloads return 400; oversized payloads 413; invalid token 401.

Tests use transaction-aware in-memory fixtures and the real HTTP middleware. Run `node --test test/images.test.mjs`; real MySQL durability/concurrency and deployed integration require the target environment and are not implied by these unit tests.
