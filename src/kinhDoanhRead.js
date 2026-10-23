import {equal, json} from './core.js';

// Dedicated Read-Only API for KinhDoanh: never accepts writes, separate token, strict rate bounds.
const protocol = 'kinhdoanh-read-v1';
const ALLOWED_ENTITIES = new Set(['VehicleTrips', 'InventoryLogs', 'CoffeeQuality', 'WarehouseBM03Reports']);

function isValidDate(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) && Number.isFinite(Date.parse(str)) && new Date(str).toISOString().slice(0, 10) === str;
}

function parseLimit(val, max = 100) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : 50;
}

export function mountKinhDoanhRead(app, pool, config, {track = (_req, _res, next) => next(), requestLogger} = {}) {
  const windows = new Map();
  let inFlight = 0;
  const maxReqPerMinute = Number(config.KINHDOANH_MAX_REQUESTS_PER_MINUTE) || 120;

  // 1. Request audit logger (records all requests including 401, 403, 429 without leaking secrets)
  if (requestLogger?.middleware) {
    app.use('/v1/kinhdoanh', requestLogger.middleware('kinhdoanh-read-only'));
  }

  // 2. Rate Limiter middleware
  app.use('/v1/kinhdoanh', (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of windows) if (value.until <= now) windows.delete(key);
    const ip = req.socket.remoteAddress || 'unknown';
    const window = windows.get(ip) || {hits: 0, until: now + 60000};
    if (++window.hits > maxReqPerMinute) {
      res.set('Retry-After', '60');
      res.locals.errorCode = 'READ_RATE_LIMIT';
      return res.status(429).json({ok: false, code: 'READ_RATE_LIMIT', message: 'Vượt quá giới hạn request cho phép. Thử lại sau 60 giây.'});
    }
    windows.set(ip, window);
    next();
  });

  // 3. Authentication & Read-only enforcement middleware
  app.use('/v1/kinhdoanh', (req, res, next) => {
    if (config.KINHDOANH_READ_ENABLED === 'false') {
      res.locals.errorCode = 'KINHDOANH_READ_DISABLED';
      return res.status(503).json({ok: false, code: 'KINHDOANH_READ_DISABLED', message: 'Kết nối KinhDoanh tạm thời bị vô hiệu hóa bởi Admin.'});
    }
    const token = config.KINHDOANH_READ_TOKEN;
    if (!token || token.length < 48 || equal(token, config.API_TOKEN)) {
      res.locals.errorCode = 'READ_TOKEN_NOT_CONFIGURED';
      return res.status(503).json({ok: false, code: 'READ_TOKEN_NOT_CONFIGURED', message: 'Token chỉ đọc KinhDoanh chưa được cấu hình hợp lệ.'});
    }
    if (!equal(req.headers.authorization, `Bearer ${token}`)) {
      res.locals.errorCode = 'READ_TOKEN_INVALID';
      return res.status(401).json({ok: false, code: 'READ_TOKEN_INVALID', message: 'Token xác thực KinhDoanh không hợp lệ.'});
    }
    if (req.method !== 'GET') {
      res.locals.errorCode = 'READ_ONLY';
      return res.status(403).json({ok: false, code: 'READ_ONLY', message: 'Chỉ cho phép phương thức GET; nghiêm cấm thao tác ghi.'});
    }
    req.kinhDoanhClient = 'kinhdoanh-read-only';
    next();
  });

  // 4. Track access activity
  app.use('/v1/kinhdoanh', track);

  // Concurrency & in-flight limiter
  app.use('/v1/kinhdoanh', (req, res, next) => {
    if (inFlight >= 5) {
      res.locals.errorCode = 'READ_BUSY';
      return res.status(429).json({ok: false, code: 'READ_BUSY', message: 'Hệ thống đang phục vụ tối đa truy vấn đồng thời. Vui lòng thử lại.'});
    }
    inFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; inFlight--; } };
    res.once('finish', release);
    res.once('close', release);
    next();
  });

  // Endpoints
  app.get('/v1/kinhdoanh/ping', (_req, res) => {
    res.json({ok: true, protocol, timestamp: new Date().toISOString()});
  });

  app.get('/v1/kinhdoanh/capabilities', (_req, res) => {
    res.json({
      ok: true,
      protocol,
      readOnly: true,
      maxLimit: 100,
      entities: Array.from(ALLOWED_ENTITIES),
    });
  });

  // Trips endpoint (VehicleTrips)
  app.get('/v1/kinhdoanh/trips', async (req, res) => {
    const limit = parseLimit(req.query.limit, 100);
    const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 191) : '';
    const from = typeof req.query.from === 'string' && isValidDate(req.query.from) ? req.query.from : null;
    const to = typeof req.query.to === 'string' && isValidDate(req.query.to) ? req.query.to : null;
    const cargoType = typeof req.query.cargoType === 'string' && ['IMPORT', 'EXPORT', 'NORMAL'].includes(req.query.cargoType) ? req.query.cargoType : null;
    const status = typeof req.query.status === 'string' && ['ON_SITE', 'EXITED'].includes(req.query.status) ? req.query.status : null;

    let sql = `SELECT id, data, version, business_at, updated_at FROM records WHERE entity = 'VehicleTrips' AND deleted_at IS NULL`;
    const args = [];

    if (after) {
      sql += ` AND id > ?`;
      args.push(after);
    }
    if (from) {
      sql += ` AND business_at >= ?`;
      args.push(from + ' 00:00:00.000');
    }
    if (to) {
      sql += ` AND business_at <= ?`;
      args.push(to + ' 23:59:59.999');
    }
    if (cargoType) {
      sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.CargoType')) = ?`;
      args.push(cargoType);
    }
    if (status) {
      sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.Status')) = ?`;
      args.push(status);
    }

    sql += ` ORDER BY id ASC LIMIT ?`;
    args.push(limit + 1);

    const [rows] = await pool.execute({sql, timeout: 3000}, args);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;

    res.locals.recordsCount = kept.length;
    const items = kept.map(r => {
      const d = json(r.data);
      return {
        id: r.id,
        plateNumber: d.PlateNumber || '',
        vehicleType: d.VehicleType || '',
        driverName: d.DriverName || '',
        phone: d.Phone || '',
        company: d.Company || '',
        purpose: d.Purpose || '',
        timeIn: d.TimeIn || '',
        timeOut: d.TimeOut || '',
        cargoType: d.CargoType || '',
        container: d.Container || '',
        container2: d.Container2 || '',
        trailerNumber: d.TrailerNumber || '',
        estimatedWeightKg: Number(d.EstimatedWeightKg) || 0,
        estimatedBagCount: Number(d.EstimatedBagCount) || 0,
        bagType: d.BagType || '',
        status: d.Status || '',
        updatedAt: r.updated_at,
        version: Number(r.version),
      };
    });

    res.json({
      ok: true,
      protocol,
      count: items.length,
      hasMore,
      nextAfter: hasMore ? items.at(-1)?.id : null,
      items,
    });
  });

  // Weighed sessions endpoint (Completed 2nd weigh records ONLY)
  app.get('/v1/kinhdoanh/weighed-sessions', async (req, res) => {
    const limit = parseLimit(req.query.limit, 100);
    const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 191) : '';
    const from = typeof req.query.from === 'string' && isValidDate(req.query.from) ? req.query.from : null;
    const to = typeof req.query.to === 'string' && isValidDate(req.query.to) ? req.query.to : null;
    const type = typeof req.query.type === 'string' && ['IMPORT', 'EXPORT'].includes(req.query.type) ? req.query.type : null;

    let sql = `SELECT id, data, version, updated_at FROM records
               WHERE entity = 'InventoryLogs' AND deleted_at IS NULL
                 AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.Status')) != 'CANCELLED'
                 AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.SecondWeighAt')) IS NOT NULL
                 AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.SecondWeighAt')) != ''
                 AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.WeightKg')) AS DECIMAL(16,3)) > 0`;
    const args = [];

    if (after) {
      sql += ` AND id > ?`;
      args.push(after);
    }
    if (from) {
      sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.SecondWeighAt')) >= ?`;
      args.push(from + 'T00:00:00.000Z');
    }
    if (to) {
      sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.SecondWeighAt')) <= ?`;
      args.push(to + 'T23:59:59.999Z');
    }
    if (type) {
      sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.Type')) = ?`;
      args.push(type);
    }

    sql += ` ORDER BY id ASC LIMIT ?`;
    args.push(limit + 1);

    const [rows] = await pool.execute({sql, timeout: 3000}, args);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;

    res.locals.recordsCount = kept.length;
    const items = kept.map(r => {
      const d = json(r.data);
      return {
        id: r.id,
        tripId: d.TripID || '',
        sessionId: d.SessionID || '',
        weighingTicketId: d.WeighingTicketID || '',
        weighingTicketNumber: d.WeighingTicketNumber || '',
        type: d.Type || '',
        itemName: d.ItemName || '',
        weightKg: Number(d.WeightKg) || 0,
        bagCount: Number(d.BagCount) || 0,
        secondWeighAt: d.SecondWeighAt,
        plateNumber: d.PlateNumber || '',
        company: d.Company || '',
        contractNumber: d.ContractNumber || '',
        container: d.Container || '',
        container2: d.Container2 || '',
        bagType: d.BagType || '',
        status: d.Status || '',
        updatedAt: r.updated_at,
        version: Number(r.version),
      };
    });

    res.json({
      ok: true,
      protocol,
      count: items.length,
      hasMore,
      nextAfter: hasMore ? items.at(-1)?.id : null,
      items,
    });
  });

  // Coffee Quality (KCS) endpoint
  app.get('/v1/kinhdoanh/coffee-quality', async (req, res) => {
    const limit = parseLimit(req.query.limit, 100);
    const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 191) : '';
    const recordId = typeof req.query.recordId === 'string' ? req.query.recordId.slice(0, 191) : null;
    const from = typeof req.query.from === 'string' && isValidDate(req.query.from) ? req.query.from : null;
    const to = typeof req.query.to === 'string' && isValidDate(req.query.to) ? req.query.to : null;

    let sql = `SELECT id, data, version, updated_at FROM records WHERE entity = 'CoffeeQuality' AND deleted_at IS NULL`;
    const args = [];

    if (after) {
      sql += ` AND id > ?`;
      args.push(after);
    }
    if (recordId) {
      sql += ` AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.RecordID')) = ?`;
      args.push(recordId);
    }
    if (from) {
      sql += ` AND business_at >= ?`;
      args.push(from + ' 00:00:00.000');
    }
    if (to) {
      sql += ` AND business_at <= ?`;
      args.push(to + ' 23:59:59.999');
    }

    sql += ` ORDER BY id ASC LIMIT ?`;
    args.push(limit + 1);

    const [rows] = await pool.execute({sql, timeout: 3000}, args);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;

    res.locals.recordsCount = kept.length;
    const items = kept.map(r => {
      const d = json(r.data);
      let details = {};
      try { details = d.DataJSON ? JSON.parse(d.DataJSON) : {}; } catch {}
      return {
        id: r.id,
        recordId: d.RecordID || '',
        revision: Number(d.Revision) || 0,
        actor: d.Actor || '',
        action: d.Action || '',
        reason: d.Reason || '',
        data: details,
        updatedAt: r.updated_at,
        version: Number(r.version),
      };
    });

    res.json({
      ok: true,
      protocol,
      count: items.length,
      hasMore,
      nextAfter: hasMore ? items.at(-1)?.id : null,
      items,
    });
  });

  // BM03 Reports endpoint
  app.get('/v1/kinhdoanh/bm03-reports', async (req, res) => {
    const limit = parseLimit(req.query.limit, 100);
    const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 191) : '';
    const from = typeof req.query.from === 'string' && isValidDate(req.query.from) ? req.query.from : null;
    const to = typeof req.query.to === 'string' && isValidDate(req.query.to) ? req.query.to : null;

    let sql = `SELECT id, data, version, updated_at FROM records WHERE entity = 'WarehouseBM03Reports' AND deleted_at IS NULL`;
    const args = [];

    if (after) {
      sql += ` AND id > ?`;
      args.push(after);
    }
    if (from) {
      sql += ` AND business_at >= ?`;
      args.push(from + ' 00:00:00.000');
    }
    if (to) {
      sql += ` AND business_at <= ?`;
      args.push(to + ' 23:59:59.999');
    }

    sql += ` ORDER BY id ASC LIMIT ?`;
    args.push(limit + 1);

    const [rows] = await pool.execute({sql, timeout: 3000}, args);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;

    res.locals.recordsCount = kept.length;
    const items = kept.map(r => {
      const d = json(r.data);
      return {
        id: r.id,
        actor: d.Actor || '',
        status: d.Status || '',
        reportDate: d.ReportDate || '',
        tripIds: json(d.TripIDsJSON || '[]'),
        rows: json(d.RowsJSON || '[]'),
        updatedAt: r.updated_at,
        version: Number(r.version),
      };
    });

    res.json({
      ok: true,
      protocol,
      count: items.length,
      hasMore,
      nextAfter: hasMore ? items.at(-1)?.id : null,
      items,
    });
  });

  // Incremental sync endpoint with composite cursor (updated_at, id)
  app.get('/v1/kinhdoanh/sync/changes', async (req, res) => {
    const entity = String(req.query.entity || '');
    if (!ALLOWED_ENTITIES.has(entity)) {
      res.locals.errorCode = 'ENTITY_NOT_ALLOWED';
      return res.status(400).json({ok: false, code: 'ENTITY_NOT_ALLOWED', message: 'Tài nguyên không thuộc danh sách cho phép đồng bộ.'});
    }

    const limit = parseLimit(req.query.limit, 100);
    const since = typeof req.query.since === 'string' ? req.query.since.slice(0, 32) : '1970-01-01 00:00:00.000';
    const after = typeof req.query.after === 'string' ? req.query.after.slice(0, 191) : '';

    let sql = `SELECT id, data, version, updated_at, deleted_at FROM records
               WHERE entity = ? AND (updated_at > ? OR (updated_at = ? AND id > ?))
               ORDER BY updated_at ASC, id ASC LIMIT ?`;
    const args = [entity, since, since, after, limit + 1];

    const [rows] = await pool.execute({sql, timeout: 3000}, args);
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;

    res.locals.recordsCount = kept.length;
    const lastRow = kept.at(-1);

    res.json({
      ok: true,
      protocol,
      entity,
      count: kept.length,
      hasMore,
      lastUpdatedAt: lastRow ? lastRow.updated_at : since,
      lastId: lastRow ? lastRow.id : after,
      records: kept.map(r => ({
        id: r.id,
        version: Number(r.version),
        updatedAt: r.updated_at,
        isDeleted: r.deleted_at !== null,
        data: json(r.data),
      })),
    });
  });

  // Fallthrough for unmatched /v1/kinhdoanh routes
  app.use('/v1/kinhdoanh', (_req, res) => {
    res.locals.errorCode = 'NOT_FOUND';
    res.status(404).json({ok: false, code: 'NOT_FOUND', message: 'Endpoint không tồn tại.'});
  });
}
