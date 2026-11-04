'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createDecipheriv} = require('node:crypto');
const mysql = require('mysql2/promise');
const {parse} = require('../../Cham_cong/backend/node_modules/dotenv');
const root = path.resolve(__dirname, '..');
const data = parse(fs.readFileSync(path.join(root, '.env')));
const backendPath = path.resolve(root, '../Cham_cong/backend/.env');
const text = fs.readFileSync(backendPath, 'utf8');
const backend = parse(text);
(async () => {
  let connection;
  try {
    if (!['127.0.0.1', 'localhost'].includes(data.MYSQL_HOST)) throw Error('LOCAL_MYSQL_REQUIRED');
    connection = await mysql.createConnection({host:data.MYSQL_HOST, port:Number(data.MYSQL_PORT || 3306), user:data.MYSQL_USER, password:data.MYSQL_PASSWORD, database:data.MYSQL_DATABASE, connectTimeout:5000});
    const [rows] = await connection.query('SELECT encrypted FROM settings WHERE id=1');
    if (!rows.length) throw Error('SETTINGS_MISSING');
    const bytes = Buffer.from(rows[0].encrypted, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(data.CONFIG_ENCRYPTION_KEY, 'hex'), bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(-16));
    const settings = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString());
    const source = settings.spreadsheetId;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(source)) throw Error('INVALID_STORED_SOURCE');
    const url = new URL(backend.DATA_DONG_BO_URL);
    if (url.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(url.hostname)) throw Error('LOCAL_API_REQUIRED');
    const response = await fetch(new URL('/v1/cham-cong/status?'+new URLSearchParams({spreadsheetId:source}),url),{headers:{Authorization:'Bearer '+backend.DATA_DONG_BO_TOKEN},signal:AbortSignal.timeout(5000)});
    const status = await response.json();
    console.log(JSON.stringify({backendMatchesStoredSource:(backend.DATA_DONG_BO_SOURCE_ID||backend.GOOGLE_SHEET_ID)===source,dataEnvMatchesStoredSource:data.GOOGLE_SHEET_ID===source,apiStatus:response.status,sourceCode:status.code,retention:status.entities?.filter(e=>Number(e.retention_days)>0).map(e=>({entity:e.name,days:Number(e.retention_days)})),notReady:status.entities?.filter(e=>e.bootstrap_state!=='ready'||Number(e.unmapped)).map(e=>e.name)}));
    if (!response.ok || status.ok !== true) throw Error('SOURCE_CHECK_FAILED');
    if (process.argv.includes('--fix')) {
      const backup = backendPath+'.before-source-fix';
      if (!fs.existsSync(backup)) fs.writeFileSync(backup,text);
      // Replace every duplicate assignment so dotenv cannot select a stale source.
      const updated = /^DATA_DONG_BO_SOURCE_ID=.*$/m.test(text) ? text.replace(/^DATA_DONG_BO_SOURCE_ID=.*$/gm,'DATA_DONG_BO_SOURCE_ID='+source) : text.trimEnd()+'\nDATA_DONG_BO_SOURCE_ID='+source+'\n';
      fs.writeFileSync(backendPath,updated);
      console.log('BACKEND_LOCAL_SOURCE_ALIGNED');
    }
  } catch(error) {
    console.error(JSON.stringify({error:error.code || 'LOCAL_SOURCE_CHECK_FAILED'}));
    process.exitCode=1;
  } finally { if(connection) await connection.end(); }
})();
