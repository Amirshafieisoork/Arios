import test from 'node:test';
import assert from 'node:assert/strict';
import { requestAIJSON, transcribeAudio, extractReport, testAIConnection } from '../worker/voice.mjs';
import { getConfig, handleVoice } from '../supabase/functions/arios-api/voice-service.mjs';

const BASE = 'https://api.groq.com/openai/v1';
const GROQ_KEY = 'test-only-dedicated-groq-key';
const OPENAI_KEY = 'test-only-existing-openai-key';
const config = { aiBaseUrl: BASE, aiApiKey: GROQ_KEY, aiModel: 'openai/gpt-oss-20b', transcriptionModel: 'whisper-large-v3-turbo' };
const audio = new Uint8Array([79, 103, 103, 83, 0, 1]);
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json'}});
const completion = value => json({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
const messages = [{role:'system',content:'Return only a JSON object.'},{role:'user',content:'آزمون فارسی'}];

test('Groq transcribes original Telegram OGG and builds a Persian report through only its dedicated endpoints', async () => {
  const calls = [], transcript='در پروژه آریوس در تاریخ 2026-10-20 از ساعت 09:00 تا 17:00 با 30 دقیقه استراحت، کابل شبکه نصب کردم.';
  const fetcher = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization,'Bearer '+GROQ_KEY);
    assert.equal(init.redirect,'manual');
    if(url===BASE+'/audio/transcriptions') {
      assert(init.body instanceof FormData);
      assert.equal(init.body.get('model'),'whisper-large-v3-turbo');
      assert.equal(init.body.get('language'),'fa');
      assert.equal(init.body.get('response_format'),'json');
      assert.equal(init.body.get('file').name,'arios-voice.ogg');
      assert.equal(init.body.get('file').type,'audio/ogg');
      assert.deepEqual(new Uint8Array(await init.body.get('file').arrayBuffer()),audio);
      return json({text:transcript});
    }
    assert.equal(url,BASE+'/chat/completions');
    const body=JSON.parse(init.body);
    assert.equal(body.model,'openai/gpt-oss-20b');
    assert.deepEqual(body.response_format,{type:'json_object'});
    assert.equal(body.max_completion_tokens,2200);
    assert.equal(body.max_tokens,undefined);
    assert.equal(body.reasoning_effort,'low');
    assert.equal(body.include_reasoning,false);
    assert.equal(body.tools,undefined);
    assert.equal(JSON.parse(body.messages[1].content).untrustedTranscript,transcript);
    return completion({projectId:'p1',date:'2026-10-20',start:'09:00',end:'17:00',breakMinutes:30,description:'نصب کابل شبکه',output:'کابل نصب شد',warnings:[]});
  };
  const text=await transcribeAudio({bytes:audio,mimeType:'audio/ogg',fileName:'telegram.ogg',config,fetcher});
  const result=await extractReport({transcript:text,projects:[{id:'p1',name:'پروژه آریوس'}],referenceDate:'2026-10-20',config,fetcher});
  assert.equal(result.projectId,'p1');
  assert.equal(result.description,'نصب کابل شبکه');
  assert.deepEqual(calls,[BASE+'/audio/transcriptions',BASE+'/chat/completions']);
});

test('Groq host/path validation rejects endpoint injection before sending a credential', async () => {
  for(const aiBaseUrl of ['http://api.groq.com/openai/v1','https://api.groq.com/v1','https://api.groq.com.evil.example/openai/v1','https://secret@api.groq.com/openai/v1','https://api.groq.com:8443/openai/v1',BASE+'?redirect=elsewhere',BASE+'#fragment',BASE+'/chat/completions','https://api.groq.com/openai%2fv1']) {
    await assert.rejects(requestAIJSON({config:{...config,aiBaseUrl},messages,fetcher:()=>assert.fail('Unsafe destination cannot receive a key')}),error=>error.code==='AI_CONFIG_INVALID');
  }
  let destination;
  await requestAIJSON({config:{...config,aiBaseUrl:BASE+'/'},messages,maxTokens:100,fetcher:async url=>{destination=url;return completion({ok:true});}});
  assert.equal(destination,BASE+'/chat/completions');
});

test('Groq connection diagnostics use bounded synthetic content and identify the selected provider', async () => {
  const calls=[];
  const result=await testAIConnection({config,fetcher:async (url,init)=>{
    calls.push(url);
    assert.equal(init.headers.Authorization,'Bearer '+GROQ_KEY);
    if(url.endsWith('/chat/completions')) {
      const body=JSON.parse(init.body);
      assert.equal(body.max_completion_tokens,512,'Reasoning diagnostics have a bounded completion budget');
      assert.equal(body.reasoning_effort,'low');
      assert.match(body.messages[0].content,/JSON/);
      return completion({ok:true});
    }
    assert.equal(url,BASE+'/audio/transcriptions');
    assert.equal(init.body.get('model'),'whisper-large-v3-turbo');
    const file=init.body.get('file');
    assert.equal(file.name,'arios-connection-test.wav');
    assert.equal(file.size,32044);
    assert.equal(file.type,'audio/wav');
    return json({text:''});
  }});
  assert.equal(result.provider,'Groq');
  assert.equal(result.ok,true);
  assert.equal(calls.length,2);
  assert(!JSON.stringify(result).includes(GROQ_KEY));
});

test('Groq failures preserve the selected host and never fall back to another paid provider', async () => {
  const destinations=[];
  await assert.rejects(requestAIJSON({config,messages,fetcher:async url=>{
    destinations.push(url);return json({error:{code:'rate_limit_exceeded',message:'Private '+GROQ_KEY}},429);
  }}),error=>error.code==='UPSTREAM_RATE_LIMITED'&&!JSON.stringify(error).includes(GROQ_KEY));
  assert.deepEqual(destinations,[BASE+'/chat/completions']);
});

function settingsFixture() {
  let saved={aiBaseUrl:'https://api.openai.com/v1',aiApiKey:OPENAI_KEY,aiModel:'gpt-4o-mini',transcriptionModel:'whisper-1',telegramBotToken:'existing-private-bot-token',botUsername:'ExistingBot',botId:'1'};
  const repo={getSetting:async()=>structuredClone(saved),setSetting:async (key,value)=>{assert.equal(key,'integrations');saved=structuredClone(value);},rateLimit:async()=>({allowed:true})};
  const save=async payload=>handleVoice({path:'/api/integrations',request:new Request('https://arios.example/api/integrations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),repo,user:{id:'manager',role:'manager'},supabase:{},fetcher:()=>assert.fail('Saving provider settings must not make an upstream request')});
  return {repo,save,read:()=>structuredClone(saved)};
}

test('saving Groq requires its new dedicated key and supplies matching models without touching Telegram', async () => {
  const f=settingsFixture(), before=f.read();
  for(const aiApiKey of [undefined,'   ',OPENAI_KEY]) {
    await assert.rejects(f.save({aiBaseUrl:BASE,...(aiApiKey===undefined?{}:{aiApiKey})}),error=>error.status===400);
    assert.deepEqual(f.read(),before);
  }
  const response=await f.save({aiBaseUrl:BASE,aiApiKey:GROQ_KEY});
  assert.equal(response.status,200);
  const output=await response.json();
  assert.equal(output.integration.aiBaseUrl,BASE);
  assert.equal(output.integration.aiModel,'openai/gpt-oss-20b');
  assert.equal(output.integration.transcriptionModel,'whisper-large-v3-turbo');
  assert(!JSON.stringify(output).includes(GROQ_KEY));
  assert(!JSON.stringify(output).includes(OPENAI_KEY));
  assert.equal(f.read().telegramBotToken,before.telegramBotToken);
  await f.save({aiModel:'openai/gpt-oss-120b'});
  assert.equal(f.read().aiApiKey,GROQ_KEY);
  assert.equal(f.read().aiModel,'openai/gpt-oss-120b');
});

test('switching from Groq back to OpenAI requires another key and does not retain Groq model defaults', async () => {
  const f=settingsFixture();
  await f.save({aiBaseUrl:BASE,aiApiKey:GROQ_KEY});
  await assert.rejects(f.save({aiBaseUrl:'https://api.openai.com/v1'}),error=>error.status===400);
  await f.save({aiBaseUrl:'https://api.openai.com/v1',aiApiKey:OPENAI_KEY});
  assert.equal(f.read().aiModel,'gpt-4o-mini');
  assert.equal(f.read().transcriptionModel,'whisper-1');
});

test('Groq model defaults are derived only for an already selected Groq configuration', async () => {
  const groq=await getConfig({getSetting:async()=>({aiBaseUrl:BASE,aiApiKey:GROQ_KEY})});
  assert.equal(groq.aiModel,'openai/gpt-oss-20b');
  assert.equal(groq.transcriptionModel,'whisper-large-v3-turbo');
  const openai=await getConfig({getSetting:async()=>({aiBaseUrl:'https://api.openai.com/v1',aiApiKey:OPENAI_KEY})});
  assert.equal(openai.aiModel,'');
  assert.equal(openai.transcriptionModel,'whisper-1');
});
