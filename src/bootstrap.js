import {settingsSchema,entitySchema,encrypt,Fault} from './core.js';
import {readFile} from 'node:fs/promises';
export function environmentSettings(config) {
  if(!config.GOOGLE_SHEET_ID&&!config.GOOGLE_SERVICE_ACCOUNT_JSON)return null;
  let serviceAccount;
  try {serviceAccount=JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON||'');}
  catch {throw new Fault(400,'GOOGLE_ENV_INVALID','GOOGLE_SERVICE_ACCOUNT_JSON chưa phải JSON hợp lệ.');}
  const parsed=settingsSchema.safeParse({spreadsheetId:config.GOOGLE_SHEET_ID,serviceAccount,
    intervalMinutes:config.SYNC_INTERVAL_MINUTES??60,batchSize:config.SYNC_BATCH_SIZE??100,enabled:config.SYNC_ENABLED==='true'});
  if(!parsed.success)throw new Fault(400,'GOOGLE_ENV_INVALID','Kiểm tra GOOGLE_SHEET_ID và Service Account trong .env.');
  return parsed.data;
}
// Seed only a new database. Configuration saved in the UI remains authoritative.
export async function bootstrapSettings(pool,config) {
  const conn=await pool.getConnection();let locked=false;
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('datadongbo-sync',10) AS acquired");
    locked=Number(lock.acquired)===1;
    if(!locked)throw new Fault(503,'BOOTSTRAP_BUSY');
    const [[existing]]=await conn.query('SELECT id FROM settings WHERE id=1');
    if(config.BOOTSTRAP_ENTITIES_FILE) {
      let entities;
      try {const input=JSON.parse(await readFile(config.BOOTSTRAP_ENTITIES_FILE,'utf8'));if(!Array.isArray(input)||input.length>100)throw Error();entities=input.map(e=>entitySchema.parse(e));}
      catch {throw new Fault(400,'ENTITY_PRESETS_INVALID','Kiểm tra file BOOTSTRAP_ENTITIES_FILE.');}
      for(const e of entities)await conn.query('INSERT IGNORE INTO entities(name,tab_name,headers,retention_days) VALUES(?,?,?,?)',[e.name,e.tabName,JSON.stringify(e.headers),e.retentionDays]);
    }
    if(existing)return {seeded:false,reason:'already_configured'};
    const initial=environmentSettings(config);
    if(!initial)return {seeded:false,reason:'no_environment_settings'};
    await conn.query('INSERT INTO settings(id,encrypted) VALUES(1,?)',[encrypt(initial,config.CONFIG_ENCRYPTION_KEY)]);
    await conn.query('UPDATE runtime_state SET next_sync_at=UTC_TIMESTAMP(3),worker_error=NULL WHERE id=1');
    return {seeded:true};
  }finally {if(locked)await conn.query("SELECT RELEASE_LOCK('datadongbo-sync')").catch(()=>{});conn.release();}
}
