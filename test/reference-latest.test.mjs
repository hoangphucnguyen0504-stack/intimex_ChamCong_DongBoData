import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRows } from '../src/chamCong.js';
import { encrypt } from '../src/core.js';
import { DatabaseSync } from 'node:sqlite';
const key = '2'.repeat(64), spreadsheetId = 'reference-latest-test-123456';
const headers = ['ID', 'CreatedAt', 'Key', 'Revision', 'Value1'];
function fixture(rows) {
  const calls = [];
  return { calls, pool: { query: async (sql, args = []) => {
    calls.push({ sql, args });
    if (sql.includes('SELECT encrypted')) return [[{ encrypted: encrypt({ spreadsheetId }, key) }]];
    if (sql.startsWith('SELECT * FROM entities')) return [[{ headers, bootstrap_state: 'ready', next_row: 100, retention_days: 0 }]];
    if (sql.startsWith('SELECT COUNT(*)') || sql.includes('m.id IS NULL')) return [[]];
    if (sql.includes('ROW_NUMBER() OVER')) return [rows];
    throw Error('Unexpected query: ' + sql);
  } } };
}
test('latest reference view ranks revisions before applying pagination and keeps a fixed upper boundary', async () => {
  const f = fixture([{ id: 'current', data: { ID: 'current', Key: 'company', Revision: '4', Value1: 'new' }, sheet_row: 80 }]);
  const result = await readRows(f.pool, key, 'ReferenceData', { spreadsheetId, view: 'latest', after: '50', upper: '90' });
  assert.equal(result.latestOnly, true);
  assert.deepEqual(result.rows, [['current', '', 'company', '4', 'new']]);
  assert.equal(result.upper, 90);
  const query = f.calls.find(call => call.sql.includes('ROW_NUMBER() OVER'));
  assert.ok(query.sql.includes('PARTITION BY BINARY'), 'catalog keys remain case sensitive');
  assert.ok(query.sql.includes('m.sheet_row<=?'), 'bound snapshot before ranking');
  assert.ok(query.sql.includes('ranked.sheet_row>?'), 'page only after ranking');
  assert.ok(query.sql.includes('ranked.numeric_revisions=0'), 'non-numeric legacy groups retain full history for the existing JS comparator');
  assert.ok(!/SELECT r\.id,r\.data,m\.sheet_row,/.test(query.sql), 'do not materialize historical JSON payloads inside the ranking table');
  assert.deepEqual(query.args, ['ReferenceData', 90, 50, 50001, 'ReferenceData']);
});
test('latest view cannot silently filter business history or combine with a state key lookup', async () => {
  const f = fixture([]);
  for (const [entity, query] of [['Attendance', {}], ['ReferenceData', { key: 'company' }], ['ReferenceData', { id: 'one' }]]) {
    await assert.rejects(readRows(f.pool, key, entity, { spreadsheetId, view: 'latest', ...query }), { code: 'INVALID_PAGE' });
  }
});
test('ranked projection preserves numeric winners, stable ties, case-sensitive keys, legacy groups and page boundaries', async t => {
  // Exercise the emitted window query against an SQL engine. Only the MySQL
  // JSON/BINARY spelling is translated; ranking, filtering and pagination run.
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.function('regexp', (pattern, value) => value == null ? 0 : Number(new RegExp(pattern).test(value)));
  db.exec('CREATE TABLE records(entity TEXT,id TEXT,data TEXT,deleted_at TEXT); CREATE TABLE row_map(entity TEXT,id TEXT,sheet_row INTEGER);');
  const seed = [
    ['a-old', 'company', '2'], ['a-new', 'company', '10'], ['a-tie', 'company', '10'],
    ['upper-case', 'Company', '1'], ['legacy-first', 'legacy', 'invalid'], ['legacy-number', 'legacy', '3'],
    ['other', 'vehicle', '1'], ['future', 'company', '11'],
  ];
  seed.forEach(([id, Key, Revision], index) => {
    db.prepare('INSERT INTO records VALUES(?,?,?,NULL)').run('ReferenceData', id, JSON.stringify({ ID: id, Key, Revision, Value1: id }));
    db.prepare('INSERT INTO row_map VALUES(?,?,?)').run('ReferenceData', id, index + 1);
  });
  const f = fixture([]), base = f.pool.query;
  f.pool.query = async (sql, args) => {
    if (!sql.includes('ROW_NUMBER() OVER')) return base(sql, args);
    const translated = sql.replace(/JSON_UNQUOTE\((JSON_EXTRACT\(r\.data,'\$\.[A-Za-z]+'\))\)/g, '$1')
      .replace(/BINARY (JSON_EXTRACT\(r\.data,'\$\.Key'\))/g, '$1 COLLATE BINARY');
    return [db.prepare(translated).all(...args)];
  };
  const ids = []; let after = 0;
  do {
    const page = await readRows(f.pool, key, 'ReferenceData', { spreadsheetId, view: 'latest', upper: '7', after: String(after), limit: '2' });
    ids.push(...page.rows.map(row => row[0]));
    if (!page.hasMore) break;
    assert.ok(page.nextAfter > after); after = page.nextAfter;
  } while (true);
  assert.deepEqual(ids, ['a-new', 'upper-case', 'legacy-first', 'legacy-number', 'other']);
});
