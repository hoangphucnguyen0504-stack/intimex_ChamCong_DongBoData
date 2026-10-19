import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeRows,readRows} from '../src/chamCong.js';
import {encrypt} from '../src/core.js';
const key='1'.repeat(64),spreadsheetId='fixture-sheet-1234567890',headers=['ID','CreatedAt','FullName'];
const body={spreadsheetId,entity:'Attendance',headers,requestId:'integration-request-1',changes:[{op:'append',recordId:'ATT-1',rowValues:['ATT-1','2026-10-19T01:00:00Z','Name']}],guards:['guard_revision']};
function fixture(){
 const calls=[],receipts=new Map();let guardExists=false;
 const query=async(sql,args=[])=>{
  calls.push({sql,args});if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId},key)}]];
  if(sql.startsWith('INSERT IGNORE INTO requests')){if(!receipts.has(args[0]))receipts.set(args[0],{fingerprint:args[1],response:null});return [{}];}
  if(sql.startsWith('SELECT * FROM requests'))return [[receipts.get(args[0])]];
  if(sql.startsWith('UPDATE requests')){receipts.get(args[1]).response=args[0];return [{}];}
  if(sql.startsWith('SELECT * FROM entities'))return [[{name:'Attendance',headers,bootstrap_state:'ready',next_row:5}]];
  if(sql.startsWith('SELECT * FROM records')||sql.startsWith('SELECT * FROM row_map'))return [[]];
  if(sql.startsWith('INSERT INTO record_guards')){if(guardExists)throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});guardExists=true;return [{}];}
  return [{}];
 };
 const conn={query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
 return {calls,pool:{query,getConnection:async()=>conn}};
}
test('integration replay keeps one mutation and reserves its row before acknowledging',async()=>{
 const f=fixture(),one=await writeRows(f.pool,key,body),two=await writeRows(f.pool,key,body);
 assert(one.durable&&two.durable);assert(two.replayed);assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO records')).length,1);
 assert.deepEqual(f.calls.find(c=>c.sql.startsWith('INSERT INTO row_map')).args,['Attendance','ATT-1',5]);
});
test('integration rejects cross-project source and revision guard collisions',async()=>{
 const f=fixture();await assert.rejects(()=>writeRows(f.pool,key,{...body,spreadsheetId:'other-source-123456789'}),{code:'SOURCE_MISMATCH'});
 await writeRows(f.pool,key,body);
 await assert.rejects(()=>writeRows(f.pool,key,{...body,requestId:'another-request-2'}),{code:'QUALITY_REVISION'});
});
test('integration reads refuse incomplete imports',async()=>{
 const f=fixture(),original=f.pool.query;f.pool.query=async(sql,args)=>sql.startsWith('SELECT * FROM entities')?[[{bootstrap_state:'new'}]]:original(sql,args);
 await assert.rejects(()=>readRows(f.pool,key,'Attendance',{spreadsheetId}),{code:'IMPORT_REQUIRED'});
});
test('integration refuses retention that would silently remove report history',async()=>{
 const f=fixture(),original=f.pool.query;f.pool.query=async(sql,args)=>sql.startsWith('SELECT * FROM entities')?[[{bootstrap_state:'ready',retention_days:7}]]:original(sql,args);
 await assert.rejects(()=>readRows(f.pool,key,'Attendance',{spreadsheetId}),{code:'RETENTION_REQUIRES_HISTORY'});
});
