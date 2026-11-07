import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encrypt,decrypt,digest,Fault} from '../src/core.js';
import {callProvider,failover,validateOutput,payloadSchema} from '../src/aiProviders.js';
import {configurationSchema,saveConfiguration,publicConfiguration,submit,getJob,retryJob,retryAdminJob,cancelQueuedJob,processNext} from '../src/ai.js';
const key='ab'.repeat(32);
const payload=payloadSchema.parse({format:'docx',positions:[{id:'word/document.xml:p0',text:'{{mass}}',label:'Khối lượng',writable:true}],dictionary:[{key:'business.netKg',label:'Khối lượng',type:'number'}]});
const field={key:'mass',position:'word/document.xml:p0',source:'business.netKg',label:'Khối lượng',type:'number',rule:'sum',confidence:.9,reason:'Đối chiếu nhãn và vị trí.'};
const provider={id:'first',name:'Test',vendor:'openai',model:'test-model',apiKey:'not-a-real-key',enabled:true,pricingKnown:true,inputUsdPerMillion:1,outputUsdPerMillion:2};
const config={revision:0,providers:[provider],maxAttempts:3,maxCallsPerDay:10,maxOutputTokens:1000,dailyBudgetUsd:1};

test('OpenAI and Gemini use structured output without application token caps',async()=>{
  for(const vendor of ['openai','gemini']){
    const result=await callProvider({...provider,vendor},payload,{maxOutputTokens:700,fetchImpl:async(url,request)=>{
      assert(new URL(url).hostname===(vendor==='openai'?'api.openai.com':'generativelanguage.googleapis.com'));
      assert.equal(request.redirect,'error');const body=JSON.parse(request.body);
      if(vendor==='openai'){assert.equal(body.store,false);assert.equal(body.max_completion_tokens,undefined);assert.equal(body.max_tokens,undefined);assert.equal(body.response_format.json_schema.strict,true);}
      else{assert.equal(body.generationConfig.maxOutputTokens,undefined);assert.equal(body.generationConfig.responseMimeType,'application/json');assert.equal(request.headers['x-goog-api-key'],provider.apiKey);}
      return Response.json(vendor==='openai'?{choices:[{message:{content:JSON.stringify({fields:[field]})},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:50}}:{candidates:[{content:{parts:[{text:JSON.stringify({fields:[field]})}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,thoughtsTokenCount:20}});
    }});
    assert.equal(result.result.fields[0].position,field.position);assert.deepEqual(result.usage,{input:100,output:vendor==='openai'?50:70});assert.equal(result.usageKnown,true);
  }
});
test('AI output cannot invent positions, formulas, sources or duplicate target writes',()=>{
  for(const bad of [{...field,position:'fake'}, {...field,source:'secret'}, {...field,key:'constructor()'}])assert.throws(()=>validateOutput({fields:[bad]},payload));
  assert.throws(()=>validateOutput({fields:[field,{...field,key:'other'}]},payload),e=>e.code==='AI_INVALID_MAPPING');
  assert.throws(()=>validateOutput({fields:[field]},{...payload,positions:[{...payload.positions[0],formula:true}]}));
});
test('provider schema constrains confidence and keys and invalid Gemini output preserves usage with a safe diagnostic',async()=>{
  let request;
  const invoke=value=>callProvider({...provider,vendor:'gemini'},payload,{fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}],usageMetadata:{promptTokenCount:180,candidatesTokenCount:381,thoughtsTokenCount:19}});
  }});
  for(const [patch,code] of [[{key:'business.netKg'},'AI_INVALID_OUTPUT_KEY'],[{confidence:93},'AI_INVALID_OUTPUT_CONFIDENCE'],[{reason:null},'AI_INVALID_OUTPUT_REASON']]){
    await assert.rejects(()=>invoke({fields:[{...field,...patch}]}),error=>{
      assert.equal(error.code,code);assert.equal(error.usageKnown,true);assert.deepEqual(error.usage,{input:180,output:400});
      assert(!JSON.stringify(error).includes('business.netKg'));return true;
    });
  }
  const properties=request.generationConfig.responseJsonSchema.properties.fields.items.properties;
  assert.equal(properties.key.pattern,'^[A-Za-z_][A-Za-z0-9_]{0,49}$');
  assert.equal(properties.confidence.minimum,0);assert.equal(properties.confidence.maximum,1);
  assert.deepEqual(properties.source.enum,['business.netKg','manual']);
  assert.equal(request.generationConfig.responseJsonSchema.properties.fields.maxItems,150);
});
test('truncated and blocked responses have specific codes and invalid output fails over once with its token usage',async()=>{
  for(const [finishReason,code] of [['MAX_TOKENS','AI_OUTPUT_TRUNCATED'],['SAFETY','AI_BLOCKED']]){
    await assert.rejects(()=>callProvider({...provider,vendor:'gemini'},payload,{fetchImpl:async()=>Response.json({candidates:[{finishReason,content:{parts:[{text:'partial'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:20}})}),error=>error.code===code&&error.usage.input===10);
  }
  const events=[],calls=[];
  const result=await failover([provider,{...provider,id:'backup'}],payload,{invoke:async p=>{
    calls.push(p.id);if(p.id==='first')throw Object.assign(new Fault(502,'AI_INVALID_OUTPUT_CONFIDENCE'),{usageKnown:true,usage:{input:180,output:400}});
    return {result:{fields:[field]},usageKnown:true,usage:{input:50,output:30}};
  },after:async(_p,event)=>events.push(event)});
  assert.deepEqual(calls,['first','backup']);assert.equal(result.providerId,'backup');assert.deepEqual(events[0].usage,{input:180,output:400});
});
test('fine-tuned OpenAI models retain compatible provider schemas and strict local validation',async()=>{
  await assert.rejects(()=>callProvider({...provider,model:'ft:test-model:organization:suffix'},payload,{fetchImpl:async(_url,options)=>{
    const schema=JSON.parse(options.body).response_format.json_schema.schema;
    assert.equal(schema.properties.fields.maxItems,undefined);
    for(const property of Object.values(schema.properties.fields.items.properties))for(const keyword of ['pattern','minLength','maxLength','minimum','maximum'])assert.equal(property[keyword],undefined);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({fields:[{...field,confidence:93}]})}}],usage:{prompt_tokens:10,completion_tokens:20}});
  }}),error=>error.code==='AI_INVALID_OUTPUT_CONFIDENCE');
});
test('rate limits fail over across the entire ordered list; cooldown and uncertain stops remain',async()=>{
  const calls=[],events=[];
  const result=await failover([{...provider,cooldownUntil:100},provider,{...provider,id:'second'}],payload,{now:()=>0,invoke:async p=>{calls.push(p.id);if(p.id==='first')throw new Fault(429,'AI_RATE_LIMIT');return {result:{fields:[field]},usage:{input:1,output:1}};},after:async(p,event)=>events.push([p.id,event.state])});
  assert.deepEqual(calls,['first','second']);assert.equal(result.providerId,'second');assert.deepEqual(events,[['first','failed'],['second','success']]);
  let attempts=0;
  await assert.rejects(()=>failover(Array.from({length:5},(_,i)=>({...provider,id:'api-'+i})),payload,{invoke:async()=>{attempts++;throw new Fault(503,'AI_SERVICE');}}));assert.equal(attempts,5);
  attempts=0;
  await assert.rejects(()=>failover([provider,provider],payload,{invoke:async()=>{attempts++;throw Object.assign(new Fault(503,'AI_TIMEOUT'),{uncertain:true});}}),e=>e.code==='AI_UNKNOWN');assert.equal(attempts,1);
});
test('failure to persist a successful call does not invoke another paid provider',async()=>{
  let calls=0;
  await assert.rejects(()=>failover([provider,provider],payload,{invoke:async()=>{calls++;return {result:{fields:[]},usage:{input:1,output:1}};},after:async()=>{throw Error('database unavailable');}}));assert.equal(calls,1);
});

function memoryPool(){
  const state={cfg:null,jobs:new Map(),calls:[],audit:[],health:[],commits:0,rollbacks:0};
  const db={state,async getConnection(){return {...db,beginTransaction:async()=>{},commit:async()=>{state.commits++;},rollback:async()=>{state.rollbacks++;},release(){}};},async query(sql,p=[]){
    if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
    if(sql.includes('RELEASE_LOCK'))return [[{}]];
    if(sql.startsWith('INSERT IGNORE INTO ai_configuration')){state.cfg||={revision:0,encrypted:p[0]};return [{affectedRows:1}];}
    if(sql.startsWith('SELECT revision,encrypted'))return [[...(state.cfg?[state.cfg]:[])]];
    if(sql==='SELECT id FROM ai_configuration WHERE id=1 FOR UPDATE')return [[{id:1}]];
    if(sql.startsWith('UPDATE ai_configuration')){state.cfg={revision:state.cfg.revision+1,encrypted:p[0]};return [{affectedRows:1}];}
    if(sql.startsWith('INSERT INTO ai_config_audit')){state.audit.push(p);return [{affectedRows:1}];}
    if(sql.startsWith('INSERT IGNORE INTO ai_diagnostics'))return [{affectedRows:1}];
    if(sql.startsWith('SELECT * FROM ai_provider_health'))return [state.health];
    if(sql.startsWith('DELETE FROM ai_provider_health')){state.health=state.health.filter(item=>item.provider_id!==p[0]);return [{affectedRows:1}];}
    if(sql.startsWith('INSERT INTO ai_provider_health')){state.health.push({provider_id:p[0],error_code:p[2]});return [{affectedRows:1}];}
    if(sql.startsWith('SELECT provider_id,COUNT'))return [[]];
    if(sql.startsWith('SELECT COUNT(*) calls'))return [[{calls:state.calls.length,cost:state.calls.reduce((sum,c)=>sum+c.cost,0)}]];
    if(sql.startsWith('INSERT INTO ai_calls')){state.calls.push({id:p[0],job:p[1],provider:p[2],state:'running',cost:0});return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE ai_calls c JOIN'))return [{affectedRows:0}];
    if(sql.startsWith('UPDATE ai_calls')){const c=state.calls.find(c=>c.id===p[2]);Object.assign(c,{state:p[0],error:p[1]});return [{affectedRows:1}];}
    if(sql.startsWith('INSERT IGNORE INTO ai_jobs')){if(!state.jobs.has(p[0]))state.jobs.set(p[0],{id:p[0],scope:p[1],fingerprint:p[2],payload_hash:p[3],encrypted_payload:p[4],state:'queued'});return [{affectedRows:1}];}
    if(sql.startsWith('SELECT id,scope')||sql.startsWith('SELECT * FROM ai_jobs WHERE id=')){const job=state.jobs.get(p[0]);return [[...(job&&(!p[1]||job.scope===p[1])?[structuredClone(job)]:[])]];}
    if(sql.includes("SELECT * FROM ai_jobs WHERE state='queued'"))return [[...([...state.jobs.values()].filter(j=>j.state==='queued'&&(!sql.includes('available_at<=')||!j.available_at||j.available_at<=Date.now())).slice(0,1))]];
    if(sql.startsWith("UPDATE ai_jobs SET state='running'")){const job=state.jobs.get(p[0]);if(job.state!=='queued')return [{affectedRows:0}];job.state='running';return [{affectedRows:1}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='queued',started_at=NULL")){const job=state.jobs.get(p[1]);if(job?.state!=='running')return [{affectedRows:0}];job.state='queued';job.started_at=null;job.available_at=Date.now()+p[0]*1000;return [{affectedRows:1}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='success'")){Object.assign(state.jobs.get(p[2]),{state:'success',encrypted_result:p[0],provider_id:p[1]});return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE ai_jobs SET state=?')){Object.assign(state.jobs.get(p[3]),{state:p[0],error_code:p[1],provider_id:p[2]});return [{affectedRows:1}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='failed'")){const job=state.jobs.get(p[0]);if(job&&job.scope===p[1]&&job.state==='queued'){Object.assign(job,{state:'failed',error_code:'AI_CANCELLED'});return [{affectedRows:1}];}return [{affectedRows:0}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='queued'")&&sql.includes('BINARY encrypted_payload')){const j=state.jobs.get(p[1]);if(j&&j.scope===p[2]&&j.state===p[3]&&j.encrypted_payload===p[4]){j.state='queued';j.encrypted_payload=p[0];return [{affectedRows:1}];}return [{affectedRows:0}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='queued'")){const j=state.jobs.get(p[0]);if(j&&j.scope===p[1]&&['failed','needs_review'].includes(j.state)&&j.encrypted_payload){j.state='queued';return [{affectedRows:1}];}return [{affectedRows:0}];}
    if(sql.startsWith("UPDATE ai_jobs SET state='needs_review'")||sql.startsWith('UPDATE ai_jobs SET encrypted_payload=NULL'))return [{affectedRows:0}];
    if(sql.startsWith('DELETE d FROM ai_documents'))return [{affectedRows:0}];
    if(sql.startsWith('SELECT * FROM ai_drive_cleanup'))return [[]];
    if(sql.startsWith('SELECT provider_id FROM ai_calls'))return [[...state.calls.filter(c=>c.job===p[0]).slice(-1).map(c=>({provider_id:c.provider}))]];
    throw Error('Unexpected SQL: '+sql);
  }};return db;
}
test('provider secrets are encrypted, masked, preserved on blank updates and revision guarded',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'test-admin');
  assert(!db.state.cfg.encrypted.includes(provider.apiKey));assert.equal(decrypt(db.state.cfg.encrypted,key).providers[0].apiKey,provider.apiKey);
  const published=await publicConfiguration(db,key);assert.equal(published.providers[0].apiKey,undefined);assert.equal(published.providers[0].keyConfigured,true);
  assert(!JSON.stringify(db.state.audit).includes(provider.apiKey));
  const {apiKey,...masked}=provider;await saveConfiguration(db,key,{...config,revision:1,providers:[masked]},'test-admin');
  assert.equal(decrypt(db.state.cfg.encrypted,key).providers[0].apiKey,provider.apiKey);
  await assert.rejects(()=>saveConfiguration(db,key,config,'test-admin'),e=>e.code==='AI_CONFIG_REVISION');
  assert.equal(configurationSchema.parse({...config,providers:[{...provider,baseURL:'http://localhost/'}]}).providers[0].baseURL,undefined);
});
test('fixing a model clears its stale cooldown without changing the key; unchanged saves preserve cooldown',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'test-admin');
  db.state.health=[{provider_id:provider.id,error_code:'AI_AUTH',cooldown_until:new Date(Date.now()+3600000).toISOString()}];
  const {apiKey,...preserved}=provider;
  await saveConfiguration(db,key,{revision:1,providers:[preserved]},'test-admin');
  assert.equal((await publicConfiguration(db,key)).providers[0].health.error_code,'AI_AUTH');
  await saveConfiguration(db,key,{revision:2,providers:[{...preserved,model:'fixed-model'}]},'test-admin');
  assert.equal((await publicConfiguration(db,key)).providers[0].health,null);
  assert.equal(decrypt(db.state.cfg.encrypted,key).providers[0].apiKey,apiKey);
});
test('durable jobs are idempotent, encrypted and scope guarded; worker commits results',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const input={requestId:'request-123',scope:'company-a',fingerprint:'a'.repeat(64),payload};
  const first=await submit(db,key,input),second=await submit(db,key,input);assert.equal(first.job.id,second.job.id);assert.equal(db.state.jobs.size,1);
  assert(![...db.state.jobs.values()][0].encrypted_payload.includes('{{mass}}'));
  await assert.rejects(()=>submit(db,key,{...input,payload:{...payload,positions:[{...payload.positions[0],text:'different'}]}}),e=>e.code==='AI_REQUEST_REUSED');
  await assert.rejects(()=>getJob(db,key,first.job.id,'other-company'),e=>e.code==='AI_JOB_NOT_FOUND');
  let calls=0;await processNext(db,key,{invoke:async()=>{calls++;return {result:{fields:[field]},usage:{input:50,output:20}};}});
  const done=await getJob(db,key,first.job.id,'company-a');assert.equal(done.job.state,'success');assert.equal(done.job.result.fields[0].key,'mass');
  await processNext(db,key,{invoke:async()=>{calls++;}});assert.equal(calls,1);assert.equal(db.state.calls[0].state,'success');
});
test('temporary provider cooldown keeps the same job queued without a paid call and resumes after expiry',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const {job}=await submit(db,key,{requestId:'cooldown-wait',scope:'company-a',fingerprint:'a'.repeat(64),payload});
  db.state.health=[{provider_id:provider.id,error_code:'AI_SERVICE',cooldown_until:new Date(Date.now()+60000).toISOString()}];
  let calls=0;const invoke=async()=>{calls++;return {result:{fields:[field]}};};
  await processNext(db,key,{invoke});await processNext(db,key,{invoke});
  assert.equal((await getJob(db,key,job.id,'company-a')).job.state,'queued');assert.equal(calls,0);assert.equal(db.state.calls.length,0);
  assert.equal(db.state.health[0].error_code,'AI_SERVICE','waiting must not erase the provider health failure');
  db.state.health[0].cooldown_until=new Date(Date.now()-1000).toISOString();
  db.state.jobs.get(job.id).available_at=Date.now()-1000;
  await processNext(db,key,{invoke});
  const done=(await getJob(db,key,job.id,'company-a')).job;assert.equal(done.id,job.id);assert.equal(done.state,'success');assert.equal(calls,1);
});
test('an available backup is used immediately while the primary is cooling down',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,{revision:0,providers:[provider,{...provider,id:'backup'}]},'admin');
  const {job}=await submit(db,key,{requestId:'cooldown-backup',scope:'company-a',fingerprint:'a'.repeat(64),payload});
  db.state.health=[{provider_id:provider.id,error_code:'AI_SERVICE',cooldown_until:new Date(Date.now()+60000).toISOString()}];
  await processNext(db,key,{invoke:async p=>{assert.equal(p.id,'backup');return {result:{fields:[field]}};}});
  assert.equal((await getJob(db,key,job.id,'company-a')).job.state,'success');assert.equal(db.state.calls.length,1);
});
test('disabled providers do not leave jobs waiting indefinitely for a cooldown',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const {job}=await submit(db,key,{requestId:'cooldown-disabled',scope:'company-a',fingerprint:'a'.repeat(64),payload});
  await saveConfiguration(db,key,{revision:1,providers:[{...provider,enabled:false}]},'admin');
  db.state.health=[{provider_id:provider.id,error_code:'AI_SERVICE',cooldown_until:new Date(Date.now()+60000).toISOString()}];
  await processNext(db,key,{invoke:async()=>{throw Error('must not call disabled provider');}});
  const failed=(await getJob(db,key,job.id,'company-a')).job;assert.equal(failed.state,'failed');assert.equal(failed.errorCode,'AI_NO_PROVIDER');assert.equal(db.state.calls.length,0);
});
test('a cooling connection-test job cannot starve a file job with an available backup',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,{revision:0,providers:[provider,{...provider,id:'backup'}]},'admin');
  const first=await submit(db,key,{requestId:'pinned-test',scope:'admin:connection-test',fingerprint:'a'.repeat(64),payload},{testProviderId:provider.id});
  const second=await submit(db,key,{requestId:'normal-file',scope:'company-a',fingerprint:'b'.repeat(64),payload});
  db.state.health=[{provider_id:provider.id,error_code:'AI_SERVICE',cooldown_until:new Date(Date.now()+60000).toISOString()}];
  const invoke=async p=>{assert.equal(p.id,'backup');return {result:{fields:[field]}};};
  await processNext(db,key,{invoke});await processNext(db,key,{invoke});
  assert.equal((await getJob(db,key,first.job.id,'admin:connection-test')).job.state,'queued');
  assert.equal((await getJob(db,key,second.job.id,'company-a')).job.state,'success');assert.equal(db.state.calls.length,1);
});
test('a corrected provider resumes a deferred job within one minute instead of its old hour cooldown',async t=>{
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const {job}=await submit(db,key,{requestId:'corrected-provider',scope:'company-a',fingerprint:'a'.repeat(64),payload});
  db.state.health=[{provider_id:provider.id,error_code:'AI_AUTH',cooldown_until:new Date(clock+3600000).toISOString()}];
  await processNext(db,key,{invoke:async()=>{throw Error('not available yet');}});
  await saveConfiguration(db,key,{revision:1,providers:[{...provider,model:'corrected-model'}]},'admin');
  clock+=61000;
  await processNext(db,key,{invoke:async p=>{assert.equal(p.model,'corrected-model');return {result:{fields:[field]}};}});
  assert.equal((await getJob(db,key,job.id,'company-a')).job.state,'success');assert.equal(db.state.calls.length,1);
});
test('legacy daily budgets and token settings are ignored; explicit retry still prevents ambiguous duplicate calls',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,{...config,maxCallsPerDay:1,dailyBudgetUsd:0.000001},'admin');
  const published=await publicConfiguration(db,key);
  assert.deepEqual(Object.keys(published).sort(),['providers','revision']);
  assert.equal(published.providers[0].pricingKnown,undefined);assert.equal(published.providers[0].inputUsdPerMillion,undefined);
  const input={requestId:'request-123',scope:'company-a',fingerprint:'a'.repeat(64),payload};
  const first=await submit(db,key,input);let calls=0;
  await processNext(db,key,{invoke:async()=>{calls++;throw Object.assign(new Fault(503,'AI_TIMEOUT'),{uncertain:true});}});
  assert.equal((await getJob(db,key,first.job.id,'company-a')).job.state,'needs_review');
  await processNext(db,key,{invoke:async()=>{calls++;}});assert.equal(calls,1);
  const retryToken=(await getJob(db,key,first.job.id,'company-a')).job.retryToken;
  await assert.rejects(()=>retryJob(db,key,first.job.id,'company-b',retryToken),e=>e.code==='AI_JOB_NOT_FOUND');
  await retryJob(db,key,first.job.id,'company-a',retryToken);
  db.state.jobs.get(first.job.id).state='needs_review';
  await assert.rejects(()=>retryJob(db,key,first.job.id,'company-a',retryToken),e=>e.code==='AI_NOT_RETRYABLE');
  db.state.jobs.get(first.job.id).state='queued';
  await processNext(db,key,{invoke:async()=>{calls++;return {result:{fields:[field]}};}});
  assert.equal(calls,2);assert.equal((await getJob(db,key,first.job.id,'company-a')).job.state,'success');
});
test('old stored configuration cannot re-enable cost or token limits before it is resaved',async()=>{
  const db=memoryPool();db.state.cfg={revision:4,encrypted:encrypt({...config,maxCallsPerDay:1,maxOutputTokens:256,dailyBudgetUsd:0.000001},key)};
  const published=await publicConfiguration(db,key);
  assert.equal(published.maxOutputTokens,undefined);assert.equal(published.maxCallsPerDay,undefined);assert.equal(published.dailyBudgetUsd,undefined);
  let calls=0;
  for(let i=0;i<3;i++){
    await submit(db,key,{requestId:'new-job-'+i,scope:'test-company',fingerprint:'b'.repeat(64),payload});
    await processNext(db,key,{invoke:async()=>{calls++;return {result:{fields:[]}};}});
  }
  assert.equal(calls,3);assert.equal(db.state.calls.length,3);
  const stored=decrypt(db.state.cfg.encrypted,key);assert.equal(stored.maxCallsPerDay,1,'reading does not rewrite legacy configuration');
});
test('stalled-queue cancellation is scope guarded and never claims to cancel a running paid request',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const created=await submit(db,key,{requestId:'cancel-test',scope:'company-a',fingerprint:'c'.repeat(64),payload});
  assert.equal((await cancelQueuedJob(db,created.job.id,'other-company')).cancelled,false);
  assert.equal((await getJob(db,key,created.job.id,'company-a')).job.state,'queued');
  assert.equal((await cancelQueuedJob(db,created.job.id,'company-a')).cancelled,true);
  await processNext(db,key,{invoke:async()=>assert.fail('cancelled queued job must never invoke a provider')});
  db.state.jobs.get(created.job.id).state='running';
  assert.equal((await cancelQueuedJob(db,created.job.id,'company-a')).cancelled,false);
  assert.equal((await getJob(db,key,created.job.id,'company-a')).job.state,'running');
});
test('a job cancelled between queue selection and worker claim cannot be revived or billed',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const created=await submit(db,key,{requestId:'cancel-race',scope:'company-a',fingerprint:'d'.repeat(64),payload});
  const query=db.query;let cancelled=false;
  db.query=async(sql,args)=>{const result=await query(sql,args);if(sql.includes("SELECT * FROM ai_jobs WHERE state='queued'")&&!cancelled){cancelled=true;assert.equal((await cancelQueuedJob(db,created.job.id,'company-a')).cancelled,true);}return result;};
  await processNext(db,key,{invoke:async()=>assert.fail('cancelled queued job was revived')});
  assert.equal((await getJob(db,key,created.job.id,'company-a')).job.state,'failed');assert.equal(db.state.calls.length,0);
});
test('unknown jobs retain their provider, legacy rows recover it, and only one explicit admin retry is queued',async()=>{
  const db=memoryPool();await saveConfiguration(db,key,config,'admin');
  const input={requestId:'request-timeout-123',scope:'inspection:test',fingerprint:'c'.repeat(64),payload},first=await submit(db,key,input);
  const transport={phase:'request',reason:'deadline',elapsedMs:180000,timeoutMs:180000};
  await processNext(db,key,{invoke:async()=>{throw Object.assign(new Fault(503,'AI_TIMEOUT'),{uncertain:true,transport});}});
  let job=(await getJob(db,key,first.job.id,input.scope)).job;assert.equal(job.state,'needs_review');assert.equal(job.providerId,provider.id);assert.equal(job.errorCode,'AI_UNKNOWN');
  db.state.jobs.get(first.job.id).provider_id=null;
  job=(await getJob(db,key,first.job.id,input.scope)).job;assert.equal(job.providerId,provider.id);
  assert.equal(db.state.health.find(h=>h.provider_id===provider.id).error_code,'AI_TIMEOUT');
  db.state.health.push({provider_id:'another',error_code:'AI_RATE_LIMIT'});
  const token=digest(db.state.jobs.get(first.job.id).encrypted_payload);
  const retries=await Promise.allSettled([retryAdminJob(db,key,first.job.id,token),retryAdminJob(db,key,first.job.id,token)]);
  assert.equal(retries.filter(r=>r.status==='fulfilled').length,1);assert.equal(db.state.jobs.get(first.job.id).state,'queued');assert.equal(db.state.calls.length,1);
  assert.equal(db.state.health.some(h=>h.provider_id===provider.id),false);assert.equal(db.state.health[0].error_code,'AI_RATE_LIMIT');
  await assert.rejects(()=>retryAdminJob(db,key,first.job.id,token),e=>e.code==='AI_NOT_RETRYABLE');
  db.state.jobs.get(first.job.id).state='needs_review';
  await assert.rejects(()=>retryAdminJob(db,key,first.job.id,token),e=>e.code==='AI_NOT_RETRYABLE','a stale confirmation cannot retry a new unknown attempt');
  db.state.jobs.get(first.job.id).state='success';await assert.rejects(()=>retryAdminJob(db,key,first.job.id,digest(db.state.jobs.get(first.job.id).encrypted_payload)),e=>e.code==='AI_NOT_RETRYABLE');
});
