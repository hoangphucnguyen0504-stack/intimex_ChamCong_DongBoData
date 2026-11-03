import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Sheets} from '../src/sheets.js';
const config={spreadsheetId:'test-sheet',serviceAccount:{client_email:'a@test.invalid',private_key:'not-used'}};
function adapter(responses=[]) {
  const calls=[],sheets=new Sheets(config,{gate:async()=>{},fetchImpl:async(url,o)=>{calls.push({url,...o});const result=responses.shift();if(result instanceof Response)return result;return new Response(JSON.stringify(result||{}),{status:200});}});
  sheets.auth.getAccessToken=async()=>({token:'test-only'});return {sheets,calls};
}
const e={tab_name:'VehicleTrips',headers:['ID','EstimatedWeightKg','EstimatedBagCount']};
test('retrying a write uses exactly the same row and RAW values; no append API',async()=>{
  const responses=()=>[{sheets:[{properties:{title:'VehicleTrips',sheetId:1,gridProperties:{rowCount:1000,columnCount:26}}}]},{valueRanges:[{values:[['TRP-1']]}]},{}];
  const {sheets,calls}=adapter([...responses(),...responses()]);
  const rows=[{id:'TRP-1',sheet_row:7,data:{ID:'TRP-1',EstimatedWeightKg:15000.125,EstimatedBagCount:0},version:3}];
  await sheets.writeRows(e,rows);await sheets.writeRows(e,rows);
  const writes=calls.filter(c=>c.url.endsWith('/values:batchUpdate'));assert.equal(writes.length,2);
  assert.equal(writes[0].body,writes[1].body);const payload=JSON.parse(writes[0].body);
  assert.equal(payload.valueInputOption,'RAW');assert.equal(payload.data[0].range,"'VehicleTrips'!A7");assert.equal(payload.data[0].values[0][1],15000.125);assert.equal(payload.data[0].values[0][2],0);
  assert(!calls.some(c=>c.url.includes('append')));
});
test('manual row move refuses overwrite and leaves delivery unacknowledged',async()=>{
  const {sheets,calls}=adapter([{sheets:[{properties:{title:'VehicleTrips',sheetId:1,gridProperties:{rowCount:1000,columnCount:26}}}]},{valueRanges:[{values:[['OTHER']]}]}]);
  await assert.rejects(()=>sheets.writeRows(e,[{id:'TRP-1',sheet_row:7,data:{},version:1}]),{code:'SHEET_ROW_MOVED'});assert.equal(calls.length,2);
});
test('429 exposes retry delay without returning credential or response body',async()=>{
  const {sheets}=adapter([new Response('sensitive diagnostic',{status:429,headers:{'Retry-After':'60'}})]);
  await assert.rejects(()=>sheets.read("'VehicleTrips'!A1"),e=>e.code==='GOOGLE_HTTP_429'&&e.retryAfterMs===60000&&!e.message.includes('sensitive'));
});
test('initialization refuses incompatible headers and adds technical columns only at the end',async()=>{
  const first=adapter([{values:[['ID','Wrong']]}]);await assert.rejects(()=>first.sheets.ensureHeader(e),{code:'SHEET_HEADER_MISMATCH'});
  const second=adapter([{values:[e.headers]},{}]);await second.sheets.ensureHeader(e);
  const data=JSON.parse(second.calls[1].body).data[0].values[0];assert.deepEqual(data.slice(0,3),e.headers);assert.equal(data[3],'__dd_version');
});
test('row lookup recovers unique moved IDs and rejects duplicate or missing acknowledged IDs',async()=>{
  const {sheets}=adapter([{values:[['OTHER'],[],['TRP-1'],['DUP'],['DUP']]}]);
  const result=await sheets.locateRows(e,[
    {id:'TRP-1',sheet_row:7,synced_version:2},
    {id:'DUP',sheet_row:8,synced_version:1},
    {id:'GONE',sheet_row:9,synced_version:1}
  ]);
  assert.equal(result.ready[0].sheet_row,4);
  assert.deepEqual(result.conflicts.map(c=>c.code),['DUPLICATE_SHEET_ID','SHEET_ID_MISSING']);
});
test('lost acknowledgement finds existing delivery instead of allocating a duplicate',async()=>{
  const {sheets}=adapter([{values:[[],['TRP-1']]}]);
  const result=await sheets.locateRows(e,[{id:'TRP-1',sheet_row:7,synced_version:0}]);
  assert.equal(result.ready[0].sheet_row,3);assert.equal(result.conflicts.length,0);
});
test('new delivery refuses nonempty row even when its ID cell is empty',async()=>{
  const {sheets,calls}=adapter([{values:[]},{values:[['','KEEP ME']]}]);
  const result=await sheets.locateRows(e,[{id:'TRP-1',sheet_row:7,synced_version:0}]);
  assert.equal(result.ready.length,0);assert.equal(result.conflicts[0].code,'SHEET_ROW_MOVED');
  assert(calls.every(c=>c.method==='GET'));
});
test('acknowledged missing row is never silently recreated at the old position',async()=>{
  const {sheets,calls}=adapter([{sheets:[{properties:{title:'VehicleTrips',sheetId:1,gridProperties:{rowCount:1000,columnCount:26}}}]},{valueRanges:[{}]}]);
  await assert.rejects(()=>sheets.writeRows(e,[{id:'TRP-1',sheet_row:7,synced_version:1,data:{},version:2}]),{code:'SHEET_ROW_MOVED'});
  assert(calls.every(c=>c.method==='GET'));
});
test('a newer Sheet version is a conflict and is not overwritten',async()=>{
  const {sheets,calls}=adapter([{sheets:[{properties:{title:'VehicleTrips',sheetId:1,gridProperties:{rowCount:1000,columnCount:26}}}]},{valueRanges:[{values:[['TRP-1',5,1,9]]}]}]);
  await assert.rejects(()=>sheets.writeRows(e,[{id:'TRP-1',sheet_row:7,synced_version:2,data:{},version:3}]),{code:'SHEET_VERSION_CONFLICT'});
  assert(calls.every(c=>c.method==='GET'));
});
test('an incomplete batch read cannot authorize a write',async()=>{
  const {sheets,calls}=adapter([{sheets:[{properties:{title:'VehicleTrips',sheetId:1,gridProperties:{rowCount:1000,columnCount:26}}}]},{valueRanges:[]}]);
  await assert.rejects(()=>sheets.writeRows(e,[{id:'TRP-1',sheet_row:7,synced_version:2,data:{},version:3}]),{code:'SHEET_READ_INCOMPLETE'});
  assert(calls.every(c=>c.method==='GET'));
});
