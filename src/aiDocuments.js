import {createHash} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import {z} from 'zod';
import {encrypt,decrypt,digest,Fault} from './core.js';
const MAX=10*1024*1024;
const upload=z.object({scope:z.string().min(1).max(200),format:z.enum(['docx','xlsx']),fileHash:z.string().regex(/^[a-f0-9]{64}$/),data:z.string().min(4).max(Math.ceil(MAX/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
const mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
export async function saveDocument(pool,key,input){
  const data=upload.parse(input),buffer=Buffer.from(data.data,'base64');
  if(buffer.length>MAX||buffer.toString('base64')!==data.data||!buffer.subarray(0,4).equals(Buffer.from([80,75,3,4]))||createHash('sha256').update(buffer).digest('hex')!==data.fileHash)throw new Fault(400,'AI_DOCUMENT_INVALID');
  const id=digest(JSON.stringify([data.scope,data.fileHash,data.format]));
  await pool.query('INSERT INTO ai_documents(id,scope,file_hash,format,encrypted_original) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE created_at=UTC_TIMESTAMP(3)',[id,data.scope,data.fileHash,data.format,encrypt({data:data.data},key)]);
  return {ok:true,document:{id,fileHash:data.fileHash}};
}
export async function assertDocument(pool,payload,scope){
  const [[row]]=await pool.query('SELECT id FROM ai_documents WHERE id=? AND scope=? AND file_hash=? AND format=?',[payload.documentId,scope,payload.fileHash,payload.format]);
  if(!row)throw new Fault(400,'AI_DOCUMENT_SCOPE');
}
export async function convertOriginal(buffer,format,{pool,key,authFactory=c=>new OAuth2Client(c.clientId,c.clientSecret)}={}){
  const [[row]]=await pool.query('SELECT encrypted FROM drive_credential_state WHERE id=1');
  const state=row?decrypt(row.encrypted,key):{},credential=state.credentials?.find(c=>c.enabled&&c.clientId&&c.clientSecret&&c.refreshToken&&c.folderId);
  if(!credential)throw new Fault(503,'AI_DOCUMENT_CONVERTER','Cần cấu hình tài khoản Drive đầy đủ trong DataDongBo để đọc bố cục file.');
  const auth=authFactory(credential);auth.setCredentials({refresh_token:credential.refreshToken});
  const boundary='inspection-'+digest(buffer).slice(0,24),metadata={name:'inspection-ai-source.'+format,parents:[credential.folderId],mimeType:format==='docx'?'application/vnd.google-apps.document':'application/vnd.google-apps.spreadsheet',appProperties:{module:'inspection-ai-review'}};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime[format]}\r\n\r\n`),buffer,Buffer.from(`\r\n--${boundary}--`)]);
  let id;
  try{
    const created=await auth.request({url:'https://www.googleapis.com/upload/drive/v3/files',method:'POST',params:{uploadType:'multipart',supportsAllDrives:true,fields:'id'},headers:{'Content-Type':`multipart/related; boundary=${boundary}`},data:body,timeout:30000,retry:false});
    id=created.data?.id;if(!/^[\w-]+$/.test(id||''))throw new Fault(503,'AI_DOCUMENT_CONVERSION');
    const exported=await auth.request({url:`https://www.googleapis.com/drive/v3/files/${id}/export`,params:{mimeType:'application/pdf'},responseType:'arraybuffer',timeout:30000,retry:false});
    return Buffer.from(exported.data);
  }catch(error){if(error instanceof Fault)throw error;throw new Fault(503,'AI_DOCUMENT_CONVERSION');}
  finally{if(id){try{await auth.request({url:`https://www.googleapis.com/drive/v3/files/${id}`,method:'PATCH',params:{supportsAllDrives:true},data:{trashed:true},timeout:15000,retry:false});}catch{throw new Fault(503,'AI_DOCUMENT_CLEANUP');}}}
}
export async function documentForReview(pool,key,payload,scope,{convert=convertOriginal}={}){
  const [[row]]=await pool.query('SELECT * FROM ai_documents WHERE id=? AND scope=? AND file_hash=? AND format=?',[payload.documentId,scope,payload.fileHash,payload.format]);
  if(!row)throw new Fault(400,'AI_DOCUMENT_SCOPE');
  if(row.encrypted_pdf)return decrypt(row.encrypted_pdf,key);
  const buffer=Buffer.from(decrypt(row.encrypted_original,key).data,'base64');
  if(createHash('sha256').update(buffer).digest('hex')!==payload.fileHash)throw new Fault(503,'AI_DOCUMENT_CHANGED');
  const pdf=await convert(buffer,payload.format,{pool,key});
  if(!Buffer.isBuffer(pdf)||pdf.length>MAX||!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Fault(503,'AI_DOCUMENT_PDF');
  const document={mimeType:'application/pdf',data:pdf.toString('base64'),sourceHash:payload.fileHash};
  await pool.query('UPDATE ai_documents SET encrypted_pdf=? WHERE id=?',[encrypt(document,key),row.id]);
  return document;
}
