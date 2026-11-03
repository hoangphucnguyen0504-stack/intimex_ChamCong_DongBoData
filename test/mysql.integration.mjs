// Chỉ chạy với database thử nghiệm riêng, không đọc .env production.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poolFor,migrate} from '../src/db.js';
import {mutate,listRecords} from '../src/records.js';
import {saveEntity,saveSettings} from '../src/settings.js';
import {enqueue,tick,cleanup} from '../src/sync.js';
import {publicRecord} from '../src/core.js';
test('MySQL isolated: atomic CRUD, replay, conflict, restart, import, retention and batch failure', {skip:!process.env.TEST_MYSQL_HOST},async t=>{
  const name=process.env.TEST_MYSQL_DATABASE;
  assert(name?.endsWith('_test'),'TEST_MYSQL_DATABASE phải kết thúc bằng _test');
  const config={MYSQL_HOST:process.env.TEST_MYSQL_HOST,MYSQL_PORT:Number(process.env.TEST_MYSQL_PORT||3306),MYSQL_DATABASE:name,MYSQL_USER:process.env.TEST_MYSQL_USER,MYSQL_PASSWORD:process.env.TEST_MYSQL_PASSWORD,MYSQL_POOL_SIZE:6,MYSQL_SSL:'false',CONFIG_ENCRYPTION_KEY:'1'.repeat(64),SHEETS_REQUESTS_PER_MINUTE:40};
  const pool=poolFor(config);t.after(()=>pool.end());await migrate(pool);
  const [[{n}]]=await pool.query('SELECT COUNT(*) n FROM entities');assert.equal(Number(n),0,'Test yêu cầu DB test rỗng; không đụng dữ liệu đã có.');
  const key='TestAttendance',headers=['ID','FullName','WeightKg','Bags'];
  await saveEntity(pool,{name:key,tabName:key,headers,retentionDays:7});
  await saveSettings(pool,config.CONFIG_ENCRYPTION_KEY,{spreadsheetId:'test-only-spreadsheet-123456',intervalMinutes:60,batchSize:20,enabled:false,serviceAccount:{client_email:'test@example.invalid',private_key:'-----BEGIN PRIVATE KEY----- test -----END PRIVATE KEY-----'}});
  const sheetRows=new Map(),fake={ensureHeader:async()=>[...headers,'__dd_version','__dd_deleted_at','__dd_business_at','__dd_finalized_at'],read:async()=>[],writeRows:async(e,rows)=>{for(const row of rows)sheetRows.set(row.sheet_row,structuredClone(row));}};
  const tickOptions={sheetsFactory:()=>fake};
  await enqueue(pool,'import',key);await tick(pool,config,tickOptions);
  const create={requestId:'test-create-001',operations:[{action:'create',entity:key,id:'test-record-1',data:{FullName:'A',WeightKg:15000.125,Bags:0}}]};
  const [a,b]=await Promise.all([mutate(pool,create),mutate(pool,create)]);assert(a.durable&&b.durable);assert.equal(a.records[0].id,b.records[0].id);assert.equal((await listRecords(pool,key)).items.length,1);
  await assert.rejects(()=>mutate(pool,{...create,operations:[{...create.operations[0],data:{FullName:'B'}}]}),{code:'REQUEST_KEY_REUSED'});
  const update={requestId:'test-update-001',operations:[{action:'update',entity:key,id:'test-record-1',expectedVersion:1,data:{FullName:'B'}}]};
  const changed=await mutate(pool,update);assert.equal(changed.records[0].version,2);assert.equal(changed.records[0].data.WeightKg,15000.125);
  await assert.rejects(()=>mutate(pool,{...update,requestId:'test-update-stale'}),{code:'VERSION_CONFLICT'});
  await assert.rejects(()=>mutate(pool,{requestId:'test-rollback-001',operations:[{action:'create',entity:key,id:'a-first',data:{FullName:'C'}},{action:'update',entity:key,id:'z-missing',data:{FullName:'D'},expectedVersion:1}]}),{code:'RECORD_NOT_FOUND'});
  assert(!(await listRecords(pool,key)).items.some(r=>r.id==='a-first'));
  // Simulate a write that reached Sheets but whose HTTP response was lost.
  const unreliable={...fake,writeRows:async(e,rows)=>{await fake.writeRows(e,rows);throw Object.assign(Error('network'),{code:'NETWORK_ERROR'});}};
  await enqueue(pool,'sync');await tick(pool,config,{sheetsFactory:()=>unreliable});
  let [[row]]=await pool.query('SELECT * FROM records WHERE entity=? AND id=?',[key,'test-record-1']);assert.equal(publicRecord(row).syncStatus,'pending');
  const position=[...sheetRows.keys()][0];
  const [[failure]]=await pool.query('SELECT * FROM sync_record_failures WHERE entity=? AND id=?',[key,'test-record-1']);
  assert.equal(Number(failure.attempts),1);assert.equal(failure.error_code,'NETWORK_ERROR');assert(failure.next_attempt_at);
  // Restart must preserve per-record backoff, even if the job itself is due.
  await pool.query('UPDATE sync_record_failures SET next_attempt_at=UTC_TIMESTAMP(3)+INTERVAL 1 HOUR WHERE entity=? AND id=?',[key,'test-record-1']);
  await pool.query("UPDATE jobs SET state='running',available_at=UTC_TIMESTAMP(3) WHERE kind='sync'");
  let prematureWrites=0;
  await tick(pool,config,{sheetsFactory:()=>({...fake,writeRows:async()=>{prematureWrites++;}})});
  assert.equal(prematureWrites,0);
  [[row]]=await pool.query('SELECT * FROM records WHERE entity=? AND id=?',[key,'test-record-1']);assert.equal(Number(row.synced_version),0);assert.equal(row.dirty,1);
  // Advance only this fixture's retry schedule instead of sleeping in the test.
  await pool.query('UPDATE sync_record_failures SET next_attempt_at=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE entity=? AND id=?',[key,'test-record-1']);
  await pool.query("UPDATE jobs SET state='running',available_at=UTC_TIMESTAMP(3) WHERE kind='sync'");
  await tick(pool,config,tickOptions);assert.equal(sheetRows.size,1);assert.equal([...sheetRows.keys()][0],position);
  [[row]]=await pool.query('SELECT * FROM records WHERE entity=? AND id=?',[key,'test-record-1']);assert.equal(Number(row.synced_version),2);assert.equal(row.dirty,0);
  const [failures]=await pool.query('SELECT * FROM sync_record_failures WHERE entity=? AND id=?',[key,'test-record-1']);assert.equal(failures.length,0);
  // Active rows survive retention even if their business date is old.
  await pool.query('UPDATE records SET business_at=UTC_TIMESTAMP(3)-INTERVAL 20 DAY,updated_at=UTC_TIMESTAMP(3)-INTERVAL 20 DAY WHERE entity=?',[key]);
  assert.equal(await cleanup(pool),0);
  await pool.query('UPDATE records SET finalized_at=UTC_TIMESTAMP(3)-INTERVAL 20 DAY WHERE entity=?',[key]);assert.equal(await cleanup(pool),1);
  assert.equal((await listRecords(pool,key)).items.length,0);
  await assert.rejects(()=>mutate(pool,{...create,requestId:'test-recreate-001'}),{code:'ID_EXISTS'});
  // Remove only this isolated test database's fixture rows. No DROP, no production env.
  for(const table of ['records','row_map','entities','sync_runs'])await pool.query(`DELETE FROM ${table} WHERE ${table==='entities'?'name':'entity'}=?`,[key]);
  await pool.query('DELETE FROM requests WHERE id LIKE ?',['test-%']);await pool.query('DELETE FROM jobs');await pool.query('DELETE FROM settings WHERE id=1');
});
