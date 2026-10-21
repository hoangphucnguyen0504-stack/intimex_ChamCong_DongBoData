import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountChatboxRead} from '../src/chatboxRead.js';
import {authFor} from '../src/auth.js';
const config={API_TOKEN:'w'.repeat(64),CHATBOX_READ_TOKEN:'r'.repeat(64)};
async function fixture(override={}){
  const queries=[];let writes=0;
  const pool={execute:async(opts,args)=>{queries.push({sql:opts.sql,args});if(opts.sql.includes('FROM entities'))return [[{bootstrap_state:'ready',retention_days:0}]];return [Array.from({length:101},()=>({event_day:'PRIVATE_ID',status:'PRIVATE NAME',kind:'PRIVATE NAME',Phone:'0901234567',weight_kg:'12.5',quantity:'2'}))];}};
  const app=express();mountChatboxRead(app,pool,{...config,...override});
  app.use('/v1',authFor(pool,config).integration);app.post('/v1/cham-cong/write',(_req,res)=>{writes++;res.json({ok:true});});
  app.use((err,_req,res,_next)=>res.status(err.status||503).json({ok:false}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=(path,{token=config.CHATBOX_READ_TOKEN,role='GUARD',method='GET'}={})=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{Authorization:'Bearer '+token,'X-ChatBox-Role':role}});
  return {request,queries,writes:()=>writes,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('separate read token cannot use writer endpoints; writer token cannot use scoped reads',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request('/v1/cham-cong/write',{method:'POST'})).status,401);assert.equal(f.writes(),0);
    assert.equal((await f.request('/v1/chatbox/rows?dataset=vehicles',{method:'POST'})).status,403);
    assert.equal((await f.request('/v1/chatbox/capabilities',{token:config.API_TOKEN})).status,401);
    assert.equal((await f.request('/v1/entities/Admins/records')).status,401);
  }finally{await f.close();}
});
test('scoped API checks roles, bounds rows, sanitizes at server, and parameterizes dates',async()=>{
  const f=await fixture();try{
    const caps=await (await f.request('/v1/chatbox/capabilities')).json();assert.equal(caps.readOnly,true);assert.equal(caps.datasets.includes('inventory'),false);
    assert.equal((await f.request('/v1/chatbox/rows?dataset=inventory')).status,403);
    assert.equal((await f.request('/v1/chatbox/rows?dataset=vehicles&dates=2026-02-31')).status,400);
    assert.equal((await f.request('/v1/chatbox/rows?dataset=vehicles&limit=10000')).status,400);
    const result=await (await f.request('/v1/chatbox/rows?dataset=vehicles&dates=2026-10-21')).json();
    assert.equal(result.rows.length,100);assert.equal(result.truncated,true);assert.equal(result.rows[0].event_day,'UNKNOWN');assert.equal(result.rows[0].status,'OTHER');assert.equal(result.rows[0].kind,'OTHER');
    assert.equal(JSON.stringify(result).includes('0901234567'),false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
    assert.deepEqual(f.queries.at(-1).args,['VehicleTrips','2026-10-21']);
    assert.ok(f.queries.every(q=>q.sql.startsWith('SELECT ')));assert.match(f.queries.at(-1).sql,/LIMIT 101$/);
  }finally{await f.close();}
});
test('read principal fails closed when token is missing or reuses writer token',async()=>{
  for(const token of [undefined,config.API_TOKEN]){const f=await fixture({CHATBOX_READ_TOKEN:token});try{assert.equal((await f.request('/v1/chatbox/capabilities')).status,503);}finally{await f.close();}}
});
