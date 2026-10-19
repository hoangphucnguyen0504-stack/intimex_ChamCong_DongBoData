import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,passwordHash,passwordMatches,batchSchema,entitySchema,backoff,columnName,publicRecord,compactReceipt} from '../src/core.js';
import {importRecord} from '../src/sync.js';
import {DataDongBoClient} from '../client/datadongbo.mjs';
const key='1'.repeat(64);
test('configuration encryption authenticates content and never stores plaintext',()=>{
  const value={serviceAccount:{private_key:'private material'},enabled:false};const ciphertext=encrypt(value,key);
  assert(!ciphertext.includes('private material'));assert.deepEqual(decrypt(ciphertext,key),value);
  assert.throws(()=>decrypt(ciphertext,'2'.repeat(64)));
  const changed=Buffer.from(ciphertext,'base64');changed[16]^=1;assert.throws(()=>decrypt(changed.toString('base64'),key));
});
test('password hash verifies only the correct password',()=>{
  const hash=passwordHash('test password');assert(passwordMatches('test password',hash));assert(!passwordMatches('wrong password',hash));assert(!passwordMatches('test password','bad'));
});
test('batch validation requires version, stable ID and known technical namespace',()=>{
  const op={action:'create',entity:'Attendance',id:'ATT-1',data:{FullName:'A',WeightKg:15000.125,Bags:0}};
  assert.equal(batchSchema.parse({requestId:'request-1',operations:[op]}).operations[0].data.WeightKg,15000.125);
  for(const invalid of [{...op,action:'update'},{...op,action:'delete'},{...op,data:{__dd_version:5}},{...op,data:{ID:'other'}},{...op,entity:'a; DROP TABLE records'},{...op,data:{WeightKg:Infinity}}])
    assert.throws(()=>batchSchema.parse({requestId:'request-1',operations:[invalid]}));
  assert.throws(()=>batchSchema.parse({requestId:'request-1',operations:Array(201).fill(op)}));
});
test('mapping preserves column order and requires exactly one ID',()=>{
  assert.deepEqual(entitySchema.parse({name:'Attendance',tabName:"Khách ' A",headers:['ID','FullName']}).headers,['ID','FullName']);
  for(const headers of [['FullName'],['ID','ID'],['ID','__dd_version']])assert.throws(()=>entitySchema.parse({name:'Attendance',tabName:'Attendance',headers}));
  assert.equal(columnName(0),'A');assert.equal(columnName(25),'Z');assert.equal(columnName(26),'AA');assert.equal(columnName(153),'EX');
});
test('backoff increases, respects Retry-After, and has bounded jitter',()=>{
  assert.equal(backoff(1,0,()=>0),4000);assert.equal(backoff(2,0,()=>0),8000);assert.equal(backoff(1,60000,()=>0),60000);assert(backoff(6,0,()=>.9)>backoff(6,0,()=>0));
});
test('import keeps decimals, zero, text IDs and existing JSON strings without unit conversion',()=>{
  const e={name:'VehicleTrips',headers:['ID','CreatedAt','EstimatedWeightKg','EstimatedBagCount','DataJSON']};
  const headers=[...e.headers,'__dd_version','__dd_deleted_at','__dd_business_at','__dd_finalized_at'];
  const r=importRecord(e,['0007','2026-10-19T08:00:00+07:00',15000.125,0,'{"a":1}',3,'','',''],headers);
  assert.equal(r.id,'0007');assert.equal(r.data.EstimatedWeightKg,15000.125);assert.equal(r.data.EstimatedBagCount,0);assert.equal(r.data.DataJSON,'{"a":1}');assert.equal(r.version,3);assert.equal(r.finalizedAt,null);
  assert.equal(importRecord(e,[],headers),null);
  assert.throws(()=>importRecord(e,['x','','','','',1.5],headers));
});
test('public data separates committed version and pending Sheets delivery',()=>{
  const row={entity:'Attendance',id:'1',data:{ID:'1'},version:'3',synced_version:'2',dirty:1,business_at:new Date(),updated_at:new Date()};
  assert.equal(publicRecord(row).version,3);assert.equal(publicRecord(row).syncStatus,'pending');
});
test('idempotency receipts keep IDs and versions without retaining archived business payloads',()=>{
  const response={ok:true,durable:true,records:[{id:'ATT-1',version:3,data:{FullName:'Private name'}}]};
  assert.deepEqual(compactReceipt(response).records,[{id:'ATT-1',version:3}]);assert.equal(response.records[0].data.FullName,'Private name');
});
test('backend client forwards fixed requestId and surfaces conflicts without automatic duplicate writes',async()=>{
  const calls=[],client=new DataDongBoClient({url:'https://data.example.com',token:'test-token',fetchImpl:async(url,o)=>{calls.push({url,...o});return new Response(JSON.stringify({ok:true,durable:true}),{status:200});}});
  const batch={requestId:'fixed-uuid',operations:[{action:'create',entity:'Attendance',id:'1',data:{}}]};
  await client.commit(batch);await client.result(batch.requestId);assert.equal(JSON.parse(calls[0].body).requestId,'fixed-uuid');assert.equal(calls[1].method,'GET');assert.equal(calls.length,2);
  const fail=new DataDongBoClient({url:'https://data.example.com',token:'test',fetchImpl:async()=>new Response(JSON.stringify({code:'VERSION_CONFLICT',current:{version:2}}),{status:409})});
  await assert.rejects(()=>fail.commit(batch),e=>e.status===409&&e.current.version===2);
});
