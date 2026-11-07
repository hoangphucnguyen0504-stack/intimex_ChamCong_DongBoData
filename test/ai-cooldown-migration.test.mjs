import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrate} from '../src/db.js';
test('existing installations add the AI due-time column and index only once',async()=>{
  const writes=[];let column=false,index=false;
  const pool={query:async sql=>{
    if(sql.includes('innodb_flush'))return [[{durable:1}]];
    if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
    if(sql.includes('SELECT VERSION'))return [[{v:'5.7'}]];
    if(sql.includes('information_schema.columns')&&sql.includes("table_name='ai_jobs'"))return [column?[{col:'available_at'}]:[]];
    if(sql.includes('information_schema.statistics')&&sql.includes("table_name='ai_jobs'"))return [index?[{col:'state'},{col:'available_at'}]:[]];
    if(sql.includes('information_schema.'))return [[{col:'already-present'}]];
    if(sql.startsWith('ALTER TABLE ai_jobs ADD COLUMN available_at')){column=true;writes.push(sql);}
    if(sql.startsWith('ALTER TABLE ai_jobs ADD INDEX ai_job_due')){index=true;writes.push(sql);}
    return [{affectedRows:0}];
  }};
  pool.getConnection=async()=>({...pool,release(){}});
  await migrate(pool);await migrate(pool);
  assert.equal(column,true);assert.equal(index,true);assert.equal(writes.length,2);
});
