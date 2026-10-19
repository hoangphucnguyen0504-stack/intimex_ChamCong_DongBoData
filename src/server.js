import {loadConfig} from './config.js';
import {poolFor,migrate} from './db.js';
import {createApp} from './app.js';
import {bootstrapSettings} from './bootstrap.js';
const config=loadConfig(),pool=poolFor(config);
try {
  await migrate(pool);
  await bootstrapSettings(pool,config);
  const server=createApp(pool,config).listen(config.PORT,'0.0.0.0',()=>console.log(JSON.stringify({event:'api_ready',port:config.PORT})));
  server.requestTimeout=45000;server.headersTimeout=15000;
  const stop=()=>server.close(async()=>{await pool.end();process.exit(0);});
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
} catch {console.error('API_START_FAILED');await pool.end();process.exitCode=1;}
