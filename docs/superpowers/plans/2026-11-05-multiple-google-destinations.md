# Multiple Google Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Continue Sheets writes on configured fallback files and manage durable, visible Drive credentials used by ChamCong and HDoi.

**Architecture:** Keep logical record/source IDs stable; store physical Sheet locations separately. Encrypt Drive registry/assignments in DataDongBo and persist acquired configurations in each consumer's durable storage. Preserve existing destination/credential ownership and fail closed on ambiguous writes.

**Tech Stack:** Existing Node.js, Express, MySQL, vanilla browser UI and Google APIs; no new dependencies.

**Spec:** ../specs/2026-11-05-multiple-google-destinations-design.md

## Global Constraints

- Partition Sheets data; do not mirror full data.
- Never poll Drive secrets or expose them in frontend responses/logs.
- Preserve existing dirty changes and all historical data.
- Acquire only when needed; persist across restart and coalesce requests.
- No production deployment or live data migration.

## Review Focus

- Partial/ambiguous upload cannot create duplicates during failover.
- Old-file reads/updates retain their physical file and credential identity.
- Concurrent quota errors cannot skip multiple credentials.
- Missing fields in legacy settings must preserve configured fallback lists.
- Browser/anonymous/read-only principals must never acquire secrets.

### Task 1: Sheets destinations and rollover
Files: src/sync.js, src/sheets.js, src/sheetDestinations.js, sql/schema.sql, src/db.js; archive/schema/source adapters as required; focused tests.
- [x] Add failing tests for physical location persistence, capacity-only rollover, retry and old-record updates.
- [x] Add backwards-compatible destination/location tables and migration under the existing migration lock.
- [x] Route per-file sync groups without changing logical row_map ordering.
- [x] Run npm test and check restart/failure behavior.

### Task 2: Drive registry
Files: src/driveCredentials.js, sql/drive-credentials.sql, focused tests.
- [x] Test masked administrative CRUD, authenticated secret acquisition, concurrency/idempotency and invalid classifications.
- [x] Implement mountDriveCredentials(app,pool,config,options) and encrypted revisioned registry/assignment transactions.
- [x] GET/PUT /admin/drive-credentials; POST /admin/drive-credentials/:id/test.
- [x] POST /v1/drive-credentials/acquire takes consumer,currentId,reason,requestId and returns credential,version,issuedAt.
- [x] Verify no secret leakage and no repeated rotation for stale currentId.

### Task 3: Drive consumers
Files: ChamCong backend uploads/report services, shared durable credential helper, status endpoint/UI; HDoi Drive worker and durable encrypted credential helper; tests.
- [x] Test acquire-once, persistence, single-flight, quota classification and old-file ownership.
- [x] Integrate durable storage and credential-aware upload/read/delete in both clients.
- [x] Add safe local active-credential status for administrator inspection.
- [x] Verify no per-operation broker polling and no duplicate ambiguous upload.

### Task 4: Administration and settings integration
Files: src/core.js, src/settings.js, src/app.js, public/index.html, public/app.js, public/google-settings.js, public/styles.css; UI/API tests.
- [x] Validate and preserve fallback settings; prohibit duplicate destinations and unsafe removal.
- [x] Add ordered file editor and per-file test/status.
- [x] Mount credential broker and add masked credential editor/consumer status/history with explicit refresh.
- [x] Run browser/API tests, relevant existing suites and frontend build; update project graph where required.
