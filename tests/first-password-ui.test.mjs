import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPasswordOnboarding,passwordChangeRequired,passwordChangeURL} from '../web/password-onboarding.mjs';
import {createBff} from '../backend/bff.mjs';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function element(extra={}){return {hidden:false,disabled:false,value:'',type:'password',textContent:'',events:{},attrs:{},addEventListener(type,callback){this.events[type]=callback;},setAttribute(name,value){this.attrs[name]=value;},focus(){this.focused=true;},...extra};}
function fixture({result={ok:true,user:{id:'person',role:'worker'},passwordChangeRequired:false},status=200,search=''}={}){
  const nodes=new Map(),requests=[],locations=[],completed=[];
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);};
  const form=node('#first-password-form');form.hidden=true;form.querySelector=node;
  const scope={document:{querySelector:node},location:{search},history:{replaceState:(...args)=>locations.push(args)},localStorage:{setItem(){assert.fail('No password may enter persistent browser storage');}}};
  const mounted=mountPasswordOnboarding({scope,fetcher:async(url,options)=>{requests.push({url,options});return json(result,status);},onComplete:data=>{completed.push(data);},onLogout:()=>completed.push('logout')});
  const show=()=>mounted.show({user:{id:'person',role:'worker',passwordChangeRequired:true},passwordChangeRequired:true},{temporaryPassword:'temporary-secret'});
  const submit=()=>form.events.submit({preventDefault(){}});
  return {node,form,scope,requests,locations,completed,mounted,show,submit};
}

test('flagged first login shows a required password form and never stores a secret in URL or persistent storage',()=>{
  const f=fixture();assert(f.show());assert.equal(f.form.hidden,false);assert.equal(f.node('#login-form').hidden,true);assert.equal(f.node('.passkey-login').hidden,true);assert.equal(f.node('[name="currentPassword"]').value,'temporary-secret');assert.equal(f.node('[name="newPassword"]').focused,true);
  assert.equal(f.locations[0][2],'/login/team?change=password');assert(!JSON.stringify(f.locations).includes('temporary-secret'));assert.equal(f.requests.length,0);assert.equal(f.completed.length,0);
  assert.equal(passwordChangeRequired({user:{passwordChangeRequired:true}}),true);assert.equal(passwordChangeRequired({passwordChangeRequired:true}),true);assert.equal(passwordChangeRequired({user:{}}),false);assert.equal(passwordChangeURL('customer'),'/login/client?change=password');assert.equal(passwordChangeURL('https://foreign.invalid'),'/login/team?change=password');
});
test('mismatched, short and unchanged passwords cannot advance or submit an update',async()=>{
  const f=fixture();f.show();for(const [password,confirmation]of [['12345','12345'],['new-secret','other-secret'],['temporary-secret','temporary-secret']]){f.node('[name="newPassword"]').value=password;f.node('[name="confirmPassword"]').value=confirmation;await f.submit();assert.equal(f.requests.length,0);assert.equal(f.completed.length,0);assert.equal(f.node('[data-password-change-error]').hidden,false);}
});
test('new password is submitted with same-origin cookies and secrets are cleared before entering the panel',async()=>{
  const f=fixture();f.show();f.node('[name="newPassword"]').value='new-private-password';f.node('[name="confirmPassword"]').value='new-private-password';await f.submit();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/api/account/password');assert.equal(f.requests[0].options.credentials,'same-origin');assert.deepEqual(JSON.parse(f.requests[0].options.body),{currentPassword:'temporary-secret',newPassword:'new-private-password'});assert.equal(f.completed.length,1);assert.equal(f.form.hidden,true);for(const field of ['currentPassword','newPassword','confirmPassword'])assert.equal(f.node('[name="'+field+'"]').value,'');
});
test('update failure or a still-restricted response cannot open the panel and remains retryable',async()=>{
  for(const scenario of [{status:400,result:{error:'رمز فعلی درست نیست.'}},{result:{user:{id:'person',role:'worker'},passwordChangeRequired:true}},{result:{user:{id:'somebody-else',role:'worker'},passwordChangeRequired:false}}]){
    const f=fixture(scenario);f.show();f.node('[name="newPassword"]').value='new-private-password';f.node('[name="confirmPassword"]').value='new-private-password';await f.submit();assert.equal(f.completed.length,0);assert.equal(f.form.hidden,false);assert.equal(f.node('[type="submit"]').disabled,false);assert.equal(f.node('[data-password-change-error]').attrs.role,'alert');
  }
});
test('refreshing a restricted login resumes using trusted session and logs out without retaining password fields',async()=>{
  const f=fixture({search:'?change=password',result:{user:{id:'person',role:'customer'},passwordChangeRequired:true}});assert.equal(await f.mounted.resume(),true);assert.equal(f.requests[0].url,'/api/session');assert.equal(f.form.hidden,false);assert.equal(f.node('[name="currentPassword"]').value,'');assert.equal(f.locations[0][2],'/login/client?change=password');f.node('[name="newPassword"]').value='private-new-secret';await f.node('[data-password-change-logout]').events.click();assert.equal(f.requests[1].url,'/api/logout');assert.equal(f.node('[name="newPassword"]').value,'');assert.deepEqual(f.completed,['logout']);
  const ordinary=fixture();assert.equal(await ordinary.mounted.resume(),false);assert.equal(ordinary.requests.length,0);assert.equal(ordinary.mounted.show({user:{id:'person'}}),false);
});
test('new password visibility toggle affects all fields accessibly without changing their values',()=>{
  const f=fixture();f.show();const button=f.node('[data-password-change-toggle]');button.events.click({currentTarget:button});assert.equal(button.attrs['aria-pressed'],'true');for(const field of ['currentPassword','newPassword','confirmPassword'])assert.equal(f.node('[name="'+field+'"]').type,'text');button.events.click({currentTarget:button});assert.equal(f.node('[name="currentPassword"]').value,'temporary-secret');assert.equal(f.node('[name="newPassword"]').type,'password');
});

const APP='https://arioshub.ir',SUPABASE='https://qategfabulrkvdckzmqp.supabase.co',env={ARIOS_SUPABASE_URL:SUPABASE,ARIOS_SUPABASE_PUBLISHABLE_KEY:'test-public-key'};
function bffFixture({tokens=true,restricted=false,mismatched=false}={}){
 const calls=[];const handle=createBff({env,fetcher:async(url,options)=>{calls.push({url,options});if(url.endsWith('/account/password'))return json({ok:true,user:{id:'person',role:'worker'},passwordChangeRequired:false,...(tokens?{access_token:'new-access',refresh_token:'new-refresh',expires_in:3600}:{})});if(url.endsWith('/session')){assert.equal(new Headers(options.headers).get('Authorization'),'Bearer new-access');return json({user:{id:mismatched?'other':'person',role:'worker',passwordChangeRequired:restricted},passwordChangeRequired:restricted,authMode:'supabase'});}if(url.endsWith('/logout'))return json({});assert.fail('Unexpected upstream path');}});
 const request=origin=>new Request(APP+'/api/account/password',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin??APP,Cookie:'arios_access=old-access; arios_refresh=old-refresh'},body:JSON.stringify({currentPassword:'temporary-secret',newPassword:'new-private-password'})});
 return {handle,request,calls};
}
test('BFF consumes fresh password-change tokens and verifies membership before emitting HttpOnly cookies',async()=>{
 const f=bffFixture(),response=await f.handle(f.request());assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);assert.equal(body.passwordChangeRequired,false);assert.equal(body.portal,'team');assert(!JSON.stringify(body).includes('new-access'));assert(!JSON.stringify(body).includes('new-refresh'));const cookies=response.headers.getSetCookie();assert.equal(cookies.length,2);assert(cookies.every(value=>value.includes('HttpOnly')&&value.includes('Secure')&&value.includes('SameSite=Lax')));assert(cookies.some(value=>value.startsWith('arios_access=new-access')));assert.equal(f.calls.length,2);
});
test('BFF rejects malformed or still-restricted password-change sessions without leaking tokens or issuing cookies',async()=>{
 for(const options of [{tokens:false},{restricted:true},{mismatched:true}]){const f=bffFixture(options),response=await f.handle(f.request());assert(response.status>=400);const body=await response.json();assert(!JSON.stringify(body).includes('new-access'));assert.deepEqual(response.headers.getSetCookie(),[]);}
 const f=bffFixture(),response=await f.handle(f.request('https://foreign.invalid'));assert.equal(response.status,403);assert.equal(f.calls.length,0);
});
test('nested API aliases and backend-only login cannot bypass the password-change token consumer',async()=>{
 const f=bffFixture();for(const path of ['/api/api/account/password','/api/api/api/account/password','/api/password-login','/api/internal/telegram-tick']){const request=new Request(APP+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:APP,Cookie:'arios_access=old-access; arios_refresh=old-refresh'},body:JSON.stringify({currentPassword:'temporary-secret',newPassword:'new-private-password'})});const response=await f.handle(request);assert.equal(response.status,404,path);assert(!JSON.stringify(await response.json()).includes('new-access'));assert.deepEqual(response.headers.getSetCookie(),[]);}assert.equal(f.calls.length,0);
 const handle=createBff({env,fetcher:async()=>json({access_token:'unexpected-access',refresh_token:'unexpected-refresh'})});const response=await handle(new Request(APP+'/api/unexpected-new-session',{headers:{Cookie:'arios_access=existing-access'}}));assert.equal(response.status,502);assert(!JSON.stringify(await response.json()).includes('unexpected-access'));
});
