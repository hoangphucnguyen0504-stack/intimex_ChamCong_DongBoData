import {test} from 'node:test';
import assert from 'node:assert/strict';
import {candidates,convertDriveDocument,processDriveCleanup} from '../src/aiDriveConversion.js';
import {encrypt,decrypt} from '../src/core.js';
const key='ab'.repeat(32),pdf=Buffer.from('%PDF-1.4\nnew-fixture\n%%EOF'),original=Buffer.from('new-office-fixture');
const account=(id,extra={})=>({id,label:id,enabled:true,clientId:'client-'+id,clientSecret:'secret-'+id,refreshToken:'token-'+id,folderId:'folder-'+id,...extra});
const provided=()=>{const {enabled,...c}=account('primary');return c;};
const quota=()=>Object.assign(Error('private raw message'),{response:{status:403,data:{error:{errors:[{reason:'userRateLimitExceeded'}]}}}});
const invalid=()=>Object.assign(Error('private refresh token'),{response:{status:400,data:{error:'invalid_grant'}}});
function poolFor(credentials=[]){
  const cleanup=new Map(),logs=[];
  return {cleanup,logs,query:async(sql,args=[])=>{
    if(sql.startsWith('SELECT encrypted FROM drive_credential_state'))return [[{encrypted:encrypt({credentials},key)}]];
    if(sql.startsWith('INSERT IGNORE INTO ai_drive_cleanup')){cleanup.set(args[0],{id:args[0],encrypted_details:args[1],attempts:0,blocked:0});return [{affectedRows:1}];}
    if(sql.startsWith('SELECT * FROM ai_drive_cleanup'))return [[...[...cleanup.values()].filter(r=>!r.blocked).slice(0,1)]];
    if(sql.startsWith('DELETE FROM ai_drive_cleanup')){cleanup.delete(args[0]);return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE ai_drive_cleanup')){Object.assign(cleanup.get(args[3]),{attempts:args[0],blocked:args[1]});return [{affectedRows:1}];}
    if(sql.startsWith('INSERT IGNORE INTO ai_diagnostics')){logs.push(decrypt(args[4],key));return [{affectedRows:1}];}
    throw Error('Unexpected SQL: '+sql);
  }};
}
function authFor(handle){return c=>({setCredentials:value=>assert.equal(value.refresh_token,c.refreshToken),request:r=>handle(c,r)});}
const success=(c,r)=>r.url.includes('/upload/')?{data:{id:'temp-'+c.id}}:r.url.endsWith('/export')?{data:pdf}:{data:{}};
test('invalid primary and quota-limited backup switch in order; token-only accounts use original shared app, full accounts retain their own settings',async()=>{
  const defaults={clientId:'shared-client',clientSecret:'shared-secret',folderId:'shared-folder'},pool=poolFor([{id:'off',enabled:false,refreshToken:'off-token'},{id:'backup',label:'Backup',enabled:true,refreshToken:'backup-token'},account('last')]),attempts=[],events=[];
  const result=await convertDriveDocument(original,'docx',{pool,key,credential:provided(),defaults,onAttempt:async event=>events.push(event),authFactory:authFor(async(c,r)=>{
    if(r.url.includes('/upload/')){attempts.push(c.id);if(c.id==='primary')throw invalid();if(c.id==='backup'){assert.equal(c.clientId,defaults.clientId);assert.equal(c.clientSecret,defaults.clientSecret);assert.equal(c.folderId,defaults.folderId);throw quota();}assert.equal(c.clientId,'client-last');}
    return success(c,r);
  })});
  assert.deepEqual(result,pdf);assert.deepEqual(attempts,['primary','backup','last']);
  assert.deepEqual(events.map(e=>e.code),['AI_DRIVE_AUTH','AI_DRIVE_QUOTA','AI_DOCUMENT_DRIVE_RECOVERED']);assert.equal(events.at(-1).driveCredentialId,'last');
  assert(!JSON.stringify(events).includes('token-'));assert(!JSON.stringify(events).includes('secret-'));
});
test('candidate selection skips disabled accounts, duplicate tokens and partial OAuth identities',()=>{
  const p=provided(),list=candidates({credentials:[account('disabled',{enabled:false}),account('duplicate',{clientId:p.clientId,refreshToken:p.refreshToken}),account('partial',{clientSecret:undefined}),account('good')]},p);
  assert.deepEqual(list.map(c=>c.id),['primary','good']);
  assert.deepEqual(candidates({credentials:[{...p,enabled:false},account('good')]},p).map(c=>c.id),['good']);
});
test('all auth/quota failures end once per distinct account with a clear exhausted code',async()=>{
  const pool=poolFor([account('backup')]),tried=[];
  await assert.rejects(()=>convertDriveDocument(original,'docx',{pool,key,credential:provided(),authFactory:authFor(async(c)=>{tried.push(c.id);throw invalid();})}),e=>e.code==='AI_DOCUMENT_DRIVE_EXHAUSTED'&&e.driveCredentialId==='backup');
  assert.deepEqual(tried,['primary','backup']);
});
test('invalid file, service errors and uncertain upload outcomes never rotate or create additional copies',async()=>{
  for(const failure of [Object.assign(Error('bad document'),{response:{status:400}}),Object.assign(Error('service unavailable'),{response:{status:503}}),Error('network response lost')]){
    const tried=[],pool=poolFor([account('backup')]);
    await assert.rejects(()=>convertDriveDocument(original,'docx',{pool,key,credential:provided(),authFactory:authFor(async(c)=>{tried.push(c.id);throw failure;})}),e=>e.code===(!failure.response?'AI_DOCUMENT_CONVERSION_UNKNOWN':'AI_DOCUMENT_CONVERSION'));
    assert.deepEqual(tried,['primary']);
  }
});
test('a failed export cleans with its creator before another account creates its own temporary copy',async()=>{
  const pool=poolFor([account('backup')]),calls=[];
  const result=await convertDriveDocument(original,'docx',{pool,key,credential:provided(),authFactory:authFor(async(c,r)=>{
    calls.push([c.id,r.method||'GET']);if(c.id==='primary'&&r.url.endsWith('/export'))throw quota();return success(c,r);
  })});
  assert.deepEqual(result,pdf);assert.deepEqual(calls,[['primary','POST'],['primary','GET'],['primary','PATCH'],['backup','POST'],['backup','GET'],['backup','PATCH']]);assert.equal(pool.cleanup.size,0);
});
test('revoked creator is retained in an encrypted cleanup queue, fallback succeeds, and later cleanup uses only the creator',async()=>{
  const pool=poolFor([account('backup')]),events=[],context={scope:'inspection:test',fileHash:'a'.repeat(64),jobId:'b'.repeat(64)};
  const result=await convertDriveDocument(original,'docx',{pool,key,context,credential:provided(),onAttempt:async e=>events.push(e),authFactory:authFor(async(c,r)=>{
    if(c.id==='primary'&&!r.url.includes('/upload/'))throw invalid();return success(c,r);
  })});
  assert.deepEqual(result,pdf);assert.equal(pool.cleanup.size,1);assert.equal(events[0].code,'AI_DOCUMENT_CLEANUP_PENDING');
  const stored=[...pool.cleanup.values()][0];assert(!stored.encrypted_details.includes('token-primary'));assert.equal(decrypt(stored.encrypted_details,key).credential.id,'primary');
  await processDriveCleanup(pool,key,{authFactory:authFor(async(c,r)=>{assert.equal(c.id,'primary');assert.equal(r.url,'https://www.googleapis.com/drive/v3/files/temp-primary');return {data:{}};})});
  assert.equal(pool.cleanup.size,0);assert.equal(pool.logs.length,0);
});
test('untracked cleanup stops failover and preserves its temporary-file reference for an administrator',async()=>{
  const pool=poolFor([account('backup')]),query=pool.query,tried=[];pool.query=async(sql,args)=>{if(sql.startsWith('INSERT IGNORE INTO ai_drive_cleanup'))throw Error('database unavailable');return query(sql,args);};
  await assert.rejects(()=>convertDriveDocument(original,'docx',{pool,key,credential:provided(),authFactory:authFor(async(c,r)=>{if(r.url.includes('/upload/')){tried.push(c.id);return success(c,r);}throw invalid();})}),e=>e.code==='AI_DOCUMENT_CLEANUP_UNTRACKED'&&e.temporaryFileId==='temp-primary');
  assert.deepEqual(tried,['primary']);
});
test('cleanup retries are bounded and blocked cleanup is logged without OAuth material',async()=>{
  const pool=poolFor();pool.cleanup.set('id',{id:'id',encrypted_details:encrypt({fileId:'old-temp',credential:provided(),scope:'inspection:test',fileHash:'a'.repeat(64)},key),attempts:0,blocked:0});
  for(let i=0;i<5;i++)await processDriveCleanup(pool,key,{authFactory:authFor(async()=>{throw invalid();})});
  assert.equal(pool.cleanup.get('id').blocked,true);assert.equal(pool.logs[0].code,'AI_DOCUMENT_CLEANUP_BLOCKED');assert.equal(pool.logs[0].temporaryFileId,'old-temp');assert.equal(pool.logs[0].driveCredentialId,'primary');
  assert(!JSON.stringify(pool.logs).includes('token-primary'));assert(!JSON.stringify(pool.logs).includes('secret-primary'));
});
test('conversion retry deadline prevents a long chain of Drive requests',async()=>{
  const pool=poolFor([account('backup')]),tried=[];let now=0;
  await assert.rejects(()=>convertDriveDocument(original,'docx',{pool,key,credential:provided(),now:()=>now,authFactory:authFor(async(c)=>{tried.push(c.id);now=120001;throw quota();})}),e=>e.code==='AI_DOCUMENT_RETRY_LIMIT');
  assert.deepEqual(tried,['primary']);
});
