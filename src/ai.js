import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {encrypt,decrypt,digest,stable,Fault} from './core.js';
import {transaction} from './db.js';
import {payloadSchema,failover} from './aiProviders.js';

const providerSchema=z.object({id:z.string().regex(/^[\w-]{1,100}$/),name:z.string().trim().min(1).max(100),vendor:z.enum(['openai','gemini']),model:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/),enabled:z.boolean(),apiKey:z.string().trim().min(8).max(2000).optional(),pricingKnown:z.boolean().default(false),inputUsdPerMillion:z.number().min(0).max(10000).default(0),outputUsdPerMillion:z.number().min(0).max(10000).default(0)}).strict();
export const configurationSchema=z.object({revision:z.number().int().nonnegative(),providers:z.array(providerSchema).max(20),maxAttempts:z.number().int().min(1).max(3),maxCallsPerDay:z.number().int().min(1).max(1000),maxOutputTokens:z.number().int().min(256).max(8000),dailyBudgetUsd:z.number().min(0).max(1000)}).strict();
const defaults={providers:[],maxAttempts:3,maxCallsPerDay:50,maxOutputTokens:4000,dailyBudgetUsd:0};
export async function configuration(db,key){
  const [[row]]=await db.query('SELECT revision,encrypted FROM ai_configuration WHERE id=1');
  return {...defaults,...(row?decrypt(row.encrypted,key):{}),revision:Number(row?.revision||0)};
}
export async function publicConfiguration(pool,key){
  const cfg=await configuration(pool,key);
  const [health]=await pool.query('SELECT * FROM ai_provider_health');
  const [stats]=await pool.query("SELECT provider_id,COUNT(*) calls,SUM(state='success') successes,SUM(state='unknown') uncertain,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,SUM(estimated_usd) estimated_usd,SUM(pricing_known=0) unpriced_calls FROM ai_calls WHERE created_at>=UTC_DATE() GROUP BY provider_id");
  return {...cfg,providers:cfg.providers.map(({apiKey,...p})=>({...p,keyConfigured:!!apiKey,health:health.find(h=>h.provider_id===p.id)||null,stats:stats.find(s=>s.provider_id===p.id)||null}))};
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
      if(next.dailyBudgetUsd>0&&p.enabled&&!p.pricingKnown)throw new Fault(400,'AI_PRICING_REQUIRED','Cần nhập giá cho mọi API đang bật khi đặt giới hạn chi phí.');
      return {...p,apiKey};
    });
    const {revision,...settings}=next;
    await db.query('UPDATE ai_configuration SET revision=revision+1,encrypted=?,updated_at=UTC_TIMESTAMP(3) WHERE id=1',[encrypt({...settings,providers},key)]);
    await db.query('INSERT INTO ai_config_audit(revision,actor,summary) VALUES(?,?,?)',[revision+1,actor,JSON.stringify(providers.map(({apiKey,...p},priority)=>({...p,priority,keyChanged:!!next.providers[priority].apiKey})))]);
    for(const p of next.providers.filter(p=>p.apiKey))await db.query('DELETE FROM ai_provider_health WHERE provider_id=?',[p.id]);
    return {ok:true,revision:revision+1};
  });
}
const submitSchema=z.object({requestId:z.string().min(8).max(150).regex(/^[\w:.-]+$/),scope:z.string().min(1).max(200),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),payload:payloadSchema}).strict();
export async function submit(pool,key,input,{testProviderId}={}){
  const d=submitSchema.parse(input),encoded=JSON.stringify(stable(d.payload));
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
  return {ok:true,job:{...publicJob(job),...(job.state==='success'?{result:decrypt(job.encrypted_result,key)}:{})}};
}
export async function retryJob(pool,id,scope){
  const [r]=await pool.query("UPDATE ai_jobs SET state='queued',error_code=NULL,started_at=NULL,finished_at=NULL WHERE id=? AND scope=? AND state IN ('failed','needs_review') AND encrypted_payload IS NOT NULL",[id,scope]);
  if(!r.affectedRows)throw new Fault(409,'AI_NOT_RETRYABLE','Tác vụ chưa thể thử lại hoặc đã hết hạn.');
  return {ok:true};
}
export async function processNext(pool,key,{invoke}={}){
  const lock=await pool.getConnection();let held=false;
  try{
    const [[r]]=await lock.query("SELECT GET_LOCK('datadongbo-ai-worker',0) acquired");held=Number(r.acquired)===1;if(!held)return;
    await lock.query("UPDATE ai_jobs SET state='needs_review',error_code='AI_INTERRUPTED',finished_at=UTC_TIMESTAMP(3) WHERE state='running' AND started_at<UTC_TIMESTAMP(3)-INTERVAL 5 MINUTE");
    await lock.query("UPDATE ai_calls c JOIN ai_jobs j ON j.id=c.job_id SET c.state='unknown',c.error_code='AI_INTERRUPTED' WHERE c.state='running' AND j.state='needs_review'");
    await lock.query('UPDATE ai_jobs SET encrypted_payload=NULL,encrypted_result=NULL WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL 14 DAY AND state NOT IN (\'queued\',\'running\')');
    const [[job]]=await lock.query("SELECT * FROM ai_jobs WHERE state='queued' ORDER BY created_at LIMIT 1");
    if(!job)return;
    await lock.query("UPDATE ai_jobs SET state='running',started_at=UTC_TIMESTAMP(3) WHERE id=?",[job.id]);
    let activeCall;
    try{
      const cfg=await configuration(pool,key),{payload,testProviderId}=decrypt(job.encrypted_payload,key);
      const [health]=await pool.query('SELECT * FROM ai_provider_health');
      const providers=cfg.providers.filter(p=>p.apiKey&&(!testProviderId||p.id===testProviderId)).map(p=>({...p,cooldownUntil:Date.parse(health.find(h=>h.provider_id===p.id)?.cooldown_until||'')||0}));
      const outcome=await failover(providers,payload,{maxAttempts:cfg.maxAttempts,maxOutputTokens:cfg.maxOutputTokens,invoke,
        before:async provider=>{
          const estimatedInput=Buffer.byteLength(JSON.stringify(payload))+4096;
          const reserved=provider.pricingKnown?(estimatedInput*provider.inputUsdPerMillion+cfg.maxOutputTokens*provider.outputUsdPerMillion)/1e6:0;
          await transaction(pool,async db=>{
            await db.query('SELECT id FROM ai_configuration WHERE id=1 FOR UPDATE');
            const [[stats]]=await db.query('SELECT COUNT(*) calls,COALESCE(SUM(estimated_usd),0) cost FROM ai_calls WHERE created_at>=UTC_DATE()');
            if(Number(stats.calls)>=cfg.maxCallsPerDay||cfg.dailyBudgetUsd>0&&(!provider.pricingKnown||Number(stats.cost)+reserved>cfg.dailyBudgetUsd))throw new Fault(429,'AI_BUDGET_LIMIT','Đã đạt giới hạn AI trong ngày.');
            activeCall={id:randomUUID(),provider};
            await db.query("INSERT INTO ai_calls(id,job_id,provider_id,state,estimated_usd,pricing_known) VALUES(?,?,?,'running',?,?)",[activeCall.id,job.id,provider.id,reserved,provider.pricingKnown]);
          });
        },
        after:async(provider,result)=>{
          const input=result.usage?.input||0,output=result.usage?.output||0;
          const cost=provider.pricingKnown?(input*provider.inputUsdPerMillion+output*provider.outputUsdPerMillion)/1e6:0;
          const accounted=result.usageKnown===true||result.state==='success'&&result.usageKnown!==false;
          await pool.query('UPDATE ai_calls SET state=?,input_tokens=?,output_tokens=?,estimated_usd=IF(?=\'success\',?,estimated_usd),error_code=? WHERE id=?',[result.state,input,output,accounted?'success':'usage_unknown',cost,result.state==='success'&&result.usageKnown===false?'AI_USAGE_UNKNOWN':result.code||null,activeCall.id]);
          if(result.state!=='success')await pool.query('INSERT INTO ai_provider_health(provider_id,cooldown_until,error_code) VALUES(?,UTC_TIMESTAMP(3)+INTERVAL ? SECOND,?) ON DUPLICATE KEY UPDATE cooldown_until=VALUES(cooldown_until),error_code=VALUES(error_code)',[provider.id,result.code==='AI_AUTH'?3600:Math.min(3600,result.retryAfter||60),result.code]);
          else await pool.query('DELETE FROM ai_provider_health WHERE provider_id=?',[provider.id]);
        }});
      await pool.query("UPDATE ai_jobs SET state='success',encrypted_result=?,provider_id=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[encrypt(outcome.result,key),outcome.providerId,job.id]);
    }catch(error){
      const code=/^AI_[A-Z_]+$/.test(error.code||'')?error.code:'AI_INTERNAL';
      await pool.query("UPDATE ai_jobs SET state=?,error_code=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[code==='AI_UNKNOWN'||code==='AI_INTERNAL'&&activeCall?'needs_review':'failed',code,job.id]);
    }
    return {id:job.id};
  }finally{if(held)await lock.query("SELECT RELEASE_LOCK('datadongbo-ai-worker')").catch(()=>{});lock.release();}
}
export function mountAI(app,pool,config){
  const key=config.CONFIG_ENCRYPTION_KEY;
  // Mounted after the existing /admin and /v1 authentication middleware.
  app.get('/admin/ai',async(_req,res)=>res.json({ok:true,configuration:await publicConfiguration(pool,key)}));
  app.put('/admin/ai',async(req,res)=>res.json(await saveConfiguration(pool,key,req.body,config.ADMIN_USERNAME)));
  app.get('/admin/ai/history',async(_req,res)=>{const [items]=await pool.query('SELECT revision,actor,summary,created_at FROM ai_config_audit ORDER BY id DESC LIMIT 50');res.json({ok:true,items});});
  app.post('/admin/ai/providers/:id/test',async(req,res)=>res.status(202).json(await submit(pool,key,{requestId:'test-'+randomUUID(),scope:'admin:connection-test',fingerprint:digest('connection-test'),payload:{format:'docx',positions:[{id:'test:p0',text:'{{contractNumber}}',label:'Số hợp đồng',context:'Kiểm tra kết nối bằng dữ liệu giả.',writable:true,formula:false,placeholders:['contractNumber']}],dictionary:[{key:'contractNumber',label:'Số hợp đồng',type:'string'}]}},{testProviderId:req.params.id})));
  app.get('/admin/ai/jobs/:id',async(req,res)=>res.json(await getJob(pool,key,req.params.id,'admin:connection-test')));
  app.post('/v1/ai/jobs',async(req,res)=>res.status(202).json(await submit(pool,key,req.body)));
  app.get('/v1/ai/jobs/:id',async(req,res)=>res.json(await getJob(pool,key,req.params.id,req.query.scope)));
  app.post('/v1/ai/jobs/:id/retry',async(req,res)=>res.json(await retryJob(pool,req.params.id,req.body?.scope)));
}
