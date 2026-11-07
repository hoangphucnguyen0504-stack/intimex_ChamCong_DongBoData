import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {encrypt,decrypt} from './core.js';
const pathPart=z.union([z.number().int().nonnegative(),z.string().regex(/^[A-Za-z0-9_]{0,50}$/)]);
export const diagnosticSchema=z.object({id:z.string().uuid().optional(),scope:z.string().min(1).max(200),stage:z.enum(['scan','submit','review','validate','poll','save']),code:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),fileHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),jobId:z.string().max(100).optional(),processingId:z.string().uuid().optional(),providerId:z.string().max(100).optional(),driveCredentialId:z.string().regex(/^[\w.-]{1,100}$/).optional(),driveCredentialLabel:z.string().max(100).optional(),temporaryFileId:z.string().regex(/^[\w-]{1,200}$/).optional(),details:z.object({actorId:z.string().max(100).optional(),issues:z.array(z.object({code:z.string().regex(/^[a-z_]{0,50}$/),path:z.array(pathPart).max(10)}).strict()).max(20).default([])}).strict().default({issues:[]})}).strict();
export async function saveDiagnostic(pool,key,input){
  const item=diagnosticSchema.parse(input),id=item.id||randomUUID();
  await pool.query('INSERT IGNORE INTO ai_diagnostics(id,scope,stage,error_code,encrypted_details) VALUES(?,?,?,?,?)',[id,item.scope,item.stage,item.code,encrypt(item,key)]);
  return {ok:true,id};
}
export function safeError(error){
  const code=/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code||'')?error.code:'AI_INTERNAL';
  const issues=(error?.issues||[]).slice(0,20).map(issue=>({code:String(issue.code||'invalid').replace(/[^a-z_]/g,'').slice(0,50),path:(issue.path||[]).slice(0,10).map(value=>typeof value==='number'?Math.max(0,value):String(value).replace(/[^A-Za-z0-9_]/g,'').slice(0,50))}));
  return {code,details:{issues},...(/^[\w.-]{1,100}$/.test(error?.driveCredentialId||'')?{driveCredentialId:error.driveCredentialId}:{}),...(typeof error?.driveCredentialLabel==='string'?{driveCredentialLabel:error.driveCredentialLabel.slice(0,100)}:{}),...(/^[\w-]{1,200}$/.test(error?.temporaryFileId||'')?{temporaryFileId:error.temporaryFileId}:{})};
}
export function mountDiagnostics(app,pool,key){
  app.post('/v1/ai/diagnostics',async(req,res)=>res.json(await saveDiagnostic(pool,key,req.body)));
  app.get('/admin/ai/diagnostics',async(_req,res)=>{
    const [rows]=await pool.query('SELECT id,stage,error_code,created_at,encrypted_details FROM ai_diagnostics ORDER BY created_at DESC LIMIT 100');
    res.json({ok:true,items:rows.map(({encrypted_details,...row})=>({...row,...decrypt(encrypted_details,key)}))});
  });
}
