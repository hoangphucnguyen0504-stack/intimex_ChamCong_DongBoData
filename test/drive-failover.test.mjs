import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriveCredentialRegistry} from '../src/driveCredentials.js';
function pool(){let row;return {getConnection:async()=>({beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){},query:async(sql,args)=>{
 if(sql.startsWith('INSERT IGNORE'))row??={revision:0,encrypted:args[0]};
 if(sql.startsWith('SELECT'))return [[row]];
 if(sql.startsWith('UPDATE'))row={revision:args[0],encrypted:args[1]};
 return [{}];
}})};}
const full=(id,more={})=>({id,label:id,clientId:'client-'+id,clientSecret:'secret',refreshToken:'refresh-'+id,folderId:'folder-'+id,enabled:true,...more});
test('invalid client skips token-only and same OAuth client; failures remain visible',async()=>{
 const registry=createDriveCredentialRegistry(pool(),{CONFIG_ENCRYPTION_KEY:'ab'.repeat(32)});
 await registry.save({revision:0,credentials:[full('a'),{id:'token',label:'Token',refreshToken:'backup',enabled:true},full('same',{clientId:'client-a',clientSecret:'secret'}),full('b')]});
 await registry.acquire({consumer:'hdoi',requestId:'first'});
 const next=await registry.acquire({consumer:'hdoi',currentId:'a',reason:'invalid_client',requestId:'next'});
 assert.equal(next.credential.id,'b');
 const admin=await registry.get();assert.equal(admin.credentials[0].failures[0].reason,'invalid_client');assert.equal(admin.events[1].status,'failed');
 assert.equal(JSON.stringify(admin).includes('refresh-a'),false);
});
test('exhaustion commits failure; initial request cannot silently reuse invalid credential',async()=>{
 const registry=createDriveCredentialRegistry(pool(),{CONFIG_ENCRYPTION_KEY:'ab'.repeat(32)});
 await registry.save({revision:0,credentials:[full('a')]});await registry.acquire({consumer:'hdoi',requestId:'first'});
 await assert.rejects(registry.acquire({consumer:'hdoi',currentId:'a',reason:'invalid_grant',requestId:'fail'}),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
 assert.equal((await registry.get()).credentials[0].failures[0].reason,'invalid_grant');
 await assert.rejects(registry.acquire({consumer:'hdoi',requestId:'restart'}),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
 await registry.save({revision:1,credentials:[full('a'),full('b')]});
 assert.equal((await registry.acquire({consumer:'hdoi',requestId:'new-backup'})).credential.id,'b');
});
test('exhausted transient failure retry keeps cooldown stable and can recover the only account',async()=>{
 let epoch=Date.parse('2026-01-01T00:00:00Z');
 const registry=createDriveCredentialRegistry(pool(),{CONFIG_ENCRYPTION_KEY:'ab'.repeat(32)},{now:()=>new Date(epoch).toISOString()});
 await registry.save({revision:0,credentials:[full('a')]});await registry.acquire({consumer:'hdoi',requestId:'start'});
 const request={consumer:'hdoi',currentId:'a',reason:'userRateLimitExceeded',requestId:'retry-stable'};
 await assert.rejects(registry.acquire(request),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
 const retryAt=(await registry.get()).credentials[0].failures[0].retryAt;
 epoch+=30000;await assert.rejects(registry.acquire(request),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
 assert.equal((await registry.get()).credentials[0].failures[0].retryAt,retryAt);
 epoch+=31000;assert.equal((await registry.acquire(request)).credential.id,'a');
 assert.equal((await registry.get()).credentials[0].failures.length,0);
});
test('token-only current can recover after temporary permission problem is repaired',async()=>{
 let epoch=Date.parse('2026-01-01T00:00:00Z');
 const registry=createDriveCredentialRegistry(pool(),{CONFIG_ENCRYPTION_KEY:'ab'.repeat(32)},{now:()=>new Date(epoch).toISOString()});
 await registry.save({revision:0,credentials:[{id:'token',label:'Token',refreshToken:'backup',enabled:true}]});
 await registry.acquire({consumer:'hdoi',requestId:'start'});
 const request={consumer:'hdoi',currentId:'token',reason:'permissionDenied',requestId:'permission'};
 await assert.rejects(registry.acquire(request),{code:'DRIVE_CREDENTIALS_EXHAUSTED'});
 epoch+=900001;assert.equal((await registry.acquire(request)).credential.id,'token');
});
test('storage quota requires a full account but permits a shared destination',async()=>{
 const registry=createDriveCredentialRegistry(pool(),{CONFIG_ENCRYPTION_KEY:'ab'.repeat(32)});
 await registry.save({revision:0,credentials:[full('a'),{id:'token',label:'Token',refreshToken:'backup',enabled:true},full('same',{folderId:'folder-a'}),full('b')]});
 await registry.acquire({consumer:'chamcong',requestId:'first'});
 assert.equal((await registry.acquire({consumer:'chamcong',currentId:'a',reason:'storageQuotaExceeded',requestId:'next'})).credential.id,'same');
});
