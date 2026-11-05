import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAdminPassword,
  assertEntity,
  isProtectedEntity,
  computeNextRun,
  previewCleanup,
  createCleanupJob,
  runJobBatch,
  runAutoPolicies,
  resetRetentionRateLimit
} from '../src/retention.js';
import {passwordHash} from '../src/core.js';

const config = {
  ADMIN_PASSWORD_HASH: passwordHash('secret123')
};

test('protected entities cannot be cleaned or selected', () => {
  assert.equal(isProtectedEntity('Users'), true);
  assert.equal(isProtectedEntity('admins'), true);
  assert.equal(isProtectedEntity('Settings'), true);
  assert.equal(isProtectedEntity('ReferenceData'), true);
  assert.equal(isProtectedEntity('ApplicationState'), true);
  assert.equal(isProtectedEntity('row_map'), true);
  assert.equal(isProtectedEntity('Attendance'), false);
  assert.equal(isProtectedEntity('VehicleTrips'), false);

  assert.throws(() => assertEntity('Users'), {code: 'ENTITY_PROTECTED'});
  assert.throws(() => assertEntity('ReferenceData'), {code: 'ENTITY_PROTECTED'});
  assert.doesNotThrow(() => assertEntity('Attendance'));
});

test('admin password verification validates correct password and rate limits brute force', () => {
  resetRetentionRateLimit();
  assert.doesNotThrow(() => verifyAdminPassword(config, '127.0.0.1', 'secret123'));
  assert.throws(() => verifyAdminPassword(config, '127.0.0.1', 'wrong'), {code: 'PASSWORD_WRONG'});
  assert.throws(() => verifyAdminPassword(config, '127.0.0.1', ''), {code: 'PASSWORD_INVALID'});

  // Trigger rate limit: 5 failed attempts, 6th attempt is blocked
  for (let i = 0; i < 5; i++) {
    try { verifyAdminPassword(config, '10.0.0.99', 'wrong'); } catch {}
  }
  assert.throws(() => verifyAdminPassword(config, '10.0.0.99', 'secret123'), {code: 'RETENTION_RATE_LIMIT'});
  resetRetentionRateLimit();
});

test('computeNextRun calculates correct UTC timestamp for Vietnam HH:MM', () => {
  const base = new Date('2026-11-05T03:00:00.000Z'); // 10:00 VN
  // 15:00 VN today -> 08:00 UTC today
  const next15 = computeNextRun('15:00', base);
  assert.equal(next15.toISOString(), '2026-11-05T08:00:00.000Z');

  // 08:00 VN (already passed today at 10:00 VN) -> 08:00 VN tomorrow -> 01:00 UTC tomorrow
  const next08 = computeNextRun('08:00', base);
  assert.equal(next08.toISOString(), '2026-11-06T01:00:00.000Z');
});

test('previewCleanup creates snapshot with eligible and skipped counts', async () => {
  const queries = [];
  const pool = {
    query: async (sql, args = []) => {
      queries.push({sql, args});
      if (sql.includes('SELECT COUNT(*) eligible')) return [[{eligible: 42}]];
      if (sql.includes('SELECT COUNT(*) total')) return [[{total: 50}]];
      if (sql.startsWith('INSERT INTO retention_previews')) return [{affectedRows: 1}];
      return [[]];
    }
  };

  const preview = await previewCleanup(pool, {
    entity: 'Attendance',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31'
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.eligibleCount, 42);
  assert.equal(preview.skippedCount, 8);
  assert.ok(preview.previewId);
  assert.ok(preview.expiresAt);
});

test('createCleanupJob requires valid matching preview and invalidates it', async () => {
  let previewDeleted = false;
  const pool = {
    query: async (sql, args = []) => {
      if (sql.startsWith('SELECT * FROM retention_previews')) {
        return [[{
          id: 'prev-1',
          entity: 'Attendance',
          entities: null,
          date_from: '2026-10-01',
          date_to: '2026-10-31',
          eligible_count: 42
        }]];
      }
      if (sql.startsWith('DELETE FROM retention_previews')) {
        previewDeleted = true;
        return [{affectedRows: 1}];
      }
      if (sql.startsWith('INSERT INTO retention_jobs')) return [{affectedRows: 1}];
      return [[]];
    }
  };

  const job = await createCleanupJob(pool, {
    previewId: 'prev-1',
    entity: 'Attendance',
    dateFrom: '2026-10-01',
    dateTo: '2026-10-31'
  });

  assert.equal(job.ok, true);
  assert.ok(job.jobId);
  assert.equal(previewDeleted, true);
});

test('runJobBatch deletes eligible records, preserves row_map and updates progress', async () => {
  let rowMapUpdated = false;
  let recordsDeleted = false;
  let jobUpdated = false;

  const mockRecords = [
    {entity: 'Attendance', id: 'ATT-1'}
  ];

  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT * FROM retention_jobs')) {
        return [[{
          id: 'job-1',
          entity: 'Attendance',
          entities: null,
          state: 'pending',
          deleted_count: 0,
          skipped_count: 0,
          batch_cursor: null
        }]];
      }
      if (sql.includes('UPDATE retention_jobs SET state=\'running\'')) return [{affectedRows: 1}];
      if (sql.includes('SELECT r.entity, r.id FROM records')) return [mockRecords];
      if (sql.includes('UPDATE retention_jobs SET deleted_count=')) {
        jobUpdated = true;
        return [{affectedRows: 1}];
      }
      return [[]];
    },
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: async (sql, args = []) => {
        if (sql.includes('SELECT id FROM records WHERE')) return [[{id: 'ATT-1'}]];
        if (sql.includes('UPDATE row_map SET archived_at=')) {
          rowMapUpdated = true;
          return [{affectedRows: 1}];
        }
        if (sql.includes('DELETE FROM records WHERE')) {
          recordsDeleted = true;
          return [{affectedRows: 1}];
        }
        return [[]];
      }
    })
  };

  const batch = await runJobBatch(pool, 'job-1', 10);
  assert.equal(batch.done, false);
  assert.equal(batch.batchDeleted, 1);
  assert.equal(rowMapUpdated, true);
  assert.equal(recordsDeleted, true);
  assert.equal(jobUpdated, true);
});
