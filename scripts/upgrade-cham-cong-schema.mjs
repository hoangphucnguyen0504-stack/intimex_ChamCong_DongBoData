import {readFile} from 'node:fs/promises';
import {loadConfig} from '../src/config.js';
import {poolFor} from '../src/db.js';
import {upgradeSchema} from '../src/upgradeChamCongSchema.js';
const config=loadConfig(),pool=poolFor(config);
try{
 const contracts=JSON.parse(await readFile(new URL('../config/cham-cong-entities.json',import.meta.url),'utf8'));
 console.log(JSON.stringify(await upgradeSchema(pool,config.CONFIG_ENCRYPTION_KEY,contracts,{apply:process.argv.includes('--apply')})));
}catch(error){console.error(error.code||'SCHEMA_UPGRADE_FAILED');process.exitCode=1;}
finally{await pool.end();}
