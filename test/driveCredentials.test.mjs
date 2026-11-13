import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriveCredentialRegistry} from '../src/driveCredentials.js';
import {decrypt} from '../src/core.js';

const key='ab'.repeat(32);
function fakePool() {
  let row,tail=Promise.resolve();
  return {get row(){return row;},async getConnection(){let release;
    return {async beginTransaction(){const prior=tail;tail=new Promise(r=>release=r);await prior;},
      async query(sql,args){
        if(sql.startsWith('INSERT IGNORE')){row??={revision:0,encrypted:args[0]};return [{}];}
        if(sql.startsWith('SELECT'))return [[{...row}]];
        if(sql.startsWith('UPDATE')){row={revision:args[0],encrypted:args[1]};return [{}];}
        throw Error('Unexpected query');
      },async commit(){},async rollback(){},release(){release();}};
  }};
}
const credentials=['a','b','c'].map(id=>({id,label:id,clientId:`${id}.apps.googleusercontent.com`,clientSecret:`secret-${id}`,refreshToken:`refresh-${id}`,folderId:`folder_${id}`,enabled:true}));
test('token-only entries are encrypted, masked and issued without shared OAuth secrets',async()=>{
  const pool=fakePool(),registry=createDriveCredentialRegistry(pool,{CONFIG_ENCRYPTION_KEY:key});
  const saved=await registry.save({revision:0,credentials:[{label:'Token dự phòng 1',refreshToken:'token-only-secret',enabled:true},{label:'Token dự phòng 2',refreshToken:'second-token-secret',enabled:true}]});
  assert.equal(saved.credentials.length,2);
  assert.equal(JSON.stringify(saved).includes('token-only-secret'),false);
  const c=saved.credentials[0];
  await registry.save({revision:1,credentials:saved.credentials.map(item=>({id:item.id,label:item.label,refreshToken:'',enabled:true}))});
  const issued=await registry.acquire({consumer:'chamcong',requestId:'token-only-request'});
  assert.equal(issued.credential.refreshToken,'token-only-secret');
  assert.equal(issued.credential.clientId,undefined);
  const next=await registry.acquire({consumer:'chamcong',currentId:c.id,reason:'invalid_grant',requestId:'rotate-token-only'});
  assert.equal(next.credential.refreshToken,'second-token-secret');
  await assert.rejects(registry.test(c.id),{code:'DRIVE_TEST_AT_CONSUMER'});
});
test('encrypted storage, masked admin output, blank secret preservation and optimistic updates',async()=>{
  const pool=fakePool(),registry=createDriveCredentialRegistry(pool,{CONFIG_ENCRYPTION_KEY:key});
  const result=await registry.save({revision:0,credentials});
  assert.equal(result.revision,1);assert.equal(JSON.stringify(result).includes('refresh-a'),false);
  assert.equal(pool.row.encrypted.includes('secret-a'),false);
  await registry.save({revision:1,credentials:credentials.map(c=>({...c,clientSecret:'',refreshToken:''}))});
  assert.equal(decrypt(pool.row.encrypted,key).credentials[0].clientSecret,'secret-a');
  await assert.rejects(registry.save({revision:0,credentials}),{code:'DRIVE_REVISION_CONFLICT'});
  await assert.rejects(registry.save({revision:2,credentials:[credentials[0],credentials[0]]}),{code:'DRIVE_DUPLICATE_ID'});
});
test('changing OAuth identity mints a new ID and preserves already issued credentials',async()=>{
  const pool=fakePool(),registry=createDriveCredentialRegistry(pool,{CONFIG_ENCRYPTION_KEY:key});
  await registry.save({revision:0,credentials});
  await registry.acquire({consumer:'chamcong',requestId:'initial-identity'});
  const updated=await registry.save({revision:1,credentials:credentials.map(c=>c.id==='a'?{...c,refreshToken:'replacement-token'}:c)});
  assert.notEqual(updated.credentials[0].id,'a');
  const state=decrypt(pool.row.encrypted,key);
  assert.equal(state.consumers.chamcong.credential.id,'a');
  assert.equal(state.consumers.chamcong.credential.refreshToken,'refresh-a');
  assert.equal(state.credentials[0].refreshToken,'replacement-token');
});
test('removed IDs retain permanent identity and reserved IDs cannot enter registry',async()=>{
  const registry=createDriveCredentialRegistry(fakePool(),{CONFIG_ENCRYPTION_KEY:key});
  await registry.save({revision:0,credentials:[credentials[0]]});
  await registry.save({revision:1,credentials:[]});
  const replacement=await registry.save({revision:2,credentials:[{...credentials[0],refreshToken:'new-owner-token'}]});
  assert.notEqual(replacement.credentials[0].id,'a');
  for(const id of ['__proto__','constructor','prototype','toString','environment','current'])assert.throws(()=>registry.save({revision:3,credentials:[{...credentials[0],id}]}),{code:'DRIVE_CREDENTIALS_INVALID'});
});
test('exhausted credentials do not cycle immediately back to a failed account',async()=>{
  const registry=createDriveCredentialRegistry(fakePool(),{CONFIG_ENCRYPTION_KEY:key});
  await registry.save({revision:0,credentials:credentials.slice(0,2)});
  await registry.acquire({consumer:'chamcong',requestId:'start-cooldown'});
  assert.equal((await registry.acquire({consumer:'chamcong',currentId:'a',reason:'userRateLimitExceeded',requestId:'next-cooldown'})).credential.id,'b');
  await assert.rejects(registry.acquire({consumer:'chamcong',currentId:'b',reason:'userRateLimitExceeded',requestId:'exhaust-cooldown'}),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
});
test('durable acquisition, idempotency and concurrent stale failures advance once',async()=>{
  const pool=fakePool(),registry=createDriveCredentialRegistry(pool,{CONFIG_ENCRYPTION_KEY:key});
  await registry.save({revision:0,credentials});
  const first=await registry.acquire({consumer:'chamcong',requestId:'initial'});
  assert.equal(first.credential.id,'a');
  const results=await Promise.all(['rotate1','rotate2'].map(requestId=>registry.acquire({consumer:'chamcong',requestId,currentId:'a',reason:'userRateLimitExceeded'})));
  assert.deepEqual(results.map(r=>r.credential.id),['b','b']);
  assert.deepEqual(results.map(r=>r.version),[2,2]);
  assert.deepEqual(await registry.acquire({consumer:'chamcong',requestId:'initial'}),first);
  const restarted=createDriveCredentialRegistry(pool,{CONFIG_ENCRYPTION_KEY:key});
  assert.equal((await restarted.acquire({consumer:'chamcong',requestId:'restart'})).credential.id,'b');
  assert.equal((await restarted.acquire({consumer:'hdoi',requestId:'other'})).credential.id,'a');
  const admin=await restarted.get();assert.equal(admin.events.length,3);assert.equal(admin.events[0].status,'issued');
  assert.equal(JSON.stringify(admin).includes('secret-a'),false);
});
test('safe exhaustion, invalid reasons and provider failures',async()=>{
  const registry=createDriveCredentialRegistry(fakePool(),{CONFIG_ENCRYPTION_KEY:key},{driveFactory:()=>({test(){throw Error('refresh-secret');}})});
  await assert.rejects(registry.acquire({consumer:'hdoi',requestId:'empty'}),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
  await registry.save({revision:0,credentials:[credentials[0]]});
  await registry.acquire({consumer:'hdoi',requestId:'first'});
  await assert.rejects(registry.acquire({consumer:'hdoi',requestId:'rotate',currentId:'a',reason:'userRateLimitExceeded'}),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
  assert.throws(()=>registry.acquire({consumer:'hdoi',requestId:'bad',reason:'quotaExceeded'}),{code:'DRIVE_ACQUIRE_INVALID'});
  await assert.rejects(registry.test('a'),error=>error.code==='DRIVE_CREDENTIAL_TEST_FAILED'&&!error.message.includes('refresh-secret'));
});
