import {createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';

export class Fault extends Error {
  constructor(status, code, message = code, details) {super(message); Object.assign(this, {status, code, details});}
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
export function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, hash) {
  const [salt, key] = String(hash).split(':');
  return !!salt && !!key && equal(passwordHash(password, salt), hash);
}
export function encrypt(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function decrypt(value, key) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString());
}
export const entityName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const recordId = z.string().min(1).max(191).regex(/^[^\x00-\x1f]+$/);
const timestamp = z.iso.datetime({offset: true});
const data = z.record(z.string().min(1).max(100), z.union([z.string().max(100000), z.number().finite(), z.boolean(), z.null()]));
export const operation = z.object({
  action: z.enum(['create', 'update', 'delete']), entity: entityName, id: recordId,
  data: data.optional(), expectedVersion: z.number().int().nonnegative().optional(),
  businessAt: timestamp.optional(), finalizedAt: timestamp.nullable().optional()
}).strict().superRefine((v, ctx) => {
  if (v.action !== 'create' && v.expectedVersion === undefined) ctx.addIssue({code:'custom', message:'Cần expectedVersion khi sửa/xóa'});
  if (v.action !== 'delete' && !v.data) ctx.addIssue({code:'custom', message:'Thiếu data'});
  if (v.data && Object.keys(v.data).some(key => key.startsWith('__dd_'))) ctx.addIssue({code:'custom', message:'Trường __dd_ dành cho hệ thống'});
  if (v.data?.ID !== undefined && v.data.ID !== v.id) ctx.addIssue({code:'custom', message:'ID trong data phải trùng id'});
});
export const batchSchema = z.object({requestId:z.string().min(8).max(128).regex(/^[\w:.-]+$/), operations:z.array(operation).min(1).max(200)}).strict();
export const entitySchema = z.object({
  name:entityName, tabName:z.string().min(1).max(100).regex(/^[^\[\]:*?/\\]+$/),
  headers:z.array(z.string().min(1).max(100)).min(1).max(150), retentionDays:z.number().int().min(0).max(3650).default(0)
}).strict().superRefine((v,ctx)=>{
  if (!v.headers.includes('ID') || new Set(v.headers).size !== v.headers.length || v.headers.some(h=>h.startsWith('__dd_'))) ctx.addIssue({code:'custom',message:'headers cần ID duy nhất; không dùng tiền tố __dd_'});
});
export const settingsSchema = z.object({
  spreadsheetId:z.string().regex(/^[\w-]{20,200}$/), intervalMinutes:z.number().int().min(1).max(1440),
  enabled:z.boolean(), batchSize:z.number().int().min(1).max(200),
  serviceAccount:z.object({client_email:z.email(), private_key:z.string().includes('PRIVATE KEY')}).optional()
}).strict();
export const metadataHeaders = ['__dd_version','__dd_deleted_at','__dd_business_at','__dd_finalized_at'];
export function columnName(index) {
  let out = ''; for(let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}
export const tabRange = tab => `'${tab.replaceAll("'", "''")}'`;
export const json = value => typeof value === 'string' ? JSON.parse(value) : value;
export function stable(value) {
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
export function backoff(attempt, retryAfter = 0, random = Math.random) {
  return Math.max(retryAfter, Math.min(3600000, 2000 * 2 ** Math.min(attempt, 10)) + Math.floor(random() * 1000));
}
export function retryable(error) {return !error.status || [408,409,429,500,502,503,504].includes(error.status);}
export function publicRecord(row) {
  const iso = v => v ? new Date(v).toISOString() : null;
  return {entity:row.entity,id:row.id,data:json(row.data),version:Number(row.version),syncedVersion:Number(row.synced_version),
    businessAt:iso(row.business_at),updatedAt:iso(row.updated_at),finalizedAt:iso(row.finalized_at),deletedAt:iso(row.deleted_at),
    syncStatus:row.dirty ? 'pending' : 'synced'};
}
// Idempotency must outlive retention, but receipts must not retain old business payloads.
export const compactReceipt=response=>({...response,records:response.records.map(({data,...metadata})=>metadata)});
