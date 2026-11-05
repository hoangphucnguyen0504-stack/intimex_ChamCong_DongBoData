import {Fault,json,metadataHeaders,tabRange,columnName} from './core.js';
import {importRecord} from './sync.js';
import {destinationSheets} from './sheetDestinations.js';
export async function archivedPage(pool,entity,query,sheets) {
  const [[e]]=await pool.query('SELECT * FROM entities WHERE name=?',[entity]);if(!e)throw new Fault(404,'ENTITY_NOT_FOUND');
  const limit=Math.max(1,Math.min(200,Number(query.limit)||100));if(!Number.isInteger(limit))throw new Fault(400,'INVALID_LIMIT');
  const args=[entity],where=['entity=?','archived_at IS NOT NULL'];
  if(query.after){where.push('id>?');args.push(String(query.after));}
  if(query.includeDeleted!=='true')where.push('deleted_at IS NULL');
  for(const [field,operator] of [['from','>='],['to','<=']])if(query[field]){const d=new Date(query[field]);if(!Number.isFinite(+d))throw new Fault(400,'INVALID_DATE');where.push('business_at'+operator+'?');args.push(d);}
  const [maps]=await pool.query(`SELECT id,sheet_row FROM row_map WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`,[...args,limit+1]);
  const page=maps.slice(0,limit);if(!page.length)return {ok:true,source:'sheets',items:[],hasMore:false,nextAfter:null};
  if(sheets.forSpreadsheet){
    const headers=[...json(e.headers),...metadataHeaders],items=[];
    for(const mapping of page){
      const [[location]]=await pool.query('SELECT * FROM sheet_locations WHERE entity=? AND id=?',[entity,mapping.id]);
      const target=location?destinationSheets(sheets,location.spreadsheet_id):sheets;
      const tab=tabRange(location?.tab_name||e.tab_name),[header=[]]=await target.read(tab+'!1:1');
      if(JSON.stringify(headers)!==JSON.stringify(header))throw new Fault(409,'SHEET_HEADER_MISMATCH');
      const values=await target.read(`${tab}!A${location?.sheet_row||mapping.sheet_row}:${columnName(headers.length-1)}${location?.sheet_row||mapping.sheet_row}`);
      const row=importRecord(e,values[0]||[],headers);
      if(!row||row.id!==mapping.id)throw new Fault(409,'SHEET_ROW_MOVED');
      items.push({...row,entity});
    }
    return {ok:true,source:'sheets',items,hasMore:maps.length>limit,nextAfter:maps.length>limit?page.at(-1).id:null};
  }
  const headers=[...json(e.headers),...metadataHeaders],tab=tabRange(e.tab_name),[currentHeader=[]]=await sheets.read(tab+'!1:1');
  if(JSON.stringify(headers)!==JSON.stringify(currentHeader))throw new Fault(409,'SHEET_HEADER_MISMATCH');
  const ranges=await sheets.batchRead(page.map(m=>`${tab}!A${m.sheet_row}:${columnName(headers.length-1)}${m.sheet_row}`));
  const items=ranges.map((range,i)=>{const r=importRecord(e,range.values?.[0]||[],headers);if(!r||r.id!==page[i].id)throw new Fault(409,'SHEET_ROW_MOVED');return {...r,entity};});
  return {ok:true,source:'sheets',items,hasMore:maps.length>limit,nextAfter:maps.length>limit?page.at(-1).id:null};
}
