import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {poolFor, migrate, transaction} from '../src/db.js';
import {createApp} from '../src/app.js';
import {mutate} from '../src/records.js';
import {saveEntity} from '../src/settings.js';
import {cleanup} from '../src/sync.js';

const TEST_CONFIG = {
  NODE_ENV: 'test',
  PORT: 3200,
  PUBLIC_ORIGIN: 'http://localhost:3200',
  COOKIE_SECURE: 'false',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_HASH: '58bf3b784a6525cbcc8e769103e937ef:40fff39ac81950e3317b5e71bfc231b528f1f5fba1b58ded1b19b0b807696159d5f6302d372b3d91c0316394f2c80cf21178d0f3e6746d8f0dc5b041ab60bdf7',
  SESSION_SECRET: 's'.repeat(48),
  API_TOKEN: 'w'.repeat(48),
  CONFIG_ENCRYPTION_KEY: 'c'.repeat(64),
  KINHDOANH_READ_TOKEN: 'k'.repeat(48),
  KINHDOANH_READ_ENABLED: 'true',
  KINHDOANH_MAX_REQUESTS_PER_MINUTE: 120,
  MYSQL_HOST: process.env.TEST_MYSQL_HOST || '127.0.0.1',
  MYSQL_PORT: Number(process.env.TEST_MYSQL_PORT || 3306),
  MYSQL_DATABASE: process.env.TEST_MYSQL_DATABASE || 'datadongbo_test',
  MYSQL_USER: process.env.TEST_MYSQL_USER || 'root',
  MYSQL_PASSWORD: process.env.TEST_MYSQL_PASSWORD || '123456',
  MYSQL_POOL_SIZE: 6,
  MYSQL_SSL: 'false',
  SHEETS_REQUESTS_PER_MINUTE: 40,
  SYNC_INTERVAL_MINUTES: 60,
  SYNC_BATCH_SIZE: 100,
  SYNC_ENABLED: 'false',
};

async function createTestServer(pool, config = TEST_CONFIG) {
  const app = createApp(pool, config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const request = (path, {token = config.KINHDOANH_READ_TOKEN, method = 'GET', body, headers = {}} = {}) => {
    const reqHeaders = {...headers};
    if (token) reqHeaders.Authorization = 'Bearer ' + token;
    if (body) reqHeaders['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
  };

  return {
    baseUrl,
    request,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('Real MySQL: Comprehensive Verification of Phase 4A', async t => {
  const pool = poolFor(TEST_CONFIG);
  t.after(async () => {
    await pool.end();
  });

  // 1. Run migrations on real MySQL
  await migrate(pool);

  // Clean test tables
  await pool.query('DELETE FROM records');
  await pool.query('DELETE FROM row_map');
  await pool.query('DELETE FROM entities');
  await pool.query('DELETE FROM client_request_logs');

  // Seed entities
  await saveEntity(pool, {name: 'VehicleTrips', tabName: 'VehicleTrips', headers: ['ID', 'PlateNumber', 'Status', 'CreatedAt', 'DriverName', 'EstimatedWeightKg'], retentionDays: 0});
  await saveEntity(pool, {name: 'InventoryLogs', tabName: 'InventoryLogs', headers: ['ID', 'TripID', 'SessionID', 'WeighingTicketID', 'Type', 'WeightKg', 'SecondWeighAt', 'Status'], retentionDays: 0});
  await saveEntity(pool, {name: 'CoffeeQuality', tabName: 'CoffeeQuality', headers: ['ID', 'TripID', 'RecordID', 'Moisture', 'BlackBroken', 'ForeignMatter', 'Status'], retentionDays: 0});
  await saveEntity(pool, {name: 'WarehouseBM03Reports', tabName: 'WarehouseBM03Reports', headers: ['ID', 'Actor', 'Status', 'ReportDate', 'TripIDsJSON', 'RowsJSON'], retentionDays: 0});

  // Mark all ready
  await pool.query("UPDATE entities SET bootstrap_state='ready'");

  const srv = await createTestServer(pool, TEST_CONFIG);
  t.after(async () => {
    await srv.close();
  });

  // =========================================================================
  // SUBTEST 1: Real Read-Only APIs against real MySQL data
  // =========================================================================
  await t.test('1. Real API endpoints query data correctly from MySQL', async () => {
    // Seed real records via MySQL parameterized insert
    await pool.query(`
      INSERT INTO records (entity, id, data, version, dirty, business_at, updated_at) VALUES
      (?, ?, ?, 1, 0, '2026-10-23 07:00:00', '2026-10-23 07:30:00'),
      (?, ?, ?, 1, 0, '2026-10-23 07:30:00', '2026-10-23 07:35:00'),
      (?, ?, ?, 1, 0, '2026-10-23 08:00:00', '2026-10-23 08:05:00')
    `, [
      'VehicleTrips', 'TRIP-101', JSON.stringify({PlateNumber: '47C-12345', Status: 'COMPLETED', DriverName: 'Nguyen Van A', EstimatedWeightKg: 15000, CreatedAt: '2026-10-23T07:00:00.000Z'}),
      'CoffeeQuality', 'QC-101', JSON.stringify({TripID: 'TRIP-101', RecordID: 'REC-101', DataJSON: JSON.stringify({Moisture: 12.5, BlackBroken: 2.0, ForeignMatter: 0.5}), Status: 'PASSED'}),
      'WarehouseBM03Reports', 'BM03-101', JSON.stringify({Actor: 'Thủ kho B', Status: 'SUBMITTED', ReportDate: '2026-10-23', TripIDsJSON: '["TRIP-101"]', RowsJSON: '[{"Item":"Robusta Grade 1","Weight":15420}]'})
    ]);

    // GET /v1/kinhdoanh/ping
    const pingRes = await srv.request('/v1/kinhdoanh/ping');
    assert.equal(pingRes.status, 200);
    const ping = await pingRes.json();
    assert.equal(ping.ok, true);
    assert.equal(ping.protocol, 'kinhdoanh-read-v1');

    // GET /v1/kinhdoanh/capabilities
    const capsRes = await srv.request('/v1/kinhdoanh/capabilities');
    assert.equal(capsRes.status, 200);
    const caps = await capsRes.json();
    assert.equal(caps.readOnly, true);
    assert.equal(caps.entities.length, 4);

    // GET /v1/kinhdoanh/trips
    const tripsRes = await srv.request('/v1/kinhdoanh/trips?plate=47C');
    assert.equal(tripsRes.status, 200);
    const trips = await tripsRes.json();
    assert.equal(trips.ok, true);
    assert.equal(trips.count, 1);
    assert.equal(trips.items[0].id, 'TRIP-101');
    assert.equal(trips.items[0].plateNumber, '47C-12345');
    assert.equal(trips.items[0].driverName, 'Nguyen Van A');

    // GET /v1/kinhdoanh/coffee-quality
    const qcRes = await srv.request('/v1/kinhdoanh/coffee-quality?tripId=TRIP-101');
    assert.equal(qcRes.status, 200);
    const qc = await qcRes.json();
    assert.equal(qc.ok, true);
    assert.equal(qc.items[0].recordId, 'REC-101');
    assert.equal(qc.items[0].data.Moisture, 12.5);

    // GET /v1/kinhdoanh/bm03-reports
    const bmRes = await srv.request('/v1/kinhdoanh/bm03-reports');
    assert.equal(bmRes.status, 200);
    const bm = await bmRes.json();
    assert.equal(bm.ok, true);
    assert.equal(bm.items[0].id, 'BM03-101');
    assert.equal(bm.items[0].actor, 'Thủ kho B');
  });

  // =========================================================================
  // SUBTEST 2: Strict weighed-sessions filtering
  // =========================================================================
  await t.test('2. weighed-sessions filters out cancelled, incomplete, and non-confirmed weighings', async () => {
    // Seed test cases into real MySQL
    await pool.query(`
      INSERT INTO records (entity, id, data, version, dirty, business_at, updated_at, deleted_at) VALUES
      ('InventoryLogs', 'INV-VALID-1', '{"TripID":"TRIP-101","SessionID":"SES-1","WeighingTicketID":"WT-1","Type":"EXPORT","WeightKg":15420.5,"SecondWeighAt":"2026-10-23T08:15:00.000Z","Status":"COMPLETED"}', 1, 0, '2026-10-23 08:15:00', '2026-10-23 08:15:00', NULL),
      ('InventoryLogs', 'INV-VALID-2', '{"TripID":"TRIP-102","SessionID":"SES-2","WeighingTicketID":"WT-2","Type":"IMPORT","WeightKg":28900.0,"SecondWeighAt":"2026-10-23T08:30:00.000Z","Status":"RECORDED"}', 1, 0, '2026-10-23 08:30:00', '2026-10-23 08:30:00', NULL),
      ('InventoryLogs', 'INV-CANCELLED', '{"TripID":"TRIP-103","SessionID":"SES-3","WeighingTicketID":"WT-3","Type":"EXPORT","WeightKg":15000.0,"SecondWeighAt":"2026-10-23T08:00:00.000Z","Status":"CANCELLED"}', 1, 0, '2026-10-23 08:00:00', '2026-10-23 08:00:00', NULL),
      ('InventoryLogs', 'INV-NO-2ND', '{"TripID":"TRIP-104","SessionID":"SES-4","WeighingTicketID":"WT-4","Type":"EXPORT","WeightKg":0,"SecondWeighAt":null,"Status":"IN_PROGRESS"}', 1, 0, '2026-10-23 07:00:00', '2026-10-23 07:00:00', NULL),
      ('InventoryLogs', 'INV-EMPTY-2ND', '{"TripID":"TRIP-105","SessionID":"SES-5","WeighingTicketID":"WT-5","Type":"EXPORT","WeightKg":14000.0,"SecondWeighAt":"","Status":"RECORDED"}', 1, 0, '2026-10-23 07:10:00', '2026-10-23 07:10:00', NULL),
      ('InventoryLogs', 'INV-ZERO-WT', '{"TripID":"TRIP-106","SessionID":"SES-6","WeighingTicketID":"WT-6","Type":"EXPORT","WeightKg":0,"SecondWeighAt":"2026-10-23T08:00:00.000Z","Status":"COMPLETED"}', 1, 0, '2026-10-23 08:00:00', '2026-10-23 08:00:00', NULL),
      ('InventoryLogs', 'INV-NEG-WT', '{"TripID":"TRIP-107","SessionID":"SES-7","WeighingTicketID":"WT-7","Type":"EXPORT","WeightKg":-50.0,"SecondWeighAt":"2026-10-23T08:00:00.000Z","Status":"COMPLETED"}', 1, 0, '2026-10-23 08:00:00', '2026-10-23 08:00:00', NULL),
      ('InventoryLogs', 'INV-SOFT-DEL', '{"TripID":"TRIP-108","SessionID":"SES-8","WeighingTicketID":"WT-8","Type":"EXPORT","WeightKg":15000.0,"SecondWeighAt":"2026-10-23T08:00:00.000Z","Status":"COMPLETED"}', 1, 0, '2026-10-23 08:00:00', '2026-10-23 08:00:00', '2026-10-23 08:35:00')
    `);

    const res = await srv.request('/v1/kinhdoanh/weighed-sessions');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);

    // MUST ONLY RETURN INV-VALID-1 and INV-VALID-2
    assert.equal(data.items.length, 2);
    const returnedIds = data.items.map(i => i.id);
    assert.ok(returnedIds.includes('INV-VALID-1'));
    assert.ok(returnedIds.includes('INV-VALID-2'));
    assert.ok(!returnedIds.includes('INV-CANCELLED'), 'Cancelled weighing must not be returned');
    assert.ok(!returnedIds.includes('INV-NO-2ND'), 'Weighing without 2nd weigh must not be returned');
    assert.ok(!returnedIds.includes('INV-EMPTY-2ND'), 'Weighing with empty 2nd weigh must not be returned');
    assert.ok(!returnedIds.includes('INV-ZERO-WT'), 'Weighing with 0kg weight must not be returned');
    assert.ok(!returnedIds.includes('INV-NEG-WT'), 'Weighing with negative weight must not be returned');
    assert.ok(!returnedIds.includes('INV-SOFT-DEL'), 'Soft-deleted weighing must not be returned');
  });

  // =========================================================================
  // SUBTEST 3: Incremental Sync with Cursor & Pagination
  // =========================================================================
  await t.test('3. sync/changes pagination, composite cursor, and soft-delete detection', async () => {
    // Test pagination limit=1 on InventoryLogs
    const page1Res = await srv.request('/v1/kinhdoanh/sync/changes?entity=InventoryLogs&limit=1');
    assert.equal(page1Res.status, 200);
    const p1 = await page1Res.json();
    assert.equal(p1.ok, true);
    assert.equal(p1.records.length, 1);
    assert.equal(p1.hasMore, true);
    assert.ok(p1.lastUpdatedAt);
    assert.ok(p1.lastId);

    // Fetch page 2 using cursor
    const page2Res = await srv.request(`/v1/kinhdoanh/sync/changes?entity=InventoryLogs&limit=10&since=${encodeURIComponent(p1.lastUpdatedAt)}&after=${encodeURIComponent(p1.lastId)}`);
    assert.equal(page2Res.status, 200);
    const p2 = await page2Res.json();
    assert.equal(p2.ok, true);
    // Page 2 should contain the remaining records without duplicating p1 record
    assert.ok(p2.records.length > 0);
    assert.ok(!p2.records.some(r => r.id === p1.records[0].id), 'Cursor pagination must not duplicate records');

    // Verify soft-deleted record is reported with isDeleted: true
    const softDelRecord = p2.records.find(r => r.id === 'INV-SOFT-DEL');
    assert.ok(softDelRecord, 'Soft-deleted record must be present in sync stream');
    assert.equal(softDelRecord.isDeleted, true, 'isDeleted must be true for soft-deleted record');

    // Forbidden entity check
    const badEntityRes = await srv.request('/v1/kinhdoanh/sync/changes?entity=Admins');
    assert.equal(badEntityRes.status, 400);
    const badData = await badEntityRes.json();
    assert.equal(badData.code, 'ENTITY_NOT_ALLOWED');
  });

  // =========================================================================
  // SUBTEST 4: Security, Read-Only, Rate Limiting, Admin Toggle
  // =========================================================================
  await t.test('4. Security isolation: separate token, write prohibition, admin toggle', async () => {
    // 1. Writer token fails on KinhDoanh API
    const badAuth = await srv.request('/v1/kinhdoanh/ping', {token: TEST_CONFIG.API_TOKEN});
    assert.equal(badAuth.status, 401);

    // 2. Read token fails on writer endpoints
    const badWrite = await srv.request('/v1/cham-cong/write', {method: 'POST', body: {entity: 'VehicleTrips'}});
    assert.equal(badWrite.status, 401);

    // 3. Prohibit any write method on /v1/kinhdoanh/*
    const postTrip = await srv.request('/v1/kinhdoanh/trips', {method: 'POST', body: {plate: 'test'}});
    assert.equal(postTrip.status, 403);
    const postData = await postTrip.json();
    assert.equal(postData.code, 'READ_ONLY');

    const deleteTrip = await srv.request('/v1/kinhdoanh/trips', {method: 'DELETE'});
    assert.equal(deleteTrip.status, 403);

    // 4. Admin Toggle: disable KinhDoanh connection
    TEST_CONFIG.KINHDOANH_READ_ENABLED = 'false';
    const disabledRes = await srv.request('/v1/kinhdoanh/ping');
    assert.equal(disabledRes.status, 503);
    const disData = await disabledRes.json();
    assert.equal(disData.code, 'KINHDOANH_READ_DISABLED');

    // Re-enable
    TEST_CONFIG.KINHDOANH_READ_ENABLED = 'true';
    const enabledRes = await srv.request('/v1/kinhdoanh/ping');
    assert.equal(enabledRes.status, 200);
  });

  // =========================================================================
  // SUBTEST 5: Request Logger, MySQL Persistence & 30-Day Pruning
  // =========================================================================
  await t.test('5. Request logging writes to MySQL and cleanup prunes logs > 30 days', async () => {
    // Give async MySQL insert a few milliseconds to settle
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check rows in client_request_logs
    const [logs] = await pool.query('SELECT * FROM client_request_logs WHERE client = ? ORDER BY id DESC', ['kinhdoanh-read-only']);
    assert.ok(logs.length > 0, 'Real MySQL client_request_logs table must contain logged requests');
    const sample = logs[0];
    assert.equal(sample.client, 'kinhdoanh-read-only');
    assert.ok(sample.fingerprint);
    assert.ok(sample.path.startsWith('/v1/kinhdoanh'));
    assert.ok(sample.status >= 200);

    // Insert an expired log (> 30 days) to verify retention pruning
    await pool.query(`
      INSERT INTO client_request_logs (client, fingerprint, method, path, status, duration_ms, records_count, created_at)
      VALUES ('kinhdoanh-read-only', 'test-fp', 'GET', '/v1/kinhdoanh/ping', 200, 5, 0, UTC_TIMESTAMP(3) - INTERVAL 45 DAY)
    `);

    const [[beforeCount]] = await pool.query('SELECT COUNT(*) n FROM client_request_logs');
    assert.ok(Number(beforeCount.n) >= 2);

    // Run cleanup
    await cleanup(pool);

    // Expired row must have been pruned
    const [expired] = await pool.query("SELECT * FROM client_request_logs WHERE created_at < UTC_TIMESTAMP(3) - INTERVAL 30 DAY");
    assert.equal(expired.length, 0, 'Old request logs > 30 days must be pruned by cleanup');
  });

  // =========================================================================
  // SUBTEST 6: Load & Concurrency Resilience (ChamCong Writes + KinhDoanh Reads)
  // =========================================================================
  await t.test('6. Concurrency resilience: concurrent ChamCong writes and KinhDoanh reads', async () => {
    const writes = [];
    const reads = [];
    const batchPrefix = 'load-' + Date.now();

    // 20 concurrent ChamCong batch mutations
    for (let i = 0; i < 20; i++) {
      writes.push(
        mutate(pool, {
          requestId: `${batchPrefix}-req-${i}`,
          operations: [{
            action: 'create',
            entity: 'VehicleTrips',
            id: `${batchPrefix}-trip-${i}`,
            data: {PlateNumber: `47C-${2000 + i}`, Status: 'ON_SITE', CreatedAt: '2026-10-23T09:00:00Z'}
          }]
        })
      );
    }

    // 15 concurrent KinhDoanh read queries
    for (let i = 0; i < 15; i++) {
      reads.push(srv.request('/v1/kinhdoanh/weighed-sessions'));
      reads.push(srv.request('/v1/kinhdoanh/sync/changes?entity=VehicleTrips&limit=50'));
    }

    const [writeResults, readResults] = await Promise.all([
      Promise.all(writes),
      Promise.all(reads)
    ]);

    // All writes succeeded
    assert.equal(writeResults.length, 20);
    for (const w of writeResults) {
      assert.ok(w.durable, 'All concurrent writes must commit durably');
    }

    // All reads succeeded without connection exhaustion or deadlock
    assert.equal(readResults.length, 30);
    for (const r of readResults) {
      assert.ok(r.status === 200 || r.status === 429, 'Reads must succeed or safely back off via in-flight guard');
    }

    // Verify written records are visible in MySQL
    const [[{tripCount}]] = await pool.query("SELECT COUNT(*) tripCount FROM records WHERE entity='VehicleTrips' AND id LIKE ?", [`${batchPrefix}-trip-%`]);
    assert.equal(Number(tripCount), 20, 'All 20 concurrent writes must exist in MySQL');
  });
});
