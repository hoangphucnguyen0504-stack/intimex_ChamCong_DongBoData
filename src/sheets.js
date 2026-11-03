import {JWT} from 'google-auth-library';
import {Fault,tabRange,columnName,metadataHeaders,json} from './core.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class Sheets {
  constructor(config,{fetchImpl=fetch,sleepImpl=sleep,rpm=40,gate}={}) {
    if(!config.serviceAccount||!config.spreadsheetId)throw new Fault(400,'SHEETS_NOT_CONFIGURED');
    this.config=config;this.fetch=fetchImpl;this.sleep=sleepImpl;this.spacing=Math.ceil(60000/rpm);this.next=0;this.gate=gate;
    this.auth=new JWT({email:config.serviceAccount.client_email,key:config.serviceAccount.private_key,scopes:['https://www.googleapis.com/auth/spreadsheets']});
    this.base=`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}`;
    this.calls=0;
  }
  async call(path,body) {
    if(this.gate) await this.gate();
    else {const delay=this.next-Date.now();if(delay>0)await this.sleep(delay);this.next=Date.now()+this.spacing;}
    const {token}=await this.auth.getAccessToken();
    const response=await this.fetch(this.base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
    this.calls++;
    if(!response.ok) {
      const error=new Fault(response.status,'GOOGLE_HTTP_'+response.status);
      const retry=response.headers.get('retry-after');
      error.retryAfterMs=retry?(Number.isFinite(Number(retry))?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())):0;
      throw error;
    }
    return response.json();
  }
  async read(range) {return (await this.call('/values/'+encodeURIComponent(range)+'?valueRenderOption=UNFORMATTED_VALUE')).values||[];}
  async batchRead(ranges) {
    const query=new URLSearchParams({valueRenderOption:'UNFORMATTED_VALUE'});ranges.forEach(r=>query.append('ranges',r));
    return (await this.call('/values:batchGet?'+query)).valueRanges||[];
  }
  async write(data) {return this.call('/values:batchUpdate',{valueInputOption:'RAW',data});}
  async test() {return this.call('?fields=spreadsheetId,properties(title),sheets(properties(title))');}
  async ensureHeader(entity) {
    const tab=tabRange(entity.tab_name),expected=[...json(entity.headers),...metadataHeaders];
    const [header=[]]=await this.read(tab+'!1:1');
    // Existing business columns must match exactly; refuse unsafe remapping.
    if(header.length && header.some((h,i)=>h!==expected[i]))throw new Fault(422,'SHEET_HEADER_MISMATCH');
    if(header.length<expected.length)await this.write([{range:tab+'!A1',values:[expected]}]);
    return expected;
  }
  async ensureCapacity(entity,lastRow) {
    const info=await this.call('?fields=sheets(properties(sheetId,title,gridProperties))');
    const prop=info.sheets?.find(s=>s.properties.title===entity.tab_name)?.properties;
    if(!prop)throw new Fault(422,'SHEET_TAB_MISSING');
    const columns=json(entity.headers).length+metadataHeaders.length;
    if(prop.gridProperties.rowCount<lastRow||prop.gridProperties.columnCount<columns)
      await this.call(':batchUpdate',{requests:[{updateSheetProperties:{properties:{sheetId:prop.sheetId,gridProperties:{rowCount:Math.max(lastRow+100,prop.gridProperties.rowCount),columnCount:Math.max(columns,prop.gridProperties.columnCount)}},fields:'gridProperties.rowCount,gridProperties.columnCount'}}]});
  }
  async writeRows(entity, rows) {
    if(!rows.length)return;
    const headers=json(entity.headers),tab=tabRange(entity.tab_name);
    await this.ensureCapacity(entity,Math.max(...rows.map(r=>r.sheet_row)));
    const current=await this.batchRead(rows.map(r=>`${tab}!A${r.sheet_row}:${columnName(headers.length+metadataHeaders.length-1)}${r.sheet_row}`));
    if(current.length!==rows.length)throw new Fault(502,'SHEET_READ_INCOMPLETE');
    current.forEach((range,i)=>{
      const cells=range.values?.[0]||[],id=cells[headers.indexOf('ID')];
      if(String(id??'')!==rows[i].id&&!(rows[i].synced_version==0&&(id===undefined||id==='')))throw new Fault(422,'SHEET_ROW_MOVED','SHEET_ROW_MOVED',{actual_id:id??null});
      if((id===undefined||id==='')&&cells.some(v=>v!==''&&v!==null&&v!==undefined))throw new Fault(422,'SHEET_ROW_MOVED');
      const version=cells[headers.length];
      if(version!==undefined&&version!==''&&(!Number.isSafeInteger(Number(version))||Number(version)<1||Number(version)>Number(rows[i].version)))throw new Fault(422,'SHEET_VERSION_CONFLICT');
    });
    const iso=v=>v?new Date(v).toISOString():'';
    await this.write(rows.map(row=>({range:`${tab}!A${row.sheet_row}`,values:[[
      ...headers.map(h=>json(row.data)[h]??''),Number(row.version),iso(row.deleted_at),iso(row.business_at),iso(row.finalized_at)
    ]]})));
  }
  async locateRows(entity,rows) {
    const headers=json(entity.headers),idCol=columnName(headers.indexOf('ID')),tab=tabRange(entity.tab_name);
    const values=await this.read(`${tab}!${idCol}2:${idCol}`),positions=new Map();
    values.forEach((cells,i)=>{const id=String(cells[0]??'');if(id){if(!positions.has(id))positions.set(id,[]);positions.get(id).push(i+2);}});
    const ready=[],conflicts=[];
    for(const row of rows){
      const found=positions.get(row.id)||[];
      if(found.length>1){conflicts.push({row,code:'DUPLICATE_SHEET_ID'});continue;}
      if(found.length===1){ready.push({...row,sheet_row:found[0]});continue;}
      if(Number(row.synced_version)>0){conflicts.push({row,code:'SHEET_ID_MISSING'});continue;}
      // A never-acknowledged delivery may reserve a slot, but must not overwrite
      // an ID-less business row or a slot now occupied after an insert/sort.
      const occupied=await this.read(`${tab}!A${row.sheet_row}:${columnName(headers.length+metadataHeaders.length-1)}${row.sheet_row}`);
      if(occupied.some(cells=>cells.some(v=>v!==''&&v!==null&&v!==undefined))){conflicts.push({row,code:'SHEET_ROW_MOVED'});continue;}
      ready.push(row);
    }
    for(const conflict of conflicts)conflict.actual_id=values[conflict.row.sheet_row-2]?.[0]??null;
    return {ready,conflicts,positions};
  }
}
