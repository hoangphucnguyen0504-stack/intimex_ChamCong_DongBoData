import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAccessActivity} from '../src/accessActivity.js';
test('ChatBox has an independent authenticated connection row and lifecycle',()=>{
 let time=1000;const activity=createAccessActivity({now:()=>time});
 const row=()=>activity.snapshot().connections.find(r=>r.client==='chatbox-read-only');
 assert.equal(row().state,'unseen');
 const req={path:'/capabilities',method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{authorization:'SECRET','x-datadongbo-client':'hdoi-worker'}};
 const res=new EventEmitter();res.statusCode=200;
 activity.track('chatbox')(req,res,()=>{});assert.equal(row().state,'requesting');res.emit('finish');res.emit('close');
 assert.equal(row().state,'recent');assert.equal(row().requests,1);assert.equal(row().inFlight,0);assert.ok(row().lastSuccessAt);
 assert.equal(activity.snapshot().connections.find(r=>r.client==='hdoi-worker').state,'unseen');
 assert.equal(activity.snapshot().items[0].account,'ChatBox (chỉ đọc)');assert.equal(JSON.stringify(activity.snapshot()).includes('SECRET'),false);
 time+=120001;assert.equal(row().state,'idle');
 const failed=new EventEmitter();failed.statusCode=503;activity.track('chatbox')(req,failed,()=>{});failed.emit('finish');
 assert.equal(row().state,'error');assert.equal(row().requests,2);assert.ok(row().lastFailureAt);
});
test('writer client header cannot impersonate the read-only ChatBox principal',()=>{
 const activity=createAccessActivity(),res=new EventEmitter();res.statusCode=200;
 activity.track('api')({path:'/cham-cong/ping',method:'GET',socket:{},headers:{'x-datadongbo-client':'chatbox-read-only'}},res,()=>{});res.emit('finish');
 assert.equal(activity.snapshot().connections.find(r=>r.client==='chatbox-read-only').state,'unseen');
});
function hit(activity,path='/entities/VehicleTrips/records',kind='api'){
 const res=new EventEmitter();res.statusCode=200;let called=false;
 activity.track(kind,'admin')({path,method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{authorization:'SECRET'},body:{password:'SECRET'}},res,()=>called=true);res.emit('finish');assert(called);
}
test('tracks authenticated connection without secrets or record URLs',()=>{const a=createAccessActivity();hit(a);hit(a);const s=a.snapshot();assert.equal(s.items[0].requests,2);assert.equal(s.items[0].resource,'VehicleTrips');assert.equal(s.items[0].status,200);assert(!JSON.stringify(s).includes('SECRET'));assert(!JSON.stringify(s).includes('127.0.0.1'));});
test('dashboard polling does not create activity and entries expire',()=>{let time=1000;const a=createAccessActivity({now:()=>time});hit(a,'/status','admin');assert.equal(a.snapshot().items.length,0);hit(a);time+=61000;assert.equal(a.snapshot().items[0].active,false);time+=900000;assert.equal(a.snapshot().items.length,0);});
test('bounded runtime storage and separate verified admin label',()=>{const a=createAccessActivity({maxEntries:1});hit(a);hit(a,'/settings','admin');assert.equal(a.snapshot().items.length,1);assert.equal(a.snapshot().items[0].account,'admin');});
test('backend connection shows success, idle and error without claiming disconnected',()=>{
 let time=1000;const a=createAccessActivity({now:()=>time});
 assert.equal(a.snapshot().connections[0].state,'unseen');
 const call=status=>{const res=new EventEmitter();res.statusCode=status;a.track('api')({path:'/cham-cong/rows/VehicleTrips',method:'GET',socket:{},headers:{'x-datadongbo-client':'cham-cong-backend'}},res,()=>{});assert.equal(a.snapshot().connections[0].inFlight,1);res.emit('finish');res.emit('close');};
 call(200);assert.equal(a.snapshot().connections[0].state,'recent');assert.equal(a.snapshot().connections[0].inFlight,0);
 time+=120001;assert.equal(a.snapshot().connections[0].state,'idle');call(503);assert.equal(a.snapshot().connections[0].state,'error');assert(a.snapshot().connections[0].lastSuccessAt);assert(a.snapshot().connections[0].lastFailureAt);
});
