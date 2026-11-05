import {randomUUID} from 'node:crypto';
import {Fault, passwordMatches, json} from './core.js';
import {transaction} from './db.js';

// Entities whose records must never be deleted through retention
const PROTECTED_ENTITIES = new Set([
  'settings','sessions','login_limits','record_guards','requests',
  'runtime_state','jobs','sync_runs','sync_record_failures',
  'business_schemas','image_metadata','image_links','client_request_logs',
  'sheet_destination_state','sheet_locations','row_map','entities',
  'retention_policies','retention_previews','retention_jobs','retention_audit',
  'users','admins','applicationstate','referencedata'
]);

export function isProtectedEntity(entity) {
  if (!entity || typeof entity !== 'string') return false;
  return PROTECTED_ENTITIES.has(entity.trim().toLowerCase());
}

export function assertEntity(entity) {
  if (isProtectedEntity(entity)) {
    throw new Fault(403, 'ENTITY_PROTECTED', `Tài nguyên "${entity}" được bảo vệ, không thể dọn.`);
  }
}

// Rate limiting for password verification (separate from login)
const retentionAttempts = new Map(); // ip -> {hits, resetAt}

export function resetRetentionRateLimit(ip) {
  if (ip) retentionAttempts.delete(ip);
  else retentionAttempts.clear();
}

function checkRetentionRateLimit(ip) {
  const now = Date.now();
  let r = retentionAttempts.get(ip);
  if (!r || r.resetAt < now) r = {hits: 0, resetAt: now + 5 * 60 * 1000};
  r.hits++;
  retentionAttempts.set(ip, r);
  if (r.hits > 5) throw new Fault(429, 'RETENTION_RATE_LIMIT', 'Nhập sai quá nhiều lần. Thử lại sau 5 phút.');
}

// Verify admin password (re-entry required; never stored)
export function verifyAdminPassword(config, ip, password) {
  checkRetentionRateLimit(ip);
  if (typeof password !== 'string' || !password || password.length > 200) {
    throw new Fault(401, 'PASSWORD_INVALID', 'Mật khẩu quản trị không hợp lệ.');
  }
  if (!passwordMatches(password, config.ADMIN_PASSWORD_HASH)) {
    throw new Fault(401, 'PASSWORD_WRONG', 'Mật khẩu quản trị không đúng. Vui lòng nhập lại.');
  }
}

// Compute next Vietnam-time occurrence of HH:MM
export function computeNextRun(scheduleHhmm, now = new Date()) {
  if (!/^\d{2}:\d{2}$/.test(scheduleHhmm)) throw new Fault(400, 'INVALID_SCHEDULE', 'Giờ phải định dạng HH:MM.');
  const [hh, mm] = scheduleHhmm.split(':').map(Number);
  if (hh > 23 || mm > 59) throw new Fault(400, 'INVALID_SCHEDULE', 'Giờ hoặc phút không hợp lệ.');

  // Vietnam is strictly UTC+7 all year (no DST)
  const vnOffsetMs = 7 * 60 * 60 * 1000;
  const vnTime = new Date(now.getTime() + vnOffsetMs);
  const vnYear = vnTime.getUTCFullYear();
  const vnMonth = vnTime.getUTCMonth();
  const vnDate = vnTime.getUTCDate();

  let runUtc = new Date(Date.UTC(vnYear, vnMonth, vnDate, hh - 7, mm, 0, 0));
  if (runUtc <= now) {
    runUtc = new Date(Date.UTC(vnYear, vnMonth, vnDate + 1, hh - 7, mm, 0, 0));
  }
  return runUtc;
}

// Get all retention policies
export async function listPolicies(pool) {
  const [rows] = await pool.query('SELECT * FROM retention_policies ORDER BY id');
  return rows;
}

// Get list of eligible entities that can have retention applied
export async function listEligibleEntities(pool) {
  const [rows] = await pool.query('SELECT name FROM entities ORDER BY name');
  return rows.map(r => r.name).filter(name => !isProtectedEntity(name));
}

// Save/upsert a policy (requires password already verified)
export async function savePolicy(pool, {entity, retentionDays, scheduleHhmm, enabled}) {
  if (entity) assertEntity(entity);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Fault(400, 'INVALID_RETENTION_DAYS', 'Số ngày giữ lại từ 1–3650.');
  }
  const nextRun = computeNextRun(scheduleHhmm);
  // MySQL UNIQUE permits multiple NULLs: explicitly update the existing global policy.
  const [[existing]] = await pool.query('SELECT * FROM retention_policies WHERE entity <=> ?', [entity || null]);
  if (existing) {
    await pool.query(
      'UPDATE retention_policies SET retention_days=?, schedule_hhmm=?, enabled=?, next_run_at=? WHERE entity <=> ?',
      [retentionDays, scheduleHhmm, enabled ? 1 : 0, nextRun, entity || null]
    );
  } else {
  await pool.query(
    `INSERT INTO retention_policies (entity, retention_days, schedule_hhmm, enabled, next_run_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE retention_days=VALUES(retention_days),
       schedule_hhmm=VALUES(schedule_hhmm), enabled=VALUES(enabled), next_run_at=VALUES(next_run_at)`,
    [entity || null, retentionDays, scheduleHhmm, enabled ? 1 : 0, nextRun]
  );
  }
  const [[p]] = await pool.query('SELECT * FROM retention_policies WHERE entity <=> ?', [entity || null]);
  await pool.query(
    'INSERT INTO retention_audit(policy_id,entity,record_count,action) VALUES(?,?,0,?)',
    [p.id, entity || '__all__', 'policy_save']
  );
  return {ok: true, policy: p};
}

// Parse and validate entities selection
function normalizeEntities(entity, entities) {
  let list = [];
  if (Array.isArray(entities)) {
    list = entities.map(e => String(e).trim()).filter(Boolean);
  } else if (entity && typeof entity === 'string') {
    list = [entity.trim()];
  }
  for (const name of list) {
    assertEntity(name);
  }
  return list;
}

// Build the WHERE conditions for eligible records (safe for deletion)
function eligibleWhere(entityList, dateFrom, dateTo) {
  const args = [];
  const conds = [
    'r.dirty = 0',
    'r.synced_version = r.version',
    'r.finalized_at IS NOT NULL',
  ];
  if (entityList && entityList.length === 1) {
    conds.push('r.entity = ?');
    args.push(entityList[0]);
  } else if (entityList && entityList.length > 1) {
    conds.push(`r.entity IN (${entityList.map(() => '?').join(',')})`);
    args.push(...entityList);
  } else {
    // All entities, excluding protected ones
    conds.push(`LOWER(r.entity) NOT IN (${[...PROTECTED_ENTITIES].map(() => '?').join(',')})`);
    args.push(...PROTECTED_ENTITIES);
  }
  if (dateFrom) {
    const dFrom = new Date(dateFrom);
    if (!Number.isFinite(+dFrom)) throw new Fault(400, 'INVALID_DATE', 'Ngày bắt đầu không hợp lệ.');
    conds.push('r.business_at >= ?');
    args.push(dFrom);
  }
  if (dateTo) {
    const dTo = new Date(dateTo + (dateTo.includes('T') ? '' : 'T23:59:59.999Z'));
    if (!Number.isFinite(+dTo)) throw new Fault(400, 'INVALID_DATE', 'Ngày kết thúc không hợp lệ.');
    conds.push('r.business_at <= ?');
    args.push(dTo);
  }
  return {where: conds.join(' AND '), args};
}

// Count eligible vs ineligible (skipped) records for preview
export async function previewCleanup(pool, {entity, entities, dateFrom, dateTo}) {
  const entityList = normalizeEntities(entity, entities);
  const {where, args} = eligibleWhere(entityList, dateFrom, dateTo);

  const [[{eligible}]] = await pool.query(
    `SELECT COUNT(*) eligible FROM records r WHERE ${where}`, args
  );

  // Count total records in range
  const rangeConds = ['1=1'];
  const rangeArgs = [];
  if (entityList && entityList.length === 1) {
    rangeConds.push('entity = ?');
    rangeArgs.push(entityList[0]);
  } else if (entityList && entityList.length > 1) {
    rangeConds.push(`entity IN (${entityList.map(() => '?').join(',')})`);
    rangeArgs.push(...entityList);
  } else {
    rangeConds.push(`LOWER(entity) NOT IN (${[...PROTECTED_ENTITIES].map(() => '?').join(',')})`);
    rangeArgs.push(...PROTECTED_ENTITIES);
  }
  if (dateFrom) {
    rangeConds.push('business_at >= ?');
    rangeArgs.push(new Date(dateFrom));
  }
  if (dateTo) {
    rangeConds.push('business_at <= ?');
    rangeArgs.push(new Date(dateTo + (dateTo.includes('T') ? '' : 'T23:59:59.999Z')));
  }

  const [[{total}]] = await pool.query(
    `SELECT COUNT(*) total FROM records WHERE ${rangeConds.join(' AND ')}`, rangeArgs
  );

  const eligibleCount = Number(eligible);
  const skippedCount = Math.max(0, Number(total) - eligibleCount);

  // Create expiring snapshot (valid for 10 minutes)
  const id = randomUUID();
  const primaryEntity = entityList.length === 1 ? entityList[0] : null;
  const entitiesJson = entityList.length > 1 ? JSON.stringify(entityList) : null;

  await pool.query(
    'INSERT INTO retention_previews(id,entity,entities,date_from,date_to,eligible_count,skipped_count,expires_at) VALUES(?,?,?,?,?,?,?,UTC_TIMESTAMP(3)+INTERVAL 10 MINUTE)',
    [id, primaryEntity, entitiesJson, dateFrom || null, dateTo || null, eligibleCount, skippedCount]
  );

  return {
    ok: true,
    previewId: id,
    eligibleCount,
    skippedCount,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  };
}

// Create a durable manual cleanup job (requires valid non-expired preview)
export async function createCleanupJob(pool, {previewId, entity, entities, dateFrom, dateTo}) {
  const entityList = normalizeEntities(entity, entities);
  const [[preview]] = await pool.query(
    'SELECT * FROM retention_previews WHERE id=? AND expires_at > UTC_TIMESTAMP(3)', [previewId]
  );
  if (!preview) throw new Fault(410, 'PREVIEW_EXPIRED', 'Bản xem trước đã hết hạn. Vui lòng xem trước lại.');

  // Validate selection matches preview
  const previewEntities = preview.entities ? json(preview.entities) : (preview.entity ? [preview.entity] : []);
  const normalizedSelection = entityList.slice().sort();
  const normalizedPreview = previewEntities.slice().sort();

  if (JSON.stringify(normalizedSelection) !== JSON.stringify(normalizedPreview) ||
      (preview.date_from ? new Date(preview.date_from).toISOString().slice(0, 10) : null) !== (dateFrom || null) ||
      (preview.date_to ? new Date(preview.date_to).toISOString().slice(0, 10) : null) !== (dateTo || null)) {
    throw new Fault(409, 'PREVIEW_MISMATCH', 'Lựa chọn không khớp với bản xem trước.');
  }

  const id = randomUUID();
  const primaryEntity = entityList.length === 1 ? entityList[0] : null;
  const entitiesJson = entityList.length > 1 ? JSON.stringify(entityList) : null;

  await pool.query(
    'INSERT INTO retention_jobs(id,preview_id,entity,entities,date_from,date_to,total_count,state) VALUES(?,?,?,?,?,?,?,?)',
    [id, previewId, primaryEntity, entitiesJson, dateFrom || null, dateTo || null, preview.eligible_count, 'pending']
  );

  // Invalidate preview so it cannot be reused
  await pool.query('DELETE FROM retention_previews WHERE id=?', [previewId]);
  return {ok: true, jobId: id};
}

// Get job status
export async function getJob(pool, jobId) {
  const [[job]] = await pool.query('SELECT * FROM retention_jobs WHERE id=?', [jobId]);
  if (!job) throw new Fault(404, 'JOB_NOT_FOUND', 'Không tìm thấy tác vụ dọn dẹp.');
  return {ok: true, job};
}

// List recent jobs and audit
export async function listJobs(pool, limit = 20) {
  const [jobs] = await pool.query('SELECT * FROM retention_jobs ORDER BY created_at DESC LIMIT ?', [Math.min(50, limit)]);
  const [audit] = await pool.query('SELECT * FROM retention_audit ORDER BY id DESC LIMIT 50');
  return {ok: true, jobs, audit};
}

// Execute one batch of a manual cleanup job (call repeatedly until done)
export async function runJobBatch(pool, jobId, batchSize = 100) {
  const [[job]] = await pool.query(
    'SELECT * FROM retention_jobs WHERE id=? AND state IN (?,?)', [jobId, 'pending', 'running']
  );
  if (!job) return {done: true};
  if (job.state === 'pending') {
    await pool.query("UPDATE retention_jobs SET state='running' WHERE id=?", [jobId]);
  }

  const entityList = job.entities ? json(job.entities) : (job.entity ? [job.entity] : []);
  for (const name of entityList) assertEntity(name);

  const {where, args} = eligibleWhere(entityList, job.date_from, job.date_to);
  const cursorCond = job.batch_cursor ? ' AND (r.entity > ? OR (r.entity = ? AND r.id > ?))' : '';
  let cursorArgs = [];
  if (job.batch_cursor) {
    const [cEntity, cId] = job.batch_cursor.split('\0');
    cursorArgs = [cEntity, cEntity, cId || ''];
  }

  const [rows] = await pool.query(
    `SELECT r.entity, r.id FROM records r WHERE ${where}${cursorCond} ORDER BY r.entity, r.id LIMIT ?`,
    [...args, ...cursorArgs, batchSize]
  );

  if (!rows.length) {
    await pool.query(
      "UPDATE retention_jobs SET state='success', finished_at=UTC_TIMESTAMP(3) WHERE id=?", [jobId]
    );
    const auditEntityLabel = entityList.length === 1 ? entityList[0] : (entityList.length > 1 ? entityList.join(', ') : '__all__');
    await pool.query(
      'INSERT INTO retention_audit(job_id,entity,record_count,action) VALUES(?,?,?,?)',
      [jobId, auditEntityLabel, job.deleted_count, 'manual_cleanup']
    );
    return {done: true, deletedCount: job.deleted_count, skippedCount: job.skipped_count};
  }

  let deleted = 0;
  await transaction(pool, async db => {
    for (const row of rows) {
      // Re-verify eligibility at execution time transactionally
      const [[r]] = await db.query(
        'SELECT id FROM records WHERE entity=? AND id=? AND dirty=0 AND synced_version=version AND finalized_at IS NOT NULL FOR UPDATE',
        [row.entity, row.id]
      );
      if (!r) continue; // Ineligible; skip safely

      // Preserve row_map and physical locations (do NOT delete - needed for archive history reads)
      await db.query(
        'UPDATE row_map SET archived_at=UTC_TIMESTAMP(3) WHERE entity=? AND id=? AND archived_at IS NULL',
        [row.entity, row.id]
      );
      await db.query('DELETE FROM records WHERE entity=? AND id=?', [row.entity, row.id]);
      deleted++;
    }
  });

  const lastRow = rows.at(-1);
  const nextCursor = `${lastRow.entity}\0${lastRow.id}`;
  const batchSkipped = rows.length - deleted;

  await pool.query(
    'UPDATE retention_jobs SET deleted_count=deleted_count+?, skipped_count=skipped_count+?, batch_cursor=? WHERE id=?',
    [deleted, batchSkipped, nextCursor, jobId]
  );

  return {
    done: false,
    batchDeleted: deleted,
    batchSkipped,
    deletedCount: job.deleted_count + deleted,
    skippedCount: job.skipped_count + batchSkipped
  };
}

// Run auto cleanup for due policies (call from worker tick)
export async function runAutoPolicies(pool) {
  const [policies] = await pool.query(
    'SELECT * FROM retention_policies WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at <= UTC_TIMESTAMP(3)'
  );
  let total = 0;

  for (const policy of policies) {
    const entity = policy.entity;
    if (entity) {
      try { assertEntity(entity); } catch { continue; }
    }
    const days = policy.retention_days;
    const cutoff = new Date(Date.now() - days * 86400000);

    const [rows] = await pool.query(
      `SELECT entity, id FROM records
       WHERE ${entity ? 'entity=? AND ' : `LOWER(entity) NOT IN (${[...PROTECTED_ENTITIES].map(() => '?').join(',')}) AND `}
         dirty=0 AND synced_version=version AND finalized_at IS NOT NULL AND business_at < ?
       ORDER BY entity, id LIMIT 500`,
      entity ? [entity, cutoff] : [...PROTECTED_ENTITIES, cutoff]
    );

    let deleted = 0;
    await transaction(pool, async db => {
      for (const row of rows) {
        const [[r]] = await db.query(
          'SELECT id FROM records WHERE entity=? AND id=? AND dirty=0 AND synced_version=version AND finalized_at IS NOT NULL FOR UPDATE',
          [row.entity, row.id]
        );
        if (!r) continue;

        await db.query(
          'UPDATE row_map SET archived_at=UTC_TIMESTAMP(3) WHERE entity=? AND id=? AND archived_at IS NULL',
          [row.entity, row.id]
        );
        await db.query('DELETE FROM records WHERE entity=? AND id=?', [row.entity, row.id]);
        deleted++;
      }
    });

    total += deleted;
    const nextRun = computeNextRun(policy.schedule_hhmm);
    await pool.query(
      'UPDATE retention_policies SET last_run_at=UTC_TIMESTAMP(3), next_run_at=? WHERE id=?',
      [nextRun, policy.id]
    );

    if (deleted > 0) {
      await pool.query(
        'INSERT INTO retention_audit(policy_id,entity,record_count,action) VALUES(?,?,?,?)',
        [policy.id, entity || '__all__', deleted, 'auto_cleanup']
      );
    }
  }

  return total;
}
