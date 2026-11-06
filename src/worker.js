import {loadConfig} from './config.js';
import {poolFor,migrate} from './db.js';
import {tick,errorCode} from './sync.js';
import {bootstrapSettings} from './bootstrap.js';
import {runAutoPolicies} from './retention.js';
import {processNext} from './ai.js';
const config=loadConfig(),pool=poolFor(config);
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try {
  await migrate(pool);
  await bootstrapSettings(pool,config);
  while(!stopping) {
    try {const r=await tick(pool,config);if(r?.error)console.error(JSON.stringify({event:'sync_error',code:r.error}));}
    catch(e) {console.error(JSON.stringify({event:'worker_error',code:errorCode(e)}));}
    try { await processNext(pool,config.CONFIG_ENCRYPTION_KEY); } catch { console.error(JSON.stringify({event:'ai_worker_error',code:'AI_WORKER_FAILED'})); }
    try { const r = await runAutoPolicies(pool); if(r>0)console.log(JSON.stringify({event:'retention_auto_total',deleted:r})); } catch(e) { console.error(JSON.stringify({event:'retention_auto_error',code:e.code||'RETENTION_AUTO_FAILED'})); }
    if(!stopping)await new Promise(resolve=>setTimeout(resolve,5000));
  }
} catch {console.error('WORKER_START_FAILED');process.exitCode=1;}
finally {await pool.end();}
