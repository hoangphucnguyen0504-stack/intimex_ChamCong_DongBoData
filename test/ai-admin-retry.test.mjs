import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
import {digest,passwordHash,encrypt} from '../src/core.js';
const jobId='a'.repeat(64),config={CONFIG_ENCRYPTION_KEY:'ab'.repeat(32),API_TOKEN:'synthetic-integration-token',SESSION_SECRET:'synthetic-session-secret',ADMIN_USERNAME:'admin',ADMIN_PASSWORD_HASH:passwordHash('synthetic-password'),PUBLIC_ORIGIN:'http://localhost:3200',COOKIE_SECURE:'false'};
async function fixture(t,state='needs_review'){
  const job={id:jobId,scope:'inspection:company-test',state,provider_id:'provider-test',encrypted_payload:encrypt({payload:{synthetic:true}},config.CONFIG_ENCRYPTION_KEY)},writes=[];
  const token=digest(job.encrypted_payload);
  const pool={query:async(sql,args=[])=>{
    if(sql.startsWith('SELECT token_hash'))return [[...args[0]===digest('synthetic-session'+config.SESSION_SECRET)?[{token_hash:'session'}]:[]]];
    if(sql.startsWith('SELECT id,stage,error_code'))return [[{id:'synthetic-log',stage:'review',error_code:'AI_UNKNOWN',created_at:new Date(),encrypted_details:encrypt({scope:job.scope,jobId:job.id,code:'AI_UNKNOWN',stage:'review'},config.CONFIG_ENCRYPTION_KEY)}]];
    if(sql.startsWith('SELECT id,state,SHA2'))return [[{id:job.id,state:job.state,retry_token:digest(job.encrypted_payload)}]];
    if(sql.startsWith('SELECT id,scope,state'))return [[...args[0]===jobId?[structuredClone(job)]:[]]];
    if(sql.startsWith('DELETE FROM ai_provider_health')){writes.push(sql);return [{affectedRows:1}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='queued'")){
      if(args[1]===job.id&&args[2]===job.scope&&job.state===args[3]&&args[4]===job.encrypted_payload){job.state='queued';job.encrypted_payload=args[0];writes.push(sql);return [{affectedRows:1}];}return [{affectedRows:0}];
    }
    throw Error('Unexpected SQL: '+sql);
  }};
  pool.getConnection=async()=>({...pool,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}});
  const server=createApp(pool,config).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url='http://127.0.0.1:'+server.address().port+'/admin/ai/jobs/'+jobId+'/retry';
  const post=headers=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({attemptToken:token})});
  const logs=headers=>fetch('http://127.0.0.1:'+server.address().port+'/admin/ai/diagnostics',{headers});
  return {job,writes,post,logs,token};
}
test('admin retry requires an authenticated admin cookie and same-origin CSRF, never an integration bearer',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:config.PUBLIC_ORIGIN},{Origin:config.PUBLIC_ORIGIN,Authorization:'Bearer '+config.API_TOKEN},{Cookie:'dd_session=synthetic-session'},{Cookie:'dd_session=synthetic-session',Origin:'https://untrusted.invalid'}]){
    const response=await f.post(headers);assert([401,403].includes(response.status));assert.equal(f.job.state,'needs_review');
  }
  assert.equal(f.writes.length,0);
  assert.equal((await f.logs({})).status,401);
  const diagnostic=await (await f.logs({Cookie:'dd_session=synthetic-session'})).json();assert.equal(diagnostic.items[0].retryToken,f.token);assert(!JSON.stringify(diagnostic).includes(f.job.encrypted_payload));
  const responses=await Promise.all([f.post({Cookie:'dd_session=synthetic-session',Origin:config.PUBLIC_ORIGIN}),f.post({Cookie:'dd_session=synthetic-session',Origin:config.PUBLIC_ORIGIN})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(f.job.state,'queued');assert.equal(f.writes.filter(sql=>sql.startsWith('UPDATE')).length,1);
  const queuedLogs=await (await f.logs({Cookie:'dd_session=synthetic-session'})).json();assert.equal(queuedLogs.items[0].retryToken,undefined);
});
test('admin retry refuses running or completed jobs instead of duplicating successful calls',async t=>{
  for(const state of ['running','success']){const f=await fixture(t,state),response=await f.post({Cookie:'dd_session=synthetic-session',Origin:config.PUBLIC_ORIGIN});assert.equal(response.status,409);assert.equal(f.job.state,state);assert.equal(f.writes.length,0);}
});
