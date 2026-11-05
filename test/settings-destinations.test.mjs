import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsSchema,encrypt,decrypt} from '../src/core.js';
import {getSettings,saveSettings} from '../src/settings.js';

const original={spreadsheetId:'primary-source-1234567890',intervalMinutes:60,batchSize:100,enabled:true,autoRollover:true,
 spreadsheetTargets:[{spreadsheetId:'fallback-target-1234567890',label:'Tiếp theo',enabled:true}],
 serviceAccount:{client_email:'fixture@example.invalid',private_key:'test-PRIVATE KEY-not-real'}};
function database(key,{linked=0}={}){
 let encrypted=encrypt(original,key);const queries=[];
 const query=async(sql,args=[])=>{
  queries.push(sql);
  if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
  if(sql.includes('SELECT encrypted'))return [[{encrypted}]];
  if(sql.includes('COUNT(*) n FROM row_map'))return [[{n:10}]];
  if(sql.includes('COUNT(*) n FROM sheet_locations'))return [[{n:linked}]];
  if(sql.startsWith('INSERT INTO settings'))encrypted=args[0];
  return [{}];
 };
 const conn={query,release(){}};
 return {pool:{query,getConnection:async()=>conn},read:()=>decrypt(encrypted,key),queries};
}
test('legacy setting updates preserve fallback targets, and secrets stay masked',async()=>{
 const key='c1'.repeat(32),db=database(key);
 const {serviceAccount,spreadsheetTargets,autoRollover,...legacy}=original;
 await saveSettings(db.pool,key,{...legacy,intervalMinutes:30});
 assert.deepEqual(db.read().spreadsheetTargets,original.spreadsheetTargets);
 assert.equal(db.read().autoRollover,true);assert.equal(db.read().intervalMinutes,30);
 const masked=await getSettings(db.pool,key,true);
 assert.equal(masked.serviceAccount,undefined);assert.equal(JSON.stringify(masked).includes('test-PRIVATE'),false);
});
test('cannot remove a linked destination, but can disable new writes to it',async()=>{
 const key='c2'.repeat(32),db=database(key,{linked:1});
 await assert.rejects(saveSettings(db.pool,key,{...original,spreadsheetTargets:[]}),{code:'TARGET_IN_USE'});
 await saveSettings(db.pool,key,{...original,spreadsheetTargets:original.spreadsheetTargets.map(target=>({...target,enabled:false}))});
 assert.equal(db.read().spreadsheetTargets[0].enabled,false);
 assert.equal(db.read().spreadsheetId,original.spreadsheetId);
});
test('duplicate files and invalid fallback inputs are rejected',()=>{
 assert.equal(settingsSchema.safeParse({...original,spreadsheetTargets:[{spreadsheetId:original.spreadsheetId,label:'duplicate',enabled:true}]}).success,false);
 assert.equal(settingsSchema.safeParse({...original,spreadsheetTargets:[{spreadsheetId:'../private',label:'bad',enabled:true}]}).success,false);
 assert.equal(settingsSchema.safeParse({...original,spreadsheetTargets:[...original.spreadsheetTargets,...original.spreadsheetTargets]}).success,false);
});
