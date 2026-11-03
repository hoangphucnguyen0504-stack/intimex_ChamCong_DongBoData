import {batchSchema,digest,stable,Fault,json,publicRecord,compactReceipt} from './core.js';
import {transaction} from './db.js';

export async function mutate(pool, input) {
  const batch=batchSchema.parse(input), fingerprint=digest(JSON.stringify(stable(batch.operations)));
  return transaction(pool,async db=>{
    await db.query('INSERT IGNORE INTO requests(id,fingerprint) VALUES(?,?)',[batch.requestId,fingerprint]);
    const [[request]]=await db.query('SELECT * FROM requests WHERE id=? FOR UPDATE',[batch.requestId]);
    if(request.fingerprint!==fingerprint) throw new Fault(409,'REQUEST_KEY_REUSED','Mã yêu cầu đã dùng cho dữ liệu khác.');
    if(request.response) return {...json(request.response),replayed:true};
    const result=[];
    // Stable locking order across batches prevents inter-record deadlocks.
    for(const op of [...batch.operations].sort((a,b)=>(a.entity+'\0'+a.id).localeCompare(b.entity+'\0'+b.id))) {
      const [[entity]]=await db.query('SELECT * FROM entities WHERE name=? FOR UPDATE',[op.entity]);
      if(!entity) throw new Fault(404,'ENTITY_NOT_FOUND');
      if(entity.bootstrap_state!=='ready') throw new Fault(409,'IMPORT_REQUIRED','Cần nhập dữ liệu lần đầu trước khi ghi.');
      const headers=json(entity.headers);
      if(op.data && Object.keys(op.data).some(k=>!headers.includes(k))) throw new Fault(400,'UNKNOWN_COLUMN','Dữ liệu chứa cột chưa được cấu hình.');
      const [[current]]=await db.query('SELECT * FROM records WHERE entity=? AND id=? FOR UPDATE',[op.entity,op.id]);
      if(op.action==='create') {
        const [[mapping]]=await db.query('SELECT id FROM row_map WHERE entity=? AND id=?',[op.entity,op.id]);
        if(current||mapping) throw new Fault(409,'ID_EXISTS','ID đã tồn tại hoặc đã được lưu trữ.');
        await db.query('INSERT INTO row_map(entity,id,sheet_row) VALUES(?,?,?)',[op.entity,op.id,entity.next_row]);
        await db.query('UPDATE entities SET next_row=next_row+1 WHERE name=?',[op.entity]);
      } else {
        if(!current||current.deleted_at) throw new Fault(404,'RECORD_NOT_FOUND');
        if(Number(current.version)!==op.expectedVersion) throw new Fault(409,'VERSION_CONFLICT','Bản ghi đã thay đổi.',publicRecord(current));
      }
      const now=new Date(), next={...(current?json(current.data):{}),...op.data,ID:op.id};
      const businessAt=op.businessAt?new Date(op.businessAt):current?.business_at||now;
      const finalizedAt=op.finalizedAt===undefined?current?.finalized_at||null:op.finalizedAt?new Date(op.finalizedAt):null;
      const deletedAt=op.action==='delete'?now:null;
      const sameDate=(a,b)=>(a?+new Date(a):null)===(b?+new Date(b):null);
      if(current&&op.action!=='delete'&&JSON.stringify(stable(json(current.data)))===JSON.stringify(stable(next))&&
        sameDate(current.business_at,businessAt)&&sameDate(current.finalized_at,finalizedAt)){
        result.push(publicRecord(current));continue;
      }
      await db.query(`INSERT INTO records(entity,id,data,version,business_at,finalized_at,updated_at,deleted_at) VALUES(?,?,?,1,?,?,?,?)
        ON DUPLICATE KEY UPDATE data=VALUES(data),version=version+1,dirty=1,business_at=VALUES(business_at),finalized_at=VALUES(finalized_at),updated_at=VALUES(updated_at),deleted_at=VALUES(deleted_at)`,
      [op.entity,op.id,JSON.stringify(next),businessAt,finalizedAt,now,deletedAt]);
      const [[saved]]=await db.query('SELECT * FROM records WHERE entity=? AND id=?',[op.entity,op.id]);
      result.push(publicRecord(saved));
    }
    const response={ok:true,durable:true,requestId:batch.requestId,records:result,sheetsStatus:'pending'};
    await db.query('UPDATE requests SET response=? WHERE id=?',[JSON.stringify(compactReceipt(response)),batch.requestId]);
    return response;
  });
}
export async function listRecords(pool, entity, query={}) {
  const limit=Math.max(1,Math.min(200,Number(query.limit)||100));
  if(!Number.isInteger(limit)) throw new Fault(400,'INVALID_LIMIT');
  const params=[entity],where=['entity=?'];
  if(query.after) {where.push('id>?');params.push(String(query.after));}
  if(query.from) {const d=new Date(query.from);if(!Number.isFinite(+d))throw new Fault(400,'INVALID_DATE');where.push('business_at>=?');params.push(d);}
  if(query.to) {const d=new Date(query.to);if(!Number.isFinite(+d))throw new Fault(400,'INVALID_DATE');where.push('business_at<=?');params.push(d);}
  if(query.includeDeleted!=='true') where.push('deleted_at IS NULL');
  const [rows]=await pool.query(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,[...params,limit+1]);
  return {ok:true,items:rows.slice(0,limit).map(publicRecord),hasMore:rows.length>limit,nextAfter:rows.length>limit?rows[limit-1].id:null};
}
