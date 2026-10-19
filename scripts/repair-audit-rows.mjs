import {loadConfig} from '../src/config.js';
import {poolFor} from '../src/db.js';
import {repairAuditRows} from '../src/repairAuditRows.js';
const config=loadConfig(),pool=poolFor(config);
try{
  const result=await repairAuditRows(pool,config,{apply:process.argv.includes('--apply')});
  console.log(JSON.stringify(result));if(result.busy)process.exitCode=1;
}catch(error){console.error(JSON.stringify({ok:false,code:/^[A-Z][A-Z0-9_]{0,90}$/.test(error.code||'')?error.code:'AUDIT_REPAIR_FAILED'}));process.exitCode=1;}
finally{await pool.end();}
