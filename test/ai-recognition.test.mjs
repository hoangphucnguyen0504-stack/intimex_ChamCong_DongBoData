import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callProvider,payloadSchema} from '../src/aiProviders.js';
import {validateRecognition} from '../src/aiRecognition.js';
import {saveDiagnostic,safeError} from '../src/aiDiagnostics.js';
import {decrypt} from '../src/core.js';
const payload={mode:'recognition-review',format:'docx',fileHash:'a'.repeat(64),positions:[{id:'word/document.xml:p0',text:'Hợp đồng: ........',label:'Đoạn 1',context:'Hợp đồng',detected:true,writable:true,formula:false,locked:false}]};
test('recognition review accepts structural input only, never data sources or mapping output',()=>{
  assert(payloadSchema.safeParse(payload).success);
  assert.equal(payloadSchema.safeParse({...payload,dictionary:[{key:'secret'}]}).success,false);
  assert.throws(()=>validateRecognition({fields:[{source:'contractNumber'}]},payload));
  assert.throws(()=>validateRecognition({corrections:[{position:'invented',recognized:true,label:''}]},payload));
  assert.throws(()=>validateRecognition({corrections:[{position:payload.positions[0].id,recognized:true,label:'invented'}]},payload));
  assert.throws(()=>validateRecognition({corrections:[{position:payload.positions[0].id,recognized:true,label:'Hợp đồng',source:'contractNumber'}]},payload));
});
test('both provider adapters review original text without mapping instructions or token caps',async()=>{
  for(const vendor of ['gemini','openai']){
    const correction={position:payload.positions[0].id,recognized:true,label:'Hợp đồng'};
    const result=await callProvider({vendor,model:'test-model',apiKey:'synthetic-dummy-key'},payload,{fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),instruction=vendor==='openai'?body.messages[0].content:body.systemInstruction.parts[0].text;
      assert.match(instruction,/structural recognition ONLY/);assert.match(instruction,/Do not select system data sources/);
      assert.equal(body.max_completion_tokens,undefined);assert.equal(body.generationConfig?.maxOutputTokens,undefined);
      const content=JSON.stringify({corrections:[correction]});
      return Response.json(vendor==='openai'?{choices:[{finish_reason:'stop',message:{content}}]}:{candidates:[{finishReason:'STOP',content:{parts:[{text:content}]}}]});
    }});
    assert.deepEqual(result.result,{corrections:[correction]});
  }
});
test('diagnostics preserve bounded stage/code/path, encrypt details and exclude raw errors or keys',async()=>{
  const key='ab'.repeat(32),writes=[];
  const pool={query:async(sql,args)=>{writes.push({sql,args});return [{affectedRows:1}];}};
  const safe=safeError(Object.assign(Error('private secret raw response'),{code:'AI_REVIEW_STRUCTURE',issues:[{code:'invalid_type',path:['corrections',0,'label'],input:'private secret'}]}));
  await saveDiagnostic(pool,key,{scope:'inspection:test',stage:'review',...safe});
  assert(!JSON.stringify(writes).includes('private secret'));
  const stored=decrypt(writes[0].args[4],key);assert.equal(stored.code,'AI_REVIEW_STRUCTURE');assert.deepEqual(stored.details.issues[0].path,['corrections',0,'label']);
});
