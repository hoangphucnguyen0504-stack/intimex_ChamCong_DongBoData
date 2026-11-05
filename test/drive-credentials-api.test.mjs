import test from 'node:test';
import assert from 'node:assert/strict';
import {OAuth2Client} from 'google-auth-library';
import {request as httpRequest} from 'node:http';
import {createApp} from '../src/app.js';
import {encrypt,passwordHash,digest} from '../src/core.js';

const key=Buffer.alloc(32,7).toString('hex');
const config={CONFIG_ENCRYPTION_KEY:key,API_TOKEN:'backend-token',CHATBOX_API_TOKEN:'chatbox-token',CHATBOX_READ_TOKEN:'chatbox-token',SESSION_SECRET:'session-test',ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:passwordHash('test password'),PUBLIC_ORIGIN:'http://localhost:3200',COOKIE_SECURE:'false'};
const credential={id:'drive-one',label:'Drive One',clientId:'client-id',clientSecret:'PRIVATE-CLIENT-SECRET',refreshToken:'PRIVATE-REFRESH-TOKEN',folderId:'folder-one',enabled:true};
async function fixture(t){
  let state={revision:1,encrypted:encrypt({credentials:[credential],consumers:{},receipts:{},events:[]},key)};
  const query=async(sql,args=[])=>{
    if(sql.includes('SELECT token_hash'))return [args[0]===digest('admin-session'+config.SESSION_SECRET)?[{token_hash:'session'}]:[]];
    if(sql.includes('SELECT hits'))return [[{hits:1}]];
    if(sql.startsWith('SELECT revision,encrypted'))return [[{...state}]];
    if(sql.startsWith('UPDATE drive_credential_state'))state={revision:args[0],encrypted:args[1]};
    return [{affectedRows:1}];
  };
  const conn={query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
  const pool={query,getConnection:async()=>conn};
  const listener=createApp(pool,config).listen(0,'127.0.0.1');
  await new Promise(r=>listener.once('listening',r));
  t.after(()=>new Promise(r=>{listener.close(r);listener.closeAllConnections();}));
  const url='http://127.0.0.1:'+listener.address().port;
  const request=(path,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const wire=body?JSON.stringify(body):undefined;
    const req=httpRequest(url+path,{method,headers:{...(wire?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(wire)}:{}),...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,headers:{get:name=>res.headers[name.toLowerCase()]},text:async()=>text,json:async()=>JSON.parse(text)}));
    });req.on('error',reject);req.end(wire);
  });
  return {request,url};
}
const acquire={consumer:'chamcong',requestId:'api-request-1',reason:'initial'};
const privateAbsent=text=>{assert(!text.includes(credential.clientSecret));assert(!text.includes(credential.refreshToken));};

test('mounted acquire denies anonymous, admin cookies, ChatBox and browser bearer requests',async t=>{
  const {request}=await fixture(t);
  for(const headers of [{},{Cookie:'dd_session=admin-session'},{Authorization:'Bearer '+config.CHATBOX_READ_TOKEN}]){
    const response=await request('/v1/drive-credentials/acquire',{method:'POST',headers,body:acquire});
    assert.equal(response.status,401);privateAbsent(await response.text());
  }
  for(const browserHeaders of [{Origin:config.PUBLIC_ORIGIN},{'Sec-Fetch-Site':'same-origin'},{'Sec-Fetch-Mode':'cors','Sec-Fetch-Site':'cross-site'}]){
    const response=await request('/v1/drive-credentials/acquire',{method:'POST',headers:{Authorization:'Bearer '+config.API_TOKEN,...browserHeaders},body:acquire});
    assert.equal(response.status,403);privateAbsent(await response.text());
  }
});

test('backend acquisition returns credentials while authenticated admin polling stays masked and stable',async t=>{
  const {request}=await fixture(t);
  const anonymous=await request('/admin/drive-credentials');assert.equal(anonymous.status,401);privateAbsent(await anonymous.text());
  const issued=await request('/v1/drive-credentials/acquire',{method:'POST',headers:{Authorization:'Bearer '+config.API_TOKEN},body:acquire});
  assert.equal(issued.status,200);assert.equal(issued.headers.get('cache-control'),'no-store');
  const value=await issued.json();assert.equal(value.credential.refreshToken,credential.refreshToken);assert.equal(value.credential.clientSecret,credential.clientSecret);
  let previous;
  for(let i=0;i<3;i++){
    const response=await request('/admin/drive-credentials',{headers:{Cookie:'dd_session=admin-session'}});
    assert.equal(response.status,200);const text=await response.text();privateAbsent(text);
    const state=JSON.parse(text);assert.equal(state.consumers.length,1);assert.equal(state.events.length,1);
    if(previous)assert.deepEqual(state,previous);previous=state;
  }
  const replay=await request('/v1/drive-credentials/acquire',{method:'POST',headers:{Authorization:'Bearer '+config.API_TOKEN},body:acquire});
  assert.deepEqual(await replay.json(),value);
});

test('native backend fetch with Sec-Fetch-Mode cors can acquire a credential',async t=>{
  const {url}=await fixture(t);
  const response=await fetch(url+'/v1/drive-credentials/acquire',{method:'POST',headers:{Authorization:'Bearer '+config.API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({...acquire,requestId:'native-worker-fetch'})});
  assert.equal(response.status,200);assert.equal((await response.json()).credential.id,'drive-one');
});

test('admin credential writes require same-origin CSRF and provider failures never expose secrets',async t=>{
  const {request}=await fixture(t);
  for(const origin of [undefined,'https://untrusted.invalid']){
    const response=await request('/admin/drive-credentials',{method:'PUT',headers:{Cookie:'dd_session=admin-session',...(origin?{Origin:origin}:{})},body:{revision:1,credentials:[credential]}});
    assert.equal(response.status,403);privateAbsent(await response.text());
  }
  const original=OAuth2Client.prototype.request;
  OAuth2Client.prototype.request=async()=>{throw Error(credential.clientSecret+' '+credential.refreshToken);};
  t.after(()=>{OAuth2Client.prototype.request=original;});
  const response=await request('/admin/drive-credentials/drive-one/test',{method:'POST',headers:{Cookie:'dd_session=admin-session',Origin:config.PUBLIC_ORIGIN},body:{}});
  assert.equal(response.status,502);const text=await response.text();privateAbsent(text);assert.equal(JSON.parse(text).code,'DRIVE_CREDENTIAL_TEST_FAILED');
});
