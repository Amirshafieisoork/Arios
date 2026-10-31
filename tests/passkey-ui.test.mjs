import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {creationOptionsFromJSON,requestOptionsFromJSON,credentialJSON,decodeBase64URL,encodeBase64URL,loginWithPasskey,registerPasskey,mountPasskeyLogin,passkeySupport,passkeyMessage,preparePasskeyRegistration,passkeyDeviceHelp} from '../public/passkey-client.mjs';
import {renderPasskeySettings,wirePasskeySettings,passkeyDeviceHTML,nativeBiometricApp} from '../public/passkey-settings.mjs';

const b64=value=>Buffer.from(value).toString('base64url');
const bytes=value=>new Uint8Array(value).buffer;
const challenge=b64([1,2,3,4]),userID=b64([9,8,7]);
const creation={challenge,rp:{id:'arioshub.ir',name:'آریوس'},user:{id:userID,name:'private-auth-id',displayName:'عضو'},pubKeyCredParams:[{type:'public-key',alg:-7}],excludeCredentials:[{type:'public-key',id:b64([6,5])}],authenticatorSelection:{residentKey:'preferred',userVerification:'preferred'}};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const options=value=>({challenge_id:'same-native-challenge',options:value,expires_at:Math.floor(Date.now()/1000)+120});
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const context=()=>({e:esc,date:value=>value,api:{isStatic:false},modal:()=>{},toast:()=>{}});
function element(extra={}){return {disabled:false,hidden:false,textContent:'',innerHTML:'',dataset:{},attributes:{},events:{},addEventListener(type,callback){this.events[type]=callback;},setAttribute(name,value){this.attributes[name]=value;},...extra};}
function fakeScope({create,get,...extra}={}){return {isSecureContext:true,location:{hostname:'arioshub.ir'},PublicKeyCredential:class {},navigator:{credentials:{create:create||(async()=>null),get:get||(async()=>null)}},...extra};}
function credential(type='registration'){
  return {id:b64([10,11]),rawId:bytes([10,11]),type:'public-key',authenticatorAttachment:'platform',getClientExtensionResults:()=>({credProps:{rk:true}}),response:type==='registration'?{clientDataJSON:bytes([1,2]),attestationObject:bytes([3,4]),getTransports:()=>['internal']}:{clientDataJSON:bytes([5,6]),authenticatorData:bytes([7,8]),signature:bytes([9,10]),userHandle:bytes([9,8,7])}};
}
async function flush(){for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));}

test('browser options decode binary values and require verified discoverable registration compatible with phone credential managers without altering native challenge',()=>{
  const original=structuredClone(creation),scope=fakeScope();
  const parsed=creationOptionsFromJSON(creation,scope);
  assert.deepEqual([...new Uint8Array(parsed.challenge)],[1,2,3,4]);
  assert.deepEqual([...new Uint8Array(parsed.user.id)],[9,8,7]);
  assert.deepEqual([...new Uint8Array(parsed.excludeCredentials[0].id)],[6,5]);
  assert.deepEqual(parsed.authenticatorSelection,{residentKey:'required',userVerification:'required',requireResidentKey:true});
  assert.deepEqual(creation,original);
  const assertion=requestOptionsFromJSON({challenge,allowCredentials:[{id:b64([6,5]),type:'public-key'}],userVerification:'preferred'},scope);
  assert.equal(assertion.userVerification,'required');assert.equal(encodeBase64URL(assertion.challenge),challenge);
  assert.deepEqual([...new Uint8Array(decodeBase64URL(b64([255,0,254])))],[255,0,254]);
  assert.equal(encodeBase64URL(new Uint8Array([9,255,1]).subarray(1,2)),b64([255]));
});

test('native browser JSON helpers are used when supported and assertion fallback includes user handle and transports',()=>{
  const calls=[],scope=fakeScope();
  scope.PublicKeyCredential.parseCreationOptionsFromJSON=value=>{calls.push('create');return {...value,challenge:bytes([1]),user:{...value.user,id:bytes([9])}};};
  scope.PublicKeyCredential.parseRequestOptionsFromJSON=value=>{calls.push('get');return {...value,challenge:bytes([2])};};
  assert.equal(creationOptionsFromJSON(creation,scope).authenticatorSelection.userVerification,'required');
  assert.equal(requestOptionsFromJSON({challenge},scope).userVerification,'required');assert.deepEqual(calls,['create','get']);
  const registered=credentialJSON(credential());assert.equal(registered.response.attestationObject,b64([3,4]));assert.deepEqual(registered.response.transports,['internal']);
  const signed=credentialJSON(credential('authentication'));assert.equal(signed.response.userHandle,userID);assert.equal(signed.response.signature,b64([9,10]));
  const native={...credential(),toJSON:()=>({id:'native-serialized',type:'public-key',response:{clientDataJSON:'AQ'}})};
  assert.equal(credentialJSON(native).id,'native-serialized');
});

test('registration performs one explicit browser creation and sends native credential only through same-origin HttpOnly session requests',async()=>{
  const calls=[],ceremonies=[];
  const scope=fakeScope({create:async value=>{ceremonies.push(value);return credential();}});
  const fetcher=async(url,init)=>{calls.push({url,init});return json(url.endsWith('/options')?options(creation):{passkey:{id:'passkey-1',friendly_name:'گوشی'}});};
  const result=await registerPasskey({scope,fetcher});assert.equal(result.passkey.id,'passkey-1');assert.equal(ceremonies.length,1);
  assert.deepEqual(calls.map(call=>call.url),['/api/passkeys/register/options','/api/passkeys/register/verify']);
  assert(calls.every(call=>call.init.credentials==='same-origin'&&call.init.cache==='no-store'));
  assert.deepEqual(JSON.parse(calls[0].init.body),{});
  const verified=JSON.parse(calls[1].init.body);assert.deepEqual(Object.keys(verified).sort(),['challengeId','credential']);assert.equal(verified.challengeId,'same-native-challenge');
  assert.equal(verified.credential.response.attestationObject,b64([3,4]));
  assert(!calls.some(call=>JSON.stringify(call.init).includes('password')));
});

test('passkey login is discoverable, requires device verification and trusts only verified server account and portal',async()=>{
  const calls=[],ceremonies=[],scope=fakeScope({get:async value=>{ceremonies.push(value);return credential('authentication');}});
  const fetcher=async(url,init)=>{calls.push({url,init});return json(url.endsWith('/options')?options({challenge,rpId:'arioshub.ir'}):{user:{id:'verified-account',role:'accountant'},portal:'team'});};
  const result=await loginWithPasskey({portal:'client',scope,fetcher});assert.equal(result.user.role,'accountant');assert.equal(result.portal,'team');assert.equal(ceremonies[0].publicKey.userVerification,'required');
  assert.equal(calls.length,2);assert.deepEqual(JSON.parse(calls[0].init.body),{portal:'client'});
  assert.deepEqual(Object.keys(JSON.parse(calls[1].init.body)).sort(),['challengeId','credential','portal']);
  assert(!JSON.stringify(calls).includes('identifier'));assert(!JSON.stringify(calls).includes('Authorization'));
});

test('cancelled, expired and invalid ceremonies never send an authentication verification or navigate',async()=>{
  const calls=[];
  await assert.rejects(loginWithPasskey({scope:fakeScope({get:async()=>{throw Object.assign(new Error('private browser message'),{name:'NotAllowedError'});}}),fetcher:async(url)=>{calls.push(url);return json(options({challenge}));}}),value=>value.name==='NotAllowedError'&&!passkeyMessage(value).includes('private'));
  assert.deepEqual(calls,['/api/passkeys/login/options']);
  let prompted=false;
  await assert.rejects(registerPasskey({scope:fakeScope({create:async()=>{prompted=true;}}),fetcher:async()=>json({...options(creation),expires_at:1})}),value=>value.code==='PASSKEY_CHALLENGE_MISMATCH');assert.equal(prompted,false);
  await assert.rejects(loginWithPasskey({scope:fakeScope({get:async()=>null}),fetcher:async()=>json(options({challenge}))}),value=>value.code==='PASSKEY_CANCELLED');
});

test('unsupported or noncanonical origins leave password entry untouched and never start passkey requests',()=>{
  const button=element(),status=element(),canonical=element(),password=element({value:'existing-password',disabled:false}),nodes={'[data-passkey-login]':button,'[data-passkey-login-status]':status,'[data-passkey-canonical]':canonical};
  let requested=false;const scope=fakeScope({isSecureContext:false,document:{querySelector:selector=>nodes[selector]}});
  mountPasskeyLogin({scope,fetcher:()=>{requested=true;}});assert.equal(button.disabled,true);assert.equal(requested,false);assert.match(status.textContent,/مرورگر|دستگاه/);assert.equal(password.value,'existing-password');assert.equal(password.disabled,false);
  scope.isSecureContext=true;scope.location.hostname='arios-rouge.vercel.app';mountPasskeyLogin({scope,fetcher:()=>{requested=true;}});assert.equal(requested,false);assert.equal(canonical.hidden,false);assert.equal(passkeySupport(scope).code,'PASSKEY_WRONG_DOMAIN');
});

test('login button waits for provider readiness and sends no prompt or verify while native passkeys are disabled',async()=>{
  const button=element(),status=element(),canonical=element(),calls=[];
  const scope=fakeScope({document:{querySelector:selector=>({'[data-passkey-login]':button,'[data-passkey-login-status]':status,'[data-passkey-canonical]':canonical}[selector])},get:async()=>{throw Error('Must not prompt');}});
  mountPasskeyLogin({scope,fetcher:async url=>{calls.push(url);return json({enabled:false,domainSupported:true});}});await flush();
  assert.equal(button.disabled,true);assert.match(status.textContent,/هنوز فعال نشده/);assert.deepEqual(calls,['/api/passkeys/status']);await button.events.click();assert.equal(calls.length,1);
});

test('settings are available to each authenticated role and escape authenticator metadata',()=>{
  const ctx=context();for(const role of ['manager','worker','customer','warehouse','accountant'])assert(renderPasskeySettings({user:{id:'own-account',role}},ctx).includes('data-passkey-register'));
  assert.equal(renderPasskeySettings({user:null},ctx),'');
  const html=passkeyDeviceHTML([{id:'own-key',friendly_name:'<img src=x onerror=alert(1)>',created_at:'2026-10-27T00:00:00Z'}],ctx);
  assert(!html.includes('<img'));assert(html.includes('&lt;img'));assert(html.includes('data-passkey-remove="own-key"'));
});

test('native Android presentation uses only the app lock and never invokes browser credentials',()=>{
  const scope={navigator:{userAgent:'Mozilla Android AriosAndroid/1.0'},document:{querySelector(){assert.fail('Native app must not mount browser key management');}}};
  assert(nativeBiometricApp(scope));assert(!nativeBiometricApp({navigator:{userAgent:'Android Chrome/1'}}));
  const html=renderPasskeySettings({user:{id:'person',role:'worker'}},context(),{scope});
  assert(html.includes('native-biometric-settings'));assert(!html.includes('data-passkey-register'));assert(!html.includes('data-passkey-browser-settings'));
  wirePasskeySettings({user:{id:'person',role:'worker'}},context(),{scope,fetcher:()=>assert.fail('Native lock cannot use browser credential endpoints')});
});

test('closed optional browser-key settings issue no challenge or list requests until explicitly opened',async()=>{
  const enroll=element(),reload=element(),status=element(),devices=element(),disclosure=element({open:false}),root=element({dataset:{passkeySettingsUser:'own-account'},isConnected:true});
  root.querySelector=selector=>({'[data-passkey-register]':enroll,'[data-passkey-reload]':reload,'[data-passkey-settings-status]':status,'[data-passkey-devices]':devices,'[data-passkey-browser-settings]':disclosure}[selector]);root.querySelectorAll=()=>[];
  const calls=[],scope=fakeScope({document:{querySelector:()=>root}});
  wirePasskeySettings({user:{id:'own-account',role:'worker'}},context(),{scope,fetcher:async url=>{calls.push(url);return url.endsWith('/status')?json({enabled:false,domainSupported:true}):json({passkeys:[]});}});
  await flush();assert.deepEqual(calls,[]);
  disclosure.open=true;disclosure.events.toggle();await flush();assert.deepEqual(calls.sort(),['/api/passkeys','/api/passkeys/status']);
  disclosure.open=false;disclosure.events.toggle();disclosure.open=true;disclosure.events.toggle();await flush();assert.equal(calls.length,2);
});

test('own-key rename and deletion use confirmed modal actions and send no account identity',async()=>{
  const enroll=element(),reload=element(),status=element(),devices=element(),rename=element({dataset:{passkeyRename:'key-1'}}),remove=element({dataset:{passkeyRemove:'key-1'}}),root=element({dataset:{passkeySettingsUser:'own-account'},isConnected:true});
  root.querySelector=selector=>({'[data-passkey-register]':enroll,'[data-passkey-reload]':reload,'[data-passkey-settings-status]':status,'[data-passkey-devices]':devices}[selector]);
  root.querySelectorAll=selector=>selector==='[data-passkey-rename]'?[rename]:selector==='[data-passkey-remove]'?[remove]:[];
  const scope=fakeScope({document:{querySelector:()=>root}}),calls=[],modals=[];let keys=[{id:'key-1',friendly_name:'<device>',created_at:'2026-10-27T00:00:00Z'}];
  const fetcher=async(url,init)=>{calls.push({url,init});if(url.endsWith('/status'))return json({enabled:true,domainSupported:true});if(url==='/api/passkeys')return json({passkeys:keys});if(url.endsWith('/rename')){keys=[{...keys[0],friendly_name:JSON.parse(init.body).name}];return json({passkey:keys[0]});}if(url.endsWith('/remove')){keys=[];return json({ok:true});}throw Error(url);};
  const ctx={...context(),modal:value=>modals.push(value)};
  wirePasskeySettings({user:{id:'own-account',role:'worker'}},ctx,{scope,fetcher});await flush();assert(devices.innerHTML.includes('&lt;device&gt;'));
  await rename.events.click();assert.equal(modals.length,1);await modals[0].onSubmit({get:()=> 'گوشی من'});assert.deepEqual(JSON.parse(calls.find(call=>call.url.endsWith('/rename')).init.body),{id:'key-1',name:'گوشی من'});
  await remove.events.click();assert.equal(modals.length,2);assert.match(modals[1].body,/رمز عبور/);assert.equal(calls.filter(call=>call.url.endsWith('/remove')).length,0);
  await modals[1].onSubmit();assert.deepEqual(JSON.parse(calls.find(call=>call.url.endsWith('/remove')).init.body),{id:'key-1'});assert(devices.innerHTML.includes('هنوز کلید'));
  assert(!JSON.stringify(calls).includes('own-account'));
});

test('an account switch while a list request is pending cannot paint previous-account passkey metadata',async()=>{
  const enroll=element(),reload=element(),status=element(),devices=element(),root=element({dataset:{passkeySettingsUser:'old-account'},isConnected:true});
  root.querySelector=selector=>({'[data-passkey-register]':enroll,'[data-passkey-reload]':reload,'[data-passkey-settings-status]':status,'[data-passkey-devices]':devices}[selector]);root.querySelectorAll=()=>[];
  let resolveList;const pending=new Promise(resolve=>resolveList=resolve),scope=fakeScope({document:{querySelector:()=>root}});
  wirePasskeySettings({user:{id:'old-account',role:'worker'}},context(),{scope,fetcher:async url=>url.endsWith('/status')?json({enabled:true,domainSupported:true}):pending});
  root.dataset.passkeySettingsUser='new-account';resolveList(json({passkeys:[{id:'old-key',friendly_name:'private-old-device'}]}));await flush();assert.equal(devices.innerHTML,'');assert(!status.textContent.includes('private-old-device'));
});

test('web and portal clients remain identical, with no password storage and passkey styling before readability overrides',async()=>{
  const [web,portal,login,index]=await Promise.all(['web/passkey-client.mjs','public/passkey-client.mjs','web/login.html','public/index.html'].map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')));
  assert.equal(web,portal);assert(!/localStorage|sessionStorage/.test(web));assert(login.includes('data-passkey-login'));assert(login.indexOf('/passkeys.css')<login.indexOf('/typography.css'));assert(index.indexOf('./passkeys.css')<index.indexOf('./typography.css'));
});


test('prepared enrollment starts the browser ceremony synchronously in the activation click, without awaiting the network',async()=>{
  const events=[],scope=fakeScope({create:async()=>{events.push('browser-create');return credential();}});
  const prepared=options(creation),fetcher=async(url)=>{events.push(url);return json({passkey:{id:'saved'}});};
  const pending=registerPasskey({scope,fetcher,start:prepared});
  assert.deepEqual(events,['browser-create']);
  await pending;assert.deepEqual(events,['browser-create','/api/passkeys/register/verify']);
});

test('prepared login preserves the user activation and never creates an unverified account session',async()=>{
  const events=[],scope=fakeScope({get:async()=>{events.push('browser-get');return credential('authentication');}});
  const pending=loginWithPasskey({scope,start:options({challenge}),fetcher:async url=>{events.push(url);return json({user:{role:'worker'},portal:'team'});}});
  assert.deepEqual(events,['browser-get']);await pending;assert.deepEqual(events,['browser-get','/api/passkeys/login/verify']);
});

test('device guidance explains embedded browsers and local phone setup without claiming to read biometric data',()=>{
  assert.match(passkeyDeviceHelp(fakeScope({navigator:{userAgent:'Android; wv)'}})),/Chrome.*Safari/);
  assert.match(passkeyDeviceHelp(fakeScope({navigator:{userAgent:'iPhone'}})),/iCloud/);
  assert.match(passkeyDeviceHelp(fakeScope({navigator:{userAgent:'Android'}})),/Google/);
  assert.match(passkeyMessage({code:'PASSKEY_ALREADY_REGISTERED'}),/قبلاً ثبت/);
});


test('ordinary login never launches passkey creation and browser keys stay an explicit optional method',async()=>{
  const [settings,login,html]=await Promise.all(['public/passkey-settings.mjs','web/login.mjs','web/login.html'].map(file=>readFile(new URL('../'+file,import.meta.url),'utf8')));
  assert.match(settings,/https:\/\/arioshub\.ir\/login\/.*\?setup=passkey/);
  assert(!login.includes('offerPasskeySetupAfterLogin'));
  assert(!login.includes('passkeyChoice'));
  assert.match(login,/setupPasskey\?'settings':landingPage\(role\)/);
  assert(!html.includes('id="login-enable-passkey"'));
  assert(html.includes('<details class="passkey-login">'));
  assert(html.includes('ورود با گذرکلید موجود'));
  assert(html.includes('href="/downloads/arios-android.apk"'));
  assert.match(login,/nativeGuide\.hidden=true/);
});

test('same-device recovery remains discoverable and verified, while default creation can still use another provider',()=>{
  const regular=creationOptionsFromJSON(creation,fakeScope()),local=creationOptionsFromJSON(creation,fakeScope(),{preferLocal:true});
  assert.equal(regular.authenticatorSelection.authenticatorAttachment,undefined);
  assert.equal(local.authenticatorSelection.authenticatorAttachment,'platform');
  for(const options of [regular,local]){assert.equal(options.authenticatorSelection.residentKey,'required');assert.equal(options.authenticatorSelection.userVerification,'required');assert.deepEqual(options.hints,['client-device']);}
  assert.match(passkeyDeviceHelp(fakeScope({navigator:{userAgent:'Android'}})),/رمز آریوس.*PIN/);
  assert.match(passkeyMessage({code:'PASSWORD_CHANGE_REQUIRED'}),/رمز اولیه/);
});

test('registration progress distinguishes local credential creation from server persistence and carries cancellation',async()=>{
  const events=[],controller=new AbortController();let resolveCreate;
  const scope=fakeScope({create:options=>{events.push('browser-create');assert.equal(options.signal,controller.signal);assert.equal(options.publicKey.authenticatorSelection.authenticatorAttachment,'platform');return new Promise(resolve=>resolveCreate=resolve);}});
  const pending=registerPasskey({scope,start:options(creation),preferLocal:true,signal:controller.signal,onStage:stage=>events.push(stage),fetcher:async url=>{events.push(url);return json({passkey:{id:'saved'}});}});
  assert.deepEqual(events,['device','browser-create']);resolveCreate(credential());await pending;
  assert.deepEqual(events,['device','browser-create','verifying','/api/passkeys/register/verify']);
});

test('near-expired login is prepared again without losing Safari activation to a late network await',async()=>{
  const button=element(),status=element(),calls=[],events=[];let issued=0;
  const scope=fakeScope({document:{querySelector:selector=>({'[data-passkey-login]':button,'[data-passkey-login-status]':status}[selector])},get:async()=>{events.push('get');return credential('authentication');}});
  mountPasskeyLogin({scope,onSuccess:()=>events.push('success'),fetcher:async url=>{calls.push(url);if(url.endsWith('/status'))return json({enabled:true,domainSupported:true});if(url.endsWith('/options'))return json({...options({challenge}),expires_at:Math.floor(Date.now()/1000)+(issued++===0?2:120)});return json({user:{role:'worker'},portal:'team'});}});
  await flush();assert.equal(button.disabled,false);await button.events.click();assert.deepEqual(events,[]);assert.match(status.textContent,/دوباره دکمه/);assert.equal(button.disabled,false);
  const clicked=button.events.click();assert.deepEqual(events,['get']);await clicked;assert.deepEqual(events,['get','success']);
  assert.equal(calls.filter(url=>url.endsWith('/login/verify')).length,1);
});
