import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountKinhDoanhRead} from '../src/kinhDoanhRead.js';
import {createRequestLogger} from '../src/requestLogger.js';
import {authFor} from '../src/auth.js';

const config = {
  API_TOKEN: 'w'.repeat(64),
  KINHDOANH_READ_TOKEN: 'k'.repeat(64),
  KINHDOANH_READ_ENABLED: 'true',
  KINHDOANH_MAX_REQUESTS_PER_MINUTE: 120,
};

async function fixture(override = {}) {
  const queries = [];
  let writes = 0;
  const cfg = {...config, ...override};

  const pool = {
    execute: async (opts, args = []) => {
      queries.push({sql: opts.sql, args});
      if (opts.sql.includes('FROM entities')) {
        return [[{bootstrap_state: 'ready', retention_days: 0}]];
      }
      if (opts.sql.includes("entity = 'InventoryLogs'") || (args && args[0] === 'InventoryLogs')) {
        return [
          Array.from({length: 3}, (_, i) => ({
            id: `INV-00${i + 1}`,
            updated_at: '2026-10-23 08:00:00',
            deleted_at: null,
            version: 1,
            data: JSON.stringify({
              TripID: `TRIP-00${i + 1}`,
              SecondWeighAt: '2026-10-23T08:15:00Z',
              WeightKg: 15420 + i * 100,
              Status: 'COMPLETED',
              Type: 'EXPORT'
            })
          }))
        ];
      }
      if (opts.sql.includes("entity = 'VehicleTrips'") || (args && args[0] === 'VehicleTrips')) {
        return [
          Array.from({length: 2}, (_, i) => ({
            id: `TRIP-00${i + 1}`,
            updated_at: '2026-10-23 07:30:00',
            deleted_at: null,
            version: 1,
            data: JSON.stringify({
              LicensePlate: `47C-${1000 + i}`,
              Status: 'COMPLETED',
              CreatedAt: '2026-10-23T07:00:00Z'
            })
          }))
        ];
      }
      return [[]];
    },
    query: async () => [[]]
  };

  const requestLogger = createRequestLogger({pool});
  const app = express();
  app.use(express.json());

  // Mount admin endpoints for testing
  app.get('/admin/kinhdoanh/status', async (_req, res) => {
    res.json({
      ok: true,
      stats: requestLogger.getStats('kinhdoanh-read-only'),
      config: {
        enabled: cfg.KINHDOANH_READ_ENABLED !== 'false',
        tokenConfigured: Boolean(cfg.KINHDOANH_READ_TOKEN && cfg.KINHDOANH_READ_TOKEN.length >= 48),
        maxPerMinute: Number(cfg.KINHDOANH_MAX_REQUESTS_PER_MINUTE) || 120,
      }
    });
  });
  app.get('/admin/kinhdoanh/logs', async (req, res) => {
    res.json({
      ok: true,
      logs: requestLogger.getLogs({
        client: 'kinhdoanh-read-only',
        status: req.query.status,
        limit: req.query.limit,
      })
    });
  });
  app.post('/admin/kinhdoanh/toggle', async (req, res) => {
    cfg.KINHDOANH_READ_ENABLED = req.body?.enabled ? 'true' : 'false';
    res.json({ok: true, enabled: cfg.KINHDOANH_READ_ENABLED === 'true'});
  });

  mountKinhDoanhRead(app, pool, cfg, {requestLogger});

  // Writer endpoints protected by ChamCong integration auth
  app.use('/v1', authFor(pool, cfg).integration);
  app.post('/v1/cham-cong/write', (_req, res) => {
    writes++;
    res.json({ok: true});
  });

  app.use((err, _req, res, _next) => res.status(err.status || 503).json({ok: false, code: err.code}));

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  const request = (path, {token = cfg.KINHDOANH_READ_TOKEN, method = 'GET', body, headers = {}} = {}) => {
    const reqHeaders = {...headers};
    if (token) reqHeaders.Authorization = 'Bearer ' + token;
    if (body) reqHeaders['Content-Type'] = 'application/json';
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
  };

  return {
    request,
    queries,
    requestLogger,
    writes: () => writes,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('separate read token cannot use writer endpoints; writer token cannot use KinhDoanh read API', async () => {
  const f = await fixture();
  try {
    // Read token trying to write -> 401
    const writeRes = await f.request('/v1/cham-cong/write', {method: 'POST', body: {entity: 'VehicleTrips'}});
    assert.equal(writeRes.status, 401);
    assert.equal(f.writes(), 0);

    // Read token trying to POST to read endpoint -> 403 Forbidden (READ_ONLY)
    const postRes = await f.request('/v1/kinhdoanh/trips', {method: 'POST', body: {foo: 'bar'}});
    assert.equal(postRes.status, 403);
    const postData = await postRes.json();
    assert.equal(postData.code, 'READ_ONLY');

    // Writer token trying to access KinhDoanh endpoint -> 401 Unauthorized
    const writerRes = await f.request('/v1/kinhdoanh/ping', {token: config.API_TOKEN});
    assert.equal(writerRes.status, 401);

    // Valid read token can access ping
    const pingRes = await f.request('/v1/kinhdoanh/ping');
    assert.equal(pingRes.status, 200);
    const pingData = await pingRes.json();
    assert.equal(pingData.ok, true);
    assert.equal(pingData.protocol, 'kinhdoanh-read-v1');
  } finally {
    await f.close();
  }
});

test('KinhDoanh read principal fails closed when unconfigured, short, or disabled', async () => {
  // Missing or short token
  for (const badToken of [undefined, '', 'too-short', config.API_TOKEN]) {
    const f = await fixture({KINHDOANH_READ_TOKEN: badToken});
    try {
      const res = await f.request('/v1/kinhdoanh/ping', {token: badToken});
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.code, 'READ_TOKEN_NOT_CONFIGURED');
    } finally {
      await f.close();
    }
  }

  // Disabled flag
  const fDisabled = await fixture({KINHDOANH_READ_ENABLED: 'false'});
  try {
    const res = await fDisabled.request('/v1/kinhdoanh/ping');
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.code, 'KINHDOANH_READ_DISABLED');
  } finally {
    await fDisabled.close();
  }
});

test('capabilities endpoint returns strictly read-only allowed entities', async () => {
  const f = await fixture();
  try {
    const res = await f.request('/v1/kinhdoanh/capabilities');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.readOnly, true);
    assert.equal(data.maxLimit, 100);
    assert.ok(data.entities.includes('VehicleTrips'));
    assert.ok(data.entities.includes('InventoryLogs'));
    assert.ok(data.entities.includes('CoffeeQuality'));
    assert.ok(data.entities.includes('WarehouseBM03Reports'));
    assert.equal(data.entities.includes('Admins'), false);
    assert.equal(data.entities.includes('Users'), false);
  } finally {
    await f.close();
  }
});

test('weighed-sessions filters and only returns records with valid SecondWeighAt and positive WeightKg', async () => {
  const f = await fixture();
  try {
    const res = await f.request('/v1/kinhdoanh/weighed-sessions?limit=50');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.items.length, 3);
    for (const rec of data.items) {
      assert.ok(rec.secondWeighAt);
      assert.ok(rec.weightKg > 0);
      assert.equal(rec.status, 'COMPLETED');
    }
  } finally {
    await f.close();
  }
});

test('sync/changes supports cursor pagination and rejects disallowed entities', async () => {
  const f = await fixture();
  try {
    // Disallowed entity -> 400
    const badRes = await f.request('/v1/kinhdoanh/sync/changes?entity=Admins');
    assert.equal(badRes.status, 400);

    // Allowed entity -> 200 with cursor
    const okRes = await f.request('/v1/kinhdoanh/sync/changes?entity=VehicleTrips&since=2026-10-23T00:00:00Z');
    assert.equal(okRes.status, 200);
    const data = await okRes.json();
    assert.equal(data.ok, true);
    assert.equal(data.entity, 'VehicleTrips');
    assert.equal(data.records.length, 2);
  } finally {
    await f.close();
  }
});

test('request logging tracks metrics and sanitizes secrets from logs', async () => {
  const f = await fixture();
  try {
    // Generate successful request
    await f.request('/v1/kinhdoanh/ping');
    // Generate failed request (403 write)
    await f.request('/v1/kinhdoanh/trips', {method: 'DELETE'});

    const statusRes = await f.request('/admin/kinhdoanh/status', {token: null});
    const statusData = await statusRes.json();
    assert.equal(statusData.ok, true);
    assert.equal(statusData.stats.totalRequests, 2);
    assert.equal(statusData.stats.successfulRequests, 1);
    assert.equal(statusData.stats.failedRequests, 1);

    const logsRes = await f.request('/admin/kinhdoanh/logs', {token: null});
    const logsData = await logsRes.json();
    assert.equal(logsData.ok, true);
    assert.equal(logsData.logs.length, 2);

    const logJson = JSON.stringify(logsData);
    assert.equal(logJson.includes(config.KINHDOANH_READ_TOKEN), false);
    assert.equal(logJson.includes(config.API_TOKEN), false);
    assert.equal(logJson.includes('127.0.0.1'), false);
  } finally {
    await f.close();
  }
});
