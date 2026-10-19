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
function readPool(rows,{unmapped=0}={}){
 const calls=[],query=async(sql,args=[])=>{
  calls.push({sql,args});
  if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId},key)}]];
  if(sql.startsWith('SELECT * FROM entities'))return [[{name:'Attendance',headers,bootstrap_state:'ready',retention_days:0,next_row:20}]];
  if(sql.startsWith('SELECT COUNT(*)'))return [[{n:unmapped}]];
  if(sql.startsWith('SELECT r.id'))return [rows];
  return [{}];
 };
 return {calls,pool:{query}};
}
test('ids view returns record ids and does not select json data',async()=>{
 const f=readPool([{id:'ATT-1',sheet_row:2},{id:'ATT-2',sheet_row:3}]);
 const page=await readRows(f.pool,key,'Attendance',{spreadsheetId,view:'ids'});
 const query=f.calls.find(c=>c.sql.startsWith('SELECT r.id'));
 assert.equal(query.sql.includes('r.data'),false);
 assert.equal(query.args.at(-1),50001);
 assert.deepEqual(page,{ok:true,headers,rows:[['ATT-1'],['ATT-2']],upper:19,hasMore:false,nextAfter:null});
});
test('limit above 50000 is an invalid page',async()=>{
 const f=fixture();
 await assert.rejects(()=>readRows(f.pool,key,'Attendance',{spreadsheetId,limit:50001}),{code:'INVALID_PAGE'});
 await assert.rejects(()=>readRows(f.pool,key,'Attendance',{spreadsheetId,view:'full'}),{code:'INVALID_PAGE'});
});
test('unmapped count runs only when after is 0',async()=>{
 const row={id:'ATT-9',data:JSON.stringify({ID:'ATT-9',CreatedAt:'',FullName:'A'}),sheet_row:9};
 const f=readPool([row],{unmapped:3});
 await assert.rejects(()=>readRows(f.pool,key,'Trips',{spreadsheetId}),{code:'UNMAPPED_RECORDS'});
 assert.equal(f.calls.filter(c=>c.sql.startsWith('SELECT COUNT(*)')).length,1);
 const page=await readRows(f.pool,key,'Trips',{spreadsheetId,after:4});
 assert.equal(f.calls.filter(c=>c.sql.startsWith('SELECT COUNT(*)')).length,1);
 assert.equal(page.rows.length,1);assert.equal(page.hasMore,false);assert.equal(page.nextAfter,null);
});
test('full page stops before the json byte cap',async()=>{
 const fat=id=>JSON.stringify({ID:id,CreatedAt:'',FullName:'x'.repeat(id==='A'?7100000:10)});
 const rows=[{id:'A',data:fat('A'),sheet_row:2},{id:'B',data:fat('B'),sheet_row:3},{id:'C',data:fat('C'),sheet_row:4}];
 const f=readPool(rows);
 const page=await readRows(f.pool,key,'Attendance',{spreadsheetId,limit:10});
 const dataQueries=f.calls.filter(c=>c.sql.startsWith('SELECT r.id'));
 assert.equal(dataQueries.length,1);
 assert.equal(dataQueries[0].sql.includes('r.data'),true);
 assert.equal(dataQueries[0].args.at(-1),11);
 assert.equal(page.rows.length,1);
 assert.equal(page.rows[0][0],'A');
 assert.equal(page.hasMore,true);
 assert.equal(page.nextAfter,2);
});
test('batch write preloads rows once in sorted id order',async()=>{
 const f=fixture();
 const changes=[
  {op:'append',recordId:'ATT-2',rowValues:['ATT-2','2026-10-19T01:00:00Z','B']},
  {op:'append',recordId:'ATT-1',rowValues:['ATT-1','2026-10-19T01:00:00Z','A']}
 ];
 await writeRows(f.pool,key,{...body,requestId:'batch-request-1',changes,guards:[]});
 const records=f.calls.filter(c=>c.sql.startsWith('SELECT * FROM records'));
 const maps=f.calls.filter(c=>c.sql.startsWith('SELECT * FROM row_map'));
 assert.equal(records.length,1);assert.equal(maps.length,1);
 assert.deepEqual(records[0].args,['Attendance','ATT-1','ATT-2']);
 assert.deepEqual(maps[0].args,['Attendance','ATT-1','ATT-2']);
 assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT INTO records')).length,2);
});
