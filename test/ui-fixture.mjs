// Local UI fixture only: no MySQL, Google credentials, or production network calls.
import {createApp} from '../src/app.js';
import {passwordHash,encrypt} from '../src/core.js';
const key='1'.repeat(64),sessions=new Set();
const settings={spreadsheetId:'fixture-only-sheet-not-real',intervalMinutes:60,batchSize:100,enabled:true,serviceAccount:{client_email:'fixture@example.invalid',private_key:'fixture-only'}};
const now=new Date();
const entities=[{name:'VehicleTrips',tab_name:'VehicleTrips',headers:['ID','FullName'],bootstrap_state:'ready',retention_days:7,total:1284,pending:12,last_sync_at:now,last_error:null},
  {name:'Attendance',tab_name:'Attendance',headers:['ID','FullName'],bootstrap_state:'new',retention_days:7,total:0,pending:0,last_sync_at:null,last_error:null}];
const pool={query:async(sql,args=[])=>{
  if(sql.includes('SELECT token_hash'))return [[...(sessions.has(args[0])?[{token_hash:args[0]}]:[])]];
  if(sql.startsWith('INSERT INTO sessions')){sessions.add(args[0]);return [{affectedRows:1}];}
  if(sql.startsWith('DELETE FROM sessions')){sessions.delete(args[0]);return [{affectedRows:1}];}
  if(sql.includes('SELECT hits'))return [[{hits:1}]];
  if(sql.includes('SELECT encrypted'))return [[{encrypted:encrypt(settings,key)}]];
  if(sql.includes('SELECT heartbeat_at'))return [[{heartbeat_at:now,next_sync_at:new Date(+now+3600000),worker_error:null}]];
  if(sql.includes('FROM entities e LEFT JOIN'))return [entities];
  if(sql.includes('FROM sync_runs'))return [[{id:1,entity:'VehicleTrips',kind:'sync',state:'success',rows_count:100,started_at:now,finished_at:now,error_code:null}]];
  if(sql.includes('FROM jobs'))return [[{id:'fixture-job',kind:'import',entity:'Attendance',state:'needs_review',attempts:8,created_at:now,error_code:'GOOGLE_HTTP_429'}]];
  if(sql==='SELECT 1')return [[{one:1}]];
  if(sql.startsWith('INSERT INTO login_limits'))return [{affectedRows:1}];
  throw Error('UI_FIXTURE_READ_ONLY');
}};
const config={API_TOKEN:'fixture-token',SESSION_SECRET:'fixture-session-secret',ADMIN_USERNAME:'demo',ADMIN_PASSWORD_HASH:passwordHash('demo-only-password'),PUBLIC_ORIGIN:'http://127.0.0.1:3209',COOKIE_SECURE:'false',CONFIG_ENCRYPTION_KEY:key};
const server=createApp(pool,config).listen(3209,'127.0.0.1',()=>console.log('UI fixture ready at http://127.0.0.1:3209 (mock data only)'));
process.once('SIGTERM',()=>server.close());process.once('SIGINT',()=>server.close());
