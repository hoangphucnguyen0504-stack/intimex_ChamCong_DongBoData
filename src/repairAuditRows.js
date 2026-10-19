import {Fault,json,tabRange,columnName,metadataHeaders,digest} from './core.js';
import {exclusive} from './db.js';
import {getSettings} from './settings.js';
import {Sheets} from './sheets.js';
import {quotaGate} from './quota.js';
import {importRecord} from './sync.js';

// Narrow repair for append-only audit records. Never guess positions or overwrite Sheets.
export function planAuditRepair(entity,values,records,mappings){
  if(entity.name!=='AuditLogs'||entity.bootstrap_state!=='ready'||Number(entity.retention_days)!==0)throw new Fault(409,'AUDIT_REPAIR_SCOPE');
  const headers=json(entity.headers),expected=[...headers,...metadataHeaders];
  if(JSON.stringify(values[0])!==JSON.stringify(expected))throw new Fault(409,'SHEET_HEADER_MISMATCH');
  const database=new Map(records.map(r=>[r.id,r])),positions=new Map(),imports=[];
  const same=(a,b)=>headers.every(h=>String(a[h]??'')===String(b[h]??''));
  for(let i=1;i<values.length;i++){
    const cells=values[i];if(!cells.some(v=>v!==''&&v!=null))continue;
    const imported=importRecord(entity,cells,expected);
    if(!imported)throw new Fault(409,'SHEET_ROW_WITHOUT_ID');
    if(positions.has(imported.id))throw new Fault(409,'DUPLICATE_SHEET_ID');
    positions.set(imported.id,i+1);
    const current=database.get(imported.id);
    if(current){
      if(!same(json(current.data),imported.data)||current.deleted_at||imported.deletedAt)throw new Fault(409,'AUDIT_CONTENT_CONFLICT');
    }else{
      if(mappings.some(m=>m.id===imported.id))throw new Fault(409,'AUDIT_ARCHIVED_RECORD');
      imports.push(imported);
    }
  }
  // A previously delivered or archived ID disappearing is not an append collision.
  for(const m of mappings)if(m.archived_at||!database.has(m.id))throw new Fault(409,'AUDIT_ARCHIVED_RECORD');
  let next=Math.max(Number(entity.next_row),values.length+1,2,...mappings.map(m=>Number(m.sheet_row)+1));
  const oldPositions=new Map(mappings.map(m=>[m.id,Number(m.sheet_row)])),used=new Set(positions.values());
  for(const r of records){
    if(String(json(r.data).ID)!==r.id)throw new Fault(409,'AUDIT_ID_MISMATCH');
    if(!positions.has(r.id)){
      if(Number(r.synced_version)!==0||Number(r.dirty)!==1||r.deleted_at)throw new Fault(409,'AUDIT_DELIVERED_ID_MISSING');
      const old=oldPositions.get(r.id);
      const slot=old>=values.length+1&&!used.has(old)?old:next++;
      positions.set(r.id,slot);used.add(slot);
    }
  }
  const changes=[...positions].map(([id,sheet_row])=>({id,sheet_row}));
  return {changes,imports,nextRow:Math.max(next,...changes.map(r=>r.sheet_row+1)),moved:mappings.filter(m=>positions.get(m.id)!==Number(m.sheet_row)).length};
}

export async function repairAuditRows(pool,config,{apply=false,sheetsFactory=c=>new Sheets(c,{gate:quotaGate(pool,config.SHEETS_REQUESTS_PER_MINUTE)})}={}){
  return exclusive(pool,async db=>{
    await db.beginTransaction();
    try{
      const [[entity]]=await db.query("SELECT * FROM entities WHERE name='AuditLogs' FOR UPDATE");
      if(!entity)throw new Fault(404,'ENTITY_NOT_FOUND');
      const settings=await getSettings(db,config.CONFIG_ENCRYPTION_KEY),sheets=sheetsFactory(settings);
      const [records]=await db.query("SELECT * FROM records WHERE entity='AuditLogs' ORDER BY updated_at,id FOR UPDATE");
      const [mappings]=await db.query("SELECT * FROM row_map WHERE entity='AuditLogs' FOR UPDATE");
      const range=tabRange(entity.tab_name)+'!A1:'+columnName(json(entity.headers).length+metadataHeaders.length-1);
      const values=await sheets.read(range);
      const plan=planAuditRepair(entity,values,records,mappings);
      const report={ok:true,applied:apply,entity:'AuditLogs',imported:plan.imports.length,remapped:plan.moved,pending:records.filter(r=>Number(r.dirty)).length,nextRow:plan.nextRow,sheetsWrites:0};
      if(!apply){await db.rollback();return report;}
      // A second read catches a changing Sheet before any database mutation.
      if(digest(JSON.stringify(await sheets.read(range)))!==digest(JSON.stringify(values)))throw new Fault(409,'SHEET_CHANGED_DURING_REPAIR');
      // Temporary negative slots permit swaps under the unique (entity,sheet_row) key.
      if(mappings.some(m=>Number(m.sheet_row)<2))throw new Fault(409,'AUDIT_MAPPING_INVALID');
      await db.query("UPDATE row_map SET sheet_row=-sheet_row WHERE entity='AuditLogs'");
      for(const r of plan.imports)await db.query(`INSERT INTO records(entity,id,data,version,synced_version,dirty,business_at,finalized_at,updated_at,deleted_at)
        VALUES('AuditLogs',?,?,?,?,0,?,?,UTC_TIMESTAMP(3),?)`,[r.id,JSON.stringify(r.data),r.version,r.version,r.businessAt,r.finalizedAt,r.deletedAt]);
      const known=new Set(mappings.map(m=>m.id));
      for(const r of plan.changes){
        if(known.has(r.id))await db.query("UPDATE row_map SET sheet_row=? WHERE entity='AuditLogs' AND id=?",[r.sheet_row,r.id]);
        else await db.query("INSERT INTO row_map(entity,id,sheet_row) VALUES('AuditLogs',?,?)",[r.id,r.sheet_row]);
      }
      await db.query("UPDATE entities SET next_row=?,last_error=NULL WHERE name='AuditLogs'",[plan.nextRow]);
      // Requeue only this entity's failed sync, never unrelated or import jobs.
      await db.query("UPDATE jobs SET state='pending',attempts=0,error_code=NULL,available_at=UTC_TIMESTAMP(3),finished_at=NULL WHERE entity='AuditLogs' AND kind='sync' AND state='needs_review' AND error_code='SHEET_ROW_MOVED'");
      await db.query("UPDATE runtime_state SET next_sync_at=UTC_TIMESTAMP(3),failures=0,worker_error=NULL WHERE id=1 AND worker_error='SHEET_ROW_MOVED'");
      await db.commit();return report;
    }catch(error){await db.rollback();throw error;}
  });
}
