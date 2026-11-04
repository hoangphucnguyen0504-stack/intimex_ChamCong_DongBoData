import {loadConfig} from '../src/config.js';
import {poolFor,exclusive} from '../src/db.js';
import {getSettings} from '../src/settings.js';
import {Sheets} from '../src/sheets.js';
import {json,metadataHeaders,tabRange} from '../src/core.js';
const config=loadConfig(),pool=poolFor(config);
try {
  const sheets=new Sheets(await getSettings(pool,config.CONFIG_ENCRYPTION_KEY));
  const [entities]=await pool.query("SELECT name,tab_name,headers FROM entities WHERE name IN ('VehicleTrips','VehicleLogs')");
  for(const entity of entities) {
    const expected=[...json(entity.headers),...metadataHeaders];
    const [actual=[]]=await sheets.read(tabRange(entity.tab_name)+'!1:1');
    const differences=Array.from({length:Math.max(expected.length,actual.length)},(_,i)=>({column:i+1,expected:expected[i]??null,actual:actual[i]??null})).filter(c=>c.expected!==c.actual);
    console.log(JSON.stringify({entity:entity.name,expectedCount:expected.length,actualCount:actual.length,differences}));
    if(process.argv.includes('--apply')) {
      if(!['127.0.0.1','localhost'].includes(config.MYSQL_HOST))throw Error('LOCAL_DATABASE_REQUIRED');
      const current=json(entity.headers),added=['ItemName','Email','GuardLockedAt','GuardLockedBy','GuardLockedRole'];
      const next=[...current,...added];
      if(JSON.stringify(actual)===JSON.stringify(expected))continue;
      if(JSON.stringify(actual)!==JSON.stringify([...next,...metadataHeaders]))throw Error('UNEXPECTED_COLUMNS_REFUSED');
      const result=await exclusive(pool,async db=>{
        await db.beginTransaction();
        try {
          const [[fresh]]=await db.query('SELECT headers,bootstrap_state FROM entities WHERE name=? FOR UPDATE',[entity.name]);
          const [[count]]=await db.query('SELECT COUNT(*) total FROM records WHERE entity=?',[entity.name]);
          if(JSON.stringify(json(fresh.headers))!==JSON.stringify(current)||fresh.bootstrap_state==='ready'||Number(count.total)!==0)throw Error('ENTITY_NOT_EMPTY_OR_CHANGED');
          await db.query('UPDATE entities SET headers=? WHERE name=?',[JSON.stringify(next),entity.name]);
          await db.commit();return {updated:true};
        }catch(error){await db.rollback();throw error;}
      });
      if(result?.busy)throw Error('WORKER_BUSY_RETRY');
      console.log(JSON.stringify({entity:entity.name,...result}));
    }
  }
} catch(error) {console.error(error.code||'HEADER_CHECK_FAILED');process.exitCode=1;}
finally {await pool.end();}
