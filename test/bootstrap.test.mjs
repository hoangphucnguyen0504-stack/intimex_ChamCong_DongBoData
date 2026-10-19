import {test} from 'node:test';
import assert from 'node:assert/strict';
import {environmentSettings,bootstrapSettings} from '../src/bootstrap.js';
import {decrypt} from '../src/core.js';
import {readFile} from 'node:fs/promises';
import {entitySchema} from '../src/core.js';
const config={GOOGLE_SHEET_ID:'test-spreadsheet-1234567890',GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({client_email:'test@example.invalid',private_key:'-----BEGIN PRIVATE KEY----- test -----END PRIVATE KEY-----'}),CONFIG_ENCRYPTION_KEY:'1'.repeat(64)};
test('Google env bootstrap defaults to 60 minutes and no automatic writes',()=>{
  const parsed=environmentSettings(config);assert.equal(parsed.intervalMinutes,60);assert.equal(parsed.enabled,false);assert.equal(parsed.batchSize,100);
  assert.equal(environmentSettings({}),null);
  assert.throws(()=>environmentSettings({...config,GOOGLE_SERVICE_ACCOUNT_JSON:'invalid-private-config'}),e=>e.code==='GOOGLE_ENV_INVALID'&&!e.message.includes('invalid-private-config'));
});
function dbFixture(existing){const calls=[];const conn={query:async(sql,args=[])=>{calls.push({sql,args});if(sql.includes('GET_LOCK'))return [[{acquired:1}]];if(sql.startsWith('SELECT id FROM settings'))return [existing?[{id:1}]:[]];return [{}];},release:()=>{}};return {calls,pool:{getConnection:async()=>conn}};}
test('first boot persists encrypted Google settings without contacting Google',async()=>{
  const f=dbFixture(false),result=await bootstrapSettings(f.pool,config);assert.equal(result.seeded,true);
  const insert=f.calls.find(c=>c.sql.startsWith('INSERT INTO settings'));
  assert(!insert.args[0].includes('PRIVATE KEY'));assert.equal(decrypt(insert.args[0],config.CONFIG_ENCRYPTION_KEY).spreadsheetId,config.GOOGLE_SHEET_ID);
});
test('UI settings survive restarts and stale environment variables',async()=>{
  const f=dbFixture(true),result=await bootstrapSettings(f.pool,{...config,GOOGLE_SERVICE_ACCOUNT_JSON:'invalid-but-unused'});
  assert.equal(result.seeded,false);assert(!f.calls.some(c=>c.sql.startsWith('INSERT')||c.sql.startsWith('UPDATE')));
});
test('Cham_cong presets are valid and only missing mappings are seeded',async()=>{
  const path=new URL('../config/cham-cong-entities.json',import.meta.url),entities=JSON.parse(await readFile(path,'utf8'));
  assert(entities.length>0);for(const e of entities)entitySchema.parse(e);
  const f=dbFixture(true);await bootstrapSettings(f.pool,{...config,BOOTSTRAP_ENTITIES_FILE:path});
  const inserts=f.calls.filter(c=>c.sql.startsWith('INSERT IGNORE INTO entities'));assert.equal(inserts.length,entities.length);
  assert(!f.calls.some(c=>c.sql.startsWith('UPDATE entities')||c.sql.startsWith('INSERT INTO settings')));
});
