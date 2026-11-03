import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileRows,syncEntity} from '../src/sync.js';
import {migrate} from '../src/db.js';

function mappingPool(maps){
  const calls=[];
  const query=async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.startsWith('SELECT id,sheet_row'))return [maps];
    return [[]];
  };
  const conn={query,beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{}};
  return {calls,pool:{query,getConnection:async()=>conn}};
}
test('sorting/swapping mapped rows stages only changed positions under transaction',async()=>{
  const f=mappingPool([{id:'A',sheet_row:2},{id:'B',sheet_row:3},{id:'C',sheet_row:9}]);
  const blocked=await reconcileRows(f.pool,{name:'Test'},new Map([['A',[3]],['B',[2]],['C',[9]]]));
  assert.equal(blocked.size,0);
  assert.deepEqual(f.calls.filter(c=>c.sql.startsWith('UPDATE row_map')).map(c=>c.args),[
    [-2,'Test','A'],[-3,'Test','B'],[3,'Test','A'],[2,'Test','B']
  ]);
  assert(!f.calls.some(c=>/DELETE|INSERT/.test(c.sql)));
});
test('missing owner preserves its slot and only the connected collision group is blocked',async()=>{
  const f=mappingPool([{id:'missing',sheet_row:2},{id:'A',sheet_row:3},{id:'B',sheet_row:4},{id:'C',sheet_row:9}]);
  const blocked=await reconcileRows(f.pool,{name:'Test'},new Map([['A',[2]],['B',[3]],['C',[10]]]));
  assert.deepEqual([...blocked].sort(),['A','B','missing']);
  assert.deepEqual(f.calls.filter(c=>c.sql.startsWith('UPDATE row_map')).map(c=>c.args),[[-9,'Test','C'],[10,'Test','C']]);
});
test('another worker holding the global lock prevents reads, allocation and writes',async()=>{
  let writes=0;const calls=[];
  const conn={query:async sql=>{calls.push(sql);return [[{acquired:0}]];},release:()=>{}};
  const result=await syncEntity({getConnection:async()=>conn},{bootstrap_state:'ready'},{writeRows:async()=>writes++},10);
  assert.deepEqual(result,{busy:true});assert.equal(writes,0);assert.equal(calls.length,1);
});
test('startup migration preserves all historical ApplicationState records and row mappings',async()=>{
  const calls=[];
  const query=async sql=>{
    calls.push(sql);
    if(sql.includes('@@innodb_flush'))return [[{durable:1}]];
    if(sql.includes('GET_LOCK'))return [[{acquired:1}]];
    if(sql.includes('SELECT VERSION'))return [[{v:'8.4.0'}]];
    if(sql.includes('information_schema.statistics'))return [[{col:'updated_at'}]];
    return [[]];
  };
  await migrate({query,getConnection:async()=>({query,release:()=>{}})});
  assert(!calls.some(sql=>/DELETE\s|TRUNCATE|DROP TABLE/i.test(sql)));
  assert(calls.some(sql=>sql.includes('CREATE TABLE IF NOT EXISTS sync_record_failures')));
});
