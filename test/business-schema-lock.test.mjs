import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from '../src/businessSchemas.js';
import protocol from '../src/businessSchemaProtocol.cjs';
import {encrypt} from '../src/core.js';

const key='b'.repeat(64),spreadsheetId='schema-lock-fixture-1234567890';
const schema={entity:'Demo',fields:[{key:'ID',type:'text',required:true},{key:'Quantity',type:'cell',required:false}]};
function fixture(known){
  const calls=[];
  const query=async(sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId},key)}]];
    if(sql.includes('JOIN entities e'))return [known?[known]:[]];
    if(sql.includes('GET_LOCK'))return [[{acquired:0}]];
    throw Error('Unexpected query: '+sql);
  };
  return {calls,pool:{query,getConnection:async()=>({query,release(){}})}};
}
test('registered compatible schemas are acknowledged while the sync lock is held',async()=>{
  for(const headers of [['ID','Quantity'],['ID','Quantity','Future']]){
    const f=fixture({version:3,headers:JSON.stringify(headers),bootstrap_state:'ready'});
    assert.deepEqual(await register(f.pool,key,{spreadsheetId,schema}),{ok:true,protocol:'cham-cong-schema-v1',schemaVersion:3,schemaHash:protocol.fingerprint(schema)});
    assert.equal(f.calls.some(c=>c.sql.includes('GET_LOCK')),false);
    const read=f.calls.find(c=>c.sql.includes('JOIN entities e'));
    assert.deepEqual(read.args,['Demo',protocol.fingerprint(schema)]);
  }
});
test('unknown, incomplete or reordered schemas still require the exclusive lock',async()=>{
  for(const known of [null,{version:3,headers:['ID','Quantity'],bootstrap_state:'new'},{version:3,headers:['Quantity','ID'],bootstrap_state:'ready'}]){
    const f=fixture(known);
    await assert.rejects(register(f.pool,key,{spreadsheetId,schema}),{code:'BUSINESS_SCHEMA_BUSY'});
    assert.equal(f.calls.filter(c=>c.sql.includes('GET_LOCK')).length,1);
  }
});
test('the read path still verifies the source binding',async()=>{
  const f=fixture({version:3,headers:['ID','Quantity'],bootstrap_state:'ready'});
  await assert.rejects(register(f.pool,key,{spreadsheetId:'different-source',schema}),{code:'SOURCE_MISMATCH'});
  assert.equal(f.calls.some(c=>c.sql.includes('JOIN entities e')||c.sql.includes('GET_LOCK')),false);
});
