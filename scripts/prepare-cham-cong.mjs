import {loadConfig} from '../src/config.js';
import {poolFor,migrate} from '../src/db.js';
import {prepareChamCong} from '../src/prepareChamCong.js';
const config=loadConfig(),pool=poolFor(config);
try{await migrate(pool);console.log(JSON.stringify(await prepareChamCong(pool,config.CONFIG_ENCRYPTION_KEY,{keepHistory:process.argv.includes('--keep-history')})));}
catch(error){console.error(error.code||'PREPARATION_FAILED');process.exitCode=1;}
finally{await pool.end();}
