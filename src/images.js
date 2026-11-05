import {z} from 'zod';
import {Fault,entityName,recordId,digest,stable} from './core.js';
import {transaction} from './db.js';

const namespace=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const imageId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/);
const version=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const timestamp=z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString());
export const imageSchema=z.object({
  namespace,imageId,version,state:z.enum(['HOLD','UPLOADING','RETRY','FAILED','COMPLETED']),
  driveFileId:z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/).nullable().default(null),
  credentialId:z.string().regex(/^[\w.-]{1,100}$/).nullable().optional(),
  mime:z.enum(['image/jpeg','image/png','image/webp']),size:z.number().int().min(1).max(50*1024*1024),
  checksum:z.string().regex(/^[a-f0-9]{64}$/),verifiedAt:timestamp.nullable().default(null),updatedAt:timestamp
}).strict().superRefine((value,ctx)=>{
  if(value.state==='COMPLETED'&&(!value.driveFileId||!value.verifiedAt))ctx.addIssue({code:'custom',message:'COMPLETED requires verified Drive metadata'});
  if(value.verifiedAt&&value.state!=='COMPLETED')ctx.addIssue({code:'custom',message:'Only COMPLETED images may be verified'});
});
export const imageLinkSchema=z.object({
  namespace,imageId,entity:entityName,recordId:recordId.refine(value=>!/[\x7f]/.test(value)),
  field:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),slot:z.number().int().min(0).max(99),version,updatedAt:timestamp
}).strict();

// Placeholder insert serializes competing first deliveries under the same row lock.
// No business-record foreign key: completion and business linking may arrive in either order.
async function writeVersioned(pool,table,keys,value,columns){
  const fingerprint=digest(JSON.stringify(stable(value)));
  const names=Object.keys(keys),args=Object.values(keys);
  return transaction(pool,async conn=>{
    await conn.query(`INSERT INTO ${table} (${names.join(',')},version,fingerprint) VALUES (${names.map(()=>'?').join(',')},0,'') ON DUPLICATE KEY UPDATE version=version`,args);
    const [[current]]=await conn.query(`SELECT version,fingerprint${table==='image_metadata'?',state':''} FROM ${table} WHERE ${names.map(name=>name+'=?').join(' AND ')} FOR UPDATE`,args);
    const seen=Number(current.version);
    if(seen>value.version)return {ok:true,applied:false,version:seen};
    if(seen===value.version){
      if(current.fingerprint!==fingerprint)throw new Fault(409,'IMAGE_VERSION_CONFLICT');
      return {ok:true,applied:false,version:seen};
    }
    if(table==='image_metadata'&&current.state==='COMPLETED'&&value.state!=='COMPLETED')throw new Fault(409,'IMAGE_ALREADY_COMPLETED');
    const updates={...columns,version:value.version,fingerprint};
    await conn.query(`UPDATE ${table} SET ${Object.keys(updates).map(name=>name+'=?').join(',')} WHERE ${names.map(name=>name+'=?').join(' AND ')}`,[...Object.values(updates),...args]);
    return {ok:true,applied:true,version:value.version};
  });
}
export async function upsertImage(pool,input){
  const v=imageSchema.parse(input);
  return writeVersioned(pool,'image_metadata',{namespace:v.namespace,image_id:v.imageId},v,{
    state:v.state,drive_file_id:v.driveFileId,...(v.credentialId!==undefined?{drive_credential_id:v.credentialId}:{}),mime:v.mime,size_bytes:v.size,checksum:v.checksum,
    verified_at:v.verifiedAt?new Date(v.verifiedAt):null,updated_at:new Date(v.updatedAt)
  });
}
export async function linkImage(pool,input){
  const v=imageLinkSchema.parse(input);
  return writeVersioned(pool,'image_links',{namespace:v.namespace,entity:v.entity,record_id:v.recordId,field_name:v.field,slot:v.slot},v,{
    image_id:v.imageId,updated_at:new Date(v.updatedAt)
  });
}
