import {digest,json,Fault} from './core.js';
import {exclusive,transaction} from './db.js';
import {getSettings} from './settings.js';
export async function prepareChamCong(pool,key,{keepHistory=false}={}){
  const result=await exclusive(pool,async connection=>{
    const settings=await getSettings(connection,key);if(!settings.spreadsheetId)throw new Fault(409,'SHEETS_NOT_CONFIGURED');
    const [entities]=await connection.query('SELECT * FROM entities');
    if(entities.some(e=>e.bootstrap_state!=='ready'))throw new Fault(409,'IMPORT_REQUIRED');
    let addedGuards=0,mapped=0;
    for(const e of entities){
      const prefix={CoffeeQuality:'qc_rev_',DailyReports:'dr_rev_',ReferenceData:'ref_rev_'}[e.name],seen=new Map();let after='';
      for(;;){
        const [rows]=await connection.query('SELECT id,data FROM records WHERE entity=? AND id>? ORDER BY id LIMIT 200',[e.name,after]);
        if(!rows.length)break;
        for(const row of rows){
          const data=json(row.data),scope=e.name==='ReferenceData'?data.Key:data.RecordID;
          if(prefix&&scope&&data.Revision!==undefined){
            const guard=digest(settings.spreadsheetId+'\0'+e.name+'\0'+prefix+digest(scope+':'+data.Revision));
            if(seen.has(guard)&&seen.get(guard)!==row.id)throw new Fault(409,'IMPORT_REVISION_CONFLICT');seen.set(guard,row.id);
            const [r]=await connection.query('INSERT IGNORE INTO record_guards(name,request_id) VALUES(?,?)',[guard,'import:'+digest(e.name+'\0'+row.id)]);addedGuards+=r.affectedRows;
          }
          const [[existing]]=await connection.query('SELECT id FROM row_map WHERE entity=? AND id=?',[e.name,row.id]);
          if(!existing){
            await transaction(pool,async db=>{
              const [[entity]]=await db.query('SELECT next_row FROM entities WHERE name=? FOR UPDATE',[e.name]);
              await db.query('INSERT INTO row_map(entity,id,sheet_row) VALUES(?,?,?)',[e.name,row.id,entity.next_row]);
              await db.query('UPDATE entities SET next_row=next_row+1 WHERE name=?',[e.name]);
            });mapped++;
          }
        }after=rows.at(-1).id;
      }
    }
    if(keepHistory)await connection.query('UPDATE entities SET retention_days=0');
    return {ok:true,addedGuards,mapped,keepHistory,googleRequests:0};
  });
  if(result?.busy)throw new Fault(409,'WORKER_BUSY');return result;
}
