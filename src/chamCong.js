import {z} from 'zod';
import {Fault,entityName,recordId,digest,stable,json,compactReceipt} from './core.js';
import {transaction} from './db.js';
import {getSettings} from './settings.js';
const cell=z.union([z.string().max(100000),z.number().finite(),z.boolean(),z.null()]);
const change=z.object({op:z.enum(['append','update','delete']),recordId,rowValues:z.array(cell).max(160)}).strict();
export const writeSchema=z.object({spreadsheetId:z.string().min(20).max(200),entity:entityName,headers:z.array(z.string().min(1).max(100)).min(1).max(150),
  requestId:z.string().regex(/^[\w:.-]{8,128}$/),changes:z.array(change).min(1).max(200),guards:z.array(z.string().regex(/^[\w:-]{1,180}$/)).max(200).default([])}).strict();
export async function assertBinding(pool,key,spreadsheetId){
  const settings=await getSettings(pool,key);
  if(!spreadsheetId||settings.spreadsheetId!==spreadsheetId)throw new Fault(409,'SOURCE_MISMATCH','Google Sheet của hai dự án không khớp.');
  return settings;
}
export async function status(pool,key,spreadsheetId){
  await assertBinding(pool,key,spreadsheetId);
  const [entities]=await pool.query(`SELECT e.name,e.headers,e.bootstrap_state,e.retention_days,COUNT(r.id) records_count,
    COALESCE(SUM(r.dirty=1),0) pending,COALESCE(SUM(r.id IS NOT NULL AND m.id IS NULL),0) unmapped
    FROM entities e LEFT JOIN records r ON r.entity=e.name LEFT JOIN row_map m ON m.entity=r.entity AND m.id=r.id GROUP BY e.name`);
  return {ok:true,protocol:'cham-cong-v1',ready:entities.length>0&&entities.every(e=>e.bootstrap_state==='ready'&&Number(e.unmapped)===0),
    entities:entities.map(e=>({...e,headers:json(e.headers)}))};
}
export async function readRows(pool,key,entity,query){
  await assertBinding(pool,key,query.spreadsheetId);
  const [[e]]=await pool.query('SELECT * FROM entities WHERE name=?',[entity]);
  if(!e)throw new Fault(404,'ENTITY_NOT_FOUND');
  if(e.bootstrap_state!=='ready')throw new Fault(409,'IMPORT_REQUIRED','Tài nguyên chưa nhập xong. Không trả dữ liệu rỗng thay thế.');
  if(Number(e.retention_days)>0)throw new Fault(409,'RETENTION_REQUIRES_HISTORY','Đặt lưu vĩnh viễn cho lần chuyển đổi đầu; adapter lịch sử theo khoảng ngày chưa được bật.');
  const after=Number(query.after||0),upper=Number(query.upper||e.next_row-1),limit=Number(query.limit||2000),ids=query.view==='ids';
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(upper)||upper<0||!Number.isInteger(limit)||limit<1||limit>2000||(query.view!=null&&!ids))throw new Fault(400,'INVALID_PAGE');
  if(after===0){
    const [[{n}]]=await pool.query('SELECT COUNT(*) n FROM records r LEFT JOIN row_map m ON m.entity=r.entity AND m.id=r.id WHERE r.entity=? AND m.id IS NULL',[entity]);
    if(Number(n))throw new Fault(409,'UNMAPPED_RECORDS','Có bản ghi chưa có vị trí; hoàn tất tác vụ đồng bộ trước khi chuyển đổi.');
  }
  const columns=ids?'r.id,m.sheet_row':'r.id,r.data,m.sheet_row';
  const [candidates]=await pool.query(`SELECT ${columns} FROM records r JOIN row_map m ON m.entity=r.entity AND m.id=r.id
    WHERE r.entity=? AND r.deleted_at IS NULL AND m.sheet_row>? AND m.sheet_row<=? ORDER BY m.sheet_row LIMIT ?`,[entity,after,upper,limit+1]);
  const selected=[];let bytes=0;
  for(const row of candidates){
    if(selected.length>=limit)break;
    const size=ids?0:Buffer.byteLength(typeof row.data==='string'?row.data:JSON.stringify(row.data??null));
    if(selected.length&&bytes+size>5000000)break;
    selected.push(row);bytes+=size;
  }
  const headers=json(e.headers),hasMore=candidates.length>selected.length;
  return {ok:true,headers,rows:ids?selected.map(r=>[r.id]):selected.map(r=>headers.map(h=>json(r.data)[h]??'')),upper,
    hasMore,nextAfter:hasMore?selected.at(-1).sheet_row:null};
}
const sqlDate=v=>v&&typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).getUTCFullYear()>=1000?new Date(v):null;
export async function writeRows(pool,key,input){
  const body=writeSchema.parse(input);await assertBinding(pool,key,body.spreadsheetId);
  if(new Set(body.changes.map(c=>c.recordId)).size!==body.changes.length)throw new Fault(400,'DUPLICATE_CHANGE_ID');
  const fingerprint=digest(JSON.stringify(stable(body)));
  return transaction(pool,async db=>{
    await db.query('INSERT IGNORE INTO requests(id,fingerprint) VALUES(?,?)',[body.requestId,fingerprint]);
    const [[receipt]]=await db.query('SELECT * FROM requests WHERE id=? FOR UPDATE',[body.requestId]);
    if(receipt.fingerprint!==fingerprint)throw new Fault(409,'REQUEST_KEY_REUSED');
    if(receipt.response)return {...json(receipt.response),replayed:true};
    const [[e]]=await db.query('SELECT * FROM entities WHERE name=? FOR UPDATE',[body.entity]);
    if(!e)throw new Fault(404,'ENTITY_NOT_FOUND');
    if(e.bootstrap_state!=='ready')throw new Fault(409,'IMPORT_REQUIRED');
    const headers=json(e.headers);
    if(JSON.stringify(headers)!==JSON.stringify(body.headers))throw new Fault(409,'ENTITY_SCHEMA_MISMATCH','Danh sách cột hai dự án khác nhau; cần đối chiếu trước khi ghi.');
    for(const guard of body.guards){
      const guardKey=digest(body.spreadsheetId+'\0'+body.entity+'\0'+guard);
      try{await db.query('INSERT INTO record_guards(name,request_id) VALUES(?,?)',[guardKey,body.requestId]);}
      catch(error){if(error.code==='ER_DUP_ENTRY')throw new Fault(409,'QUALITY_REVISION','Phiên bản đã được xử lý.');throw error;}
    }
    let nextRow=e.next_row;const saved=[];
    const ids=body.changes.map(c=>c.recordId).sort(),marks=ids.map(()=>'?').join(',');
    const [existing]=await db.query(`SELECT * FROM records WHERE entity=? AND id IN (${marks}) FOR UPDATE`,[body.entity,...ids]);
    const [mappings]=await db.query(`SELECT * FROM row_map WHERE entity=? AND id IN (${marks})`,[body.entity,...ids]);
    const oldById=new Map(existing.map(row=>[row.id,row])),mapById=new Map(mappings.map(row=>[row.id,row]));
    for(const c of body.changes){
      if(c.rowValues.length>headers.length||(c.op!=='delete'&&String(c.rowValues[headers.indexOf('ID')])!==c.recordId))throw new Fault(400,'INVALID_ROW_ID');
      const old=oldById.get(c.recordId),mapping=mapById.get(c.recordId);
      if(!old&&mapping?.archived_at)throw new Fault(410,'RECORD_ARCHIVED','Không ghi đè bản ghi đã lưu trữ.');
      const next={...(old?json(old.data):{}),...Object.fromEntries(headers.map((h,i)=>[h,c.rowValues[i]??''])),ID:c.recordId};
      if(c.op==='delete'&&(!old||old.deleted_at))continue;
      if(old?.deleted_at)throw new Fault(409,'RECORD_DELETED');
      if(old&&c.op==='append'){
        if(JSON.stringify(headers.map(h=>json(old.data)[h]??''))!==JSON.stringify(headers.map(h=>next[h]??'')))throw new Fault(409,'ID_EXISTS');
        saved.push({entity:body.entity,id:c.recordId,version:Number(old.version),syncStatus:old.dirty?'pending':'synced'});continue;
      }
      if(!mapping){await db.query('INSERT INTO row_map(entity,id,sheet_row) VALUES(?,?,?)',[body.entity,c.recordId,nextRow++]);}
      const now=new Date(),deleted=c.op==='delete'?now:null;
      const finalized=old?.finalized_at||null;
      await db.query(`INSERT INTO records(entity,id,data,version,business_at,finalized_at,updated_at,deleted_at) VALUES(?,?,?,1,?,?,?,?)
        ON DUPLICATE KEY UPDATE data=VALUES(data),version=version+1,dirty=1,finalized_at=VALUES(finalized_at),updated_at=VALUES(updated_at),deleted_at=VALUES(deleted_at)`,
        [body.entity,c.recordId,JSON.stringify(c.op==='delete'?json(old.data):next),old?.business_at||sqlDate(next.CreatedAt)||now,finalized,now,deleted]);
      saved.push({entity:body.entity,id:c.recordId,version:Number(old?.version||0)+1,syncStatus:'pending'});
    }
    await db.query('UPDATE entities SET next_row=? WHERE name=?',[nextRow,body.entity]);
    const response={ok:true,durable:true,requestId:body.requestId,records:saved,sheetsStatus:'pending'};
    await db.query('UPDATE requests SET response=? WHERE id=?',[JSON.stringify(compactReceipt(response)),body.requestId]);
    return response;
  });
}
