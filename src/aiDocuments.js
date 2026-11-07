import {createHash} from 'node:crypto';
import {z} from 'zod';
import {encrypt,decrypt,digest,Fault} from './core.js';
import {conversionCredential,conversionDefaults,convertDriveDocument} from './aiDriveConversion.js';
import {saveDiagnostic} from './aiDiagnostics.js';
const MAX=10*1024*1024;
const upload=z.object({scope:z.string().min(1).max(200),format:z.enum(['docx','xlsx']),fileHash:z.string().regex(/^[a-f0-9]{64}$/),data:z.string().min(4).max(Math.ceil(MAX/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/),conversionCredential:conversionCredential.optional(),conversionDefaults:conversionDefaults.optional()}).strict();
export async function saveDocument(pool,key,input){
  const data=upload.parse(input),buffer=Buffer.from(data.data,'base64');
  if(buffer.length>MAX||buffer.toString('base64')!==data.data||!buffer.subarray(0,4).equals(Buffer.from([80,75,3,4]))||createHash('sha256').update(buffer).digest('hex')!==data.fileHash)throw new Fault(400,'AI_DOCUMENT_INVALID');
  const id=digest(JSON.stringify([data.scope,data.fileHash,data.format]));
  await pool.query('INSERT INTO ai_documents(id,scope,file_hash,format,encrypted_original) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE encrypted_original=VALUES(encrypted_original),created_at=UTC_TIMESTAMP(3)',[id,data.scope,data.fileHash,data.format,encrypt({data:data.data,...(data.conversionCredential?{conversionCredential:data.conversionCredential}:{}),...(data.conversionDefaults?{conversionDefaults:data.conversionDefaults}:{})},key)]);
  return {ok:true,document:{id,fileHash:data.fileHash}};
}
export async function assertDocument(pool,payload,scope){
  const [[row]]=await pool.query('SELECT id FROM ai_documents WHERE id=? AND scope=? AND file_hash=? AND format=?',[payload.documentId,scope,payload.fileHash,payload.format]);
  if(!row)throw new Fault(400,'AI_DOCUMENT_SCOPE');
}
export const convertOriginal=convertDriveDocument;
export async function documentForReview(pool,key,payload,scope,{convert=convertOriginal,jobId}={}){
  const [[row]]=await pool.query('SELECT * FROM ai_documents WHERE id=? AND scope=? AND file_hash=? AND format=?',[payload.documentId,scope,payload.fileHash,payload.format]);
  if(!row)throw new Fault(400,'AI_DOCUMENT_SCOPE');
  if(row.encrypted_pdf)return decrypt(row.encrypted_pdf,key);
  const source=decrypt(row.encrypted_original,key),buffer=Buffer.from(source.data,'base64');
  if(createHash('sha256').update(buffer).digest('hex')!==payload.fileHash)throw new Fault(503,'AI_DOCUMENT_CHANGED');
  const context={scope,fileHash:payload.fileHash,...(jobId?{jobId}:{})};
  const pdf=await convert(buffer,payload.format,{pool,key,credential:source.conversionCredential,defaults:source.conversionDefaults,context,onAttempt:entry=>saveDiagnostic(pool,key,{...context,stage:'scan',...entry})});
  if(!Buffer.isBuffer(pdf)||pdf.length>MAX||!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Fault(503,'AI_DOCUMENT_PDF');
  const document={mimeType:'application/pdf',data:pdf.toString('base64'),sourceHash:payload.fileHash};
  await pool.query('UPDATE ai_documents SET encrypted_pdf=? WHERE id=?',[encrypt(document,key),row.id]);
  return document;
}
