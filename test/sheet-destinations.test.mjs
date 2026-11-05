import test from 'node:test';
import assert from 'node:assert/strict';
import {syncDestinations,configuredTargets} from '../src/sheetDestinations.js';
import {Sheets} from '../src/sheets.js';
const entity={name:'Test',tab_name:'Test',headers:['ID'],bootstrap_state:'ready'};
function fixture(){
  const rows=[{id:'a',version:1,synced_version:0,dirty:1,data:{ID:'a'}},{id:'b',version:1,synced_version:0,dirty:1,data:{ID:'b'}}];
  const locations=new Map(),states=new Map(),writes=[],failures=new Map(),batches=[];
  const logicalRows=new Map();
  const put=(recordId,location)=>{
    if([...locations].some(([owner,l])=>owner!==recordId&&l.spreadsheet_id===location.spreadsheet_id&&l.sheet_row===location.sheet_row))throw Object.assign(Error('duplicate physical position'),{code:'ER_DUP_ENTRY'});
    locations.set(recordId,location);
  };
  const query=async(sql,a=[])=>{
    if(sql.startsWith('SELECT r.*'))return [rows.filter(r=>r.dirty)];
    if(sql.startsWith('SELECT * FROM sheet_locations'))return [[locations.get(a[1])].filter(Boolean)];
    if(sql.startsWith('SELECT * FROM sheet_destination_state'))return [a.length===2?[states.get(a[1])]:[...states.values()]];
    if(sql.startsWith('SELECT sheet_row FROM row_map'))return [[{sheet_row:logicalRows.get(a[1])??rows.findIndex(r=>r.id===a[1])+2}]];
    if(sql.startsWith('INSERT IGNORE INTO sheet_destination_state')){if(!states.has(a[1]))states.set(a[1],{spreadsheet_id:a[1],next_row:a[2],exhausted:0});}
    if(sql.includes('INTO sheet_locations'))put(a[1],{spreadsheet_id:a[2],tab_name:a[3],sheet_row:a[4],write_attempted:0});
    if(sql.startsWith('UPDATE sheet_locations SET spreadsheet_id'))put(a[4],{spreadsheet_id:a[0],tab_name:a[1],sheet_row:a[2],write_attempted:0});
    if(sql.startsWith('UPDATE sheet_locations SET sheet_row'))put(a[2],{...locations.get(a[2]),sheet_row:a[0],...(sql.includes('write_attempted=1')?{write_attempted:1}:{})});
    if(sql.startsWith('UPDATE sheet_destination_state SET next_row'))states.get(a[2]).next_row=Math.max(states.get(a[2]).next_row,a[0]);
    if(sql.startsWith('UPDATE sheet_destination_state SET exhausted'))states.get(a[2]).exhausted=1;
    if(sql.startsWith('UPDATE sheet_locations SET write_attempted'))locations.get(a[1]).write_attempted=1;
    if(sql.startsWith('UPDATE records SET synced_version')){const r=rows.find(r=>r.id===a[3]);r.synced_version=a[0];r.dirty=0;}
    return [[]];
  };
  let snapshot;
  const restore=(map,entries)=>{map.clear();for(const entry of entries)map.set(...entry);};
  const conn={query,beginTransaction:async()=>{snapshot=structuredClone({locations:[...locations],states:[...states]});},commit:async()=>{},rollback:async()=>{restore(locations,snapshot.locations);restore(states,snapshot.states);},release:()=>{}};
  const pool={query,getConnection:async()=>conn};
  const config={spreadsheetId:'primary',spreadsheetTargets:[{spreadsheetId:'next'},{spreadsheetId:'third'}]};
  const make=id=>({config:{...config,spreadsheetId:id},call:async()=>({sheets:[{properties:{title:'Test'}}]}),read:async()=>[],ensureHeader:async()=>{},prepareDestination:async()=>{},ensureCapacity:async()=>{const e=failures.get(id);if(e)throw Object.assign(Error(e),{code:e});},writeRows:async(e,r)=>{batches.push(r.length);for(const row of r)writes.push([id,row.id,row.sheet_row]);}});
  const sheets=make('primary');sheets.forSpreadsheet=make;
  return {rows,locations,states,writes,failures,pool,sheets,batches,logicalRows};
}
test('confirmed full files roll forward, persist reservations and retain logical source',async()=>{
  const f=fixture();f.failures.set('primary','SHEET_CAPACITY_EXHAUSTED');f.failures.set('next','SHEET_CAPACITY_EXHAUSTED');
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),2);
  assert.deepEqual(f.writes,[['third','a',2],['third','b',3]]);
  assert.deepEqual(f.batches,[2]);
  f.rows[0].version=2;f.rows[0].dirty=1;
  await syncDestinations(f.pool,entity,f.sheets,100);
  assert.deepEqual(f.writes.at(-1),['third','a',2]);
  assert.equal(f.sheets.config.spreadsheetId,'primary');
});
test('permission, quota and network failures never switch destination',async()=>{
  for(const code of ['GOOGLE_HTTP_403','GOOGLE_HTTP_429','ECONNRESET']){
    const f=fixture();f.failures.set('primary',code);
    await assert.rejects(()=>syncDestinations(f.pool,entity,f.sheets,100),{code});
    assert.equal(f.locations.get('a').spreadsheet_id,'primary');assert.equal(f.writes.length,0);
  }
});
test('ambiguous prior writes retain their file and other files still progress',async()=>{
  const f=fixture();f.locations.set('a',{spreadsheet_id:'primary',tab_name:'Test',sheet_row:2,write_attempted:1});
  f.states.set('primary',{spreadsheet_id:'primary',next_row:3,exhausted:0});
  f.locations.set('b',{spreadsheet_id:'next',tab_name:'Test',sheet_row:2,write_attempted:0});
  f.failures.set('primary','SHEET_CAPACITY_EXHAUSTED');
  await assert.rejects(()=>syncDestinations(f.pool,entity,f.sheets,100),{code:'SHEET_CAPACITY_EXHAUSTED'});
  assert.equal(f.locations.get('a').spreadsheet_id,'primary');assert.deepEqual(f.writes,[['next','b',2]]);
});
test('only specific Google cell-capacity errors classify as exhaustion',async()=>{
  for(const [status,message,code] of [[400,'This action would increase the number of cells in the workbook above the limit of 10000000 cells.','SHEET_CAPACITY_EXHAUSTED'],[400,'Invalid range','GOOGLE_HTTP_400'],[403,'Cell limit exceeded','GOOGLE_HTTP_403']]){
    const s=new Sheets({spreadsheetId:'x',serviceAccount:{client_email:'x',private_key:'x'}},{gate:async()=>{},fetchImpl:async()=>new Response(JSON.stringify({error:{message}}),{status})});
    s.auth.getAccessToken=async()=>({token:'test'});await assert.rejects(()=>s.test(),{code});
  }
});
test('target order keeps original source first and ignores disabled duplicates',()=>{
  assert.deepEqual(configuredTargets({spreadsheetId:'a',spreadsheetTargets:[{spreadsheetId:'a'},{spreadsheetId:'b',enabled:false},{spreadsheetId:'c'}]}).map(t=>t.spreadsheetId),['a','c']);
});
test('one file uses one lookup and one write for the configured batch',async()=>{
  const f=fixture();let lookups=0;
  f.sheets.locateRows=async(e,rows)=>{lookups++;return {ready:rows,conflicts:[],positions:new Map()};};
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),2);
  assert.equal(lookups,1);assert.deepEqual(f.batches,[2]);
});
test('timeout survives restart without moving an unacknowledged reservation',async()=>{
  const f=fixture();f.rows.splice(1);
  f.sheets.writeRows=async()=>{throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});};
  await assert.rejects(()=>syncDestinations(f.pool,entity,f.sheets,100),{code:'ETIMEDOUT'});
  assert.equal(f.locations.get('a').write_attempted,1);
  f.failures.set('primary','SHEET_CAPACITY_EXHAUSTED');
  await assert.rejects(()=>syncDestinations(f.pool,entity,f.sheets,100),{code:'SHEET_CAPACITY_EXHAUSTED'});
  assert.equal(f.locations.get('a').spreadsheet_id,'primary');
});
test('full-file new rows roll forward while existing rows update in their original grid',async()=>{
  const f=fixture();f.rows[0].synced_version=1;f.rows[0].version=2;
  f.locations.set('a',{spreadsheet_id:'primary',tab_name:'Test',sheet_row:2,write_attempted:1});
  f.states.set('primary',{spreadsheet_id:'primary',next_row:3,exhausted:0});
  const checked=[];f.sheets.ensureCapacity=async(e,last)=>{checked.push(last);if(last>2)throw Object.assign(Error('full'),{code:'SHEET_CAPACITY_EXHAUSTED'});};
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),2);
  assert.deepEqual(checked,[3,2]);
  assert.deepEqual(f.writes,[['primary','a',2],['next','b',2]]);
  assert.equal(f.locations.get('a').spreadsheet_id,'primary');assert.equal(f.rows[0].dirty,0);
});
test('a moved delivery and unrelated far occupant advance the next physical reservation',async()=>{
  const f=fixture();f.rows[0].synced_version=1;f.rows[1].dirty=0;
  f.locations.set('a',{spreadsheet_id:'next',tab_name:'Test',sheet_row:2,write_attempted:1});
  f.states.set('primary',{spreadsheet_id:'primary',next_row:4,exhausted:1});
  f.states.set('next',{spreadsheet_id:'next',next_row:3,exhausted:0});
  const grid=new Map([[7,'a'],[20,'external']]);
  const next={...f.sheets,config:{...f.sheets.config,spreadsheetId:'next'},prepareDestination:async()=>{},read:async range=>{
    if(range==="'Test'!A2:A")return Array.from({length:19},(_,i)=>grid.has(i+2)?[grid.get(i+2)]:[]);
    const row=Number(range.match(/A(\d+):/)?.[1]);return grid.has(row)?[[grid.get(row)]]:[];
  },locateRows:Sheets.prototype.locateRows,writeRows:async(e,rows)=>{for(const row of rows){assert(!grid.has(row.sheet_row)||grid.get(row.sheet_row)===row.id);grid.set(row.sheet_row,row.id);f.writes.push(['next',row.id,row.sheet_row]);}}};
  f.sheets.forSpreadsheet=id=>{assert.equal(id,'next');return next;};
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),1);
  assert.equal(f.locations.get('a').sheet_row,7);assert.equal(f.states.get('next').next_row,21);
  f.rows[1].dirty=1;
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),1);
  assert.equal(f.locations.get('b').sheet_row,21);assert.equal(grid.get(20),'external');
  assert.deepEqual(f.writes,[['next','a',7],['next','b',21]]);
});
test('allocation collisions preserve the existing owner and other files still deliver',async()=>{
  const f=fixture();
  f.states.set('primary',{spreadsheet_id:'primary',next_row:4,exhausted:1});
  f.states.set('next',{spreadsheet_id:'next',next_row:2,exhausted:0});
  f.locations.set('owner',{spreadsheet_id:'next',tab_name:'Test',sheet_row:2,write_attempted:1});
  f.locations.set('b',{spreadsheet_id:'third',tab_name:'Test',sheet_row:2,write_attempted:0});
  await assert.rejects(()=>syncDestinations(f.pool,entity,f.sheets,100),{code:'ER_DUP_ENTRY'});
  assert.equal(f.locations.has('a'),false);assert.equal(f.locations.get('owner').sheet_row,2);
  assert.deepEqual(f.writes,[['third','b',2]]);assert.equal(f.rows[1].dirty,0);
});
test('reconciliation collisions roll back mappings and never overwrite another owner',async()=>{
  const f=fixture();f.rows[1].dirty=0;f.rows[0].synced_version=1;
  f.locations.set('a',{spreadsheet_id:'primary',tab_name:'Test',sheet_row:2,write_attempted:1});
  f.locations.set('owner',{spreadsheet_id:'primary',tab_name:'Test',sheet_row:7,write_attempted:1});
  f.states.set('primary',{spreadsheet_id:'primary',next_row:4,exhausted:0});
  f.sheets.locateRows=async(e,rows)=>({ready:rows.map(row=>({...row,sheet_row:7})),conflicts:[],positions:new Map([['a',[7]]])});
  await assert.rejects(()=>syncDestinations(f.pool,entity,f.sheets,100),{code:'ER_DUP_ENTRY'});
  assert.equal(f.locations.get('a').sheet_row,2);assert.equal(f.locations.get('owner').sheet_row,7);
  assert.equal(f.states.get('primary').next_row,8);assert.equal(f.writes.length,0);
});
test('legacy acknowledgement loss pins an already-written ID at its actual original row',async()=>{
  const f=fixture();f.rows.splice(1);f.logicalRows.set('a',100);
  let lookups=0;
  f.sheets.read=async()=>{lookups++;return [[],[],[],[],[],['a']];};
  f.sheets.ensureCapacity=async(e,last)=>{if(last>10)throw Object.assign(Error('full'),{code:'SHEET_CAPACITY_EXHAUSTED'});};
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),1);
  assert.equal(lookups,1);assert.deepEqual(f.writes,[['primary','a',7]]);
  assert.equal(f.locations.get('a').write_attempted,1);assert.equal(f.rows[0].synced_version,1);
  f.rows[0].dirty=1;f.rows[0].version=2;
  await syncDestinations(f.pool,entity,f.sheets,100);
  assert.deepEqual(f.writes.at(-1),['primary','a',7]);assert.equal(lookups,1);
});
test('legacy ID absence is positively read before rollover; failed lookups never authorize moving',async()=>{
  const absent=fixture();absent.rows.splice(1);absent.failures.set('primary','SHEET_CAPACITY_EXHAUSTED');
  let lookups=0;absent.sheets.read=async()=>{lookups++;return [];};
  assert.equal(await syncDestinations(absent.pool,entity,absent.sheets,100),1);
  assert.equal(lookups,1);assert.deepEqual(absent.writes,[['next','a',2]]);
  const failed=fixture();failed.rows.splice(1);failed.failures.set('primary','SHEET_CAPACITY_EXHAUSTED');
  failed.sheets.read=async()=>{throw Object.assign(Error('offline'),{code:'ECONNRESET'});};
  for(let retry=0;retry<2;retry++){
    await assert.rejects(()=>syncDestinations(failed.pool,entity,failed.sheets,100),{code:'ECONNRESET'});
    assert.equal(failed.locations.get('a').spreadsheet_id,'primary');assert.equal(failed.writes.length,0);
  }
});
test('a missing fallback tab at workbook capacity is proved absent before advancing again',async()=>{
  const f=fixture();f.rows.splice(1);f.failures.set('primary','SHEET_CAPACITY_EXHAUSTED');
  const original=f.sheets.forSpreadsheet;
  let metadata=0,missingTabReads=0;
  f.sheets.forSpreadsheet=id=>id==='next'?{...original(id),prepareDestination:async()=>{throw Object.assign(Error('full adding tab'),{code:'SHEET_CAPACITY_EXHAUSTED'});},call:async()=>{metadata++;return {sheets:[]};},read:async()=>{missingTabReads++;throw Error('tab absent');}}:original(id);
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),1);
  assert.equal(metadata,1);assert.equal(missingTabReads,0);assert.deepEqual(f.writes,[['third','a',2]]);
});
test('saved exhaustion on restart still checks unmapped legacy IDs in the primary',async()=>{
  const f=fixture();f.rows.splice(1);f.states.set('primary',{spreadsheet_id:'primary',next_row:100,exhausted:1});
  f.sheets.read=async()=>[[],[],['a']];
  assert.equal(await syncDestinations(f.pool,entity,f.sheets,100),1);
  assert.deepEqual(f.writes,[['primary','a',4]]);assert.equal(f.locations.get('a').write_attempted,1);
});
