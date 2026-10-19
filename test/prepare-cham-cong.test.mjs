import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareChamCong} from '../src/prepareChamCong.js';
import {encrypt} from '../src/core.js';
const key='1'.repeat(64);
test('preparation blocks incomplete imports without modifying retention or Google',async()=>{
 const calls=[],query=async(sql)=>{calls.push(sql);if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId:'fixture-sheet'},key)}]];if(sql==='SELECT * FROM entities')return [[{name:'VehicleTrips',bootstrap_state:'new'}]];return [{}];};
 const pool={getConnection:async()=>({query,release(){}})};
 await assert.rejects(()=>prepareChamCong(pool,key,{keepHistory:true}),{code:'IMPORT_REQUIRED'});assert(!calls.some(sql=>sql.startsWith('UPDATE')));
});
test('history retention is changed only with explicit keepHistory flag',async()=>{
 for(const keepHistory of [false,true]){
  const calls=[],query=async(sql)=>{calls.push(sql);if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId:'fixture-sheet'},key)}]];if(sql==='SELECT * FROM entities')return [[]];return [{}];};
  const result=await prepareChamCong({getConnection:async()=>({query,release(){}})},key,{keepHistory});
  assert.equal(result.googleRequests,0);assert.equal(calls.includes('UPDATE entities SET retention_days=0'),keepHistory);
 }
});
