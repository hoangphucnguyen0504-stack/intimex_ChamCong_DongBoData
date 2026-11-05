# MySQL Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Password-confirmed rolling and bulk MySQL cleanup with unchanged Sheets and complete archive reads.
**Architecture:** Revisioned policy + expiring snapshot previews + durable cleanup jobs. The worker verifies immutable versions and Sheets acknowledgement before transactional payload deletion, preserving permanent mappings and idempotency metadata. Browser presents preview, password dialog, scheduling and progress; no password persistence.
**Tech Stack:** Existing Node/Express, MySQL, vanilla JS and existing Sheets client; no new dependencies.
**Spec:** ../specs/2026-11-05-mysql-retention-design.md

## Global Constraints
- Automatic cleanup defaults off; no production data touched during implementation.
- Password verification/rate limiting on server; CSRF/admin checks on all writes.
- Never send Sheets writes/deletes from cleanup; preserve maps/guards/receipts.
- Protected resources cannot be bypassed with forged entity names.
- Archive outages/missing versions must fail closed rather than authorize deletion or incomplete reads.

## Review Focus
- Candidate changed after preview, sync pending or active business state: skip safely.
- Restart/duplicate submit: one durable job, no scope expansion.
- Password wrong/missing, CSRF absent, repeated failures: no job/config changes.
- Vietnam schedule across UTC day boundaries and sync disabled: one due run.
- Archived rows spread over fallback files: exact identity/version, stable merged pagination.

### Task 1: Retention backend and worker
Files: src/retention.js, sql/retention.sql, src/db.js, src/sync.js; focused unit tests.
- [ ] Add policy validation, protections, server password rate limiter and safe admin routes.
- [ ] Add bounded preview snapshot, idempotent job creation, batch verification/deletion/audit.
- [ ] Replace uncontrolled legacy payload cleanup with explicitly scheduled password-authorized jobs.
- [ ] Verify schedule, concurrent edits, restart and no Sheet mutations.

### Task 2: Complete archive reads
Files: src/archivedHistory.js, src/chamCong.js, src/archive.js, src/records.js, readonly integration as required; Cham adapter and tests.
- [ ] Read mapped archive rows in batches from correct file/tab with verification.
- [ ] Merge archived/live history without duplicating or omitting records; preserve cursor/filter semantics.
- [ ] Advertise capability and allow retained entities only when compatible.
- [ ] Test pagination, protected scopes, corruption and outages.

### Task 3: Admin tab and integration
Files: src/app.js, public/retention.js, public/index.html, public/app.js, public/styles.css; browser/API tests and docs.
- [ ] Build auto policy, manual filters, preview and password confirmation dialog.
- [ ] Invalidate previews on selection change; clear password after cancel/submit/logout.
- [ ] Show durable progress/history and poll only active jobs while tab visible.
- [ ] Mount secured routes, verify policy cannot bypass protections through old resource form.
- [ ] Run relevant suites, build, graph update and document deployment behavior/limits.
