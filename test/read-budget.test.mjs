import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

const refKey = "JSON_EXTRACT(r.data,'$.Key') COLLATE BINARY";
const refRevision = "JSON_EXTRACT(r.data,'$.Revision')";
const numeric = `${refRevision} REGEXP '^[0-9]{1,15}$'`;
const ranking = `SELECT r.id,m.sheet_row,
  ROW_NUMBER() OVER (PARTITION BY ${refKey} ORDER BY CASE WHEN ${numeric} THEN CAST(${refRevision} AS DECIMAL(30,0)) ELSE 0 END DESC,m.sheet_row) AS revision_rank,
  MIN(CASE WHEN ${numeric} THEN 1 ELSE 0 END) OVER (PARTITION BY ${refKey}) AS numeric_revisions
  FROM records r JOIN row_map m ON m.entity=r.entity AND m.id=r.id
  WHERE r.entity=? AND r.deleted_at IS NULL AND m.sheet_row<=?`;

const beforeSql = `SELECT ranked.id,content.data,ranked.sheet_row FROM (
  ${ranking}
) ranked JOIN records content ON content.entity=? AND content.id=ranked.id
WHERE (ranked.numeric_revisions=0 OR ranked.revision_rank=1) AND ranked.sheet_row>? ORDER BY ranked.sheet_row LIMIT ?`;

const afterSql = `SELECT page.id,content.data,page.sheet_row FROM (
  SELECT ranked.id,ranked.sheet_row FROM (
  ${ranking}
  ) ranked
  WHERE (ranked.numeric_revisions=0 OR ranked.revision_rank=1) AND ranked.sheet_row>? ORDER BY ranked.sheet_row LIMIT ?
) page JOIN records content ON content.entity=? AND content.id=page.id
ORDER BY page.sheet_row`;

test('latest reference page keeps the same rows and avoids shipping old revisions', () => {
  const db = new DatabaseSync(':memory:');
  db.function('regexp', (pattern, value) => value == null ? 0 : Number(new RegExp(pattern).test(value)));
  db.exec('CREATE TABLE records(entity TEXT,id TEXT,data TEXT,deleted_at TEXT); CREATE TABLE row_map(entity TEXT,id TEXT,sheet_row INTEGER);');
  const payload = 'x'.repeat(8000);
  const insertRecord = db.prepare('INSERT INTO records VALUES(?,?,?,NULL)');
  const insertMap = db.prepare('INSERT INTO row_map VALUES(?,?,?)');
  for (let index = 0; index < 800; index += 1) {
    for (const revision of [1, 2]) {
      const id = `perf-ref-${index}-${revision}`;
      insertRecord.run('ReferenceData', id, JSON.stringify({ID: id, Key: `key-${index}`, Revision: String(revision), Value: payload}));
      insertMap.run('ReferenceData', id, index * 2 + revision);
    }
  }
  const beforeStarted = performance.now();
  const before = db.prepare(beforeSql).all('ReferenceData', 100000, 'ReferenceData', 0, 20);
  const beforeMs = performance.now() - beforeStarted;
  const afterStarted = performance.now();
  const after = db.prepare(afterSql).all('ReferenceData', 100000, 0, 20, 'ReferenceData');
  const afterMs = performance.now() - afterStarted;
  console.log(JSON.stringify({
    system: 'DataDongBo',
    case: 'reference-latest-page',
    fixtureRevisions: 1600,
    page: 20,
    beforeMs: Number(beforeMs.toFixed(2)),
    afterMs: Number(afterMs.toFixed(2)),
  }));
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
  assert.equal(after.length, 20);
  assert.ok(beforeMs < 3000 && afterMs < 3000, `before ${beforeMs}ms after ${afterMs}ms`);
  db.close();
});
