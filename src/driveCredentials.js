import {randomUUID} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {z} from 'zod';
import {decrypt,encrypt,equal,Fault} from './core.js';

const id=z.string().min(1).max(100).regex(/^[\w.-]+$/).refine(value=>value!=='prototype'&&!Object.hasOwn(Object.prototype,value));
const secret=z.string().max(8192).refine(v=>!/[\x00-\x1f]/.test(v));
const credentialSchema=z.object({id:id.refine(value=>!['current','environment'].includes(value)).optional(),label:z.string().trim().min(1).max(100),clientId:z.string().trim().min(1).max(512).optional(),clientSecret:secret.optional(),refreshToken:secret.optional(),folderId:z.string().min(1).max(200).regex(/^[\w-]+$/).optional(),enabled:z.boolean()}).strict();
const saveSchema=z.object({revision:z.number().int().nonnegative(),credentials:z.array(credentialSchema).max(100)}).strict();
const acquireSchema=z.object({consumer:z.enum(['chamcong','hdoi']),currentId:id.optional(),reason:z.enum(['initial','userRateLimitExceeded','invalid_grant','invalid_client','permissionDenied','storageQuotaExceeded','accountDisabled']).default('initial'),requestId:z.string().min(1).max(128).regex(/^[\w:.-]+$/)}).strict();
const empty=()=>({credentials:[],identities:[],consumers:{},receipts:{},events:[],cooldowns:{}});
const mask=c=>c?.refreshToken?'••••••••':null;
const fail=(status,code)=>new Fault(status,code);
function publicState(state,revision) {
  return {ok:true,revision,credentials:state.credentials.map(c=>({id:c.id,label:c.label,clientId:c.clientId,folderId:c.folderId,enabled:c.enabled,maskedToken:mask(c),clientSecretConfigured:!!c.clientSecret,refreshTokenConfigured:!!c.refreshToken,failures:Object.entries(state.failures||{}).filter(([key])=>key.endsWith(':'+c.id)).map(([,value])=>value)})),consumers:Object.entries(state.consumers).map(([consumer,a])=>({consumer,credentialId:a.credential.id,label:a.credential.label,maskedToken:mask(a.credential),issuedAt:a.issuedAt,reason:a.reason,version:a.version,failure:state.failures?.[consumer+':'+a.credential.id]||null})),events:state.events};
}
async function defaultDriveFactory(c) {
  const auth=new OAuth2Client(c.clientId,c.clientSecret);auth.setCredentials({refresh_token:c.refreshToken});
  return {test:async()=>{
    const result=await auth.request({url:`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(c.folderId)}`,params:{fields:'id,mimeType,capabilities(canAddChildren)',supportsAllDrives:true},timeout:15000});
    if(result.data?.mimeType!=='application/vnd.google-apps.folder'||result.data?.capabilities?.canAddChildren!==true)throw fail(422,'DRIVE_FOLDER_NOT_WRITABLE');
    return result;
  }};
}
export function createDriveCredentialRegistry(pool,config,{driveFactory=defaultDriveFactory,now=()=>new Date().toISOString()}={}) {
  const key=config.CONFIG_ENCRYPTION_KEY;
  async function transaction(fn) {
    const db=await pool.getConnection();
    try {
      await db.beginTransaction();
      await db.query('INSERT IGNORE INTO drive_credential_state(id,revision,encrypted) VALUES(1,0,?)',[encrypt(empty(),key)]);
      const [[row]]=await db.query('SELECT revision,encrypted FROM drive_credential_state WHERE id=1 FOR UPDATE');
      const state=decrypt(row.encrypted,key),revision=Number(row.revision);
      const result=await fn(state,revision);
      if(result.write){
        if(Buffer.byteLength(JSON.stringify(state))>8*1024*1024)throw fail(503,'DRIVE_REGISTRY_CAPACITY');
        await db.query('UPDATE drive_credential_state SET revision=?,encrypted=? WHERE id=1',[result.revision??revision,encrypt(state,key)]);
      }
      await db.commit();return result.value;
    } catch(error) {await db.rollback();throw error;} finally {db.release();}
  }
  return {
    get:()=>transaction((state,revision)=>({value:publicState(state,revision)})),
    save:input=>{
      const parsed=saveSchema.safeParse(input);if(!parsed.success)throw fail(400,'DRIVE_CREDENTIALS_INVALID');
      return transaction((state,revision)=>{
        if(parsed.data.revision!==revision)throw fail(409,'DRIVE_REVISION_CONFLICT');
        const seen=new Set();
        const identities=state.identities||=[...state.credentials];
        for(const assignment of Object.values(state.consumers))if(!identities.some(item=>item.id===assignment.credential.id))identities.push(assignment.credential);
        const credentials=parsed.data.credentials.map(c=>{
          const credentialId=c.id||randomUUID();if(seen.has(credentialId))throw fail(400,'DRIVE_DUPLICATE_ID');seen.add(credentialId);
          const old=state.credentials.find(x=>x.id===credentialId)||identities.find(x=>x.id===credentialId);
          const merged={...c,id:credentialId,clientSecret:c.clientSecret||old?.clientSecret,refreshToken:c.refreshToken||old?.refreshToken};
          const tokenOnly=!merged.clientId&&!merged.clientSecret&&!merged.folderId;
          if(!merged.refreshToken||(!tokenOnly&&(!merged.clientId||!merged.clientSecret||!merged.folderId)))throw fail(400,'DRIVE_SECRETS_REQUIRED');
          // A file's owner identity is permanent. Replacing OAuth material creates
          // a new identity so archived consumers can still read existing files.
          if(old&&['clientId','clientSecret','refreshToken','folderId'].some(field=>old[field]!==merged[field]))merged.id=randomUUID();
          if(!identities.some(item=>item.id===merged.id))identities.push({...merged});
          return merged;
        });
        state.credentials=credentials;
        return {write:true,revision:revision+1,value:publicState(state,revision+1)};
      });
    },
    test:credentialId=>transaction(async state=>{
      const c=state.credentials.find(c=>c.id===credentialId);if(!c)throw fail(404,'DRIVE_CREDENTIAL_NOT_FOUND');
      if(!c.clientId)throw new Fault(400,'DRIVE_TEST_AT_CONSUMER','Token dùng cấu hình của dịch vụ; kiểm tra tại dịch vụ nhận token.');
      try {const client=await driveFactory({...c});const result=await client.test();
        if(result?.data?.mimeType&&result.data.mimeType!=='application/vnd.google-apps.folder')throw Error();
        return {value:{ok:true,id:c.id,status:'accessible'}};
      } catch {throw fail(502,'DRIVE_CREDENTIAL_TEST_FAILED');}
    }),
    acquire:input=>{
      const parsed=acquireSchema.safeParse(input);if(!parsed.success)throw fail(400,'DRIVE_ACQUIRE_INVALID');
      const req=parsed.data;
      return transaction((state,revision)=>{
        const receiptKey=`${req.consumer}:${req.requestId}`;
        if(state.receipts[receiptKey])return {value:state.receipts[receiptKey]};
        const current=state.consumers[req.consumer];
        let assignment=current;
        if(!current || (req.reason!=='initial'&&req.currentId===current.credential.id) || state.failures?.[req.consumer+':'+current.credential.id]) {
          const cooldowns=state.cooldowns||={},at=now(),epoch=Date.parse(at);
          const failures=state.failures||={};
          const previousFailure=current&&failures[req.consumer+':'+current.credential.id];
          const alreadyReported=previousFailure?.requestId===req.requestId;
          if(current&&req.reason!=='initial'&&req.currentId===current.credential.id&&!alreadyReported){
            const retryAt=req.reason==='userRateLimitExceeded'?epoch+60000:['permissionDenied','storageQuotaExceeded'].includes(req.reason)?epoch+900000:null;
            failures[req.consumer+':'+current.credential.id]={consumer:req.consumer,credentialId:current.credential.id,reason:req.reason,requestId:req.requestId,failedAt:at,retryAt:retryAt?new Date(retryAt).toISOString():null};
            cooldowns[req.consumer+':'+current.credential.id]=retryAt||Number.MAX_SAFE_INTEGER;
            state.events.unshift({consumer:req.consumer,credentialId:current.credential.id,label:current.credential.label,issuedAt:at,reason:req.reason,version:current.version,status:'failed'});
            state.events=state.events.slice(0,200);
          }
          const failureReason=req.reason==='initial'?(failures[req.consumer+':'+current?.credential.id]?.reason||req.reason):req.reason;
          const requireFull=['invalid_client','permissionDenied','storageQuotaExceeded','accountDisabled'].includes(failureReason);
          const available=c=>c.enabled&&(cooldowns[req.consumer+':'+c.id]||0)<=epoch&&(!requireFull||!!c.clientId)&&!(failureReason==='invalid_client'&&current?.credential.clientId&&c.clientId===current.credential.clientId&&c.clientSecret===current.credential.clientSecret);
          const eligible=state.credentials.filter(available);
          let next=eligible[0];
          if(current) {
            const index=state.credentials.findIndex(c=>c.id===current.credential.id);
            next=[...state.credentials.slice(index+1),...state.credentials.slice(0,index+1)].find(c=>available(c)&&c.id!==current.credential.id);
          }
          if(!next&&current&&previousFailure?.retryAt&&Date.parse(previousFailure.retryAt)<=epoch&&(alreadyReported||req.reason==='initial'))next=state.credentials.find(c=>c.id===current.credential.id&&c.enabled&&(cooldowns[req.consumer+':'+c.id]||0)<=epoch);
          if(!next)return {write:true,value:{ok:false,code:'DRIVE_CREDENTIALS_EXHAUSTED'}};
          delete failures[req.consumer+':'+next.id];
          const {enabled:_enabled,...issuedCredential}=next;
          assignment={credential:{...issuedCredential,revision},version:(current?.version||0)+1,issuedAt:now(),reason:req.reason};
          state.consumers[req.consumer]=assignment;
          state.events.unshift({consumer:req.consumer,credentialId:next.id,label:next.label,issuedAt:assignment.issuedAt,reason:req.reason,version:assignment.version,status:'issued'});
          state.events=state.events.slice(0,200);
        }
        const value={ok:true,credential:assignment.credential,version:assignment.version,issuedAt:assignment.issuedAt};
        state.receipts[receiptKey]=value;
        return {write:true,value};
      }).then(result=>{if(result.ok===false)throw fail(503,result.code);return result;});
    }
  };
}
export function mountDriveCredentials(app,pool,config,options={}) {
  const registry=createDriveCredentialRegistry(pool,config,options);
  const noStore=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
  const bounded=(req,_res,next)=>{
    if(Number(req.headers['content-length']||0)>256*1024||Buffer.byteLength(JSON.stringify(req.body||{}))>256*1024)return next(fail(413,'PAYLOAD_TOO_LARGE'));next();
  };
  app.get('/admin/drive-credentials',noStore,async(_req,res)=>res.json(await registry.get()));
  app.put('/admin/drive-credentials',noStore,bounded,async(req,res)=>res.json(await registry.save(req.body)));
  app.post('/admin/drive-credentials/:id/test',noStore,bounded,async(req,res)=>res.json(await registry.test(req.params.id)));
  app.post('/v1/drive-credentials/acquire',noStore,bounded,async(req,res)=>{
    if(!config.API_TOKEN||!equal(req.headers.authorization,`Bearer ${config.API_TOKEN}`))throw fail(401,'API_TOKEN_INVALID');
    // Node fetch also sends Sec-Fetch-Mode:cors. Origin/Sec-Fetch-Site
    // identify browser context; mode alone must not reject backend workers.
    if(req.headers.origin||req.headers['sec-fetch-site'])throw fail(403,'DRIVE_BACKEND_ONLY');
    res.json(await registry.acquire(req.body));
  });
  return registry;
}
