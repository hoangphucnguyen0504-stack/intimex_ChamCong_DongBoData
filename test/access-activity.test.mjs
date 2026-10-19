import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAccessActivity} from '../src/accessActivity.js';
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
