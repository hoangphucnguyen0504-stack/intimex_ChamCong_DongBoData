import mysql from 'mysql2/promise';
import {readFile} from 'node:fs/promises';
export function poolFor(c) {
  return mysql.createPool({host:c.MYSQL_HOST,port:c.MYSQL_PORT,user:c.MYSQL_USER,password:c.MYSQL_PASSWORD,database:c.MYSQL_DATABASE,
    connectionLimit:c.MYSQL_POOL_SIZE,waitForConnections:true,queueLimit:100,connectTimeout:10000,
    timezone:'Z',charset:'utf8mb4',supportBigNumbers:true,bigNumberStrings:true,ssl:c.MYSQL_SSL==='true'?{rejectUnauthorized:true}:undefined});
}
export async function migrate(pool) {
  const [[durability]]=await pool.query('SELECT @@innodb_flush_log_at_trx_commit AS durable');
  if(Number(durability.durable)!==1)throw Object.assign(Error('MySQL cần innodb_flush_log_at_trx_commit=1'),{code:'MYSQL_DURABILITY_REQUIRED'});
  const source = await readFile(new URL('../sql/schema.sql', import.meta.url),'utf8');
  const conn=await pool.getConnection();
  try {
    const [[lock]]=await conn.query("SELECT GET_LOCK('datadongbo-migration',30) AS acquired");
    if(!Number(lock.acquired)) throw Error('MIGRATION_BUSY');
    for(const sql of source.split(';').map(s=>s.trim()).filter(Boolean)) await conn.query(sql);
    const [[version]]=await conn.query('SELECT VERSION() AS v');
    const modern=/^(8\.|9\.)/.test(String(version.v));
    const [indexed]=await conn.query("SELECT COLUMN_NAME col FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='records' AND index_name='record_state_key'");
    if(modern&&!indexed.some(row=>row.col==='updated_at')){
      if(indexed.length)await conn.query('ALTER TABLE records DROP INDEX record_state_key');
      await conn.query("ALTER TABLE records ADD INDEX record_state_key (entity, (CAST(JSON_UNQUOTE(JSON_EXTRACT(data,'$.Key')) AS CHAR(191))), updated_at)");
    }
  } finally {await conn.query("SELECT RELEASE_LOCK('datadongbo-migration')").catch(()=>{});conn.release();}
}
export async function transaction(pool, fn) {
  const c = await pool.getConnection();
  try {await c.beginTransaction();const r = await fn(c);await c.commit();return r;}
  catch(e) {await c.rollback();throw e;} finally {c.release();}
}
export async function exclusive(pool, fn) {
  const c=await pool.getConnection();let held=false;
  try {
    const [[r]]=await c.query("SELECT GET_LOCK('datadongbo-sync',0) AS acquired");
    held=Number(r.acquired)===1;
    if(!held) return {busy:true};
    return await fn(c);
  } finally {if(held)await c.query("SELECT RELEASE_LOCK('datadongbo-sync')").catch(()=>{});c.release();}
}
