import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {callProvider,payloadSchema} from '../src/aiProviders.js';
import {validateDual} from '../src/aiRecognitionV2.js';
import {saveDocument,documentForReview,assertDocument,convertOriginal} from '../src/aiDocuments.js';
import {decrypt,encrypt} from '../src/core.js';
import {safeError} from '../src/aiDiagnostics.js';
const fileHash='a'.repeat(64),documentId='d'.repeat(64),pdf=Buffer.from('%PDF-1.4\nsynthetic-new-layout\n%%EOF');
const payload={mode:'recognition-review-v2',format:'docx',fileHash,documentId,positions:[{id:'word/document.xml:p0',text:'Vessel: SHIP-TEST',label:'Vessel',context:'Vessel',detected:false,writable:false,formula:false,locked:false}]};
const output={corrections:[{position:payload.positions[0].id,recognized:true,label:'Vessel',targets:[{start:8,end:17,text:'SHIP-TEST',label:'Vessel',type:'string',kind:'text',repeat:false}]}]};
test('Gemini and OpenAI receive both actual PDF bytes and full structural scan; absent document cannot downgrade to text-only',async()=>{
  assert(payloadSchema.safeParse(payload).success);
  for(const vendor of ['gemini','openai']){
    let calls=0;
    const provider={vendor,model:'test-multimodal',apiKey:'synthetic-test-key'};
    await assert.rejects(()=>callProvider(provider,payload,{fetchImpl:async()=>{calls++;}}),e=>e.code==='AI_DOCUMENT_REQUIRED');assert.equal(calls,0);
    const result=await callProvider(provider,{...payload,document:{mimeType:'application/pdf',data:pdf.toString('base64'),sourceHash:fileHash}},{fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),parts=vendor==='openai'?body.messages[1].content:body.contents[0].parts;
      const data=vendor==='openai'?parts[0].file.file_data.split(',')[1]:parts[0].inlineData.data;
      assert.deepEqual(Buffer.from(data,'base64'),pdf);const structural=JSON.parse(parts[1].text);assert.deepEqual(structural,payload);assert.equal(structural.document,undefined);
      assert.equal(body.max_completion_tokens,undefined);assert.equal(body.generationConfig?.maxOutputTokens,undefined);
      const content=JSON.stringify(output);return Response.json(vendor==='openai'?{choices:[{finish_reason:'stop',message:{content}}]}:{candidates:[{finishReason:'STOP',content:{parts:[{text:content}]}}]});
    }});assert.deepEqual(result.result,output);
  }
});
test('dual-input validation requires a decision for every position and exact, nonoverlapping, real source spans',()=>{
  assert.deepEqual(validateDual(output,payload),output);
  for(const mutate of [v=>v.corrections.pop(),v=>v.corrections[0].targets[0].text='invented',v=>v.corrections[0].targets.push({...v.corrections[0].targets[0]}),v=>v.corrections[0].recognized=false,v=>v.corrections[0].source='contractNumber']){const value=structuredClone(output);mutate(value);assert.throws(()=>validateDual(value,payload));}
  assert.throws(()=>validateDual(output,{...payload,positions:[{...payload.positions[0],locked:true}]}));
});
test('source evidence repairs a miscounted offset only when the exact text has one allowed occurrence',()=>{
  const input=structuredClone(payload),value=structuredClone(output);
  input.positions[0].text='🚢 Tàu: SHIP-TEST';value.corrections[0].label='Tàu';Object.assign(value.corrections[0].targets[0],{start:0,end:9,label:'Tàu'});
  const result=validateDual(value,input),target=result.corrections[0].targets[0];
  assert.equal(target.start,8);assert.equal(target.end,17);assert.equal(input.positions[0].text.slice(target.start,target.end),'SHIP-TEST');
  assert.equal(value.corrections[0].targets[0].start,0,'validation does not mutate the received AI payload');
});
test('offset repair stays within the original range and refuses ambiguous or invented evidence',()=>{
  const input=structuredClone(payload),value=structuredClone(output);
  input.positions[0].text='Tel: .... Fax: ....';input.positions[0].id='word/document.xml:p5@range15-19';
  Object.assign(value.corrections[0],{position:input.positions[0].id,label:'Fax'});
  Object.assign(value.corrections[0].targets[0],{start:0,end:4,text:'....',label:'Fax'});
  assert.deepEqual(validateDual(value,input).corrections[0].targets.map(t=>[t.start,t.end]),[[15,19]]);
  input.positions[0].id='word/document.xml:p5';value.corrections[0].position=input.positions[0].id;
  assert.throws(()=>validateDual(value,input),e=>e.code==='AI_REVIEW_TARGET'&&e.issues[0].code==='ambiguous_source');
  value.corrections[0].targets[0].text='not in source';
  assert.throws(()=>validateDual(value,input),e=>e.issues[0].code==='missing_source');
});
test('target validation reports safe distinct reasons without including document text',()=>{
  for(const [patch,reason] of [[{label:'private-invented-label'},'unsupported_label'],[{repeat:true},'repeat_outside_table'],[{kind:'checkbox'},'invalid_checkbox']]){
    const value=structuredClone(output);Object.assign(value.corrections[0].targets[0],patch);
    assert.throws(()=>validateDual(value,payload),error=>{
      assert.equal(error.code,'AI_REVIEW_TARGET');const diagnostic=safeError(error);
      assert.equal(diagnostic.details.issues[0].code,reason);
      assert.deepEqual(diagnostic.details.issues[0].path,['positions',0,'targets',0]);
      assert(!JSON.stringify(diagnostic).includes('SHIP-TEST'));assert(!JSON.stringify(diagnostic).includes('private-invented-label'));return true;
    });
  }
});
test('uploaded original is hash verified, encrypted, scope bound, converted once and reused without changing source bytes',async()=>{
  const key='ab'.repeat(32),original=Buffer.concat([Buffer.from([80,75,3,4]),Buffer.from('synthetic-original')]),hash=createHash('sha256').update(original).digest('hex');let row,conversions=0;
  const pool={query:async(sql,args)=>{
    if(sql.startsWith('INSERT INTO ai_documents')){row||={id:args[0],scope:args[1],file_hash:args[2],format:args[3],encrypted_original:args[4]};return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE ai_documents')){row.encrypted_pdf=args[0];return [{affectedRows:1}];}
    return [[row&&args[0]===row.id&&args[1]===row.scope&&args[2]===row.file_hash&&args[3]===row.format?row:undefined].filter(Boolean)];
  }};
  const input={scope:'inspection:test',format:'docx',fileHash:hash,data:original.toString('base64')},saved=await saveDocument(pool,key,input);
  assert(!row.encrypted_original.includes(input.data));assert.deepEqual(Buffer.from(decrypt(row.encrypted_original,key).data,'base64'),original);
  const request={...payload,documentId:saved.document.id,fileHash:hash};await assertDocument(pool,request,input.scope);
  const options={convert:async(buffer,format)=>{conversions++;assert.deepEqual(buffer,original);assert.equal(format,'docx');return pdf;}};
  const one=await documentForReview(pool,key,request,input.scope,options),two=await documentForReview(pool,key,request,input.scope,options);
  assert.equal(conversions,1);assert.deepEqual(one,two);assert.deepEqual(Buffer.from(one.data,'base64'),pdf);assert.equal(one.sourceHash,hash);
  await assert.rejects(()=>assertDocument(pool,request,'other-company'),e=>e.code==='AI_DOCUMENT_SCOPE');
  await assert.rejects(()=>saveDocument(pool,key,{...input,fileHash:'b'.repeat(64)}),e=>e.code==='AI_DOCUMENT_INVALID');
});
test('worker converts the untouched original with configured Drive credentials and trashes its temporary copy on success or failure',async()=>{
  const key='cd'.repeat(32),original=Buffer.from('fresh-office-source'),credential={enabled:true,clientId:'test-id',clientSecret:'test-secret',refreshToken:'test-token',folderId:'test-folder'};
  const pool={query:async()=>[[{encrypted:encrypt({credentials:[credential]},key)}]]};
  for(const exportFails of [false,true]){
    const calls=[];
    const authFactory=()=>({setCredentials:value=>assert.equal(value.refresh_token,'test-token'),request:async request=>{
      calls.push(request);assert.equal(request.retry,false);
      if(request.url.includes('/upload/')){assert(request.data.includes(original));assert.equal(request.method,'POST');return {data:{id:'test-temp-file'}};}
      if(request.url.endsWith('/export')){if(exportFails)throw Error('sensitive upstream body');return {data:pdf};}
      assert.equal(request.method,'PATCH');assert.deepEqual(request.data,{trashed:true});return {data:{}};
    }});
    if(exportFails)await assert.rejects(()=>convertOriginal(original,'docx',{pool,key,authFactory}),e=>e.code==='AI_DOCUMENT_CONVERSION_UNKNOWN'&&!e.message.includes('sensitive'));
    else assert.deepEqual(await convertOriginal(original,'docx',{pool,key,authFactory}),pdf);
    assert.equal(calls.length,3);assert.equal(calls.at(-1).method,'PATCH');
  }
  await assert.rejects(()=>convertOriginal(original,'docx',{pool:{query:async()=>[[]]},key}),e=>e.code==='AI_DOCUMENT_CONVERTER');
});
test('backend conversion credential is encrypted with the original and used without a second Drive registry',async()=>{
  const key='ef'.repeat(32),original=Buffer.concat([Buffer.from([80,75,3,4]),Buffer.from('new-original')]),fileHash=createHash('sha256').update(original).digest('hex');
  const credential={clientId:'test-id',clientSecret:'never-plaintext-secret',refreshToken:'never-plaintext-refresh',folderId:'test-folder'};let row;
  const pool={query:async(sql,args)=>{
    if(sql.startsWith('INSERT INTO ai_documents')){row={id:args[0],scope:args[1],file_hash:args[2],format:args[3],encrypted_original:args[4]};return [{affectedRows:1}];}
    if(sql.startsWith('UPDATE ai_documents')){row.encrypted_pdf=args[0];return [{affectedRows:1}];}
    if(sql.startsWith('SELECT * FROM ai_documents'))return [[row]];
    if(sql.startsWith('SELECT encrypted FROM drive_credential_state'))return [[]];
    throw Error('Unexpected registry query');
  }};
  const saved=await saveDocument(pool,key,{scope:'inspection:test',format:'docx',fileHash,data:original.toString('base64'),conversionCredential:credential});
  assert(!JSON.stringify(row).includes(credential.clientSecret));assert(!JSON.stringify(row).includes(credential.refreshToken));
  const result=await documentForReview(pool,key,{documentId:saved.document.id,format:'docx',fileHash},'inspection:test',{convert:async(buffer,format,options)=>{
    assert.deepEqual(options.credential,credential);assert.deepEqual(buffer,original);
    return convertOriginal(buffer,format,{...options,authFactory:()=>({setCredentials:()=>{},request:async request=>request.url.includes('/upload/')?{data:{id:'temp-document'}}:request.url.endsWith('/export')?{data:pdf}:{data:{}}})});
  }});
  assert.deepEqual(Buffer.from(result.data,'base64'),pdf);assert(!JSON.stringify(result).includes(credential.clientSecret));assert.equal(result.conversionCredential,undefined);
});
