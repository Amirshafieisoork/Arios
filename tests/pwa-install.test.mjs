import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {ANDROID_APP_DOWNLOAD,installContext,installationSteps,registerAppWorker,mountInstaller} from '../web/install.mjs';

test('install metadata is stable, standalone and includes real correctly sized app icons',async()=>{
  const manifest=JSON.parse(await readFile('public/assets/manifest.webmanifest','utf8'));
  assert.equal(manifest.id,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.display,'standalone');assert.equal(manifest.prefer_related_applications,false);
  assert.equal(new URL(manifest.start_url,'https://arioshub.ir').origin,'https://arioshub.ir');
  for(const size of [192,512])for(const purpose of ['any','maskable']){
    const icon=manifest.icons.find(row=>row.sizes===`${size}x${size}`&&row.purpose===purpose);assert(icon);
    const png=await readFile('public'+icon.src);assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size);
  }
  assert.deepEqual(manifest.shortcuts.map(item=>item.url),['/login/team','/login/client']);
});
test('install instructions distinguish installed apps, iOS, unsupported and embedded browsers',()=>{
  const ios=installContext({isSecureContext:true,navigator:{userAgent:'iPhone Safari',standalone:false}});assert(ios.ios);assert(installationSteps(ios).some(step=>step.includes('Safari')));
  const installed=installContext({isSecureContext:true,navigator:{standalone:true}});assert(installed.installed);
  const android=installContext({navigator:{userAgent:'Android Chrome'}});assert(installationSteps(android).some(step=>step.includes('فایل نصب اندروید')));assert(!installationSteps(android).some(step=>step.includes('صفحهٔ اصلی')));
  const firefox=installContext({navigator:{userAgent:'Firefox'}});assert(installationSteps(firefox)[0].includes('Chrome'));
  const embedded=installContext({navigator:{userAgent:'Android Telegram'}});assert(installationSteps(embedded)[0].includes('Chrome'));assert(installationSteps(embedded)[0].includes('فایل نصب اندروید'));
  assert(installationSteps(installContext({navigator:{userAgent:'iPhone Telegram'}}))[0].includes('مرورگر داخلی'));
});
test('Android download is an APK and native Android never registers a worker or mounts another installer',async()=>{
  assert.equal(ANDROID_APP_DOWNLOAD,'/downloads/arios-android.apk');
  const calls=[],scope={isSecureContext:true,location:{protocol:'https:',hostname:'arioshub.ir'},navigator:{userAgent:'Mozilla/5.0 (Linux; Android 14) AriosAndroid/1',serviceWorker:{register:async(...args)=>{calls.push(args);}}},document:{body:{}}};
  assert.equal(installContext(scope).native,true);assert.equal(await registerAppWorker(scope),null);assert.equal(mountInstaller(scope),null);assert.deepEqual(calls,[]);
  const samsung=installContext({isSecureContext:true,navigator:{userAgent:'Mozilla/5.0 (Linux; Android 14; SM-S918B) SamsungBrowser/26.0',standalone:true}});assert.equal(samsung.android,true);assert.equal(samsung.native,false);assert.equal(samsung.installed,true);
});
test('root worker registration uses no cache and never blocks unsupported or insecure contexts',async()=>{
  const calls=[],register=async(...args)=>{calls.push(args);return {scope:'https://arioshub.ir/'};};
  assert.equal(await registerAppWorker({isSecureContext:false,navigator:{serviceWorker:{register}}}),null);
  assert.equal(await registerAppWorker({isSecureContext:true,location:{protocol:'http:',hostname:'example.test'},navigator:{serviceWorker:{register}}}),null);
  await registerAppWorker({isSecureContext:true,location:{protocol:'https:',hostname:'arioshub.ir'},navigator:{serviceWorker:{register}}});
  assert.deepEqual(calls,[['/sw.js',{scope:'/',updateViaCache:'none'}]]);
});
async function workerFixture(){
  const handlers=new Map(),added=[],removed=[],stored=new Map();let offline=false,fetches=0;
  const cache={add:async request=>{assert.equal(request.credentials,'omit');added.push(new URL(request.url).pathname);stored.set(new URL(request.url).pathname,new Response('PUBLIC OFFLINE ASSET'));}};
  class LocalRequest extends Request{constructor(input,init){super(new URL(input,'https://arioshub.ir'),init);}}
  const context={URL,Request:LocalRequest,Response,Promise,self:{location:{origin:'https://arioshub.ir'},addEventListener:(type,handler)=>handlers.set(type,handler),skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>cache,keys:async()=>['arios-public-shell-v0','unrelated-cache'],delete:async key=>{removed.push(key);return true;},match:async path=>stored.get(path)},fetch:async request=>{fetches++;if(offline)throw Error('Offline');return new Response('PRIVATE ACCOUNT HTML');}};
  vm.runInNewContext(await readFile('web/sw.js','utf8'),context);
  const dispatch=async(type,request)=>{let promise;handlers.get(type)({request,waitUntil:p=>promise=p,respondWith:p=>promise=p});return promise?await promise:null;};
  return {added,removed,stored,dispatch,setOffline:value=>offline=value,get fetches(){return fetches;}};
}
test('worker caches only public offline assets with omitted credentials and cleans only its own cache',async()=>{
  const f=await workerFixture();await f.dispatch('install');assert.deepEqual(f.added,['/offline.html','/offline.css','/assets/brand/app-icon-navy-gold-192.png']);
  await f.dispatch('activate');assert.deepEqual(f.removed,['arios-public-shell-v0']);
});
test('API/auth/cross-origin/write requests never enter the worker, and private navigations are never cached',async()=>{
  const f=await workerFixture();await f.dispatch('install');const original=f.added.length;
  const request=(url,{method='GET',auth=false,mode='navigate'}={})=>({url,method,mode,headers:new Headers(auth?{authorization:'Bearer private'}:{})});
  for(const req of [request('https://arioshub.ir/api/session'),request('https://arioshub.ir/api/passkeys/register/verify',{method:'POST'}),request('https://arioshub.ir/portal/',{auth:true}),request('https://other.example/portal/'),request('https://arioshub.ir/portal/',{method:'POST'})])assert.equal(await f.dispatch('fetch',req),null);
  const account=await f.dispatch('fetch',request('https://arioshub.ir/portal/#finance'));assert.equal(await account.text(),'PRIVATE ACCOUNT HTML');assert.equal(f.added.length,original);
  f.setOffline(true);const fallback=await f.dispatch('fetch',request('https://arioshub.ir/portal/'));assert.equal(await fallback.clone().text(),'PUBLIC OFFLINE ASSET');assert(!await fallback.text().then(text=>text.includes('PRIVATE')));
  const css=await f.dispatch('fetch',request('https://arioshub.ir/offline.css',{mode:'no-cors'}));assert.equal(await css.text(),'PUBLIC OFFLINE ASSET');assert.equal(f.added.length,original);
});
test('shared install and worker assets stay identical for public and portal builds',async()=>{
  for(const name of ['install.mjs','install.css','sw.js','offline.html','offline.css'])assert.equal(await readFile('web/'+name,'utf8'),await readFile('public/'+name,'utf8'),name);
});
