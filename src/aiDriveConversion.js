import {createHash} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {z} from 'zod';
import {decrypt,encrypt,Fault} from './core.js';
import {saveDiagnostic} from './aiDiagnostics.js';
export const conversionDefaults=z.object({clientId:z.string().min(1).max(512),clientSecret:z.string().min(1).max(8192),folderId:z.string().min(1).max(200).regex(/^[\w-]+$/)}).strict();
export const conversionCredential=conversionDefaults.extend({refreshToken:z.string().min(1).max(8192),id:z.string().regex(/^[\w.-]{1,100}$/).optional(),label:z.string().max(100).optional()}).strict();
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=c=>hash(JSON.stringify([c.clientId,c.refreshToken]));
const info=c=>({driveCredentialId:c.id||'drive-'+identity(c).slice(0,16),...(c.label?{driveCredentialLabel:c.label}:{})});
const factory=c=>new OAuth2Client(c.clientId,c.clientSecret);
const mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
function classify(error){
  if(error instanceof Fault)return error;
  const status=Number(error?.response?.status||error?.status||error?.code),detail=error?.response?.data?.error;
  const reasons=[...(Array.isArray(detail?.errors)?detail.errors:[]),...(Array.isArray(detail?.details)?detail.details:[])].map(item=>item?.reason);
  if(error?.code==='invalid_grant'||detail==='invalid_grant'||status===401)return Object.assign(new Fault(503,'AI_DRIVE_AUTH'),{rotate:true});
  if(status===429||status===403&&reasons.some(reason=>['userRateLimitExceeded','rateLimitExceeded','storageQuotaExceeded','dailyLimitExceeded','quotaExceeded'].includes(reason)))return Object.assign(new Fault(503,'AI_DRIVE_QUOTA'),{rotate:true});
  if(!status)return Object.assign(new Fault(503,'AI_DOCUMENT_CONVERSION_UNKNOWN'),{uncertain:true});
  return new Fault(503,status===403?'AI_DRIVE_PERMISSION':'AI_DOCUMENT_CONVERSION');
}
export function candidates(state,provided,defaults){
  const initial=provided?conversionCredential.parse(provided):undefined,shared=defaults?conversionDefaults.parse(defaults):initial?Object.fromEntries(['clientId','clientSecret','folderId'].map(key=>[key,initial[key]])):undefined;
  const entries=Array.isArray(state.credentials)?state.credentials:[],result=[],seen=new Set();
  const append=c=>{const parsed=conversionCredential.safeParse(c);if(!parsed.success)return;const id=identity(parsed.data);if(seen.has(id))return;seen.add(id);result.push(parsed.data);};
  const blocked=initial&&entries.some(c=>c.enabled===false&&(c.id&&c.id===initial.id||c.refreshToken===initial.refreshToken&&(!c.clientId||c.clientId===initial.clientId)));
  if(initial&&!blocked)append(initial);
  for(const c of entries){
    if(c.enabled!==true)continue;
    const tokenOnly=!c.clientId&&!c.clientSecret&&!c.folderId;
    if(tokenOnly&&!shared)continue;
    // Match the existing broker: only token-only entries inherit shared OAuth settings.
    // A partially configured full account must never mix OAuth client identities.
    const own=tokenOnly?{...shared,refreshToken:c.refreshToken}:{clientId:c.clientId,clientSecret:c.clientSecret,refreshToken:c.refreshToken,folderId:c.folderId};
    append({...own,...(c.id?{id:c.id}:{}),...(c.label?{label:c.label}:{})});
  }
  return result;
}
async function deferCleanup(pool,key,fileId,credential,context){
  const id=hash(fileId+':'+identity(credential));
  await pool.query('INSERT IGNORE INTO ai_drive_cleanup(id,encrypted_details) VALUES(?,?)',[id,encrypt({fileId,credential,...context},key)]);
}
async function convertOne(buffer,format,credential,{pool,key,authFactory,onAttempt,context,remaining}){
  const auth=authFactory(credential);auth.setCredentials({refresh_token:credential.refreshToken});
  const boundary='inspection-'+hash(buffer).slice(0,24),metadata={name:'inspection-ai-source.'+format,parents:[credential.folderId],mimeType:format==='docx'?'application/vnd.google-apps.document':'application/vnd.google-apps.spreadsheet',appProperties:{module:'inspection-ai-review'}};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime[format]}\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--`)]);
  const timeout=()=>{const ms=remaining();if(ms<=0)throw new Fault(503,'AI_DOCUMENT_RETRY_LIMIT');return Math.min(30000,ms);};
  let id,pdf,failure;
  try{
    const created=await auth.request({url:'https://www.googleapis.com/upload/drive/v3/files',method:'POST',params:{uploadType:'multipart',supportsAllDrives:true,fields:'id'},headers:{'Content-Type':`multipart/related; boundary=${boundary}`},data:body,timeout:timeout(),retry:false});
    id=created.data?.id;
    if(!/^[\w-]{1,200}$/.test(id||'')){id=undefined;throw new Fault(503,'AI_DOCUMENT_CONVERSION_UNKNOWN');}
    const exported=await auth.request({url:`https://www.googleapis.com/drive/v3/files/${id}/export`,params:{mimeType:'application/pdf'},responseType:'arraybuffer',timeout:timeout(),retry:false});
    pdf=Buffer.from(exported.data);
    if(pdf.length>10*1024*1024||!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Fault(503,'AI_DOCUMENT_PDF');
  }catch(error){failure=classify(error);}
  if(id){
    try{await auth.request({url:`https://www.googleapis.com/drive/v3/files/${id}`,method:'PATCH',params:{supportsAllDrives:true},data:{trashed:true},timeout:15000,retry:false});}
    catch(error){
      if(![404,410].includes(Number(error?.response?.status||error?.status))){
        // Persist the owner before continuing to another account. Never trash via the next account.
        try{await deferCleanup(pool,key,id,credential,context);}catch{throw Object.assign(new Fault(503,'AI_DOCUMENT_CLEANUP_UNTRACKED'),info(credential),{temporaryFileId:id});}
        await onAttempt({code:'AI_DOCUMENT_CLEANUP_PENDING',...info(credential),temporaryFileId:id});
      }
    }
  }
  if(failure)throw Object.assign(failure,info(credential));return pdf;
}
export async function convertDriveDocument(buffer,format,{pool,key,credential,defaults,authFactory=factory,now=Date.now,onAttempt=async()=>{},context={}}={}){
  const [[row]]=await pool.query('SELECT encrypted FROM drive_credential_state WHERE id=1');
  const state=row?decrypt(row.encrypted,key):{},list=candidates(state,credential,defaults);
  if(!list.length)throw new Fault(503,'AI_DOCUMENT_CONVERTER');
  const until=now()+120000;let last;
  for(const [index,c] of list.entries()){
    if(now()>=until)throw new Fault(503,'AI_DOCUMENT_RETRY_LIMIT');
    try{
      const pdf=await convertOne(buffer,format,c,{pool,key,authFactory,onAttempt,context,remaining:()=>until-now()});
      if(index)await onAttempt({code:'AI_DOCUMENT_DRIVE_RECOVERED',...info(c)});
      return pdf;
    }catch(error){
      await onAttempt({code:error.code||'AI_DOCUMENT_CONVERSION',...info(c)});
      if(!error.rotate)throw error;last=error;
    }
  }
  throw Object.assign(new Fault(503,'AI_DOCUMENT_DRIVE_EXHAUSTED'),last?{driveCredentialId:last.driveCredentialId,driveCredentialLabel:last.driveCredentialLabel}:{});
}
export async function processDriveCleanup(pool,key,{authFactory=factory}={}){
  // Called under the existing AI-worker lock: at most one bounded cleanup per tick.
  const [[row]]=await pool.query("SELECT * FROM ai_drive_cleanup WHERE blocked=0 AND available_at<=UTC_TIMESTAMP(3) ORDER BY available_at LIMIT 1");
  if(!row)return;
  let item;
  try{
    item=decrypt(row.encrypted_details,key);const credential=conversionCredential.parse(item.credential);
    if(!/^[\w-]{1,200}$/.test(item.fileId||''))throw new Fault(503,'AI_DOCUMENT_CLEANUP_DATA');
    const auth=authFactory(credential);auth.setCredentials({refresh_token:credential.refreshToken});
    try{await auth.request({url:`https://www.googleapis.com/drive/v3/files/${item.fileId}`,method:'PATCH',params:{supportsAllDrives:true},data:{trashed:true},timeout:10000,retry:false});}
    catch(error){if(![404,410].includes(Number(error?.response?.status||error?.status)))throw error;}
    await pool.query('DELETE FROM ai_drive_cleanup WHERE id=?',[row.id]);
  }catch{
    const attempts=Number(row.attempts||0)+1,blocked=attempts>=5;
    await pool.query('UPDATE ai_drive_cleanup SET attempts=?,blocked=?,available_at=UTC_TIMESTAMP(3)+INTERVAL ? SECOND WHERE id=?',[attempts,blocked,Math.min(3600,60*2**attempts),row.id]);
    if(blocked)await saveDiagnostic(pool,key,{scope:item?.scope||'inspection:file-processing',stage:'scan',code:'AI_DOCUMENT_CLEANUP_BLOCKED',...(item?.fileHash?{fileHash:item.fileHash}:{}),...(item?.jobId?{jobId:item.jobId}:{}),...(item?.credential?info(item.credential):{}),...(item?.fileId?{temporaryFileId:item.fileId}:{})});
  }
}
