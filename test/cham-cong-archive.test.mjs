import test from 'node:test';
import assert from 'node:assert/strict';
import {readRows} from '../src/chamCong.js';
import {encrypt} from '../src/core.js';

const key = Buffer.alloc(32, 5).toString('hex');
const spreadsheetId = 'test-spreadsheet-id-1234567890';
const headers = ['ID', 'CreatedAt', 'FullName', 'Status'];

function accountPool(candidates, inspect = () => {}, {nextRow=10,maxRow=9}={}) {
  return {query: async sql => {
    if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId},key)}]];
    if(sql.startsWith('SELECT * FROM entities'))return [[{name:'Admins',headers,bootstrap_state:'ready',retention_days:0,next_row:nextRow}]];
    if(sql.startsWith('SELECT COUNT(*) n')||sql.startsWith('SELECT 1 AS n FROM records'))return [[]];
    if(sql.startsWith('SELECT COALESCE(MAX(sheet_row)'))return [[{maxRow}]];
    if(sql.startsWith('UPDATE entities SET next_row=GREATEST'))return [{affectedRows:1}];
    if(sql.includes('FROM row_map m LEFT JOIN records r')||sql.includes('ROW_NUMBER() OVER')){inspect(sql);return [candidates];}
    throw Error('Unexpected query: '+sql.slice(0,120));
  }};
}

test('account reads exclude soft-deleted records in WHERE while preserving archive joins',async()=>{
  const pool=accountPool([{id:'active',map_id:'active',sheet_row:3,data:JSON.stringify({ID:'active'})}],sql=>{
    assert.match(sql,/deleted_at IS NULL/);
    assert.match(sql,/ROW_NUMBER\(\) OVER|LEFT JOIN records r/);
  });
  const page=await readRows(pool,key,'Admins',{spreadsheetId});
  assert.equal(page.rows.length,1);
  assert.equal(page.rows[0][0],'active');
});

test('list reads recover when entities.next_row lags behind row_map sheet rows',async()=>{
  let repaired=null;
  const pool=accountPool(
    [{id:'RPF-1',map_id:'RPF-1',sheet_row:12,data:JSON.stringify({ID:'RPF-1',Title:'Bao cao'})}],
    sql=>{if(sql.includes('sheet_row>?'))assert.match(sql,/m\.sheet_row<=\?|ranked\.sheet_row>/);},
    {nextRow:2,maxRow:12}
  );
  const original=pool.query;
  pool.query=async(sql,args)=>{
    if(sql.startsWith('UPDATE entities SET next_row=GREATEST')){repaired=args;return [{affectedRows:1}];}
    return original(sql,args);
  };
  const page=await readRows(pool,key,'Admins',{spreadsheetId});
  assert.equal(page.rows.length,1);
  assert.equal(page.rows[0][0],'RPF-1');
  assert.equal(page.upper,12);
  assert.deepEqual(repaired,[13,'Admins']);
});

test('orphan account mapping fails explicitly instead of returning empty accounts',async()=>{
  await assert.rejects(readRows(accountPool([{id:null,map_id:'orphan',sheet_row:2,data:null,archived_at:null}]),key,'Admins',{spreadsheetId}),{code:'ROW_MAP_RECORD_MISSING'});
});

test('null account payload fails explicitly instead of TypeError',async()=>{
  await assert.rejects(readRows(accountPool([{id:'broken',map_id:'broken',sheet_row:2,data:null}]),key,'Admins',{spreadsheetId}),{code:'RECORD_DATA_INVALID'});
});

test('readRows seamlessly merges live MySQL rows and archived Sheets rows', async () => {
  const entity = 'Attendance';
  // Row 2 is archived (not in records, but in row_map with archived_at)
  // Row 3 is live in MySQL
  const liveRow = {
    id: 'ATT-2',
    data: JSON.stringify({ID: 'ATT-2', CreatedAt: '2026-11-05T01:00:00Z', FullName: 'Trần Văn B', Status: 'ON_SITE'}),
    sheet_row: 3,
    map_id: 'ATT-2',
    archived_at: null
  };

  const archivedRowMap = {
    id: null,
    data: null,
    sheet_row: 2,
    map_id: 'ATT-1',
    archived_at: new Date('2026-11-05T00:00:00Z')
  };

  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT encrypted')) {
        return [[{encrypted: encrypt({spreadsheetId}, key)}]];
      }
      if (sql.startsWith('SELECT * FROM entities')) {
        return [[{name: entity, tab_name: entity, headers: JSON.stringify(headers), bootstrap_state: 'ready', retention_days: 0, next_row: 10}]];
      }
      if (sql.startsWith('SELECT COUNT(*) n')||sql.startsWith('SELECT 1 AS n FROM records')) {
        return [[]];
      }
      if (sql.startsWith('SELECT COALESCE(MAX(sheet_row)')) {
        return [[{maxRow: 10}]];
      }
      if (sql.startsWith('UPDATE entities SET next_row=GREATEST')) {
        return [{affectedRows: 1}];
      }
      if (sql.includes('FROM row_map m LEFT JOIN records r')||sql.includes('ROW_NUMBER() OVER')) {
        return [[archivedRowMap, liveRow]];
      }
      if (sql.includes('SELECT * FROM sheet_locations')) {
        return [[]];
      }
      return [[]];
    }
  };

  // Mock sheets
  let batchReadCalls = 0;
  const mockSheets = {
    config: {spreadsheetId},
    read: async (range) => {
      if (range.endsWith('!1:1')) {
        return [[...headers, '__dd_version', '__dd_deleted_at', '__dd_business_at', '__dd_finalized_at']];
      }
      return [];
    },
    batchRead: async (ranges) => {
      batchReadCalls++;
      assert.equal(ranges.length, 1);
      assert.equal(ranges[0], "'Attendance'!A2:H2");
      return [{
        values: [['ATT-1', '2026-10-01T00:00:00Z', 'Nguyễn Văn A', 'FINALIZED', '1', '', '', '']]
      }];
    }
  };

  const page = await readRows(pool, key, entity, {spreadsheetId, after: 0, limit: 10}, {sheets: mockSheets});
  assert.equal(page.ok, true);
  assert.equal(batchReadCalls, 1);
  assert.equal(page.rows.length, 2);
  // Merged in order: ATT-1 (from Sheets) at row 2, ATT-2 (from MySQL) at row 3
  assert.deepEqual(page.rows[0], ['ATT-1', '2026-10-01T00:00:00Z', 'Nguyễn Văn A', 'FINALIZED']);
  assert.deepEqual(page.rows[1], ['ATT-2', '2026-11-05T01:00:00Z', 'Trần Văn B', 'ON_SITE']);
});

test('readRows view=ids returns IDs without calling Google Sheets batchRead', async () => {
  const entity = 'Attendance';
  const liveRow = {id: 'ATT-2', sheet_row: 3, map_id: 'ATT-2', archived_at: null};
  const archivedRowMap = {id: null, sheet_row: 2, map_id: 'ATT-1', archived_at: new Date()};

  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT encrypted')) return [[{encrypted: encrypt({spreadsheetId}, key)}]];
      if (sql.startsWith('SELECT * FROM entities')) {
        return [[{name: entity, tab_name: entity, headers: JSON.stringify(headers), bootstrap_state: 'ready', retention_days: 0, next_row: 10}]];
      }
      if (sql.startsWith('SELECT COUNT(*) n')||sql.startsWith('SELECT 1 AS n FROM records')) return [[]];
      if (sql.startsWith('SELECT COALESCE(MAX(sheet_row)')) return [[{maxRow: 10}]];
      if (sql.includes('FROM row_map m LEFT JOIN records r')||sql.includes('ROW_NUMBER() OVER')) return [[archivedRowMap, liveRow]];
      return [[]];
    }
  };

  let batchReadCalled = false;
  const mockSheets = {
    config: {spreadsheetId},
    batchRead: async () => { batchReadCalled = true; return []; }
  };

  const page = await readRows(pool, key, entity, {spreadsheetId, after: 0, view: 'ids'}, {sheets: mockSheets});
  assert.equal(page.ok, true);
  assert.equal(batchReadCalled, false);
  assert.deepEqual(page.rows, [['ATT-1'], ['ATT-2']]);
});

test('readRows single id lookup fetches archived record from Sheets if absent in records', async () => {
  const entity = 'Attendance';
  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT encrypted')) return [[{encrypted: encrypt({spreadsheetId}, key)}]];
      if (sql.startsWith('SELECT * FROM entities')) {
        return [[{name: entity, tab_name: entity, headers: JSON.stringify(headers), bootstrap_state: 'ready', retention_days: 0, next_row: 10}]];
      }
      if (sql.includes('SELECT r.id,r.data,m.sheet_row FROM records r')) {
        // Not found in records table (was cleaned up)
        return [[]];
      }
      if (sql.includes('SELECT id,sheet_row,archived_at,deleted_at FROM row_map')) {
        // Found in row_map as archived!
        return [[{id: 'ATT-1', sheet_row: 5, archived_at: new Date(), deleted_at: null}]];
      }
      if (sql.includes('SELECT * FROM sheet_locations')) return [[]];
      return [[]];
    }
  };

  const mockSheets = {
    config: {spreadsheetId},
    read: async (range) => {
      if (range.endsWith('!1:1')) {
        return [[...headers, '__dd_version', '__dd_deleted_at', '__dd_business_at', '__dd_finalized_at']];
      }
      if (range.includes('!A5:')) {
        return [['ATT-1', '2026-10-01T00:00:00Z', 'Nguyễn Văn A', 'FINALIZED', '1', '', '', '']];
      }
      return [];
    }
  };

  const res = await readRows(pool, key, entity, {spreadsheetId, id: 'ATT-1'}, {sheets: mockSheets});
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows, [['ATT-1', '2026-10-01T00:00:00Z', 'Nguyễn Văn A', 'FINALIZED']]);
});

test('readRows throws SHEET_ROW_MOVED if row in Sheets does not match expected ID', async () => {
  const entity = 'Attendance';
  const archivedRowMap = {
    id: null,
    data: null,
    sheet_row: 2,
    map_id: 'ATT-1',
    archived_at: new Date()
  };

  const pool = {
    query: async (sql, args = []) => {
      if (sql.includes('SELECT encrypted')) return [[{encrypted: encrypt({spreadsheetId}, key)}]];
      if (sql.startsWith('SELECT * FROM entities')) {
        return [[{name: entity, tab_name: entity, headers: JSON.stringify(headers), bootstrap_state: 'ready', retention_days: 0, next_row: 10}]];
      }
      if (sql.startsWith('SELECT COUNT(*) n')||sql.startsWith('SELECT 1 AS n FROM records')) return [[]];
      if (sql.startsWith('SELECT COALESCE(MAX(sheet_row)')) return [[{maxRow: 10}]];
      if (sql.includes('FROM row_map m LEFT JOIN records r')||sql.includes('ROW_NUMBER() OVER')) return [[archivedRowMap]];
      if (sql.includes('SELECT * FROM sheet_locations')) return [[]];
      return [[]];
    }
  };

  const mockSheets = {
    config: {spreadsheetId},
    read: async () => [[...headers, '__dd_version', '__dd_deleted_at', '__dd_business_at', '__dd_finalized_at']],
    batchRead: async () => [{
      values: [['DIFFERENT-ID', '2026-10-01T00:00:00Z', 'Người Khác', 'FINALIZED', '1', '', '', '']]
    }]
  };

  await assert.rejects(
    () => readRows(pool, key, entity, {spreadsheetId, after: 0, limit: 10}, {sheets: mockSheets}),
    {code: 'SHEET_ROW_MOVED'}
  );
});
