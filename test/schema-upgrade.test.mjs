import test from 'node:test';
import assert from 'node:assert/strict';
import {schemaPlan,upgradeSchema} from '../src/upgradeChamCongSchema.js';
import {metadataHeaders,encrypt} from '../src/core.js';
import compatibility from '../src/schemaCompatibility.cjs';
const old=['ID','CreatedAt','Container'],next=[...old,'Seal','Seal2'];
test('schema upgrade preserves metadata positions and resumes an interrupted header insertion',()=>{
 assert.deepEqual(schemaPlan('VehicleTrips',old,next,[...old,...metadataHeaders]),{insert:2,write:true});
 assert.deepEqual(schemaPlan('VehicleTrips',old,next,[...old,'','',...metadataHeaders]),{insert:0,write:true});
 assert.deepEqual(schemaPlan('VehicleTrips',old,next,[...next,...metadataHeaders]),{insert:0,write:false});
 assert.deepEqual(schemaPlan('VehicleTrips',old,next,old),{insert:0,write:true});
 assert.throws(()=>schemaPlan('VehicleTrips',old,next,['ID','OTHER']),{code:'SHEET_HEADER_MISMATCH'});
 assert.throws(()=>schemaPlan('VehicleTrips',old,['ID','Renamed'],old),{code:'SCHEMA_UPGRADE_UNSAFE'});
 assert.equal(compatibility.compatibleHeaders('VehicleTrips',next,old),true);
});
test('older jobs never attach a hidden Seal to a replacement container',()=>{
 const old={Container:'CONT1',Container2:'CONT2',Seal:'ONE',Seal2:'TWO'};
 assert.deepEqual(compatibility.legacySealPatch('VehicleTrips',old,{Container:'NEW',Container2:'CONT2'}),{Seal:'',Seal2:'TWO'});
 assert.deepEqual(compatibility.legacySealPatch('VehicleTrips',old,{Container:'CONT2',Container2:'CONT1'}),{Seal:'TWO',Seal2:'ONE'});
 assert.deepEqual(compatibility.legacySealPatch('VehicleTrips',old,{Container:'CONT1',Container2:'CONT2'}),{Seal:'ONE',Seal2:'TWO'});
});
test('schema migration defaults to dry run and resumes a lost Google response without shifting twice',async()=>{
 const key='2'.repeat(64),entity={name:'VehicleTrips',tab_name:'VehicleTrips',headers:old,bootstrap_state:'ready'};
 let header=[...old,...metadataHeaders],inserts=0,writes=0,updates=0,loseAck=true;
 const query=async(sql,args)=>{
  if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
  if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt({spreadsheetId:'fixture-sheet'},key)}]];
  if(sql.startsWith('SELECT * FROM entities'))return [[entity]];
  if(sql.startsWith('UPDATE entities')){updates++;entity.headers=JSON.parse(args[0]);}
  return [{}];
 };
 const db={query,beginTransaction:async()=>{},rollback:async()=>{},commit:async()=>{},release:()=>{}},pool={getConnection:async()=>db};
 const sheets={read:async()=>[header],call:async(path,body)=>{
  if(!body)return {sheets:[{properties:{title:'VehicleTrips',sheetId:1}}]};
  inserts++;header=[...old,'','',...metadataHeaders];if(loseAck){loseAck=false;throw Error('lost Google ACK');}
 },write:async data=>{writes++;header=data[0].values[0];}};
 const contracts=[{name:'VehicleTrips',headers:next}],options={sheetsFactory:()=>sheets};
 const dry=await upgradeSchema(pool,key,contracts,options);assert.equal(dry.dryRun,true);assert.equal(inserts+writes+updates,0);
 await assert.rejects(()=>upgradeSchema(pool,key,contracts,{...options,apply:true}),/lost Google ACK/);assert.equal(updates,0);
 await upgradeSchema(pool,key,contracts,{...options,apply:true});
 assert.equal(inserts,1);assert.equal(writes,1);assert.equal(updates,1);assert.deepEqual(entity.headers,next);assert.deepEqual(header,[...next,...metadataHeaders]);
});
