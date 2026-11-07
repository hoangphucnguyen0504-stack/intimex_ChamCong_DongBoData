import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {encrypt,decrypt,digest,stable,Fault} from './core.js';
import {transaction} from './db.js';
import {payloadSchema,failover} from './aiProviders.js';
import {saveDiagnostic,safeError,mountDiagnostics} from './aiDiagnostics.js';
import {saveDocument,assertDocument,documentForReview} from './aiDocuments.js';
import {processDriveCleanup} from './aiDriveConversion.js';

const providerSchema=z.object({id:z.string().regex(/^[\w-]{1,100}$/),name:z.string().trim().min(1).max(100).optional(),vendor:z.enum(['openai','gemini']),model:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),enabled:z.boolean().default(true),apiKey:z.string().trim().min(8).max(2000).optional()}).strip();
// Old pricing/limit fields are intentionally discarded when old clients save configuration.
export const configurationSchema=z.object({revision:z.number().int().nonnegative(),providers:z.array(providerSchema)}).strip();
const defaults={providers:[]};
export async function configuration(db,key){
  const [[row]]=await db.query('SELECT revision,encrypted FROM ai_configuration WHERE id=1');
  const stored=row?decrypt(row.encrypted,key):defaults;
  return configurationSchema.parse({providers:stored.providers||[],revision:Number(row?.revision||0)});
}
export async function publicConfiguration(pool,key){
  const cfg=await configuration(pool,key);
  const [health]=await pool.query('SELECT * FROM ai_provider_health');
  return {...cfg,providers:cfg.providers.map(({apiKey,...p})=>({...p,keyConfigured:!!apiKey,health:health.find(h=>h.provider_id===p.id)||null}))};
}
export async function saveConfiguration(pool,key,input,actor){
  const next=configurationSchema.parse(input);
  if(new Set(next.providers.map(p=>p.id)).size!==next.providers.length)throw new Fault(400,'AI_PROVIDER_DUPLICATE');
  return transaction(pool,async db=>{
    await db.query('INSERT IGNORE INTO ai_configuration(id,revision,encrypted) VALUES(1,0,?)',[encrypt(defaults,key)]);
    await db.query('SELECT id FROM ai_configuration WHERE id=1 FOR UPDATE');
    const old=await configuration(db,key);
    if(next.revision!==old.revision)throw new Fault(409,'AI_CONFIG_REVISION','Cấu hình đã thay đổi. Tải lại trước khi lưu.');
    const providers=next.providers.map(p=>{
      const previous=old.providers.find(o=>o.id===p.id);
      const apiKey=p.apiKey||(previous?.vendor===p.vendor?previous.apiKey:undefined);
      if(p.enabled&&!apiKey)throw new Fault(400,'AI_KEY_REQUIRED','Nhập API key trước khi bật nhà cung cấp.');
      return {...p,name:p.name||`${p.vendor} · ${p.model}`.slice(0,100),apiKey};
    });
    const {revision,...settings}=next;
    await db.query('UPDATE ai_configuration SET revision=revision+1,encrypted=?,updated_at=UTC_TIMESTAMP(3) WHERE id=1',[encrypt({...settings,providers},key)]);
    await db.query('INSERT INTO ai_config_audit(revision,actor,summary) VALUES(?,?,?)',[revision+1,actor,JSON.stringify(providers.map(({apiKey,...p},priority)=>({...p,priority,keyChanged:!!next.providers[priority].apiKey})))]);
    for(const p of next.providers.filter(p=>p.apiKey||old.providers.some(previous=>previous.id===p.id&&(previous.vendor!==p.vendor||previous.model!==p.model))))await db.query('DELETE FROM ai_provider_health WHERE provider_id=?',[p.id]);
    return {ok:true,revision:revision+1};
  });
}
const submitSchema=z.object({requestId:z.string().min(8).max(150).regex(/^[\w:.-]+$/),scope:z.string().min(1).max(200),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),payload:payloadSchema}).strict();
export async function submit(pool,key,input,{testProviderId}={}){
  const d=submitSchema.parse(input),encoded=JSON.stringify(stable(d.payload));
  if(d.payload.mode==='recognition-review-v2')await assertDocument(pool,d.payload,d.scope);
  if(encoded.length>60000)throw new Fault(413,'AI_INPUT_LIMIT','Mẫu vượt giới hạn phân tích AI; thu gọn vùng dữ liệu hoặc cấu hình thủ công.');
  const id=digest(d.scope+':'+d.requestId),payloadHash=digest(encoded);
  const [[existing]]=await pool.query('SELECT id,scope,fingerprint,payload_hash,state,error_code,provider_id FROM ai_jobs WHERE id=?',[id]);
  if(existing){
    if(existing.payload_hash!==payloadHash||existing.fingerprint!==d.fingerprint||existing.scope!==d.scope)throw new Fault(409,'AI_REQUEST_REUSED','Mã yêu cầu đã được dùng cho dữ liệu khác.');
    return {ok:true,job:publicJob(existing)};
  }
  const cfg=await configuration(pool,key);
  if(!cfg.providers.some(p=>p.enabled&&p.apiKey&&(!testProviderId||p.id===testProviderId)))throw new Fault(503,'AI_NOT_CONFIGURED','Chưa có API AI đang bật. Cấu hình Danh sách API AI trong DataDongBo.');
  await pool.query('INSERT IGNORE INTO ai_jobs(id,scope,fingerprint,payload_hash,encrypted_payload) VALUES(?,?,?,?,?)',[id,d.scope,d.fingerprint,payloadHash,encrypt({payload:d.payload,testProviderId},key)]);
  const [[job]]=await pool.query('SELECT id,scope,fingerprint,payload_hash,state,error_code,provider_id FROM ai_jobs WHERE id=?',[id]);
  if(job.payload_hash!==payloadHash||job.fingerprint!==d.fingerprint||job.scope!==d.scope)throw new Fault(409,'AI_REQUEST_REUSED','Mã yêu cầu đã được dùng cho dữ liệu khác.');
  return {ok:true,job:publicJob(job)};
}
const publicJob=row=>({id:row.id,scope:row.scope,fingerprint:row.fingerprint,state:row.state,errorCode:row.error_code,providerId:row.provider_id});
export async function getJob(pool,key,id,scope){
  if(!/^[a-f0-9]{64}$/.test(id)||typeof scope!=='string'||!scope)throw new Fault(400,'AI_JOB_ID');
  const [[job]]=await pool.query('SELECT * FROM ai_jobs WHERE id=? AND scope=?',[id,scope]);
  if(!job)throw new Fault(404,'AI_JOB_NOT_FOUND');
  if(job.state==='success'&&!job.encrypted_result)throw new Fault(410,'AI_JOB_EXPIRED','Kết quả phân tích đã hết hạn. Quét lại mẫu.');
  if(!job.provider_id&&['needs_review','failed'].includes(job.state)){
    const [[call]]=await pool.query('SELECT provider_id FROM ai_calls WHERE job_id=? ORDER BY created_at DESC LIMIT 1',[id]);job.provider_id=call?.provider_id||null;
  }
  return {ok:true,job:{...publicJob(job),...(['failed','needs_review'].includes(job.state)&&job.encrypted_payload?{retryToken:digest(job.encrypted_payload)}:{}),...(job.state==='success'?{result:decrypt(job.encrypted_result,key)}:{})}};
}
async function retryVersion(pool,key,id,attemptToken,{scope,states}){
  z.string().regex(/^[a-f0-9]{64}$/).parse(id);
  z.string().regex(/^[a-f0-9]{64}$/).parse(attemptToken);
  return transaction(pool,async db=>{
    const [[job]]=await db.query('SELECT id,scope,state,provider_id,encrypted_payload FROM ai_jobs WHERE id=?'+(scope?' AND scope=?':''),scope?[id,scope]:[id]);
    if(!job)throw new Fault(404,'AI_JOB_NOT_FOUND');
    if(!states.includes(job.state)||!job.encrypted_payload||digest(job.encrypted_payload)!==attemptToken)throw new Fault(409,'AI_NOT_RETRYABLE','Tác vụ đã thay đổi. Tải lại nhật ký trước khi thử lại.');
    // A fresh encryption IV is an opaque attempt version. A stale confirmation
    // cannot requeue a later failure, even when both attempts need review.
    const refreshed=encrypt(decrypt(job.encrypted_payload,key),key);
    const [claimed]=await db.query("UPDATE ai_jobs SET state='queued',error_code=NULL,started_at=NULL,finished_at=NULL,available_at=UTC_TIMESTAMP(3),encrypted_payload=? WHERE id=? AND scope=? AND state=? AND BINARY encrypted_payload=BINARY ?",[refreshed,id,job.scope,job.state,job.encrypted_payload]);
    if(claimed.affectedRows!==1)throw new Fault(409,'AI_NOT_RETRYABLE');
    let providerId=job.provider_id;
    if(!providerId){const [[call]]=await db.query('SELECT provider_id FROM ai_calls WHERE job_id=? ORDER BY created_at DESC LIMIT 1',[id]);providerId=call?.provider_id;}
    if(providerId)await db.query("DELETE FROM ai_provider_health WHERE provider_id=? AND error_code IN ('AI_TIMEOUT','AI_NETWORK','AI_UNKNOWN')",[providerId]);
    return {ok:true};
  });
}
export function retryAdminJob(pool,key,id,attemptToken){return retryVersion(pool,key,id,attemptToken,{states:['needs_review']});}
export function retryJob(pool,key,id,scope,attemptToken){
  z.string().min(1).max(200).parse(scope);
  return retryVersion(pool,key,id,attemptToken,{scope,states:['failed','needs_review']});
}
export async function cancelQueuedJob(pool,id,scope){
  const input=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),scope:z.string().min(1).max(200)}).parse({id,scope});
  const [result]=await pool.query("UPDATE ai_jobs SET state='failed',error_code='AI_CANCELLED',finished_at=UTC_TIMESTAMP(3) WHERE id=? AND scope=? AND state='queued'",[input.id,input.scope]);
  return {ok:true,cancelled:result.affectedRows===1};
}
export async function processNext(pool,key,{invoke}={}){
  const lock=await pool.getConnection();let held=false;
  try{
    const [[r]]=await lock.query("SELECT GET_LOCK('datadongbo-ai-worker',0) acquired");held=Number(r.acquired)===1;if(!held)return;
    await lock.query("UPDATE ai_jobs SET state='needs_review',error_code='AI_INTERRUPTED',finished_at=UTC_TIMESTAMP(3) WHERE state='running' AND started_at<UTC_TIMESTAMP(3)-INTERVAL 5 MINUTE");
    await lock.query("UPDATE ai_calls c JOIN ai_jobs j ON j.id=c.job_id SET c.state='unknown',c.error_code='AI_INTERRUPTED' WHERE c.state='running' AND j.state='needs_review'");
    await lock.query('UPDATE ai_jobs SET encrypted_payload=NULL,encrypted_result=NULL WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL 14 DAY AND state NOT IN (\'queued\',\'running\')');
    await lock.query("DELETE d FROM ai_documents d WHERE d.created_at<UTC_TIMESTAMP(3)-INTERVAL 14 DAY AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.scope=d.scope AND j.state IN ('queued','running'))");
    await processDriveCleanup(lock,key);
    const [[job]]=await lock.query("SELECT * FROM ai_jobs WHERE state='queued' AND available_at<=UTC_TIMESTAMP(3) ORDER BY created_at LIMIT 1");
    if(!job)return;
    const [claimed]=await lock.query("UPDATE ai_jobs SET state='running',started_at=UTC_TIMESTAMP(3) WHERE id=? AND state='queued'",[job.id]);
    if(claimed.affectedRows!==1)return {id:job.id,skipped:true};
    let activeCall,sourceFileHash;
    try{
      const cfg=await configuration(pool,key),stored=decrypt(job.encrypted_payload,key),testProviderId=stored.testProviderId;
      sourceFileHash=stored.payload.fileHash;
      const [health]=await pool.query('SELECT * FROM ai_provider_health');
      const providers=cfg.providers.filter(p=>p.apiKey&&(!testProviderId||p.id===testProviderId)).map(p=>({...p,cooldownUntil:Date.parse(health.find(h=>h.provider_id===p.id)?.cooldown_until||'')||0}));
      const enabled=providers.filter(p=>p.enabled);
      if(enabled.length&&enabled.every(p=>p.cooldownUntil>Date.now())){
        // Cooldown is temporary availability, not a failed file review. Keep
        // the same durable job; the next worker tick rechecks provider health.
        const delay=Math.min(60,Math.max(1,Math.ceil((Math.min(...enabled.map(p=>p.cooldownUntil))-Date.now())/1000)));
        await pool.query("UPDATE ai_jobs SET state='queued',started_at=NULL,available_at=UTC_TIMESTAMP(3)+INTERVAL ? SECOND WHERE id=? AND state='running'",[delay,job.id]);
        return {id:job.id,deferred:true};
      }
      const payload=stored.payload.mode==='recognition-review-v2'?{...stored.payload,document:await documentForReview(pool,key,stored.payload,job.scope,{jobId:job.id})}:stored.payload;
      const outcome=await failover(providers,payload,{invoke,
        before:async provider=>{
          activeCall={id:randomUUID(),provider};
          await pool.query("INSERT INTO ai_calls(id,job_id,provider_id,state) VALUES(?,?,?,'running')",[activeCall.id,job.id,provider.id]);
        },
        after:async(provider,result)=>{
          await pool.query('UPDATE ai_calls SET state=?,error_code=? WHERE id=?',[result.state,result.code||null,activeCall.id]);
          if(result.state!=='success'&&payload.mode?.startsWith('recognition-review'))await saveDiagnostic(pool,key,{scope:job.scope,stage:'review',fileHash:payload.fileHash,jobId:job.id,providerId:provider.id,...safeError(result)});
          if(result.state!=='success')await pool.query('INSERT INTO ai_provider_health(provider_id,cooldown_until,error_code) VALUES(?,UTC_TIMESTAMP(3)+INTERVAL ? SECOND,?) ON DUPLICATE KEY UPDATE cooldown_until=VALUES(cooldown_until),error_code=VALUES(error_code)',[provider.id,result.code==='AI_AUTH'?3600:Math.min(3600,result.retryAfter||60),result.code]);
          else await pool.query('DELETE FROM ai_provider_health WHERE provider_id=?',[provider.id]);
        }});
      await pool.query("UPDATE ai_jobs SET state='success',encrypted_result=?,provider_id=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[encrypt(outcome.result,key),outcome.providerId,job.id]);
    }catch(error){
      const code=/^AI_[A-Z_]+$/.test(error.code||'')?error.code:'AI_INTERNAL';
      const providerId=activeCall?.provider.id||null;
      await pool.query("UPDATE ai_jobs SET state=?,error_code=?,provider_id=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[['AI_UNKNOWN','AI_DOCUMENT_CONVERSION_UNKNOWN','AI_DOCUMENT_CLEANUP_UNTRACKED'].includes(code)||code==='AI_INTERNAL'&&activeCall?'needs_review':'failed',code,providerId,job.id]);
      await saveDiagnostic(pool,key,{scope:job.scope,stage:'review',jobId:job.id,...(sourceFileHash?{fileHash:sourceFileHash}:{}),...(providerId?{providerId}:{}),...safeError(error)});
    }
    return {id:job.id};
  }finally{if(held)await lock.query("SELECT RELEASE_LOCK('datadongbo-ai-worker')").catch(()=>{});lock.release();}
}
export function mountAI(app,pool,config){
  const key=config.CONFIG_ENCRYPTION_KEY;
  mountDiagnostics(app,pool,key);
  app.post('/v1/ai/documents',async(req,res)=>{
    try{res.status(201).json(await saveDocument(pool,key,req.body));}
    catch(error){await saveDiagnostic(pool,key,{scope:'inspection:file-processing',stage:'scan',...safeError(error)});throw error;}
  });
  // Mounted after the existing /admin and /v1 authentication middleware.
  app.get('/admin/ai',async(_req,res)=>res.json({ok:true,configuration:await publicConfiguration(pool,key)}));
  app.put('/admin/ai',async(req,res)=>res.json(await saveConfiguration(pool,key,req.body,config.ADMIN_USERNAME)));
  app.get('/admin/ai/history',async(_req,res)=>{const [items]=await pool.query('SELECT revision,actor,summary,created_at FROM ai_config_audit ORDER BY id DESC LIMIT 50');res.json({ok:true,items});});
  app.post('/admin/ai/providers/:id/test',async(req,res)=>res.status(202).json(await submit(pool,key,{requestId:'test-'+randomUUID(),scope:'admin:connection-test',fingerprint:digest('connection-test'),payload:{mode:'recognition-review',format:'docx',fileHash:digest('connection-test'),positions:[{id:'test:p0',text:'Hợp đồng: ........',label:'Hợp đồng',context:'Kiểm tra nhận diện bằng dữ liệu giả.',detected:true,writable:true,formula:false,locked:false}]}},{testProviderId:req.params.id})));
  app.get('/admin/ai/jobs/:id',async(req,res)=>res.json(await getJob(pool,key,req.params.id,'admin:connection-test')));
  app.post('/admin/ai/jobs/:id/retry',async(req,res)=>res.json(await retryAdminJob(pool,key,req.params.id,req.body?.attemptToken)));
  app.post('/v1/ai/jobs',async(req,res)=>{
    try{res.status(202).json(await submit(pool,key,req.body));}
    catch(error){await saveDiagnostic(pool,key,{scope:typeof req.body?.scope==='string'?req.body.scope.slice(0,200):'inspection:file-processing',stage:'submit',...safeError(error)});throw error;}
  });
  app.get('/v1/ai/jobs/:id',async(req,res)=>res.json(await getJob(pool,key,req.params.id,req.query.scope)));
  app.post('/v1/ai/jobs/:id/retry',async(req,res)=>res.json(await retryJob(pool,key,req.params.id,req.body?.scope,req.body?.attemptToken)));
  app.post('/v1/ai/jobs/:id/cancel',async(req,res)=>res.json(await cancelQueuedJob(pool,req.params.id,req.body?.scope)));
}
