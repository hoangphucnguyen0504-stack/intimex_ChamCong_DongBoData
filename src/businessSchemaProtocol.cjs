'use strict';
const {createHash}=require('node:crypto');
const bad=(code)=>{throw Object.assign(Error(code),{code,status:409});};
const key=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const fingerprint=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function normalize(input){
  if(!input||!key(input.entity)||input.entity.length>64||!Array.isArray(input.fields)||input.fields.length<1||input.fields.length>150)bad('BUSINESS_SCHEMA_INVALID');
  const fields=input.fields.map(f=>{
    if(!f||!key(f.key)||!['cell','text','number','integer','boolean','date'].includes(f.type)||typeof f.required!=='boolean')bad('BUSINESS_FIELD_INVALID');
    return {key:f.key,type:f.type,required:f.required};
  });
  if(fields[0].key!=='ID'||fields[0].type!=='text'||!fields[0].required||new Set(fields.map(f=>f.key)).size!==fields.length)bad('BUSINESS_SCHEMA_INVALID');
  return {entity:input.entity,fields};
}
function evolution(previous,next){
  const current=normalize(next);
  if(!previous)return current;
  const old=normalize(previous);
  if(old.entity!==current.entity||current.fields.length<old.fields.length)bad('BUSINESS_SCHEMA_BREAKING');
  for(let i=0;i<old.fields.length;i++)if(JSON.stringify(old.fields[i])!==JSON.stringify(current.fields[i]))bad('BUSINESS_SCHEMA_BREAKING');
  if(current.fields.slice(old.fields.length).some(f=>f.required))bad('BUSINESS_SCHEMA_REQUIRED_MIGRATION');
  return current;
}
function validateData(schema,data,{partial=false}={}){
  const fields=normalize(schema).fields;
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!fields.some(f=>f.key===k)))bad('BUSINESS_DATA_UNKNOWN_FIELD');
  for(const f of fields){
    if(!Object.hasOwn(data,f.key)){if(!partial&&f.required)bad('BUSINESS_DATA_REQUIRED');continue;}
    const v=data[f.key];
    if(v===null||v===''){if(f.required)bad('BUSINESS_DATA_REQUIRED');continue;}
    const valid=f.type==='cell'?['string','boolean','number'].includes(typeof v)&&(typeof v!=='number'||Number.isFinite(v)):
      f.type==='text'?typeof v==='string':f.type==='number'?typeof v==='number'&&Number.isFinite(v):
      f.type==='integer'?Number.isSafeInteger(v):f.type==='boolean'?typeof v==='boolean':
      typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
    if(!valid||(typeof v==='string'&&v.length>100000))bad('BUSINESS_DATA_TYPE');
  }
  return data;
}
module.exports={normalize,evolution,validateData,fingerprint};
