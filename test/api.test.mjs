import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
import {passwordHash} from '../src/core.js';
const config={API_TOKEN:'integration-test-secret',SESSION_SECRET:'test-session-secret',ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:passwordHash('test password'),PUBLIC_ORIGIN:'http://localhost:3200',COOKIE_SECURE:'false'};
const fake={query:async(sql)=>{
  if(sql.includes('SELECT token_hash'))return [[{token_hash:'fixture-session'}]];
  if(sql.includes('SELECT hits'))return [[{hits:1}]];
  if(sql==='SELECT 1')return [[{one:1}]];
  return [{affectedRows:1}];
}};
async function server(t,db=fake) {const listener=createApp(db,config).listen(0,'127.0.0.1');await new Promise(r=>listener.once('listening',r));t.after(()=>new Promise(r=>{listener.close(r);listener.closeAllConnections();}));return 'http://127.0.0.1:'+listener.address().port;}
test('API token required; browser cookies do not grant integration access',async t=>{
  const url=await server(t);const r=await fetch(url+'/v1/batch',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'dd_session=test'},body:'{}'});assert.equal(r.status,401);assert.equal((await r.json()).code,'API_TOKEN_INVALID');
});
test('admin rejects cross-origin writes and anonymous origin',async t=>{
  const url=await server(t);for(const origin of [undefined,'https://untrusted.invalid']){const r=await fetch(url+'/admin/logout',{method:'POST',headers:origin?{Origin:origin}:{}});assert.equal(r.status,403);}
});
test('login uses HttpOnly cookie, logout clears it, HTML has a strict CSP',async t=>{
  const url=await server(t);const r=await fetch(url+'/admin/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:config.PUBLIC_ORIGIN},body:JSON.stringify({username:'admin',password:'test password'})});
  assert.equal(r.status,200);const cookie=r.headers.get('set-cookie');assert.match(cookie,/HttpOnly/i);assert.match(cookie,/SameSite=Strict/i);assert(!cookie.includes('test password'));
  const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  const logout=await fetch(url+'/admin/logout',{method:'POST',headers:{Origin:config.PUBLIC_ORIGIN,Cookie:cookie}});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Expires=/i);
});
test('validation and unexpected failures do not leak credentials or SQL',async t=>{
  const url=await server(t);const r=await fetch(url+'/v1/batch',{method:'POST',headers:{Authorization:'Bearer '+config.API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({requestId:'short',operations:[]})});assert.equal(r.status,400);assert.equal((await r.json()).code,'VALIDATION_ERROR');
  const bad=await server(t,{query:async()=>{throw Error('MYSQL_PASSWORD=secret');}});const failure=await fetch(bad+'/admin/me');assert.equal(failure.status,503);assert(!(await failure.text()).includes('secret'));
});
