import protocol from './businessSchemaProtocol.cjs';
import {Fault,json,metadataHeaders,tabRange} from './core.js';
import {exclusive} from './db.js';
import {getSettings} from './settings.js';
import {Sheets} from './sheets.js';
import {assertBinding,writeRows} from './chamCong.js';
const {normalize,evolution,fingerprint,validateData}=protocol;
const fail=code=>{throw new Fault(409,code);};
function checked(fn){try{return fn();}catch(e){throw new Fault(e.status||400,e.code||'BUSINESS_SCHEMA_INVALID');}}

// Shares the sync lock: the worker cannot write using old column positions
// while optional columns are inserted before the DataDongBo metadata columns.
export async function register(pool,key,input,{sheetsFactory=s=>new Sheets(s)}={}){
  const schema=checked(()=>normalize(input?.schema));
  await assertBinding(pool,key,input.spreadsheetId);
  const next=schema.fields.map(f=>f.key),hash=fingerprint(schema);
  // An existing contract needs no schema mutation or sync lock. Read the
  // committed contract and headers together; additive upgrades preserve it.
  const [[registered]]=await pool.query(`SELECT s.version,e.headers,e.bootstrap_state
    FROM business_schemas s JOIN entities e ON e.name=s.entity
    WHERE s.entity=? AND s.schema_hash=? LIMIT 1`,[schema.entity,hash]);
  if(registered?.bootstrap_state==='ready'&&next.every((h,i)=>json(registered.headers)[i]===h))
    return {ok:true,protocol:'cham-cong-schema-v1',schemaVersion:Number(registered.version),schemaHash:hash};
  const result=await exclusive(pool,async db=>{
    await db.beginTransaction();
    try{
      const [[entity]]=await db.query('SELECT * FROM entities WHERE name=? FOR UPDATE',[schema.entity]);
      const [[prior]]=await db.query('SELECT * FROM business_schemas WHERE entity=? ORDER BY version DESC LIMIT 1 FOR UPDATE',[schema.entity]);
      const [[known]]=await db.query('SELECT * FROM business_schemas WHERE entity=? AND schema_hash=?',[schema.entity,hash]);
      if(known&&entity&&entity.bootstrap_state==='ready'&&next.every((h,i)=>json(entity.headers)[i]===h)){
        await db.commit();return {ok:true,protocol:'cham-cong-schema-v1',schemaVersion:Number(known.version),schemaHash:hash};
      }
      if(prior)checked(()=>evolution(json(prior.descriptor),schema));
      const current=entity?json(entity.headers):[];
      if(entity&&(entity.bootstrap_state!=='ready'||current.length>next.length||current.some((h,i)=>h!==next[i])))fail('BUSINESS_SCHEMA_MAPPING');
      if(entity&&Number(entity.retention_days)>0)fail('BUSINESS_SCHEMA_RETENTION');
      if(entity&&!prior&&schema.fields.slice(0,current.length).some((f,i)=>i===0?f.type!=='text'||!f.required:f.type!=='cell'||f.required))fail('BUSINESS_SCHEMA_REQUIRED_MIGRATION');
      if(!prior&&schema.fields.slice(current.length).some(f=>f.required)&&entity)fail('BUSINESS_SCHEMA_REQUIRED_MIGRATION');
      const baseSheets=sheetsFactory(await getSettings(db,key));
      let tab=entity?.tab_name||schema.entity;
      const destinations=[baseSheets];
      if(baseSheets.forSpreadsheet){
        const [locations]=await db.query('SELECT DISTINCT spreadsheet_id FROM sheet_locations WHERE entity=?',[schema.entity]);
        for(const location of locations)if(location.spreadsheet_id!==baseSheets.config.spreadsheetId)destinations.push(baseSheets.forSpreadsheet(location.spreadsheet_id));
      }
      for(const sheets of destinations){
      if(!entity){
        const info=await sheets.call('?fields=sheets(properties(sheetId,title))');
        if(!info.sheets?.some(s=>s.properties.title===tab))await sheets.call(':batchUpdate',{requests:[{addSheet:{properties:{title:tab}}}]});
        // Never adopt a nonempty spreadsheet tab as a new empty entity.
        const rows=await sheets.read(tabRange(tab));
        const expected=[...next,...metadataHeaders];
        const empty=row=>!row?.some(v=>v!==''&&v!=null);
        if(rows.slice(1).some(row=>!empty(row))||(!empty(rows[0])&&JSON.stringify(rows[0])!==JSON.stringify(expected)))fail('BUSINESS_SCHEMA_TAB_NOT_EMPTY');
      }
      if(!entity||JSON.stringify(current)!==JSON.stringify(next)){
        const [header=[]]=await sheets.read(tabRange(tab)+'!1:1');
        const expected=[...next,...metadataHeaders],old=[...current,...metadataHeaders];
        const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
        const afterInsert=[...current,...Array(next.length-current.length).fill(''),...metadataHeaders];
        if(entity&&!same(header,expected)&&!same(header,current)&&!same(header,old)&&!same(header,afterInsert))fail('SHEET_HEADER_MISMATCH');
        if(entity&&same(header,old)&&next.length>current.length){
          const info=await sheets.call('?fields=sheets(properties(sheetId,title))');
          const sheetId=info.sheets?.find(s=>s.properties.title===tab)?.properties.sheetId;
          if(sheetId==null)fail('SHEET_TAB_MISSING');
          await sheets.call(':batchUpdate',{requests:[{insertDimension:{range:{sheetId,dimension:'COLUMNS',startIndex:current.length,endIndex:next.length},inheritFromBefore:true}}]});
        }
        if(!same(header,expected))await sheets.write([{range:tabRange(tab)+'!A1',values:[expected]}]);
      }
      }
      const version=Number(prior?.version||0)+1;
      if(entity)await db.query('UPDATE entities SET headers=? WHERE name=?',[JSON.stringify(next),schema.entity]);
      else await db.query("INSERT INTO entities(name,tab_name,headers,retention_days,bootstrap_state) VALUES(?,?,?,0,'ready')",[schema.entity,tab,JSON.stringify(next)]);
      await db.query('INSERT INTO business_schemas(entity,version,schema_hash,descriptor) VALUES(?,?,?,?)',[schema.entity,version,hash,JSON.stringify(schema)]);
      await db.commit();
      return {ok:true,protocol:'cham-cong-schema-v1',schemaVersion:version,schemaHash:hash};
    }catch(e){await db.rollback();throw e;}
  });
  if(result?.busy)throw new Fault(409,'BUSINESS_SCHEMA_BUSY');
  return result;
}

export async function writeObject(pool,key,input){
  if(!input||!Number.isSafeInteger(input.schemaVersion)||input.schemaVersion<1||!Array.isArray(input.changes)||!input.changes.length||input.changes.length>200)throw new Fault(400,'BUSINESS_WRITE_INVALID');
  await assertBinding(pool,key,input.spreadsheetId);
  const [[row]]=await pool.query('SELECT * FROM business_schemas WHERE entity=? AND version=?',[input.entity,input.schemaVersion]);
  if(!row)throw new Fault(409,'BUSINESS_SCHEMA_UNKNOWN');
  const schema=checked(()=>normalize(json(row.descriptor))),headers=schema.fields.map(f=>f.key);
  const changes=input.changes.map(change=>{
    if(!['append','update','delete'].includes(change.op))throw new Fault(400,'BUSINESS_WRITE_INVALID');
    if(change.op!=='append'&&(!Number.isSafeInteger(change.expectedVersion)||change.expectedVersion<1))throw new Fault(400,'BUSINESS_VERSION_REQUIRED');
    if(change.op!=='delete'){
      checked(()=>validateData(schema,change.data,{partial:change.op==='update'}));
      if(Object.hasOwn(change.data,'ID')&&change.data.ID!==change.recordId)throw new Fault(400,'INVALID_ROW_ID');
    }
    return {op:change.op,recordId:change.recordId,rowValues:change.op==='delete'?[]:headers.map(h=>h==='ID'?change.recordId:change.data[h]??'')};
  });
  return writeRows(pool,key,{spreadsheetId:input.spreadsheetId,entity:input.entity,headers,requestId:input.requestId,guards:input.guards||[],changes},
    {registered:true,objectChanges:input.changes});
}
