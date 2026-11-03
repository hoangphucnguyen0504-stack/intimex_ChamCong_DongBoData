import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeRows,readRows,unchangedStateChunks} from '../src/chamCong.js';
import {encrypt,digest} from '../src/core.js';
const key='1'.repeat(64),spreadsheetId='fixture-sheet-1234567890',headers=['ID','CreatedAt','FullName'];
const body={spreadsheetId,entity:'Attendance',headers,requestId:'integration-request-1',changes:[{op:'append',recordId:'ATT-1',rowValues:['ATT-1','2026-10-19T01:00:00Z','Name']}],guards:['guard_revision']};
function fixture({entity='Attendance',entityHeaders=headers,existing=[]}={}){
 const calls=[],receipts=new Map();let guardExists=false;
 const query=async(sql,args=[])=>{
  calls.push({sql,args});if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId},key)}]];
  if(sql.startsWith('INSERT IGNORE INTO requests')){if(!receipts.has(args[0]))receipts.set(args[0],{fingerprint:args[1],response:null});return [{}];}
  if(sql.startsWith('SELECT * FROM requests'))return [[receipts.get(args[0])]];
  if(sql.startsWith('UPDATE requests')){receipts.get(args[1]).response=args[0];return [{}];}
  if(sql.startsWith('SELECT * FROM entities'))return [[{name:entity,headers:entityHeaders,bootstrap_state:'ready',next_row:5}]];
  if(sql.startsWith('SELECT * FROM records'))return [existing];
  if(sql.startsWith('SELECT * FROM row_map'))return [existing.map(row=>({id:row.id,sheet_row:2}))];
  if(sql.startsWith('INSERT INTO record_guards')){if(guardExists)throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});guardExists=true;return [{}];}
  return [{}];
 };
 const conn={query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
 return {calls,pool:{query,getConnection:async()=>conn}};
}
test('old queued vehicle updates preserve newer Seal fields after additive schema upgrade',async()=>{
 const legacy=['ID','CreatedAt','Container'],current=[...legacy,'Seal','Seal2'];
 const f=fixture({entity:'VehicleTrips',entityHeaders:current,existing:[{id:'TRIP-1',version:2,data:{ID:'TRIP-1',Container:'CONT1',Seal:'KEEP',Seal2:'KEEP2'}}]});
 await writeRows(f.pool,key,{spreadsheetId,entity:'VehicleTrips',headers:legacy,requestId:'legacy-update-request',changes:[{op:'update',recordId:'TRIP-1',rowValues:['TRIP-1','','CONT1']}],guards:[]});
 const saved=JSON.parse(f.calls.find(call=>call.sql.startsWith('INSERT INTO records')).args[2]);
 assert.equal(saved.Seal,'KEEP');assert.equal(saved.Seal2,'KEEP2');
 const unsafe={spreadsheetId,entity:'VehicleTrips',headers:['ID','Changed'],requestId:'unsafe-request',changes:[{op:'update',recordId:'TRIP-1',rowValues:['TRIP-1','x']}],guards:[]};
 await assert.rejects(()=>writeRows(f.pool,key,unsafe),{code:'ENTITY_SCHEMA_MISMATCH'});
});
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
test('state key reads only the latest revision of that key',async()=>{
 const f=readPool([{id:'AST-1',data:JSON.stringify({ID:'AST-1',Key:'runtime-config',Revision:'rev-9',Value:'{}'}),sheet_row:2}]);
 const original=f.pool.query;
 f.pool.query=async(sql,args)=>sql.includes('ORDER BY r.updated_at DESC')?[[{revision:'rev-9'}]]:original(sql,args);
 await readRows(f.pool,key,'ApplicationState',{spreadsheetId,key:'runtime-config'});
 const query=f.calls.find(c=>c.sql.startsWith('SELECT r.id'));
 assert.equal(query.sql.includes("JSON_EXTRACT(r.data,'$.Key')"),true);
 assert.equal(query.sql.includes("JSON_EXTRACT(r.data,'$.Revision')"),true);
 assert.equal(query.args.at(-3),'runtime-config');
 assert.equal(query.args.at(-2),'rev-9');
 await assert.rejects(()=>readRows(f.pool,key,'ApplicationState',{spreadsheetId,key:'bad key'}),{code:'INVALID_PAGE'});
 const longKey='@state/gate/submission-cooldown/'+'sheet'.repeat(11)+'/VEHICLE_IN/'+'a'.repeat(64)+'/'+'b'.repeat(64);
 const longPage=await readRows(f.pool,key,'ApplicationState',{spreadsheetId,key:longKey});
 assert.equal(longPage.ok,true);
 await assert.rejects(()=>readRows(f.pool,key,'ApplicationState',{spreadsheetId,key:'k'.repeat(513)}),{code:'INVALID_PAGE'});
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
test('identical ApplicationState chunk keeps version and existing pending acknowledgement',async()=>{
 const stateHeaders=['ID','Key','Revision','Value'];
 const data={ID:'state:18',Key:'state-key',Revision:'r1',Value:'chunk'};
 const f=fixture({entity:'ApplicationState',entityHeaders:stateHeaders,existing:[{id:data.ID,data,version:1226,dirty:1,synced_version:99}]});
 const result=await writeRows(f.pool,key,{spreadsheetId,entity:'ApplicationState',headers:stateHeaders,requestId:'state-noop-test',guards:[],changes:[{op:'append',recordId:data.ID,rowValues:stateHeaders.map(h=>data[h])}]});
 assert.equal(result.records[0].version,1226);assert.equal(result.records[0].syncStatus,'pending');
 assert(!f.calls.some(c=>c.sql.startsWith('INSERT INTO records')));
});
test('stable state ignores transport revision/time only for a complete unchanged group',()=>{
 const fields=['ID','CreatedAt','Key','Revision','Part','Value','Parts','Checksum'];
 const prefix=digest('runtime-config').slice(0,24),checksum=digest('firstsecond');
 const old=[0,1].map(i=>({id:prefix+':'+i,data:{ID:prefix+':'+i,CreatedAt:'old-time',Key:'runtime-config',Revision:'old-rev',Part:String(i),Value:i?'second':'first',Parts:'2',Checksum:checksum}}));
 const changes=old.map(row=>({op:'append',recordId:row.id,rowValues:fields.map(h=>h==='CreatedAt'?'new-time':h==='Revision'?'new-rev':row.data[h])}));
 const body={entity:'ApplicationState',headers:fields,changes};
 assert.equal(unchangedStateChunks(body,old).size,2);
 assert.equal(unchangedStateChunks({...body,changes:changes.slice(0,1)},old).size,0);
 const changed=structuredClone(body);changed.changes[1].rowValues[5]='modified';
 assert.equal(unchangedStateChunks(changed,old).size,0);
 const mixed=structuredClone(old);mixed[1].data.Revision='incomplete-old';
 assert.equal(unchangedStateChunks(body,mixed).size,0);
});
test('record id and one column do not page the whole sheet',async()=>{
 const data=JSON.stringify({ID:'TRP-1',CreatedAt:'2026-10-20T02:00:00Z',FullName:'TAI XE'});
 const f=readPool([{id:'TRP-1',data,sheet_row:4}]);
 const page=await readRows(f.pool,key,'Attendance',{spreadsheetId,id:'TRP-1'});
 assert.equal(page.rows[0][0],'TRP-1');
 assert.equal(f.calls.some(c=>c.sql.includes('r.id=?')&&c.args[1]==='TRP-1'),true);
 assert.equal(f.calls.some(c=>c.sql.includes('LIMIT ?')),false);
 await assert.rejects(()=>readRows(f.pool,key,'Attendance',{spreadsheetId,column:'Missing',value:'A'}),{code:'INVALID_PAGE'});
 const named=await readRows(f.pool,key,'Attendance',{spreadsheetId,column:'FullName',value:'TAI XE',status:'ON_SITE'});
 const lookup=f.calls.find(c=>c.sql.includes('$.FullName'));
 assert.equal(lookup.args[1],'TAI XE');
 assert.equal(lookup.args[2],'ON_SITE');
 assert.equal(named.rows[0][2],'TAI XE');
 const setting=await readRows(f.pool,key,'Attendance',{spreadsheetId,id:'security.adminIdleMinutes'});
 assert.equal(setting.ok,true);
 assert.equal(f.calls.some(c=>c.args.includes('security.adminIdleMinutes')),true);
 await assert.rejects(()=>readRows(f.pool,key,'Attendance',{spreadsheetId,id:'bad\nid'}),{code:'INVALID_PAGE'});
});
