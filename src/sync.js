import {randomUUID} from 'node:crypto';
import {Fault,backoff,retryable,json,metadataHeaders,tabRange,columnName,digest} from './core.js';
import {exclusive,transaction} from './db.js';
import {getSettings} from './settings.js';
import {Sheets} from './sheets.js';
import {quotaGate} from './quota.js';
import {syncDestinations} from './sheetDestinations.js';

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
    const id=randomUUID();await db.query('INSERT INTO jobs(id,kind,entity,available_at,created_at) VALUES(?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[id,kind,entity]);
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
      const prefix={CoffeeQuality:'qc_rev_',DailyReports:'dr_rev_',ReferenceData:'ref_rev_'}[entity.name];
      const scope=entity.name==='ReferenceData'?r.data.Key:r.data.RecordID;
      if(prefix&&scope&&r.data.Revision!==undefined&&sheets.config?.spreadsheetId){
        const name=digest(sheets.config.spreadsheetId+'\0'+entity.name+'\0'+prefix+digest(scope+':'+r.data.Revision));
        const owner='import:'+digest(entity.name+'\0'+r.id);
        await db.query('INSERT IGNORE INTO record_guards(name,request_id) VALUES(?,?)',[name,owner]);
        const [[existing]]=await db.query('SELECT request_id FROM record_guards WHERE name=?',[name]);
        if(existing.request_id!==owner)throw new Fault(422,'IMPORT_REVISION_CONFLICT');
      }
    }
    const done=values.length<limit;
    await db.query('UPDATE entities SET import_row=?,next_row=GREATEST(next_row,?),bootstrap_state=?,last_error=NULL WHERE name=?',
      [start+limit,start+values.length,done?'ready':'importing',entity.name]);
  });
  return {done:values.length<limit,count:values.length};
}
async function deferRecord(pool,entity,row,error) {
  const code=errorCode(error);
  const [[old]]=await pool.query('SELECT version,attempts FROM sync_record_failures WHERE entity=? AND id=?',[entity.name,row.id]);
  const attempts=old&&String(old.version)===String(row.version)?Number(old.attempts)+1:1;
  const next=retryable(error)&&attempts<8?new Date(Date.now()+backoff(attempts,error.retryAfterMs||0)):null;
  await pool.query(`INSERT INTO sync_record_failures(entity,id,version,attempts,error_code,next_attempt_at) VALUES(?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE version=VALUES(version),attempts=VALUES(attempts),error_code=VALUES(error_code),next_attempt_at=VALUES(next_attempt_at)`,
    [entity.name,row.id,row.version,attempts,code,next]);
  console.error(JSON.stringify({event:'sheet_row_conflict',entity:entity.name,record_id:row.id,expected_row:row.sheet_row,
    expected_id:row.id,actual_id:error.details?.actual_id??null,action:'skipped',error_code:code}));
}
export async function reconcileRows(pool,entity,positions) {
  return transaction(pool,async db=>{
    await db.query('SELECT next_row FROM entities WHERE name=? FOR UPDATE',[entity.name]);
    const [maps]=await db.query('SELECT id,sheet_row FROM row_map WHERE entity=? FOR UPDATE',[entity.name]);
    const blocked=new Set(),proposed=maps.map(m=>{
      const found=positions.get(m.id)||[];
      return {...m,target:found.length===1?found[0]:Number(m.sheet_row)};
    });
    // A missing/duplicate owner must retain its slot. Propagate collisions only
    // through that connected group; unrelated records can still be delivered.
    let changed;
    do{
      changed=false;const targets=new Map();
      for(const m of proposed){
        const target=blocked.has(m.id)?Number(m.sheet_row):m.target,other=targets.get(target);
        if(other){for(const id of [m.id,other])if(!blocked.has(id)){blocked.add(id);changed=true;}}
        else targets.set(target,m.id);
      }
    }while(changed);
    const changes=proposed.filter(m=>!blocked.has(m.id)&&m.target!==Number(m.sheet_row));
    // Stage only changed mappings inside one transaction to support swaps while
    // preserving the unique sheet_position constraint and archived mappings.
    for(const m of changes)await db.query('UPDATE row_map SET sheet_row=? WHERE entity=? AND id=?',[-Number(m.sheet_row),entity.name,m.id]);
    for(const m of changes)await db.query('UPDATE row_map SET sheet_row=? WHERE entity=? AND id=?',[m.target,entity.name,m.id]);
    let max=1;for(const found of positions.values())for(const row of found)max=Math.max(max,row);
    await db.query('UPDATE entities SET next_row=GREATEST(next_row,?) WHERE name=?',[max+1,entity.name]);
    return blocked;
  });
}
export async function syncEntity(pool,entity,sheets,batchSize,{lockHeld=false}={}) {
  if(!lockHeld)return exclusive(pool,()=>syncEntity(pool,entity,sheets,batchSize,{lockHeld:true}));
  if(entity.bootstrap_state!=='ready')return 0;
  if(sheets.config?.spreadsheetId&&sheets.forSpreadsheet)return syncDestinations(pool,entity,sheets,batchSize,{deferRecord});
  const [rows]=await pool.query(`SELECT r.* FROM records r LEFT JOIN sync_record_failures f ON f.entity=r.entity AND f.id=r.id AND f.version=r.version
    WHERE r.entity=? AND r.dirty=1 AND (f.id IS NULL OR f.next_attempt_at<=UTC_TIMESTAMP(3)) ORDER BY r.updated_at,r.id LIMIT ?`,[entity.name,batchSize]);
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
  let ready=rows;
  if(sheets.locateRows){
    await sheets.ensureCapacity(entity,Math.max(...rows.map(r=>r.sheet_row)));
    const located=await sheets.locateRows(entity,rows);
    for(const {row,code,actual_id} of located.conflicts)await deferRecord(pool,entity,row,new Fault(422,code,code,{actual_id}));
    if(located.ready.length){
      const blocked=await reconcileRows(pool,entity,located.positions);
      for(const row of located.ready.filter(row=>blocked.has(row.id)))await deferRecord(pool,entity,row,new Fault(422,'ROW_MAP_CONFLICT'));
      located.ready=located.ready.filter(row=>!blocked.has(row.id));
    }
    ready=located.ready;
  }
  if(!ready.length)return 0;
  const deliver=async batch=>{
    try{await sheets.writeRows(entity,batch);return batch;}
    catch(error){
      // These errors are raised by read-only preflight before any write. Split
      // only those batches; never amplify an HTTP timeout or quota failure.
      if(['SHEET_ROW_MOVED','SHEET_VERSION_CONFLICT'].includes(error.code)&&error.status===422){
        if(batch.length>1){const mid=Math.floor(batch.length/2);return [...await deliver(batch.slice(0,mid)),...await deliver(batch.slice(mid))];}
        await deferRecord(pool,entity,batch[0],error);return [];
      }
      for(const row of batch)await deferRecord(pool,entity,row,error);
      throw error;
    }
  };
  ready=await deliver(ready);
  if(!ready.length)return 0;
  await transaction(pool,async db=>{
    for(const row of ready){
      await db.query('UPDATE records SET synced_version=GREATEST(synced_version,?),dirty=IF(version=?,0,1) WHERE entity=? AND id=?',
        [row.version,row.version,entity.name,row.id]);
      await db.query('DELETE FROM sync_record_failures WHERE entity=? AND id=? AND version<=?',[entity.name,row.id,row.version]);
    }
    await db.query('UPDATE entities SET last_sync_at=UTC_TIMESTAMP(3),last_error=NULL WHERE name=?',[entity.name]);
  });
  return ready.length;
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
    await db.query("DELETE FROM client_request_logs WHERE created_at<UTC_TIMESTAMP(3)-INTERVAL 30 DAY LIMIT 500");
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
      let entityError;
      for(const entity of entities) {
        const kind=job?.kind||'sync';
        const [{insertId}]=await db.query('INSERT INTO sync_runs(entity,kind) VALUES(?,?)',[entity.name,kind]);
        try {
          const value=kind==='import'?await importPage(pool,entity,sheets):{count:await syncEntity(pool,entity,sheets,settings.batchSize,{lockHeld:true}),done:true};
          await db.query("UPDATE sync_runs SET state='success',rows_count=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[value.count,insertId]);
          if(!value.done) {await db.query("UPDATE jobs SET state='pending',attempts=0 WHERE id=?",[job.id]);return;}
        } catch(e) {
          const code=errorCode(e);
          await db.query("UPDATE sync_runs SET state='failed',error_code=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?",[code,insertId]);
          await db.query('UPDATE entities SET last_error=? WHERE name=?',[code,entity.name]);entityError??=e;
        }
      }
      if(entityError)throw entityError;
      // Drain additional dirty batches on subsequent ticks, not after another full hour.
      const [[{n}]]=await db.query("SELECT COUNT(*) n FROM records r JOIN entities e ON e.name=r.entity LEFT JOIN sync_record_failures f ON f.entity=r.entity AND f.id=r.id AND f.version=r.version WHERE r.dirty=1 AND e.bootstrap_state='ready' AND (f.id IS NULL OR f.next_attempt_at IS NOT NULL)"+(job?.entity?' AND r.entity=?':''),job?.entity?[job.entity]:[]);
      const [[{n:blocked}]]=await db.query("SELECT COUNT(*) n FROM records r JOIN sync_record_failures f ON f.entity=r.entity AND f.id=r.id AND f.version=r.version WHERE r.dirty=1 AND f.next_attempt_at IS NULL"+(job?.entity?' AND r.entity=?':''),job?.entity?[job.entity]:[]);
      if(job?.kind==='sync'&&Number(n)>0) {
        await db.query("UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=UTC_TIMESTAMP(3)+INTERVAL 5 SECOND WHERE id=?",[job.id]);
      } else if(job&&Number(blocked)>0)await db.query("UPDATE jobs SET state='needs_review',finished_at=UTC_TIMESTAMP(3),error_code='SYNC_RECORDS_NEED_REVIEW' WHERE id=?",[job.id]);
      else if(job)await db.query("UPDATE jobs SET state='success',finished_at=UTC_TIMESTAMP(3),error_code=NULL WHERE id=?",[job.id]);
      await db.query('UPDATE runtime_state SET next_sync_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP(3)),worker_error=?,failures=0 WHERE id=1',[Number(n)>0?5:settings.intervalMinutes*60,Number(blocked)>0?'SYNC_RECORDS_NEED_REVIEW':null]);
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
