import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callProvider,failover} from '../src/aiProviders.js';
import {safeError,saveDiagnostic} from '../src/aiDiagnostics.js';
import {decrypt} from '../src/core.js';
const provider={id:'provider-test',vendor:'gemini',model:'synthetic-model',apiKey:'synthetic-api-key',enabled:true};
const payload={mode:'recognition-review-v2',format:'docx',fileHash:'a'.repeat(64),documentId:'d'.repeat(64),positions:[{id:'word/document.xml:p0',text:'Contract: ........',label:'Contract',context:'Contract',detected:true,writable:true,formula:false,locked:false}],document:{mimeType:'application/pdf',sourceHash:'a'.repeat(64),data:Buffer.from('%PDF-1.4\nsynthetic\n%%EOF').toString('base64')}};
const result={corrections:[{position:payload.positions[0].id,recognized:true,label:'Contract',targets:[]}]};
function answer(vendor,value=result){const content=JSON.stringify(value);return Response.json(vendor==='openai'?{choices:[{finish_reason:'stop',message:{content}}]}:{candidates:[{finishReason:'STOP',content:{parts:[{text:content}]}}]});}
test('file reviews get 180 seconds, accept responses later than 30 seconds, and connection tests retain a short deadline',async()=>{
  for(const vendor of ['gemini','openai']){
    let clock=0,budget;
    const data=await callProvider({...provider,vendor},payload,{now:()=>clock,signalFactory:ms=>{budget=ms;return new AbortController().signal;},fetchImpl:async()=>{clock=45000;return answer(vendor);}});
    assert.equal(budget,180000);assert.deepEqual(data.result,result);
    const {document,documentId,...legacy}=payload;
    await callProvider({...provider,vendor},{...legacy,mode:'recognition-review'},{signalFactory:ms=>{assert.equal(ms,30000);return new AbortController().signal;},fetchImpl:async()=>answer(vendor,{corrections:result.corrections.map(({targets,...item})=>item)})});
  }
});
test('true deadlines record elapsed time and phase without logging raw errors or document contents',async()=>{
  const controller=new AbortController();let clock=0;
  await assert.rejects(()=>callProvider(provider,payload,{now:()=>clock,signalFactory:()=>controller.signal,fetchImpl:async()=>{clock=180000;controller.abort();throw new DOMException('private headers and document text','AbortError');}}),error=>{
    assert.equal(error.code,'AI_TIMEOUT');assert.equal(error.uncertain,true);assert.deepEqual(error.transport,{phase:'request',reason:'deadline',elapsedMs:180000,timeoutMs:180000});
    assert(!JSON.stringify(error).includes('private'));return true;
  });
});
test('DNS/TLS/reset/refused/connect-deadline failures have bounded, distinct diagnostics',async()=>{
  for(const [cause,code,reason] of [['ENOTFOUND','AI_NETWORK','dns'],['CERT_HAS_EXPIRED','AI_NETWORK','tls'],['ECONNRESET','AI_NETWORK','connection_reset'],['ECONNREFUSED','AI_NETWORK','connection_refused'],['UND_ERR_CONNECT_TIMEOUT','AI_TIMEOUT','connect_timeout']]){
    await assert.rejects(()=>callProvider(provider,payload,{fetchImpl:async()=>{throw Object.assign(TypeError('private upstream host and key'),{cause:{code:cause,address:'private-host'}});}}),error=>error.code===code&&error.transport.reason===reason&&!JSON.stringify(error).includes('private-host'));
  }
});
test('an interrupted response body is classified separately from a request failure',async()=>{
  const stream=new ReadableStream({start(controller){controller.error(Object.assign(Error('private response'),{cause:{code:'ECONNRESET'}}));}});
  await assert.rejects(()=>callProvider(provider,payload,{fetchImpl:async()=>new Response(stream,{status:200})}),error=>error.code==='AI_NETWORK'&&error.transport.phase==='response'&&error.transport.reason==='connection_reset');
});
test('uncertain failures retain the provider/transport context and stop after one potentially billed request',async()=>{
  let calls=0;const events=[];
  await assert.rejects(()=>failover([provider,{...provider,id:'backup'}],payload,{invoke:async p=>{calls++;return callProvider(p,payload,{fetchImpl:async()=>{throw Object.assign(TypeError('private'),{cause:{code:'ENOTFOUND'}});}});},after:async(p,event)=>events.push({provider:p.id,...event})}),error=>error.code==='AI_UNKNOWN'&&error.providerId===provider.id&&error.transport.reason==='dns');
  assert.equal(calls,1);assert.equal(events[0].state,'unknown');assert.equal(events[0].code,'AI_NETWORK');assert.equal(events[0].transport.reason,'dns');
});
test('transport diagnostics are encrypted and reject arbitrary host, key and response properties',async()=>{
  const key='ab'.repeat(32),writes=[],transport={phase:'request',reason:'deadline',elapsedMs:180000,timeoutMs:180000};
  const pool={query:async(sql,args)=>{writes.push(args);return [{affectedRows:1}];}};
  await saveDiagnostic(pool,key,{scope:'inspection:test',stage:'review',providerId:provider.id,...safeError({code:'AI_TIMEOUT',transport,message:'private raw response'})});
  assert.deepEqual(decrypt(writes[0][4],key).details.transport,transport);assert(!JSON.stringify(writes).includes('private raw response'));
  assert.equal(safeError({code:'AI_NETWORK',transport:{...transport,url:'private-key'}}).details.transport,undefined);
});
