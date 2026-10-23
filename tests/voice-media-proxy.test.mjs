import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { createBff } from '../backend/bff.mjs';
import { createApiHandler } from '../api/index.mjs';

const APP='https://arios.example.com';
const SUPABASE='https://qategfabulrkvdckzmqp.supabase.co';
const ID='telegram_19991865';
const FILE='/api/voice/audio/file/'+ID;
const MAX=20*1024*1024;
// A complete, playable 100 ms Ogg/Opus silence file, generated without user audio.
const OGG=Buffer.from('T2dnUwACAAAAAAAAAABIjVxYAAAAAN6ZNdEBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAEiNXFgBAAAAg3UljwE9T3B1c1RhZ3MMAAAATGF2ZjYxLjcuMTAzAQAAAB0AAABlbmNvZGVyPUxhdmM2MS4xOS4xMDEgbGlib3B1c09nZ1MABPgTAAAAAAAASI1cWAIAAADee+LUBgMDAwMDA/j//vj//vj//vj//vj//vj//g==','base64');
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const sign=()=>({url:SUPABASE+'/storage/v1/object/sign/arios-audio/voice/worker/'+ID+'.ogg?token=private-signature',expiresAt:new Date(Date.now()+300000).toISOString(),mimeType:'audio/ogg',fileName:'arios-voice.ogg'});
function fixture({signed=sign(),edge,storage,refresh}={}){
 const calls=[];
 const fetcher=async(input,options={})=>{
  const url=new URL(input),headers=new Headers(options.headers),call={url,headers,options};calls.push(call);
  assert.equal(options.redirect,'manual');
  if(url.pathname==='/auth/v1/token'){
   assert.equal(headers.get('apikey'),'test-publishable');
   assert.deepEqual(JSON.parse(options.body),{refresh_token:'old-refresh'});
   return refresh?refresh(call):json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  }
  if(url.pathname==='/functions/v1/arios-api/voice/audio'){
   assert.equal(url.origin,SUPABASE);assert.equal(options.method,'POST');
   assert.equal(headers.get('apikey'),'test-publishable');assert.equal(headers.has('cookie'),false);
   assert.deepEqual(JSON.parse(options.body),{id:ID});
   return edge?edge(call):json(signed);
  }
  assert.equal(url.origin,SUPABASE);assert.match(url.pathname,new RegExp('^/storage/v1/object/sign/arios-audio/voice/worker/'+ID+'\\.[a-z0-9]+$'));
  for(const secret of ['authorization','apikey','cookie','origin'])assert.equal(headers.has(secret),false,secret+' must not be sent to signed storage');
  assert.equal(options.credentials,'omit');
  return storage?storage(call):new Response(options.method==='HEAD'?null:OGG,{headers:{'Content-Type':'audio/ogg','Content-Length':String(OGG.length),'Accept-Ranges':'bytes','Set-Cookie':'foreign=secret','Access-Control-Allow-Origin':'*'}});
 };
 const handle=createBff({env:{ARIOS_SUPABASE_URL:SUPABASE,ARIOS_SUPABASE_PUBLISHABLE_KEY:'test-publishable'},fetcher});
 const request=(path=FILE,{method='GET',cookie='arios_access=current-access',headers={},body}={})=>handle(new Request(APP+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{'Content-Type':'application/json',Origin:APP}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return{calls,request,handle};
}

test('media requires a valid workspace session and rejects cross-site reads before fetching',async()=>{
 const f=fixture();
 for(const method of ['GET','HEAD']){
  const denied=await f.request(FILE,{method,cookie:null});assert.equal(denied.status,401);
 }
 for(const headers of [{'Sec-Fetch-Site':'cross-site'},{Origin:'https://foreign.example.com'}])assert.equal((await f.request(FILE,{headers})).status,403);
 assert.equal(f.calls.length,0);
});

test('audio preparation returns only a same-origin route, never the signed storage capability',async()=>{
 const f=fixture();const response=await f.request('/api/voice/audio',{method:'POST',body:{id:ID}});
 assert.equal(response.status,200);const value=await response.json();
 assert.equal(value.url,FILE);assert.equal(value.mimeType,'audio/ogg');assert.equal(value.fileName,'arios-voice.ogg');
 assert.equal(JSON.stringify(value).includes('private-signature'),false);assert.equal(JSON.stringify(value).includes(SUPABASE),false);
 assert.equal(f.calls.length,1);
});

test('authenticated playback streams complete Ogg bytes with private headers and no upstream secrets',async()=>{
 const f=fixture();const response=await f.request();assert.equal(response.status,200);
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),OGG);
 assert.equal(response.headers.get('Content-Type'),'audio/ogg');assert.equal(response.headers.get('Content-Length'),String(OGG.length));
 assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(response.headers.get('Accept-Ranges'),'bytes');
 assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Cross-Origin-Resource-Policy'),'same-origin');
 assert.equal(response.headers.has('Set-Cookie'),false);assert.equal(response.headers.has('Access-Control-Allow-Origin'),false);
 assert.equal(f.calls[0].headers.get('Authorization'),'Bearer current-access');assert.equal(f.calls.length,2);
});

test('single byte ranges preserve 206 and Content-Range for seeking',async()=>{
 const f=fixture({storage:call=>{
  assert.equal(call.headers.get('Range'),'bytes=32-63');
  return new Response(OGG.subarray(32,64),{status:206,headers:{'Content-Type':'audio/ogg','Content-Length':'32','Content-Range':`bytes 32-63/${OGG.length}`,'Accept-Ranges':'bytes'}});
 }});
 const response=await f.request(FILE,{headers:{Range:'bytes=32-63'}});assert.equal(response.status,206);
 assert.equal(response.headers.get('Content-Range'),`bytes 32-63/${OGG.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),OGG.subarray(32,64));
});

test('legacy OGA, Opus and MPEG paths keep the same authorized playback route',async()=>{
 for(const [extension,mimeType] of [['oga','audio/ogg'],['opus','audio/opus'],['mpeg','audio/mpeg']]){
  const signed={...sign(),url:sign().url.replace('.ogg?','.'+extension+'?'),mimeType};
  const f=fixture({signed,storage:()=>new Response(OGG,{headers:{'Content-Type':mimeType}})});
  const prepared=await f.request('/api/voice/audio',{method:'POST',body:{id:ID}});assert.equal(prepared.status,200,extension);assert.equal((await prepared.json()).url,FILE);
  const response=await f.request();assert.equal(response.status,200,extension);assert.equal(response.headers.get('Content-Type'),mimeType);await response.arrayBuffer();
 }
});

test('generic legacy storage MIME is normalized only by authenticated metadata matching the canonical extension',async()=>{
 const f=fixture({storage:()=>new Response(OGG,{headers:{'Content-Type':'application/octet-stream'}})});
 const response=await f.request();assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'audio/ogg');assert.deepEqual(Buffer.from(await response.arrayBuffer()),OGG);
 for(const mimeType of ['audio/mpeg','application/pdf','application/octet-stream','text/html']){
  const bad=fixture({signed:{...sign(),mimeType},storage:()=>new Response(OGG,{headers:{'Content-Type':'application/octet-stream'}})});
  assert.equal((await bad.request()).status,502,mimeType);
 }
});

test('HEAD authorizes the draft and returns safe metadata without a media body',async()=>{
 const f=fixture();const response=await f.request(FILE,{method:'HEAD'});
 assert.equal(response.status,200);assert.equal(response.body,null);assert.equal(response.headers.get('Content-Length'),String(OGG.length));
 assert.equal(f.calls[0].options.method,'POST');assert.equal(f.calls[1].options.method,'HEAD');
});

test('valid unsatisfiable storage ranges return 416 without forwarding its error body',async()=>{
 const f=fixture({storage:()=>new Response('upstream-private-error',{status:416,headers:{'Content-Range':`bytes */${OGG.length}`}})});
 const response=await f.request(FILE,{headers:{Range:'bytes=1000-'}});assert.equal(response.status,416);
 assert.equal(response.headers.get('Content-Range'),`bytes */${OGG.length}`);assert.equal(await response.text(),'');
});

test('invalid IDs, traversal and multipart or unbounded ranges never fetch a file',async()=>{
 const f=fixture();
 for(const suffix of ['a%2Fb','a%2eogg','a.b','a/b','a'.repeat(121)])assert.equal((await f.request('/api/voice/audio/file/'+suffix)).status,400);
 for(const range of ['bytes=','bytes=-','bytes=0-1,4-8','items=0-2','bytes=5-4','bytes=-0',`bytes=${MAX}-`,`bytes=0-${MAX}`,'bytes=9007199254740992-']){
  const response=await f.request(FILE,{headers:{Range:range}});assert.equal(response.status,416,range);
 }
 assert.equal(f.calls.length,0);
});

test('draft ownership and role denials prevent all storage requests',async()=>{
 const f=fixture({edge:()=>json({error:'اجازهٔ شنیدن این صوت را ندارید.',code:'FORBIDDEN'},403)});
 const response=await f.request();assert.equal(response.status,403);assert.equal((await response.json()).code,'FORBIDDEN');assert.equal(f.calls.length,1);
});

test('expired access credentials refresh through the existing cookie flow before media fetch',async()=>{
 let attempts=0;
 const f=fixture({edge:call=>{
  if(attempts++===0){assert.equal(call.headers.get('Authorization'),'Bearer current-access');return json({error:'expired'},401);}
  assert.equal(call.headers.get('Authorization'),'Bearer new-access');return json(sign());
 }});
 const response=await f.request(FILE,{cookie:'arios_access=current-access; arios_refresh=old-refresh'});
 assert.equal(response.status,200);assert.equal(response.headers.getSetCookie().length,2);assert.ok(response.headers.getSetCookie().every(value=>value.includes('HttpOnly')));
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),OGG);assert.equal(f.calls.length,4);
});

test('failed session refresh clears cookies and never fetches private audio',async()=>{
 const f=fixture({edge:()=>json({error:'expired'},401),refresh:()=>json({error:'invalid refresh'},400)});
 const response=await f.request(FILE,{cookie:'arios_access=current-access; arios_refresh=old-refresh'});
 assert.equal(response.status,401);assert.equal(response.headers.getSetCookie().length,2);assert.ok(response.headers.getSetCookie().every(value=>value.includes('Max-Age=0')));assert.equal(f.calls.length,2);
});

test('foreign origins, URL credentials, redirects and another draft cannot become media fetch targets',async()=>{
 for(const url of [
  'https://foreign.example.com/private.ogg?token=private-signature',
  SUPABASE.replace('https://','https://secret@')+'/storage/v1/object/sign/arios-audio/voice/worker/'+ID+'.ogg?token=x',
  SUPABASE+'/storage/v1/object/sign/arios-audio/voice/worker/other-draft.ogg?token=x',
  SUPABASE+'/storage/v1/object/public/arios-audio/voice/worker/'+ID+'.ogg?token=x',
  sign().url+'#private-fragment',
  sign().url.replace('?token=private-signature',''),
 ]){
  const f=fixture({signed:{...sign(),url}});const response=await f.request();assert.equal(response.status,502,url);
  assert.equal(f.calls.length,1);assert.ok(!(await response.text()).includes('private-signature'));
 }
 const f=fixture({storage:()=>new Response('private-provider-error',{status:302,headers:{Location:'https://foreign.example.com/secret'}})});
 const response=await f.request();assert.equal(response.status,502);assert.ok(!(await response.text()).includes('private-provider-error'));assert.equal(f.calls.length,2);
});

test('unexpected MIME, oversized lengths and malformed ranges never reach the browser as media',async()=>{
 for(const headers of [
  {'Content-Type':'text/html'},
  {'Content-Type':'audio/ogg','Content-Length':String(MAX+1)},
  {'Content-Type':'audio/ogg','Content-Length':'NaN'},
 ]){
  const f=fixture({storage:()=>new Response('private-provider-error',{headers})});const response=await f.request();assert.equal(response.status,502);assert.ok(!(await response.text()).includes('private-provider-error'));
 }
 const f=fixture({storage:()=>new Response(OGG,{status:206,headers:{'Content-Type':'audio/ogg','Content-Range':'bytes 0-100/50'}})});
 assert.equal((await f.request(FILE,{headers:{Range:'bytes=0-100'}})).status,502);
});

test('a missing Content-Length cannot bypass the streaming size bound',async()=>{
 let cancelled=false;
 const f=fixture({storage:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'audio/ogg'}})});
 const response=await f.request();assert.equal(response.status,200);await assert.rejects(response.arrayBuffer(),/AUDIO_RESPONSE_TOO_LARGE/);assert.equal(cancelled,true);
});

test('Node adapter forwards chunks before the source finishes instead of buffering a voice',async()=>{
 const req=Readable.from([]);req.url='/api/index?route=voice/audio/file/'+ID;req.method='GET';req.headers={host:'arios.example.com'};
 let source,finished=false;
 const body=new ReadableStream({start(controller){source=controller;controller.enqueue(OGG.subarray(0,64));}});
 const chunks=[],headers=new Map();
 const res=new Writable({highWaterMark:1,write(chunk,encoding,callback){chunks.push(Buffer.from(chunk));this.emit('chunk');callback();}});
 res.setHeader=(key,value)=>headers.set(key,value);
 const handler=createApiHandler({handle:async request=>{assert.equal(new URL(request.url).pathname,FILE);return new Response(body,{headers:{'Content-Type':'audio/ogg'}});}});
 const firstChunk=once(res,'chunk');const pending=handler(req,res).then(()=>{finished=true;});await firstChunk;
 assert.equal(finished,false,'the first bytes must be written before EOF');assert.deepEqual(chunks[0],OGG.subarray(0,64));
 source.enqueue(OGG.subarray(64));source.close();await pending;
 assert.deepEqual(Buffer.concat(chunks),OGG);assert.equal(headers.get('content-type'),'audio/ogg');
});

test('Node adapter, BFF authorization and private storage stream an 8 MB response in chunks',async()=>{
 const total=8*1024*1024,chunkSize=256*1024;let produced=0,written=0,largestChunk=0;
 const f=fixture({storage:()=>new Response(new ReadableStream({pull(controller){if(produced===total){controller.close();return;}const chunk=new Uint8Array(chunkSize);chunk.fill(produced/chunkSize);produced+=chunk.length;controller.enqueue(chunk);}}),{headers:{'Content-Type':'audio/ogg','Content-Length':String(total)}})});
 const req=Readable.from([]);req.url='/api/index?route=voice/audio/file/'+ID;req.method='GET';req.headers={host:'arios.example.com',cookie:'arios_access=current-access'};
 const headers=new Map();const res=new Writable({highWaterMark:16384,write(chunk,encoding,callback){assert.equal(chunk[0],written/chunkSize);written+=chunk.length;largestChunk=Math.max(largestChunk,chunk.length);callback();}});res.setHeader=(key,value)=>headers.set(key,value);
 await createApiHandler({handle:f.handle})(req,res);
 assert.equal(res.statusCode,200);assert.equal(written,total);assert.equal(largestChunk,chunkSize);assert.equal(headers.get('content-length'),String(total));assert.equal(headers.get('content-type'),'audio/ogg');assert.equal(f.calls.length,2);
});
