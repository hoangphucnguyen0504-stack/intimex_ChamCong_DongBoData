import {Fault,json,metadataHeaders,tabRange} from './core.js';
import {exclusive} from './db.js';
import {getSettings} from './settings.js';
import {Sheets} from './sheets.js';
import compatibility from './schemaCompatibility.cjs';

export function schemaPlan(entity,current,next,header){
 if(!compatibility.compatibleHeaders(entity,next,current))throw new Fault(409,'SCHEMA_UPGRADE_UNSAFE');
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const expected=[...next,...metadataHeaders],delta=next.length-current.length;
 if(same(header,expected))return {insert:0,write:false};
 if(same(header,current))return {insert:0,write:true};
 if(same(header,[...current,...metadataHeaders]))return {insert:delta,write:true};
 if(same(header,[...current,...Array(delta).fill(''),...metadataHeaders]))return {insert:0,write:true};
 throw new Fault(409,'SHEET_HEADER_MISMATCH');
}

// Explicit maintenance operation: default is read-only. Existing row JSON and IDs never change.
export async function upgradeSchema(pool,key,contracts,{apply=false,sheetsFactory=s=>new Sheets(s)}={}){
 const result=await exclusive(pool,async db=>{
  await db.beginTransaction();
  try{
   const sheets=sheetsFactory(await getSettings(db,key)),changes=[];
   for(const contract of contracts){
    const [[entity]]=await db.query('SELECT * FROM entities WHERE name=? FOR UPDATE',[contract.name]);
    if(!entity)continue;
    const current=json(entity.headers),next=contract.headers;
    if(JSON.stringify(current)===JSON.stringify(next))continue;
    if(entity.bootstrap_state!=='ready')throw new Fault(409,'IMPORT_REQUIRED');
    const [header=[]]=await sheets.read(tabRange(entity.tab_name)+'!1:1');
    const plan=schemaPlan(entity.name,current,next,header);
    changes.push({entity:entity.name,added:next.slice(current.length),insertColumns:plan.insert});
    if(!apply)continue;
    if(plan.insert){
     const info=await sheets.call('?fields=sheets(properties(sheetId,title))');
     const tab=info.sheets?.find(row=>row.properties.title===entity.tab_name)?.properties;
     if(!tab)throw new Fault(409,'SHEET_TAB_MISSING');
     await sheets.call(':batchUpdate',{requests:[{insertDimension:{range:{sheetId:tab.sheetId,dimension:'COLUMNS',startIndex:current.length,endIndex:next.length},inheritFromBefore:true}}]});
    }
    if(plan.write)await sheets.write([{range:tabRange(entity.tab_name)+'!A1',values:[[...next,...metadataHeaders]]}]);
    // A lost Google reply leaves a recognizable header; a retry resumes without another insert.
    await db.query('UPDATE entities SET headers=? WHERE name=?',[JSON.stringify(next),entity.name]);
   }
   if(apply)await db.commit();else await db.rollback();
   return {ok:true,dryRun:!apply,changes};
  }catch(error){await db.rollback();throw error;}
 });
 if(result?.busy)throw new Fault(409,'WORKER_BUSY');
 return result;
}
