'use strict';
const additions={VehicleTrips:new Set(['Seal','Seal2']),VehicleLogs:new Set(['Container','Container2','TrailerNumber','Seal','Seal2'])};
function compatibleHeaders(entity,expected,actual){
 if(!Array.isArray(actual)||!Array.isArray(expected)||actual.length>expected.length)return false;
 if(actual.some((column,index)=>column!==expected[index]))return false;
 return expected.slice(actual.length).every(column=>additions[entity]?.has(column));
}
function legacySealPatch(entity,current,patch){
 if(!additions[entity])return {};
 const slots=[['Container','Seal'],['Container2','Seal2']],key=value=>String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
 const result={};
 for(const [container,seal] of slots){
  if(Object.hasOwn(patch,seal))continue;
  const identity=key(Object.hasOwn(patch,container)?patch[container]:current[container]);
  const previous=slots.find(([name])=>identity&&key(current[name])===identity);
  result[seal]=previous?current[previous[1]]||'':!identity&&!key(current[container])?current[seal]||'':'';
 }
 return result;
}
module.exports={compatibleHeaders,legacySealPatch};
