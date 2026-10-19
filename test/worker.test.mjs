import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,Fault} from '../src/core.js';
import {tick,syncEntity} from '../src/sync.js';
const key='1'.repeat(64),entity={name:'Attendance',tab_name:'Attendance',headers:['ID','FullName'],bootstrap_state:'ready',retention_days:0};
const row={entity:'Attendance',id:'ATT-1',data:{ID:'ATT-1',FullName:'Test'},version:1,dirty:1,synced_version:0,updated_at:new Date()};
function fixture({remaining=0,writeError}={}) {
  const calls=[],writes=[];
  const settings={spreadsheetId:'test-sheet',enabled:false,intervalMinutes:60,batchSize:1,serviceAccount:{client_email:'test@example.invalid',private_key:'not-real'}};
  const query=async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
    if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt(settings,key)}]];
    if(sql.includes('SELECT * FROM jobs'))return [[{id:'test-job',kind:'sync',entity:null,state:'pending',attempts:0}]];
    if(sql.includes('SELECT * FROM runtime_state'))return [[{failures:0}]];
    if(sql==='SELECT * FROM entities')return [[entity]];
    if(sql.startsWith('SELECT * FROM records'))return [[structuredClone(row)]];
    if(sql.includes('SELECT next_row'))return [[{next_row:8}]];
    if(sql.includes('SELECT sheet_row'))return [[{sheet_row:7}]];
    if(sql.includes('SELECT COUNT(*)'))return [[{n:remaining}]];
    if(sql.includes('SELECT r.entity,r.id'))return [[]];
    return [{affectedRows:1,insertId:1}];
  };
  const connection={query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
  const pool={query,getConnection:async()=>connection};
  const sheets={ensureHeader:async()=>[],writeRows:async(e,rows)=>{writes.push(...rows);if(writeError)throw writeError;}};
  return {pool,calls,writes,sheets};
}
test('manual sync remains queued until all batches drain even when auto-sync is disabled',async()=>{
  const f=fixture({remaining:1});await tick(f.pool,{CONFIG_ENCRYPTION_KEY:key},{sheetsFactory:()=>f.sheets});
  assert.equal(f.writes.length,1);assert(f.calls.some(c=>c.sql.includes("UPDATE jobs SET state='pending'")));
  assert(!f.calls.some(c=>c.sql.includes("UPDATE jobs SET state='success'")));
});
test('429 keeps MySQL data pending and schedules durable retry after Retry-After',async()=>{
  const e=new Fault(429,'GOOGLE_HTTP_429');e.retryAfterMs=60000;const f=fixture({writeError:e});
  await tick(f.pool,{CONFIG_ENCRYPTION_KEY:key},{sheetsFactory:()=>f.sheets});
  assert(!f.calls.some(c=>c.sql.startsWith('UPDATE records SET synced_version')));
  const retry=f.calls.find(c=>c.sql.includes('UPDATE jobs SET attempts=attempts+1'));
  assert.equal(retry.args[0],'retry');assert(retry.args[1]>=60);assert.equal(retry.args[2],'GOOGLE_HTTP_429');
  assert(!f.calls.some(c=>c.sql.startsWith('DELETE FROM records')));
});
test('successful batch acknowledges only its sent version and preserves a newer dirty version',async()=>{
  const f=fixture();await syncEntity(f.pool,entity,f.sheets,100);
  const ack=f.calls.find(c=>c.sql.startsWith('UPDATE records SET synced_version'));
  assert.match(ack.sql,/dirty=IF\(version=\?,0,1\)/);assert.deepEqual(ack.args,[1,1,'Attendance','ATT-1']);
  const allocationIndex=f.calls.findIndex(c=>c.sql.includes('SELECT next_row'));
  assert(allocationIndex>=0);assert.equal(f.writes[0].sheet_row,7);
});
