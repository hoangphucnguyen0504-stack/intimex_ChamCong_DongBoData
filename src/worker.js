import {loadConfig} from './config.js';
import {poolFor,migrate} from './db.js';
import {tick,errorCode} from './sync.js';
const config=loadConfig(),pool=poolFor(config);
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try {
  await migrate(pool);
  while(!stopping) {
    try {const r=await tick(pool,config);if(r?.error)console.error(JSON.stringify({event:'sync_error',code:r.error}));}
    catch(e) {console.error(JSON.stringify({event:'worker_error',code:errorCode(e)}));}
    if(!stopping)await new Promise(resolve=>setTimeout(resolve,5000));
  }
} catch {console.error('WORKER_START_FAILED');process.exitCode=1;}
finally {await pool.end();}
