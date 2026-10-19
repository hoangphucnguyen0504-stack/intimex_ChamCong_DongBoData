import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planAuditRepair,repairAuditRows} from '../src/repairAuditRows.js';
import {metadataHeaders} from '../src/core.js';
const entity={name:'AuditLogs',tab_name:'AuditLogs',headers:['ID','Action'],bootstrap_state:'ready',retention_days:0,next_row:4};
const row=(id,action=id)=>[id,action];
const record=(id,{synced=0,action=id}={})=>({id,data:{ID:id,Action:action},version:1,synced_version:synced,dirty:synced?0:1});
const values=(...rows)=>[['ID','Action',...metadataHeaders],...rows];
test('preserves Sheet-only log, moves new pending record after it, never shifts every row',()=>{
 const r=planAuditRepair(entity,values(row('a'),row('legacy')), [record('a',{synced:1}),record('new')],[{id:'a',sheet_row:2},{id:'new',sheet_row:3}]);
 assert.deepEqual(r.changes,[{id:'a',sheet_row:2},{id:'legacy',sheet_row:3},{id:'new',sheet_row:4}]);
 assert.equal(r.imports[0].id,'legacy');assert.equal(r.moved,1);assert.equal(r.nextRow,5);
});
test('already delivered pending ID reuses its Sheet row instead of duplicating',()=>{
 const r=planAuditRepair(entity,values(row('new'),row('a')),[record('a',{synced:1}),record('new')],[{id:'a',sheet_row:2},{id:'new',sheet_row:3}]);
 assert.equal(r.imports.length,0);assert.deepEqual(r.changes,[{id:'new',sheet_row:2},{id:'a',sheet_row:3}]);
});
test('repeat repair does not keep advancing pending row slots',()=>{
 const e={...entity,next_row:5};const r=planAuditRepair(e,values(row('a'),row('legacy')),[record('a',{synced:1}),record('legacy',{synced:1}),record('new')],[{id:'a',sheet_row:2},{id:'legacy',sheet_row:3},{id:'new',sheet_row:4}]);
 assert.equal(r.moved,0);assert.equal(r.nextRow,5);assert.equal(r.imports.length,0);
});
test('duplicates, content conflicts, missing delivered IDs, ID-less content and archived records stop repair',()=>{
 const cases=[
  [values(row('a'),row('a')),[],[],'DUPLICATE_SHEET_ID'],
  [values(row('a','changed')),[record('a')],[],'AUDIT_CONTENT_CONFLICT'],
  [values(),[record('a',{synced:1})],[],'AUDIT_DELIVERED_ID_MISSING'],
  [values(row('','data')),[],[],'SHEET_ROW_WITHOUT_ID'],
  [values(row('a')),[],[{id:'a',sheet_row:2,archived_at:new Date()}],'AUDIT_ARCHIVED_RECORD'],
 ];
 for(const [v,r,m,code]of cases)assert.throws(()=>planAuditRepair(entity,v,r,m),{code});
});
test('invalid header, retention and other entities are refused',()=>{
 assert.throws(()=>planAuditRepair(entity,[['ID']],[],[]),{code:'SHEET_HEADER_MISMATCH'});
 for(const patch of [{name:'VehicleTrips'},{retention_days:7},{bootstrap_state:'importing'}])assert.throws(()=>planAuditRepair({...entity,...patch},values(),[],[]),{code:'AUDIT_REPAIR_SCOPE'});
});
function database(){
 const events=[];
 const db={beginTransaction:async()=>events.push('begin'),commit:async()=>events.push('commit'),rollback:async()=>events.push('rollback'),release:()=>events.push('release'),query:async(sql,args)=>{
  events.push({sql,args});
  if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
  if(sql.startsWith('SELECT * FROM entities'))return [[entity]];
  if(sql.startsWith('SELECT encrypted'))return [[]];
  if(sql.startsWith('SELECT * FROM records'))return [[record('a',{synced:1}),record('new')]];
  if(sql.startsWith('SELECT * FROM row_map'))return [[{id:'a',sheet_row:2},{id:'new',sheet_row:3}]];
  return [{affectedRows:1}];
 }};
 return {pool:{getConnection:async()=>db},events};
}
test('dry run rolls back without changing mappings, receipts or Sheets',async()=>{
 const {pool,events}=database();
 const result=await repairAuditRows(pool,{}, {sheetsFactory:()=>({read:async()=>values(row('a'),row('legacy'))})});
 assert.equal(result.applied,false);assert.equal(result.imported,1);assert.equal(result.sheetsWrites,0);
 assert(events.includes('rollback'));assert(!events.includes('commit'));assert(!events.some(e=>/^(INSERT|UPDATE|DELETE)/.test(e.sql)));
});
test('apply imports missing log and remaps atomically without changing business payloads',async()=>{
 const {pool,events}=database();let reads=0;
 const result=await repairAuditRows(pool,{}, {apply:true,sheetsFactory:()=>({read:async()=>{reads++;return values(row('a'),row('legacy'));}})});
 assert.equal(result.applied,true);assert.equal(reads,2);assert(events.includes('commit'));assert(!events.includes('rollback'));
 assert(events.some(e=>e.sql?.startsWith('INSERT INTO records')&&e.args[0]==='legacy'));
 assert(events.some(e=>e.sql?.startsWith('UPDATE row_map SET sheet_row=?')&&e.args[0]===4&&e.args[1]==='new'));
 assert(!events.some(e=>/^(DELETE|UPDATE records)/.test(e.sql)));
});
test('changed Sheet aborts before SQL mutation and transaction rolls back',async()=>{
 const {pool,events}=database();let reads=0;
 await assert.rejects(()=>repairAuditRows(pool,{}, {apply:true,sheetsFactory:()=>({read:async()=>++reads===1?values(row('a'),row('legacy')):values(row('a'),row('legacy'),row('another'))})}),{code:'SHEET_CHANGED_DURING_REPAIR'});
 assert(events.includes('rollback'));assert(!events.some(e=>/^(INSERT|UPDATE|DELETE)/.test(e.sql)));
});
