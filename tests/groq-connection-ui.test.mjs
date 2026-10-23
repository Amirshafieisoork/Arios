import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceProviderDefaults, voiceConnectionPayload, wireVoiceConnectionForm } from '../public/voice.mjs';

const OPENAI='https://api.openai.com/v1';
const GROQ='https://api.groq.com/openai/v1';
const saved={aiConfigured:true,aiBaseUrl:OPENAI,aiModel:'current-custom-chat',transcriptionModel:'current-custom-transcriber'};
const formData=values=>{const result=new FormData();for(const [key,value]of Object.entries(values))result.set(key,value);return result;};

test('Groq defaults are independent of the saved provider and only known services are selectable',()=>{
  assert.deepEqual(voiceProviderDefaults(GROQ),{label:'Groq',aiModel:'openai/gpt-oss-20b',transcriptionModel:'whisper-large-v3-turbo'});
  for(const value of ['https://unknown.example/v1','https://api.groq.com/v1','__proto__','toString'])assert.equal(voiceProviderDefaults(value),null);
  const copy=voiceProviderDefaults(GROQ);copy.aiModel='changed';assert.equal(voiceProviderDefaults(GROQ).aiModel,'openai/gpt-oss-20b');
  assert.equal(saved.aiBaseUrl,OPENAI);
});

test('changing a provider requires its own key while unchanged provider settings preserve the stored key',()=>{
  const empty={aiBaseUrl:GROQ,aiApiKey:' ',aiModel:'openai/gpt-oss-20b',transcriptionModel:'whisper-large-v3-turbo',telegramBotToken:''};
  assert.throws(()=>voiceConnectionPayload(formData(empty),saved),/کلید اختصاصی Groq/);
  assert.throws(()=>voiceConnectionPayload(formData({...empty,aiBaseUrl:OPENAI}),{...saved,aiConfigured:false}),/کلید اختصاصی OpenAI/);
  const preserved=voiceConnectionPayload(formData({...empty,aiBaseUrl:OPENAI,aiModel:saved.aiModel,transcriptionModel:saved.transcriptionModel}),saved);
  assert.equal(preserved.aiApiKey,undefined);assert.equal(preserved.telegramBotToken,undefined);assert.equal(preserved.aiModel,saved.aiModel);
  const result=voiceConnectionPayload(formData({...empty,aiApiKey:'  dedicated-groq-test-key  '}),saved);
  assert.equal(result.aiBaseUrl,GROQ);assert.equal(result.aiApiKey,'dedicated-groq-test-key');assert.equal(result.telegramBotToken,undefined);
  assert.deepEqual(saved,{aiConfigured:true,aiBaseUrl:OPENAI,aiModel:'current-custom-chat',transcriptionModel:'current-custom-transcriber'});
});

function fields(current=saved){
  const select=Object.assign(new EventTarget(),{value:current.aiBaseUrl});
  const key={value:'',required:false,placeholder:''},report={value:current.aiModel},transcription={value:current.transcriptionModel},note={textContent:''};
  const controls={'[name="aiBaseUrl"]':select,'[name="aiApiKey"]':key,'[name="aiModel"]':report,'[name="transcriptionModel"]':transcription,'[data-ai-provider-note]':note};
  return {select,key,report,transcription,note,form:{querySelector:selector=>controls[selector]}};
}

test('provider changes clear a typed key, set Groq models and disclose free-plan quotas without modifying saved settings',()=>{
  const f=fields(),dispose=wireVoiceConnectionForm(f.form,saved);
  assert.equal(f.key.required,false);assert.equal(f.report.value,saved.aiModel);
  f.key.value='typed-for-openai-test';f.select.value=GROQ;f.select.dispatchEvent(new Event('change'));
  assert.equal(f.key.value,'');assert.equal(f.key.required,true);assert.match(f.key.placeholder,/Groq/);
  assert.equal(f.report.value,'openai/gpt-oss-20b');assert.equal(f.transcription.value,'whisper-large-v3-turbo');assert.match(f.note.textContent,/رایگان.*سهمیه/);
  f.key.value='typed-for-groq-test';f.select.value=OPENAI;f.select.dispatchEvent(new Event('change'));
  assert.equal(f.key.value,'');assert.equal(f.key.required,false);assert.equal(f.report.value,saved.aiModel);assert.equal(f.transcription.value,saved.transcriptionModel);
  dispose();f.select.value=GROQ;f.select.dispatchEvent(new Event('change'));assert.equal(f.report.value,saved.aiModel);
});

test('first-time Groq setup requires a key immediately and never populates a stored secret',()=>{
  const current={aiBaseUrl:GROQ,aiConfigured:false,aiModel:'openai/gpt-oss-20b',transcriptionModel:'whisper-large-v3-turbo'},f=fields(current);
  wireVoiceConnectionForm(f.form,current);
  assert.equal(f.key.required,true);assert.equal(f.key.value,'');assert.match(f.note.textContent,/Groq/);
});
