import {Fault,json,columnName,tabRange} from './core.js';
import {transaction} from './db.js';

export function configuredTargets(settings){
  const seen=new Set();
  return [{spreadsheetId:settings.spreadsheetId,label:'Primary'},...(settings.spreadsheetTargets||[])]
    .filter(t=>t.enabled!==false&&t.spreadsheetId&&!seen.has(t.spreadsheetId)&&seen.add(t.spreadsheetId));
}
export async function listDestinationStatus(pool,settings){
  const [states]=await pool.query('SELECT * FROM sheet_destination_state ORDER BY entity,spreadsheet_id');
  return {ok:true,autoRollover:settings.autoRollover!==false,targets:configuredTargets(settings),states};
}
export function destinationSheets(sheets,id){
  if(id===sheets.config.spreadsheetId)return sheets;
  if(!sheets.forSpreadsheet)throw new Fault(409,'SHEET_DESTINATION_UNAVAILABLE');
  return sheets.forSpreadsheet(id);
}
async function assign(pool,entity,row,id,primary,{replace=false}={}){
  return transaction(pool,async db=>{
    await db.query('SELECT next_row FROM entities WHERE name=? FOR UPDATE',[entity.name]);
    const [[logical]]=await db.query('SELECT sheet_row FROM row_map WHERE entity=? AND id=?',[entity.name,row.id]);
    let logicalRow=logical?.sheet_row;
    if(logicalRow==null){
      const [[e]]=await db.query('SELECT next_row FROM entities WHERE name=?',[entity.name]);logicalRow=Number(e.next_row);
      await db.query('INSERT INTO row_map(entity,id,sheet_row) VALUES(?,?,?)',[entity.name,row.id,logicalRow]);
      await db.query('UPDATE entities SET next_row=next_row+1 WHERE name=?',[entity.name]);
    }
    await db.query('INSERT IGNORE INTO sheet_destination_state(entity,spreadsheet_id,next_row) VALUES(?,?,?)',[entity.name,id,id===primary?Number(logicalRow)+1:2]);
    const [[state]]=await db.query('SELECT * FROM sheet_destination_state WHERE entity=? AND spreadsheet_id=? FOR UPDATE',[entity.name,id]);
    const physical=id===primary?Number(logicalRow):Number(state.next_row);
    await db.query('UPDATE sheet_destination_state SET next_row=GREATEST(next_row,?) WHERE entity=? AND spreadsheet_id=?',[physical+1,entity.name,id]);
    // REPLACE can delete another record's unique physical-position owner.
    // Explicit updates/inserts reject collisions and roll back the reservation.
    if(replace)await db.query('UPDATE sheet_locations SET spreadsheet_id=?,tab_name=?,sheet_row=? WHERE entity=? AND id=? AND write_attempted=0',[id,entity.tab_name,physical,entity.name,row.id]);
    else await db.query('INSERT INTO sheet_locations(entity,id,spreadsheet_id,tab_name,sheet_row) VALUES(?,?,?,?,?)',[entity.name,row.id,id,entity.tab_name,physical]);
    return {spreadsheet_id:id,tab_name:entity.tab_name,sheet_row:physical};
  });
}
// Capacity checks occur before any values write. An ambiguous HTTP result never
// changes a reservation: retries read and overwrite the exact same physical row.
export async function syncDestinations(pool,entity,sheets,batchSize,{deferRecord}={}){
  const targets=configuredTargets(sheets.config),primary=sheets.config.spreadsheetId;
  const [rows]=await pool.query(`SELECT r.* FROM records r LEFT JOIN sync_record_failures f ON f.entity=r.entity AND f.id=r.id AND f.version=r.version
    WHERE r.entity=? AND r.dirty=1 AND (f.id IS NULL OR f.next_attempt_at<=UTC_TIMESTAMP(3)) ORDER BY r.updated_at,r.id LIMIT ?`,[entity.name,batchSize]);
  let count=0,firstError;
  const groups=new Map();
  const inspected=new Map();
  const inspect=async(id,tab)=>{
    const key=id+'\0'+tab;
    if(inspected.has(key))return inspected.get(key);
    const target=destinationSheets(sheets,id);
    // A failed addSheet due to capacity can leave no tab to read. Metadata is
    // affirmative evidence of absence; a read failure is never such evidence.
    const info=await target.call('?fields=sheets(properties(title))');
    if(!Array.isArray(info.sheets))throw new Fault(502,'SHEET_READ_INCOMPLETE');
    const positions=new Map();
    if(info.sheets.some(s=>s.properties?.title===tab)){
      const col=columnName(json(entity.headers).indexOf('ID'));
      const values=await target.read(`${tabRange(tab)}!${col}2:${col}`);
      values.forEach((cells,i)=>{const id=String(cells[0]??'');if(id){if(!positions.has(id))positions.set(id,[]);positions.get(id).push(i+2);}});
    }
    inspected.set(key,positions);return positions;
  };
  const pin=async(row,location,positions)=>{
    const found=positions.get(row.id)||[];
    if(found.length>1)throw new Fault(422,'DUPLICATE_SHEET_ID');
    if(!found.length)return location;
    await pool.query('UPDATE sheet_locations SET sheet_row=?,write_attempted=1 WHERE entity=? AND id=?',[found[0],entity.name,row.id]);
    return {...location,sheet_row:found[0],write_attempted:1};
  };
  const add=(row,location)=>{
    const key=location.spreadsheet_id+'\0'+location.tab_name;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({...row,...location,location});
  };
  const fail=async(batch,error)=>{
    for(const row of batch)if(deferRecord)await deferRecord(pool,entity,row,error);
    firstError??=error;
  };
  for(const row of rows){
    try{
    let [[location]]=await pool.query('SELECT * FROM sheet_locations WHERE entity=? AND id=?',[entity.name,row.id]);
    if(!location){
      const [states]=await pool.query('SELECT * FROM sheet_destination_state WHERE entity=?',[entity.name]);
      const exhausted=new Set(states.filter(s=>Number(s.exhausted)).map(s=>s.spreadsheet_id));
      let id=Number(row.synced_version)>0||sheets.config.autoRollover===false?primary:(targets.find(t=>!exhausted.has(t.spreadsheetId))?.spreadsheetId||primary);
      // Pre-upgrade row_map slots can have an unacknowledged primary write.
      // Even after primary exhaustion was saved, prove absence before a first
      // physical assignment is allowed to skip directly to a fallback.
      let original;
      if(id!==primary){original=await inspect(primary,entity.tab_name);if(original.has(row.id))id=primary;}
      location=await assign(pool,entity,row,id,primary);
      if(original?.has(row.id))location=await pin(row,location,original);
    }
    add(row,location);
    }catch(error){await fail([row],error);}
  }
  // Map iteration includes groups appended during rollover, so the same run
  // drains all reachable files without waiting for the worker's next tick.
  for(const [key,batch] of groups){
    groups.delete(key);
    const location=batch[0].location,physicalEntity={...entity,tab_name:location.tab_name};
    let active=batch;
    try{
      const target=destinationSheets(sheets,location.spreadsheet_id);
      try{
        await (location.spreadsheet_id===primary?target.ensureHeader(physicalEntity):target.prepareDestination(physicalEntity));
        await target.ensureCapacity(physicalEntity,Math.max(...batch.map(r=>Number(r.sheet_row))));
      }catch(error){
        if(error.code!=='SHEET_CAPACITY_EXHAUSTED'||sheets.config.autoRollover===false)throw error;
        await pool.query('UPDATE sheet_destination_state SET exhausted=1,last_error=? WHERE entity=? AND spreadsheet_id=?',[error.code,entity.name,location.spreadsheet_id]);
        let movable=batch.filter(r=>Number(r.synced_version)===0&&!Number(r.location.write_attempted));
        const fixed=batch.filter(r=>!movable.includes(r));
        if(movable.length){
          const positions=await inspect(location.spreadsheet_id,location.tab_name),absent=[];
          for(const row of movable){
            try{
              if(positions.has(row.id)){
                const pinned=await pin(row,row.location,positions);
                fixed.push({...row,...pinned,location:pinned});
              }else absent.push(row);
            }catch(error){await fail([row],error);}
          }
          movable=absent;
        }
        const index=targets.findIndex(t=>t.spreadsheetId===location.spreadsheet_id);
        const [states]=await pool.query('SELECT * FROM sheet_destination_state WHERE entity=?',[entity.name]);
        const exhausted=new Set(states.filter(s=>Number(s.exhausted)).map(s=>s.spreadsheet_id));
        const next=index<0?null:targets.slice(index+1).find(t=>!exhausted.has(t.spreadsheetId));
        if(!next){if(movable.length)await fail(movable,new Fault(409,'SHEET_TARGETS_EXHAUSTED'));}
        else for(const row of movable){
          try{add(row,await assign(pool,entity,row,next.spreadsheetId,primary,{replace:true}));}
          catch(error){await fail([row],error);}
        }
        // A failed expansion for new rows must not block updates inside the
        // existing grid. Fixed/ambiguous records remain on their original file.
        active=fixed;
        if(!active.length)continue;
        await target.ensureHeader(physicalEntity);
        await target.ensureCapacity(physicalEntity,Math.max(...active.map(r=>Number(r.sheet_row))));
      }
      let delivery=active;
      if(target.locateRows){
        const located=await target.locateRows(physicalEntity,delivery);
        for(const conflict of located.conflicts)await fail([conflict.row],new Fault(422,conflict.code));
        delivery=located.ready;
        let observedMax=1;
        for(const positions of located.positions?.values()||[])for(const position of positions)observedMax=Math.max(observedMax,Number(position));
        // Include non-delivery occupants: a manually inserted/moved row can be
        // beyond every reservation in this batch.
        await pool.query('UPDATE sheet_destination_state SET next_row=GREATEST(next_row,?) WHERE entity=? AND spreadsheet_id=?',[observedMax+1,entity.name,location.spreadsheet_id]);
        // Stage swaps without violating the physical-position unique key.
        await transaction(pool,async db=>{
          const moved=delivery.filter(r=>Number(r.sheet_row)!==Number(r.location.sheet_row));
          for(const row of moved)await db.query('UPDATE sheet_locations SET sheet_row=? WHERE entity=? AND id=?',[-Number(row.location.sheet_row),entity.name,row.id]);
          for(const row of moved)await db.query('UPDATE sheet_locations SET sheet_row=? WHERE entity=? AND id=?',[row.sheet_row,entity.name,row.id]);
        });
      }
      if(!delivery.length)continue;
      for(const row of delivery)await pool.query('UPDATE sheet_locations SET write_attempted=1 WHERE entity=? AND id=?',[entity.name,row.id]);
      const deliver=async rows=>{
        try{await target.writeRows(physicalEntity,rows);return rows;}
        catch(error){
          if(error.status!==422||!['SHEET_ROW_MOVED','SHEET_VERSION_CONFLICT'].includes(error.code))throw error;
          if(rows.length===1){await fail(rows,error);return [];}
          const mid=Math.floor(rows.length/2);
          return [...await deliver(rows.slice(0,mid)),...await deliver(rows.slice(mid))];
        }
      };
      delivery=await deliver(delivery);
      await transaction(pool,async db=>{
        for(const row of delivery){
          await db.query('UPDATE records SET synced_version=GREATEST(synced_version,?),dirty=IF(version=?,0,1) WHERE entity=? AND id=?',[row.version,row.version,entity.name,row.id]);
          await db.query('DELETE FROM sync_record_failures WHERE entity=? AND id=? AND version<=?',[entity.name,row.id,row.version]);
        }
      });count+=delivery.length;
    }catch(error){
      await fail(active,error);
    }
  }
  if(count)await pool.query('UPDATE entities SET last_sync_at=UTC_TIMESTAMP(3),last_error=NULL WHERE name=?',[entity.name]);
  if(firstError)throw firstError;
  return count;
}
