import {randomUUID} from 'node:crypto';
import {Fault,backoff,retryable,json,metadataHeaders,tabRange,columnName} from './core.js';
import {exclusive,transaction} from './db.js';
import {getSettings} from './settings.js';
import {Sheets} from './sheets.js';
import {quotaGate} from './quota.js';

export async function enqueue(pool,kind,entity=null) {
  if(!['sync','import'].includes(kind))throw new Fault(400,'INVALID_JOB');
  return exclusiveJob(pool,kind,entity);
}
async function exclusiveJob(pool,kind,entity) {
  return transaction(pool,async db=>{
    await db.query('SELECT id FROM runtime_state WHERE id=1 FOR UPDATE');
    if(entity) {
      const [[e]]=await db.query('SELECT * FROM entities WHERE name=? FOR UPDATE',[entity]);
      if(!e)throw new Fault(404,'ENTITY_NOT_FOUND');
      if(kind==='import'&&e.bootstrap_state==='ready')throw new Fault(409,'ALREADY_IMPORTED','Tài nguyên đã khởi tạo. Không nhập lại để tránh ghi đè.');
    }
    if(kind==='import'&&!entity)throw new Fault(400,'ENTITY_REQUIRED');
    const [[old]]=await db.query("SELECT id FROM jobs WHERE kind=? AND entity <=> ? AND state IN ('pending','retry','running') LIMIT 1",[kind,entity]);
    if(old)return {ok:true,id:old.id,existing:true};
    const id=randomUUID();await db.query('INSERT INTO jobs(id,kind,entity) VALUES(?,?,?)',[id,kind,entity]);
    return {ok:true,id};
  });
}
function importRecord(entity,values,headers) {
  const business=json(entity.headers),idIndex=business.indexOf('ID'),id=values[idIndex];
  if(id===undefined||id==='')return null;
  if(String(id).length>191)throw new Fault(422,'IMPORT_ID_TOO_LONG');
  const data=Object.fromEntries(business.map((h,i)=>[h,values[i]??'']));data.ID=String(id);
  const get=h=>values[headers.indexOf(h)];
  const validDate=v=>v&&Number.isFinite(+new Date(v))?new Date(v):null;
  const businessAt=validDate(get('__dd_business_at'))||validDate(data.CreatedAt)||new Date();
  const rawVersion=get('__dd_version');
  if(rawVersion && (!Number.isSafeInteger(Number(rawVersion))||Number(rawVersion)<1))throw new Fault(422,'IMPORT_VERSION_INVALID');
  return {id:String(id),data,version:Number(rawVersion)||1,businessAt,
    finalizedAt:validDate(get('__dd_finalized_at')),deletedAt:validDate(get('__dd_deleted_at'))};
}
export async function importPage(pool,entity,sheets) {
  // bootstrap_state remains importing on failure; application writes stay blocked.
  await pool.query("UPDATE entities SET bootstrap_state='importing' WHERE name=? AND bootstrap_state='new'",[entity.name]);
  const headers=await sheets.ensureHeader(entity),start=entity.import_row,limit=500;
  const values=await sheets.read(`${tabRange(entity.tab_name)}!A${start}:${columnName(headers.length-1)}${start+limit-1}`);
  await transaction(pool,async db=>{
    for(let i=0;i<values.length;i++) {
      const r=importRecord(entity,values[i],headers);if(!r)continue;
      const [[mapped]]=await db.query('SELECT sheet_row FROM row_map WHERE entity=? AND id=?',[entity.name,r.id]);
      if(mapped&&mapped.sheet_row!==start+i)throw new Fault(422,'DUPLICATE_SHEET_ID');
      await db.query('INSERT IGNORE INTO row_map(entity,id,sheet_row) VALUES(?,?,?)',[entity.name,r.id,start+i]);
      await db.query(`INSERT IGNORE INTO records(entity,id,data,version,synced_version,dirty,business_at,finalized_at,updated_at,deleted_at)
        VALUES(?,?,?,?,?,0,?,?,UTC_TIMESTAMP(3),?)`,[entity.name,r.id,JSON.stringify(r.data),r.version,r.version,r.businessAt,r.finalizedAt,r.deletedAt]);
    }
    const done=values.length<limit;
    await db.query('UPDATE entities SET import_row=?,next_row=GREATEST(next_row,?),bootstrap_state=?,last_error=NULL WHERE name=?',
      [start+limit,start+values.length,done?'ready':'importing',entity.name]);
  });
  return {done:values.length<limit,count:values.length};
}
export async function syncEntity(pool,entity,sheets,batchSize) {
  if(entity.bootstrap_state!=='ready')return 0;
  const [rows]=await pool.query('SELECT * FROM records WHERE entity=? AND dirty=1 ORDER BY updated_at,id LIMIT ?',[entity.name,batchSize]);
  if(!rows.length)return 0;
  await sheets.ensureHeader(entity);
  // Persist deterministic row slots before HTTP. Retrying overwrites the same row.
  await transaction(pool,async db=>{
    const [[locked]]=await db.query('SELECT next_row FROM entities WHERE name=? FOR UPDATE',[entity.name]);let next=locked.next_row;
    for(const row of rows) {
      const [[m]]=await db.query('SELECT sheet_row FROM row_map WHERE entity=? AND id=?',[entity.name,row.id]);
      row.sheet_row=m?.sheet_row??next++;
      if(!m)await db.query('INSERT INTO row_map(entity,id,sheet_row) VALUES(?,?,?)',[entity.name,row.id,row.sheet_row]);
    }
    await db.query('UPDATE entities SET next_row=? WHERE name=?',[next,entity.name]);
  });
  await sheets.writeRows(entity,rows);
  await transaction(pool,async db=>{
    for(const row of rows)await db.query('UPDATE records SET synced_version=GREATEST(synced_version,?),dirty=IF(version=?,0,1) WHERE entity=? AND id=?',
      [row.version,row.version,entity.name,row.id]);
    await db.query('UPDATE entities SET last_sync_at=UTC_TIMESTAMP(3),last_error=NULL WHERE name=?',[entity.name]);
  });
  return rows.length;
}
export async function cleanup(pool) {
  // Finalized + latest version confirmed + old business date. Reference data retention=0.
  return transaction(pool,async db=>{
    const [rows]=await db.query(`SELECT r.entity,r.id,r.business_at,r.deleted_at FROM records r JOIN entities e ON e.name=r.entity
      WHERE e.retention_days>0 AND r.dirty=0 AND r.synced_version=r.version AND r.finalized_at IS NOT NULL
      AND r.business_at < TIMESTAMPADD(DAY,-e.retention_days,UTC_TIMESTAMP(3))
      AND r.finalized_at < TIMESTAMPADD(DAY,-e.retention_days,UTC_TIMESTAMP(3))
      AND r.updated_at < TIMESTAMPADD(DAY,-e.retention_days,UTC_TIMESTAMP(3)) LIMIT 200 FOR UPDATE`);
    for(const row of rows) {
      await db.query('UPDATE row_map SET archived_at=UTC_TIMESTAMP(3),business_at=?,deleted_at=? WHERE entity=? AND id=?',[row.business_at,row.deleted_at,row.entity,row.id]);
      await db.query('DELETE FROM records WHERE entity=? AND id=?',[row.entity,row.id]);
    }
    await db.query('DELETE FROM sessions WHERE expires_at<UTC_TIMESTAMP(3)');
    await db.query('DELETE FROM login_limits WHERE expires_at<UTC_TIMESTAMP(3)');
    await db.query("DELETE FROM sync_runs WHERE finished_at<UTC_TIMESTAMP(3)-INTERVAL 30 DAY LIMIT 200");
    // Idempotency receipts deliberately retained; never expire while clients may retry.
    return rows.length;
  });
}
export async function tick(pool,config,{sheetsFactory=c=>new Sheets(c,{gate:quotaGate(pool,config.SHEETS_REQUESTS_PER_MINUTE)})}={}) {
  return exclusive(pool,async db=>{
    await db.query('UPDATE runtime_state SET heartbeat_at=UTC_TIMESTAMP(3) WHERE id=1');
    // No other worker holds the global lock: a running job belongs to a crashed worker.
    await db.query("UPDATE jobs SET state='retry' WHERE state='running'");
    await db.query("UPDATE sync_runs SET state='interrupted',finished_at=UTC_TIMESTAMP(3),error_code='WORKER_RESTARTED' WHERE state='running'");
    const settings=await getSettings(db,config.CONFIG_ENCRYPTION_KEY);
    const [[job]]=await db.query("SELECT * FROM jobs WHERE state IN ('pending','retry') AND available_at<=UTC_TIMESTAMP(3) ORDER BY created_at LIMIT 1");
    const [[state]]=await db.query('SELECT * FROM runtime_state WHERE id=1');
    if(!job && (!settings.enabled || state.next_sync_at&&new Date(state.next_sync_at)>new Date()))return;
    if(!settings.serviceAccount||!settings.spreadsheetId) {
      await db.query("UPDATE runtime_state SET worker_error='SHEETS_NOT_CONFIGURED' WHERE id=1");return;
    }
    const sheets=sheetsFactory(settings);
    if(job)await db.query("UPDATE jobs SET state='running' WHERE id=?",[job.id]);
    try {
      const [entities]=await db.query('SELECT * FROM entities'+(job?.entity?' WHERE name=?':''),job?.entity?[job.entity]:[]);
      for(const entity of entities) {
        const kind=job?.kind||'sync';
        const [{insertId}]=await db.query('INSERT INTO sync_runs(entity,kind) VALUES(?,?)',[entity.name,kind]);
        try {
          const value=kind==='import'?await importPage(pool,entity,sheets):{count:await syncEntity(pool,entity,sheets,settings.batchSize),done:true};
          await db.query("UPDATE sync_runs SET state='success',rows_count=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[value.count,insertId]);
          if(!value.done) {await db.query("UPDATE jobs SET state='pending',attempts=0 WHERE id=?",[job.id]);return;}
        } catch(e) {
          const code=errorCode(e);
          await db.query("UPDATE sync_runs SET state='failed',error_code=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[code,insertId]);
          await db.query('UPDATE entities SET last_error=? WHERE name=?',[code,entity.name]);throw e;
        }
      }
      // Drain additional dirty batches on subsequent ticks, not after another full hour.
      const [[{n}]]=await db.query("SELECT COUNT(*) n FROM records r JOIN entities e ON e.name=r.entity WHERE r.dirty=1 AND e.bootstrap_state='ready'"+(job?.entity?' AND r.entity=?':''),job?.entity?[job.entity]:[]);
      if(job?.kind==='sync'&&Number(n)>0) {
        await db.query("UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=UTC_TIMESTAMP(3)+INTERVAL 5 SECOND WHERE id=?",[job.id]);
      } else if(job)await db.query("UPDATE jobs SET state='success',finished_at=UTC_TIMESTAMP(3),error_code=NULL WHERE id=?",[job.id]);
      await db.query('UPDATE runtime_state SET next_sync_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)),worker_error=NULL,failures=0 WHERE id=1',[Number(n)>0?5:settings.intervalMinutes*60]);
      await cleanup(pool);
    } catch(error) {
      const code=errorCode(error),delay=backoff((job?.attempts??state.failures??0)+1,error.retryAfterMs||0);
      if(job)await db.query("UPDATE jobs SET attempts=attempts+1,state=?,available_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)),error_code=? WHERE id=?",
        [retryable(error)&&job.attempts<7?'retry':'needs_review',Math.ceil(delay/1000),code,job.id]);
      await db.query('UPDATE runtime_state SET next_sync_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)),worker_error=?,failures=failures+1 WHERE id=1',[Math.ceil(delay/1000),code]);
      return {error:code};
    }
  });
}
export function errorCode(error) {return /^[A-Z][A-Z0-9_]{0,90}$/.test(error.code||'')?error.code:'SYNC_FAILED';}
export {importRecord};
