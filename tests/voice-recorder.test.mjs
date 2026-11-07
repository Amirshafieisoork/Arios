import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioCapture,recordingSupport,recordingError,renderVoiceRecorder,wireVoiceRecorder} from '../public/voice-recorder.mjs';
import {renderVoice} from '../public/voice.mjs';
import {renderVoiceInbox} from '../public/voice-inbox.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node {
 constructor(){this.listeners=new Map();this.dataset={};this.hidden=false;this.disabled=false;this.textContent='';this.pauseCount=0;}
 addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
 removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
 async emit(type,extra={}){for(const fn of this.listeners.get(type)||[])await fn({target:this,...extra});}
 click(){return this.emit('click');}
 pause(){this.pauseCount++;}
 removeAttribute(key){delete this[key];}
}
function fixture({getUserMedia,stopChunk=true,maxSeconds,maxBytes}={}){
 const tracks=[{stops:0,stop(){this.stops++;}}],stream={getTracks:()=>tracks},timers=new Map(),events=[],recorders=[],created=[],revoked=[];
 let id=0;
 class Recorder {
  static isTypeSupported=type=>type==='audio/webm;codecs=opus';
  constructor(source,options){assert.equal(source,stream);this.mimeType=options.mimeType;this.state='inactive';recorders.push(this);}
  start(interval){this.state='recording';assert.equal(interval,1000);}
  data(bytes){this.ondataavailable?.({data:new Blob([bytes],{type:this.mimeType})});}
  stop(){this.state='inactive';if(stopChunk)this.data('sound');this.onstop?.();}
 }
 const scope=Object.assign(new Node(),{isSecureContext:true,MediaRecorder:Recorder,Blob,File,navigator:{mediaDevices:{getUserMedia:getUserMedia||(async options=>{assert.equal(options.video,false);return stream;})}},URL:{createObjectURL:file=>{created.push(file);return'blob:voice-'+created.length;},revokeObjectURL:url=>revoked.push(url)},setInterval:fn=>{timers.set(++id,fn);return id;},clearInterval:key=>timers.delete(key),document:Object.assign(new Node(),{hidden:false})});
 const capture=createAudioCapture({scope,onChange:value=>events.push(value),...(maxSeconds?{maxSeconds}:{}),...(maxBytes?{maxBytes}:{})});
 return{scope,capture,events,stream,tracks,timers,recorders,created,revoked};
}

test('audio capture is explicit, audio-only and returns a correctly named private in-memory file',async()=>{
 const f=fixture();assert(recordingSupport(f.scope));await f.capture.start();
 assert.equal(f.capture.snapshot().phase,'recording');assert.equal(f.tracks[0].stops,0);
 f.recorders[0].data('first');f.capture.stop();
 const final=f.capture.snapshot();assert.equal(final.phase,'ready');assert.equal(final.file.type,'audio/webm;codecs=opus');assert.match(final.file.name,/^ARIOS-voice-.*\.webm$/);
 assert.equal(await final.file.text(),'firstsound');assert.equal(f.tracks[0].stops,1);assert.equal(f.timers.size,0);
 f.capture.dispose();
});

test('late microphone permission after cancellation or disposal cannot leave a live track',async()=>{
 for(const action of ['cancel','dispose']){
  let resolve;const f=fixture({getUserMedia:()=>new Promise(done=>resolve=done)});
  const started=f.capture.start();assert.equal(f.capture.snapshot().phase,'requesting');f.capture[action]();resolve(f.stream);await started;
  assert.equal(f.tracks[0].stops,1);assert.equal(f.recorders.length,0);assert.equal(f.timers.size,0);assert.equal(f.capture.snapshot().file,null);
 }
});

test('permission denial and unsupported browsers give a file alternative without a recording',async()=>{
 const f=fixture({getUserMedia:async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});}});await f.capture.start();
 assert.equal(f.capture.snapshot().phase,'error');assert.match(f.capture.snapshot().error,/اجازهٔ میکروفن/);assert.equal(f.capture.snapshot().file,null);
 assert.equal(recordingSupport({...f.scope,isSecureContext:false}),false);assert.equal(recordingSupport({}),false);
 assert.match(recordingError({name:'NotReadableError'}),/برنامهٔ دیگری/);f.capture.dispose();
});

test('recording ends at the duration limit and rejects empty or oversized audio while releasing the microphone',async()=>{
 const bounded=fixture({maxSeconds:2});await bounded.capture.start();[...bounded.timers.values()][0]();[...bounded.timers.values()][0]();
 assert.equal(bounded.capture.snapshot().phase,'ready');assert.equal(bounded.capture.snapshot().seconds,2);assert.equal(bounded.tracks[0].stops,1);
 const empty=fixture({stopChunk:false});await empty.capture.start();empty.capture.stop();assert.equal(empty.capture.snapshot().phase,'error');assert.match(empty.capture.snapshot().error,/صدایی ضبط نشد/);
 const large=fixture({maxBytes:3});await large.capture.start();large.recorders[0].data('large');assert.equal(large.capture.snapshot().phase,'error');assert.equal(large.capture.snapshot().file,null);assert.match(large.capture.snapshot().error,/۲۰ مگابایت/);assert.equal(large.tracks[0].stops,1);
 for(const f of [bounded,empty,large])f.capture.dispose();
});

function mounted(options={}){
 const f=fixture(),nodes=new Map(['start','stop','send','discard','preview','status','timer','phone','phone-input','app-update'].map(key=>[key,new Node()]));
 const block=Object.assign(new Node(),{querySelector:selector=>nodes.get(selector.match(/data-record-([^\]]+)/)?.[1])});
 const root={querySelector:()=>block},files=[],sent=[],saved=[];
 const controller=wireVoiceRecorder(root,{scope:f.scope,onFile:file=>files.push(file),upload:async file=>{sent.push(file);return{id:'new',status:'ready'};},onSaved:result=>saved.push(result),...options});
 return{...f,nodes,block,controller,files,sent,saved};
}

test('record-preview-send sends once and releases its object URL only after successful storage',async()=>{
 let finish,calls=0;const f=mounted({upload:async file=>{calls++;return new Promise(resolve=>finish=resolve);}});
 await f.nodes.get('start').click();await flush();await f.nodes.get('stop').click();
 assert.equal(f.nodes.get('preview').hidden,false);assert.equal(f.nodes.get('send').hidden,false);assert.equal(f.created.length,1);
 const sending=f.nodes.get('send').click();await f.nodes.get('send').click();assert.equal(calls,1);assert.equal(f.nodes.get('send').disabled,true);
 finish({id:'stored',status:'ready'});await sending;
 assert.equal(f.saved[0].id,'stored');assert.equal(f.files.at(-1),null);assert.equal(f.revoked.length,1);assert.equal(f.controller.busy,false);f.controller.dispose();
});

test('failed uploads preserve the same recording for retry and discard never sends it',async()=>{
 const f=mounted({upload:async()=>{throw Error('ارتباط قطع شد؛ دوباره بفرستید.');}});
 await f.nodes.get('start').click();await flush();await f.nodes.get('stop').click();const file=f.files.at(-1);
 await f.nodes.get('send').click();assert.equal(f.files.at(-1),file);assert.equal(f.nodes.get('send').disabled,false);assert.equal(f.controller.busy,true);assert.match(f.nodes.get('status').textContent,/ارتباط قطع شد/);
 await f.nodes.get('discard').click();assert.equal(f.files.at(-1),null);assert.equal(f.sent.length,0);assert.equal(f.revoked.length,1);assert.equal(f.controller.busy,false);f.controller.dispose();
});

test('background events stop recording and preserve the completed file, and unmount revokes playback URLs',async()=>{
 const f=mounted();await f.nodes.get('start').click();await flush();await f.scope.emit('arios-native-background');
 assert.equal(f.tracks[0].stops,1);assert(f.files.at(-1) instanceof File);assert.equal(f.nodes.get('send').hidden,false);
 f.controller.dispose();assert.equal(f.revoked.length,1);assert.equal(f.timers.size,0);assert.equal(f.scope.listeners.get('arios-native-background').size,0);
});

test('native permission failures expose an app update link and file fallback remains available',async()=>{
 const f=fixture({getUserMedia:async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});}});
 f.scope.navigator.userAgent='Android AriosAndroid/1';
 const nodes=new Map(['start','stop','send','discard','preview','status','timer','phone','phone-input','app-update'].map(key=>[key,new Node()]));
 const block=Object.assign(new Node(),{querySelector:s=>nodes.get(s.match(/data-record-([^\]]+)/)?.[1])});
 const controller=wireVoiceRecorder({querySelector:()=>block},{scope:f.scope,upload:async()=>{}});
 await nodes.get('start').click();await flush();assert.equal(nodes.get('app-update').hidden,false);assert.equal(nodes.get('phone').disabled,false);controller.dispose();
});

test('recorder appears independently of Telegram and report-creation controls respect the staff capability',()=>{
 const html=renderVoiceRecorder();assert.match(html,/بدون نیاز به تلگرام/);assert.match(html,/capture="microphone"/);assert.match(html,/data-record-preview/);assert.match(html,/data-record-discard/);assert(!html.includes('https://'));
 const ctx={e:String,n:String,date:String,icon:()=>'',personName:()=>'',api:{isStatic:false}},state={user:{id:'store',role:'warehouse',permissions:{'voice.use':true}},projects:[],users:[]};
 const voice=renderVoice(state,ctx);assert.match(voice,/data-voice-recorder/);assert(!voice.includes('صندوق ویس برای این حساب فعال نیست'));
 const inbox=renderVoiceInbox(state,ctx,{filter:'all',processingIds:new Set(),data:{drafts:[{id:'mine',userId:'store',source:'upload',status:'ready',fields:{},audio:{available:true}}]}});
 assert(!inbox.includes('data-voice-review="mine"'));assert.match(inbox,/ویس و متن در صندوق شما ذخیره/);
 assert.match(renderVoice({...state,user:{role:'customer',permissions:{'voice.use':true}}},ctx),/دسترسی صندوق ویس/);
});
