import {decrypt, encrypt, Fault, json, settingsSchema, entitySchema} from './core.js';
import {exclusive} from './db.js';
export const defaults = {spreadsheetId:'', intervalMinutes:60, enabled:false, batchSize:100, spreadsheetTargets:[], autoRollover:true};
const settingsCache=new Map();
export async function getSettings(db, key, masked = false) {
  let hit=settingsCache.get(key);
  if(!hit||Date.now()-hit.at>=30000){
    const [[row]]=await db.query('SELECT encrypted FROM settings WHERE id=1');
    hit={at:Date.now(),value:row ? decrypt(row.encrypted,key) : {...defaults}};
    settingsCache.set(key,hit);
  }
  const value={...defaults,...hit.value};
  return masked ? {...value,serviceAccount:undefined,credentialsConfigured:!!value.serviceAccount,serviceAccountEmail:value.serviceAccount?.client_email||''} : value;
}
export async function saveSettings(pool, key, input) {
  const next=settingsSchema.parse(input);
  const result=await exclusive(pool,async db=>{
    const old=await getSettings(db,key);
    const [[{n}]]=await db.query('SELECT COUNT(*) n FROM row_map');
    if(Number(n)>0 && old.spreadsheetId !== next.spreadsheetId) throw new Fault(409,'TARGET_LOCKED','Đã có dữ liệu liên kết. Không thể đổi Sheet đích; cần dự án/migration riêng.');
    const merged={...old,...next,spreadsheetTargets:next.spreadsheetTargets??old.spreadsheetTargets??[],autoRollover:next.autoRollover??old.autoRollover??true,serviceAccount:next.serviceAccount||old.serviceAccount};
    const removed=(old.spreadsheetTargets||[]).filter(target=>!merged.spreadsheetTargets.some(item=>item.spreadsheetId===target.spreadsheetId));
    if(removed.length){
      const [[{n:linked}]]=await db.query('SELECT COUNT(*) n FROM sheet_locations WHERE spreadsheet_id IN ('+removed.map(()=>'?').join(',')+')',removed.map(target=>target.spreadsheetId));
      if(Number(linked)>0)throw new Fault(409,'TARGET_IN_USE','File đã chứa dữ liệu liên kết. Hãy tắt nhận bản ghi mới thay vì xóa cấu hình.');
    }
    if(!merged.serviceAccount) throw new Fault(400,'CREDENTIALS_REQUIRED','Cần JSON Service Account');
    await db.query('INSERT INTO settings(id,encrypted) VALUES(1,?) ON DUPLICATE KEY UPDATE encrypted=VALUES(encrypted)',[encrypt(merged,key)]);
    await db.query('UPDATE runtime_state SET next_sync_at=UTC_TIMESTAMP(3),worker_error=NULL WHERE id=1');
    settingsCache.delete(key);
    return {ok:true};
  });
  if(result?.busy) throw new Fault(409,'WORKER_BUSY','Worker đang xử lý. Vui lòng lưu cấu hình sau.');
  return result;
}
export async function saveEntity(pool, input) {
  const e=entitySchema.parse(input);
  const result=await exclusive(pool,async db=>{
    const [[old]]=await db.query('SELECT * FROM entities WHERE name=?',[e.name]);
    if(old && (old.tab_name!==e.tabName || JSON.stringify(json(old.headers))!==JSON.stringify(e.headers))) throw new Fault(409,'ENTITY_MAPPING_LOCKED','Không đổi tab/cột của tài nguyên đã tạo.');
    await db.query('INSERT INTO entities(name,tab_name,headers,retention_days) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE retention_days=VALUES(retention_days)',[e.name,e.tabName,JSON.stringify(e.headers),e.retentionDays]);
    return {ok:true};
  });
  if(result?.busy) throw new Fault(409,'WORKER_BUSY','Worker đang xử lý. Vui lòng thử lại.');
  return result;
}
