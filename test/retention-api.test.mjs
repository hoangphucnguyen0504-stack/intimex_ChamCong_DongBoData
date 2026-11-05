import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {createApp} from '../src/app.js';
import {passwordHash, digest} from '../src/core.js';
import {resetRetentionRateLimit} from '../src/retention.js';

const key = Buffer.alloc(32, 8).toString('hex');
const config = {
  CONFIG_ENCRYPTION_KEY: key,
  API_TOKEN: 'backend-token',
  SESSION_SECRET: 'session-secret-retention',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_HASH: passwordHash('mypassword123'),
  PUBLIC_ORIGIN: 'http://localhost:3200',
  COOKIE_SECURE: 'false'
};

async function fixture(t) {
  resetRetentionRateLimit();
  const validSessionToken = 'valid-admin-session-token';
  const validSessionHash = digest(validSessionToken + config.SESSION_SECRET);

  let policies = [];
  let previews = [];
  let jobs = [];
  let audit = [];

  const query = async (sql, args = []) => {
    if (sql.includes('SELECT token_hash')) {
      return [args[0] === validSessionHash ? [{token_hash: args[0]}] : []];
    }
    if (sql.includes('SELECT * FROM retention_policies ORDER BY id')) {
      return [policies];
    }
    if (sql.includes('SELECT name FROM entities')) {
      return [[{name: 'Attendance'}, {name: 'Users'}, {name: 'VehicleTrips'}]];
    }
    if (sql.includes('INSERT INTO retention_policies')) {
      policies = [{id: 1, entity: args[0], retention_days: args[1], schedule_hhmm: args[2], enabled: args[3]}];
      return [{affectedRows: 1}];
    }
    if (sql.includes('SELECT * FROM retention_policies WHERE entity <=>')) {
      return [[policies[0]]];
    }
    if (sql.includes('INSERT INTO retention_audit')) {
      audit.push({action: args[3], entity: args[1], record_count: args[2]});
      return [{affectedRows: 1}];
    }
    if (sql.includes('SELECT COUNT(*) eligible')) {
      return [[{eligible: 10}]];
    }
    if (sql.includes('SELECT COUNT(*) total')) {
      return [[{total: 15}]];
    }
    if (sql.includes('INSERT INTO retention_previews')) {
      previews.push({id: args[0], entity: args[1], eligible_count: args[5], skipped_count: args[6]});
      return [{affectedRows: 1}];
    }
    if (sql.includes('SELECT * FROM retention_previews WHERE id=?')) {
      const p = previews.find(x => x.id === args[0]);
      return [p ? [{...p, date_from: null, date_to: null, entities: null}] : []];
    }
    if (sql.includes('DELETE FROM retention_previews')) {
      previews = previews.filter(x => x.id !== args[0]);
      return [{affectedRows: 1}];
    }
    if (sql.includes('INSERT INTO retention_jobs')) {
      jobs.push({id: args[0], preview_id: args[1], entity: args[2], state: 'pending', total_count: args[6]});
      return [{affectedRows: 1}];
    }
    if (sql.includes('SELECT * FROM retention_jobs ORDER BY created_at DESC')) {
      return [jobs];
    }
    if (sql.includes('SELECT * FROM retention_audit ORDER BY id DESC')) {
      return [audit];
    }
    return [[]];
  };

  const pool = {query, getConnection: async () => ({query, release: () => {}})};
  const listener = createApp(pool, config).listen(0, '127.0.0.1');
  await new Promise(r => listener.once('listening', r));
  t.after(() => new Promise(r => { listener.close(r); listener.closeAllConnections(); }));

  const url = 'http://127.0.0.1:' + listener.address().port;
  const request = (path, {method = 'GET', headers = {}, body} = {}) => new Promise((resolve, reject) => {
    const wire = body ? JSON.stringify(body) : undefined;
    const req = httpRequest(url + path, {
      method,
      headers: {
        Origin: config.PUBLIC_ORIGIN,
        Cookie: `dd_session=${validSessionToken}`,
        ...(wire ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire)} : {}),
        ...headers
      }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        json: async () => JSON.parse(text)
      }));
    });
    req.on('error', reject);
    req.end(wire);
  });

  return {request};
}

test('GET /admin/retention/policies returns policies and non-protected entities', async t => {
  const {request} = await fixture(t);
  const res = await request('/admin/retention/policies');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.entities, ['Attendance', 'VehicleTrips']); // 'Users' was excluded because protected
});

test('POST /admin/retention/policies requires valid password and saves policy', async t => {
  const {request} = await fixture(t);
  // Wrong password
  const fail = await request('/admin/retention/policies', {
    method: 'POST',
    body: {entity: 'Attendance', retentionDays: 30, scheduleHhmm: '02:00', enabled: true, password: 'wrong'}
  });
  assert.equal(fail.status, 401);

  // Correct password
  const ok = await request('/admin/retention/policies', {
    method: 'POST',
    body: {entity: 'Attendance', retentionDays: 30, scheduleHhmm: '02:00', enabled: true, password: 'mypassword123'}
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.policy.retention_days, 30);
});

test('POST /admin/retention/preview returns counts and POST /admin/retention/jobs creates durable job', async t => {
  const {request} = await fixture(t);
  const prevRes = await request('/admin/retention/preview', {
    method: 'POST',
    body: {entity: 'Attendance'}
  });
  assert.equal(prevRes.status, 200);
  const prevBody = await prevRes.json();
  assert.equal(prevBody.ok, true);
  assert.equal(prevBody.eligibleCount, 10);
  assert.equal(prevBody.skippedCount, 5);
  assert.ok(prevBody.previewId);

  // Job creation requires password
  const jobFail = await request('/admin/retention/jobs', {
    method: 'POST',
    body: {previewId: prevBody.previewId, entity: 'Attendance', password: 'wrong'}
  });
  assert.equal(jobFail.status, 401);

  const jobOk = await request('/admin/retention/jobs', {
    method: 'POST',
    body: {previewId: prevBody.previewId, entity: 'Attendance', password: 'mypassword123'}
  });
  assert.equal(jobOk.status, 202);
  const jobBody = await jobOk.json();
  assert.equal(jobBody.ok, true);
  assert.ok(jobBody.jobId);
});

