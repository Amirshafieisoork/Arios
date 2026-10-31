import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {authenticate,changeOwnPassword,createAccount,markPasswordChangeRequired,passwordLogin} from '../supabase/functions/arios-api/auth.mjs';
import {createSeedState} from '../public/domain.mjs';

const built=await build({entryPoints:[resolve('supabase/functions/arios-api/index.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node24',plugins:[{name:'native-client-test',setup(b){b.onResolve({filter:/^npm:@supabase\/supabase-js@/},()=>({path:'test',namespace:'native-client-test'}));b.onLoad({filter:/.*/,namespace:'native-client-test'},()=>({contents:'export function createClient(){throw Error("Inject test client");}',loader:'js'}));}}]});
const {createHandler}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const AUTH_ID='11111111-1111-4111-8111-111111111111',OLD_SESSION='22222222-2222-4222-8222-222222222222',PROOF_SESSION='33333333-3333-4333-8333-333333333333',NEW_SESSION='44444444-4444-4444-8444-444444444444';
const jwt=session=>'e30.'+Buffer.from(JSON.stringify({session_id:session})).toString('base64url')+'.signature';
const JSONResponse=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture({phone='+989121234567',initialPassword='09121234567'}={}){
 const state=createSeedState(),user=state.users.find(u=>u.id==='worker');user.phone=phone;
 const settings=new Map([['auth-onboarding:worker',{required:true,version:1,reason:'roster-import'}]]),calls=[],locks=new Map(),sessions=new Map([[OLD_SESSION,'2000-01-01T00:00:00.000Z']]);
 const profile={auth_user_id:AUTH_ID,domain_user_id:'worker',role:'worker'},authUser={id:AUTH_ID,email:'account.worker@phone.arios.invalid',user_metadata:{passwordChangeRequired:false}};
 const repo={loadState:async()=>({state:structuredClone(state),revision:1}),getProfile:async id=>id===AUTH_ID?structuredClone(profile):null,getProfileByDomainId:async id=>id==='worker'?structuredClone(profile):null,getSetting:async key=>structuredClone(settings.get(key)??null),setSetting:async(key,value)=>{settings.set(key,structuredClone(value));},deleteSetting:async key=>settings.delete(key),rateLimit:async()=>({allowed:true}),acquireLock:async(name,token)=>{if(locks.has(name))return false;locks.set(name,token);return true;},releaseLock:async(name,token)=>{if(locks.get(name)===token)locks.delete(name);},authSessionValid:async(id,session,after)=>id===AUTH_ID&&sessions.has(session)&&Date.parse(sessions.get(session))>Date.parse(after)};
 const client={auth:{getUser:async token=>({data:{user:authUser}})}};
 let password=initialPassword;
 const fetcher=async(url,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({url,method:options.method,body});assert.equal(options.redirect,'manual');assert.equal(options.headers.apikey,'server-test-key');
  if(url.endsWith('/token?grant_type=password')){assert.equal(body.email,authUser.email);if(body.password!==password)return JSONResponse({error_code:'invalid_credentials'},400);const id=body.password===initialPassword?PROOF_SESSION:NEW_SESSION;sessions.set(id,new Date(Date.now()+1).toISOString());return JSONResponse({user:authUser,access_token:jwt(id),refresh_token:'private-refresh-'+id,expires_in:3600});}
  if(url.endsWith('/user')){assert.equal(options.method,'PUT');assert.equal(options.headers.Authorization,'Bearer '+jwt(PROOF_SESSION));assert.equal(body.current_password,password);password=body.password;return JSONResponse(authUser);}
  if(url.includes('/logout?scope=global')){sessions.clear();return new Response(null,{status:204});}
  if(url.includes('/logout?scope=local')){sessions.delete(PROOF_SESSION);return new Response(null,{status:204});}
  throw Error('Unexpected provider request');
 };
 const change=payload=>changeOwnPassword({client,repo,user:{...user,passwordChangeRequired:true},authUser,payload,authUrl:'https://test-project.supabase.co',authKey:'server-test-key',fetcher});
 const handler=createHandler({client,repo,env:{SUPABASE_URL:'https://test-project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-test-key'},fetcher});
 const request=(path,body)=>new Request('https://test-project.supabase.co/functions/v1/arios-api'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+jwt(OLD_SESSION),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {state,user,profile,authUser,settings,calls,repo,client,fetcher,change,handler,request,sessions};
}

test('first-login gate comes only from private server state and is absent for existing accounts',async()=>{
 const f=fixture();const result=await authenticate(f.request('/session'),f.client,f.repo);assert.equal(result.user.passwordChangeRequired,true);
 f.authUser.user_metadata={passwordChangeRequired:true,role:'manager'};f.settings.clear();const existing=await authenticate(f.request('/session'),f.client,f.repo);assert.equal(existing.user.passwordChangeRequired,false);assert.equal(existing.user.role,'worker');
});
test('required accounts can read only their own minimal session and every business route is gated first',async()=>{
 const f=fixture();const session=await f.handler(f.request('/session'));assert.equal(session.status,200);const data=await session.json();assert.equal(data.passwordChangeRequired,true);assert.equal(data.user.passwordChangeRequired,true);assert(!('projects'in data));assert(!JSON.stringify(data).includes('phone.arios.invalid'));assert.equal(f.calls.length,0);
 for(const[path,body]of[['/state'],['/actions',{action:'message.send',payload:{}}],['/voice'],['/voice/text',{text:'secret'}],['/project-files/upload-url',{}],['/backups/recovery-key',{}],['/telegram/link',{}],['/reminders/settings',{}],['/assistant',{}],['/integrations',{}],['/leads']]){const response=await f.handler(f.request(path,body));assert.equal(response.status,403,path);assert.equal((await response.json()).code,'PASSWORD_CHANGE_REQUIRED',path);}assert.equal(f.calls.length,0);
});
test('native proof, update and fresh login clear gate while all older JWT session ids are denied',async()=>{
 const f=fixture(),result=await f.change({currentPassword:'09121234567',newPassword:'my-fresh-code'});assert.equal(result.ok,true);assert.equal(result.passwordChangeRequired,false);assert.equal(result.access_token,jwt(NEW_SESSION));assert.equal(result.user.passwordChangeRequired,false);assert.equal(f.settings.get('auth-onboarding:worker').required,false);assert(f.settings.get('auth-security:worker').validAfter);assert.equal(await f.repo.authSessionValid(AUTH_ID,PROOF_SESSION,'2000-01-01'),false);
 assert(!JSON.stringify([...f.settings]).includes('my-fresh-code'));assert(!JSON.stringify([...f.settings]).includes('09121234567'));
 await assert.rejects(authenticate(f.request('/state'),f.client,f.repo),e=>e.code==='INVALID_SESSION');
 const fresh=new Request('https://app.test',{headers:{Authorization:'Bearer '+result.access_token}});assert.equal((await authenticate(fresh,f.client,f.repo)).user.passwordChangeRequired,false);
});
test('wrong current password, unchanged password and contact-number variants cannot clear gate',async()=>{
 const f=fixture();await assert.rejects(f.change({currentPassword:'wrong123',newPassword:'my-new-password'}),e=>e.code==='CURRENT_PASSWORD_INVALID');assert.equal(f.calls.filter(c=>c.url.endsWith('/user')).length,0);
 for(const newPassword of ['09121234567','+989121234567','۰۹۱۲۱۲۳۴۵۶۷','0912-123-4567'])await assert.rejects(f.change({currentPassword:'09121234567',newPassword}));
 assert.equal(f.settings.get('auth-onboarding:worker').required,true);
});
test('Persian digits are accepted for imported temporary phone passwords without changing arbitrary chosen passwords',async()=>{
 const f=fixture();await passwordLogin({client:{auth:{admin:{getUserById:async()=>({data:{user:f.authUser}})}}},repo:f.repo,payload:{phone:'۰۹۱۲۱۲۳۴۵۶۷',password:'۰۹۱۲۱۲۳۴۵۶۷'},authUrl:'https://test-project.supabase.co',authKey:'server-test-key',fetcher:f.fetcher});assert.equal(f.calls[0].body.password,'09121234567');
 await f.change({currentPassword:'۰۹۱۲۱۲۳۴۵۶۷',newPassword:'رمز-تازه-۱۲۳۴'});assert(f.calls.some(c=>c.url.endsWith('/user')&&c.body.password==='رمز-تازه-۱۲۳۴'));assert.equal(f.settings.get('auth-onboarding:worker').required,false);
});
test('provider update errors and uncertain updates preserve required gate and clean native proof session',async()=>{
 for(const kind of ['rejected','network','redirect']){const f=fixture(),native=f.fetcher;const fetcher=async(url,options)=>url.endsWith('/user')?kind==='rejected'?JSONResponse({error:'weak'},422):kind==='redirect'?new Response(null,{status:302,headers:{Location:'https://other.test'}}):Promise.reject(Error('unavailable')):native(url,options);
 await assert.rejects(changeOwnPassword({client:f.client,repo:f.repo,user:f.user,authUser:f.authUser,payload:{currentPassword:'09121234567',newPassword:'new-code-123'},authUrl:'https://test-project.supabase.co',authKey:'server-test-key',fetcher}));assert.equal(f.settings.get('auth-onboarding:worker').required,true);assert(!f.sessions.has(PROOF_SESSION));}
});
test('personnel-code login with an incomplete saved contact accepts Persian temporary digits but still requires a different password',async()=>{
 const f=fixture({phone:'0912123456',initialPassword:'0912123456'});f.user.username='100001';
 const client={auth:{admin:{getUserById:async()=>({data:{user:f.authUser}})}}};
 await passwordLogin({client,repo:f.repo,payload:{username:'۱۰۰۰۰۱',password:'۰۹۱۲۱۲۳۴۵۶'},authUrl:'https://test-project.supabase.co',authKey:'server-test-key',fetcher:f.fetcher});
 assert.equal(f.calls[0].body.password,'0912123456');
 await assert.rejects(f.change({currentPassword:'۰۹۱۲۱۲۳۴۵۶',newPassword:'0912123456'}),error=>error.code==='PASSWORD_IS_PHONE');
 const result=await f.change({currentPassword:'۰۹۱۲۱۲۳۴۵۶',newPassword:'a-personal-password'});
 assert.equal(result.passwordChangeRequired,false);assert.equal(f.user.phone,'0912123456');assert.equal(f.settings.get('auth-onboarding:worker').required,false);
});
test('an incomplete contact never rewrites a chosen password after its private onboarding gate is cleared',async()=>{
 const f=fixture({phone:'0912123456',initialPassword:'0912123456'});f.user.username='100001';f.settings.set('auth-onboarding:worker',{required:false});
 await assert.rejects(passwordLogin({client:{auth:{admin:{getUserById:async()=>({data:{user:f.authUser}})}}},repo:f.repo,payload:{username:'100001',password:'۰۹۱۲۱۲۳۴۵۶'},authUrl:'https://test-project.supabase.co',authKey:'server-test-key',fetcher:f.fetcher}),error=>error.code==='INVALID_CREDENTIALS');
 assert.equal(f.calls[0].body.password,'۰۹۱۲۱۲۳۴۵۶');
});
test('failed fresh login leaves prior JWTs revoked and first-login restriction in place',async()=>{
 const f=fixture(),native=f.fetcher;const fetcher=async(url,options)=>url.endsWith('/token?grant_type=password')&&JSON.parse(options.body).password==='new-code-123'?JSONResponse({error:'unavailable'},503):native(url,options);
 await assert.rejects(changeOwnPassword({client:f.client,repo:f.repo,user:f.user,authUser:f.authUser,payload:{currentPassword:'09121234567',newPassword:'new-code-123'},authUrl:'https://test-project.supabase.co',authKey:'server-test-key',fetcher}));assert.equal(f.settings.get('auth-onboarding:worker').required,true);assert(f.settings.get('auth-security:worker').validAfter);await assert.rejects(authenticate(f.request('/state'),f.client,f.repo),e=>e.code==='INVALID_SESSION');
});
test('new imported accounts have private requirement persisted before Auth profile commit',async()=>{
 const f=fixture(),created=[];f.client.auth.admin={createUser:async()=>({data:{user:{id:AUTH_ID}}}),deleteUser:async()=>({})};f.repo.getProfileByDomainId=async()=>null;
 f.repo.commitAccount=async({state,domainUserId})=>{created.push(domainUserId);assert.equal(f.settings.get('auth-onboarding:'+domainUserId)?.required,true);assert(state.users.some(u=>u.id===domainUserId));return true;};
 const actor=f.state.users.find(u=>u.id==='manager');const result=await createAccount(f.client,f.repo,actor,{name:'همکار واردشده',phone:'09351234567',password:'09351234567',role:'worker',requirePasswordChange:true});assert.equal(created.length,1);assert.equal(result.result.role,'worker');assert(!JSON.stringify([...f.settings]).includes('09351234567'));
});
test('onboarding requirements validate their API input and cannot be disabled by forged password payloads',async()=>{
 const f=fixture();await assert.rejects(f.change({currentPassword:'09121234567',newPassword:'new12345',userId:'manager'}),e=>e.status===400);await assert.rejects(createAccount(f.client,f.repo,{role:'manager',id:'manager'},{requirePasswordChange:'yes',password:'valid123'}),e=>e.status===400);assert.equal(f.calls.length,0);
 const marked=await markPasswordChangeRequired(f.repo,'worker',{reason:'roster-import'});assert.equal(marked.required,true);assert.equal(marked.version,2);
});
