import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {access,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
import {encrypt,decrypt} from '../src/core.js';
const helperPath=new URL('../../HDoi/src/services/driveCredentials.js',import.meta.url);
let available=true;try{await access(helperPath);}catch{available=false;}
test('real broker HTTP and encrypted HDoi volume acquire once, survive restart and coalesce rotation',{skip:!available,timeout:15000},async t=>{
 const require=createRequire(import.meta.url),{createCredentialStore}=require(helperPath.pathname.replace(/^\/([A-Za-z]:)/,'$1'));
 const key='d7'.repeat(32),root=await mkdtemp(join(tmpdir(),'drive-roundtrip-'));
 let row={revision:1,encrypted:encrypt({credentials:['a','b'].map(id=>({id,label:'Drive '+id,clientId:'client-'+id,clientSecret:'TEST-SECRET-'+id,refreshToken:'TEST-REFRESH-'+id,folderId:'folder-'+id,enabled:true})),consumers:{},events:[],receipts:{}},key)};
 const query=async(sql,args=[])=>{
  if(sql.startsWith('SELECT revision,encrypted'))return [[row]];
  if(sql.startsWith('UPDATE drive_credential_state'))row={revision:args[0],encrypted:args[1]};
  return [{affectedRows:1}];
 };
 const db={query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release(){}};
 const server=createApp({query,getConnection:async()=>db},{CONFIG_ENCRYPTION_KEY:key,API_TOKEN:'TEST-BACKEND-TOKEN'}).listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(root,{recursive:true,force:true});});
 const env={DRIVE_CREDENTIAL_ENCRYPTION_KEY:key,DATA_DONG_BO_URL:'http://127.0.0.1:'+server.address().port,DATA_DONG_BO_TOKEN:'TEST-BACKEND-TOKEN',DRIVE_CLIENT_ID:'local-client',DRIVE_CLIENT_SECRET:'TEST-LOCAL-SECRET',DRIVE_REFRESH_TOKEN:'TEST-LOCAL-REFRESH',DRIVE_FOLDER_ID:'local-folder'};
 let calls=0;const options={env,root,fetchImpl:(...args)=>{calls++;return fetch(...args);}};
 const first=createCredentialStore(options);
 assert.equal((await first.acquire({consumer:'hdoi'})).id,'a');assert.equal(calls,1);
 const restarted=createCredentialStore(options);
 assert.equal((await restarted.acquire({consumer:'hdoi'})).id,'a');assert.equal(calls,1);
 await restarted.owner('hdoi','file_roundtrip_123456','a');
 assert.equal((await restarted.get('hdoi','environment')).refreshToken,'TEST-LOCAL-REFRESH');
 assert.equal(await restarted.owner('hdoi','file_roundtrip_123456'),'a');
 const [one,two]=await Promise.all([first,restarted].map(store=>store.acquire({consumer:'hdoi',currentId:'a',reason:'userRateLimitExceeded'})));
 assert.equal(one.id,'b');assert.equal(two.id,'b');assert.equal(calls,2);
 assert.equal((await first.get('hdoi','a')).refreshToken,'TEST-REFRESH-a');
 const bytes=await readFile(join(root,'hdoi.json'),'utf8');
 for(const secret of ['TEST-LOCAL-REFRESH','TEST-REFRESH-a','TEST-REFRESH-b'])assert(!bytes.includes(secret));
 const registry=decrypt(row.encrypted,key);assert.equal(registry.events.length,3);assert.equal(registry.consumers.hdoi.credential.id,'b');
});
