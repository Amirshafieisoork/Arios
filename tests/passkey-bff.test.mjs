import test from 'node:test';
import assert from 'node:assert/strict';
import {createBff} from '../backend/bff.mjs';

const APP='https://arioshub.ir',UPSTREAM='https://qategfabulrkvdckzmqp.supabase.co';
const ENV={ARIOS_SUPABASE_URL:UPSTREAM,ARIOS_SUPABASE_PUBLISHABLE_KEY:'public-project-key',NODE_ENV:'production'};
const ID='11653560-1210-4e7b-9652-dc078a828256',CHALLENGE='a688547b-147b-46b0-b8b7-7e2adf1d9ef0';
const TOKEN={access_token:'private-access',refresh_token:'private-refresh',expires_in:3600};
const creation=()=>({challenge_id:CHALLENGE,expires_at:Math.floor(Date.now()/1000)+300,options:{challenge:'YWJjZA',rp:{id:'arioshub.ir',name:'آریوس'},user:{id:'dXNlcg',name:'internal@phone.arios.invalid',displayName:'old-name'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{userVerification:'preferred'},secret:'never-return'}});
const authentication=()=>({challenge_id:CHALLENGE,expires_at:Math.floor(Date.now()/1000)+300,options:{challenge:'YWJjZA',rpId:'arioshub.ir',timeout:120000,secret:'never-return'}});
const authCredential=()=>({id:'Y3JlZGVudGlhbA',rawId:'Y3JlZGVudGlhbA',type:'public-key',response:{clientDataJSON:'YWJjZA',authenticatorData:'YWJjZA',signature:'YWJjZA',userHandle:'dXNlcg'},clientExtensionResults:{},authenticatorAttachment:'platform'});
const registrationCredential=()=>({id:'Y3JlZGVudGlhbA',rawId:'Y3JlZGVudGlhbA',type:'public-key',response:{clientDataJSON:'YWJjZA',attestationObject:'YWJjZA',transports:['internal']},clientExtensionResults:{},authenticatorAttachment:'platform'});
const meta=()=>({id:ID,friendly_name:'گوشی من',created_at:'2026-10-27T00:00:00Z',last_used_at:'2026-10-27T01:00:00Z',public_key:'never-return',auth_user_id:'private-owner'});
const session=(role='worker')=>({user:{id:'staff',name:'همکار',username:'staff-one',role},authMode:'supabase',demo:false,capabilities:{supabaseAuth:true}});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(upstream,env=ENV){
  const calls=[],fetcher=async(url,options={})=>{
    const parsed=new URL(url);assert.equal(parsed.origin,UPSTREAM);assert.equal(options.redirect,'manual');
    const headers=new Headers(options.headers);assert.equal(headers.get('apikey'),ENV.ARIOS_SUPABASE_PUBLISHABLE_KEY);assert.equal(headers.has('cookie'),false);
    const c={path:parsed.pathname+parsed.search,method:options.method,headers,body:options.body===undefined?undefined:JSON.parse(options.body)};calls.push(c);
    if(!upstream)assert.fail('Unexpected upstream call '+c.path);return upstream(c,calls);
  };
  const handle=createBff({env,fetcher});
  return {calls,async call(path,{method='POST',body={},cookie,origin=APP,app=APP,headers:extra={}}={}){
    const headers=new Headers(extra);if(cookie)headers.set('Cookie',cookie);if(method==='POST'){headers.set('Content-Type','application/json');if(origin!==null)headers.set('Origin',origin);}
    const response=await handle(new Request(app+path,{method,headers,...(method==='POST'?{body:JSON.stringify(body)}:{})}));
    return {status:response.status,data:await response.json(),cookies:response.headers.getSetCookie(),headers:response.headers};
  }};
}

test('public passkey status exposes only native availability and stable production domain support',async()=>{
  const f=fixture(c=>{assert.equal(c.path,'/auth/v1/settings');assert.equal(c.method,'GET');assert.equal(c.headers.has('Authorization'),false);return json({passkeys_enabled:true,private_settings:'never-return'});});
  const r=await f.call('/api/passkeys/status',{method:'GET'});assert.deepEqual(r.data,{enabled:true,domainSupported:true,canonicalUrl:APP});assert.deepEqual(r.cookies,[]);
  const preview=await f.call('/api/passkeys/status',{method:'GET',app:'https://arios-preview.vercel.app'});assert.equal(preview.data.domainSupported,false);
  assert.equal((await fixture(()=>json({})).call('/api/passkeys/status',{method:'GET'})).data.enabled,false);
});

test('anonymous discoverable options are not bound to caller-selected identities and set an HttpOnly short-lived challenge',async()=>{
  const f=fixture(c=>{assert.equal(c.path,'/auth/v1/passkeys/authentication/options');assert.equal(c.headers.has('Authorization'),false);assert.equal(c.headers.get('Origin'),APP);assert.deepEqual(c.body,{gotrue_meta_security:{}});return json(authentication());});
  const r=await f.call('/api/passkeys/login/options',{cookie:'arios_access=old-user-session',body:{userId:'forged-owner',identifier:'private-phone',portal:'client'}});
  assert.equal(r.status,200);assert.equal(r.data.options.userVerification,'required');assert.equal(r.data.options.secret,undefined);
  assert.equal(r.cookies.length,1);assert.match(r.cookies[0],/arios_passkey_login=/);for(const flag of ['HttpOnly','SameSite=Strict','Secure','Path=/'])assert(r.cookies[0].includes(flag));assert.match(r.cookies[0],/Max-Age=\d+/);
  assert(!JSON.stringify(r.data).includes('old-user-session'));assert.equal(r.headers.get('Cache-Control'),'private, no-store');
});

test('challenge mismatch and malformed credentials are rejected before provider verification',async()=>{
  const f=fixture();for(const body of [{challengeId:CHALLENGE,credential:authCredential()},{challengeId:'bad',credential:authCredential()},{challengeId:CHALLENGE,credential:{type:'public-key'}}]){
    const r=await f.call('/api/passkeys/login/verify',{body});assert.equal(r.status,400);assert.equal(r.cookies.length,1);assert(r.cookies[0].includes('Max-Age=0'));
  }assert.equal(f.calls.length,0);
});

test('native sign-in is verified against protected membership before secure cookie creation, without exposing tokens',async()=>{
  for(const role of ['manager','worker','warehouse','accountant','customer']){
    const f=fixture(c=>{
      if(c.path==='/auth/v1/passkeys/authentication/verify'){assert.equal(c.headers.has('Authorization'),false);assert.equal(c.body.challenge_id,CHALLENGE);assert.equal(c.body.userId,undefined);assert.equal(c.body.credential.userId,undefined);return json({...TOKEN,user:{email:'private-auth-email'}});}
      assert.equal(c.path,'/functions/v1/arios-api/session');assert.equal(c.headers.get('Authorization'),'Bearer '+TOKEN.access_token);return json(session(role));
    });
    const r=await f.call('/api/passkeys/login/verify',{cookie:'arios_passkey_login='+CHALLENGE,body:{challengeId:CHALLENGE,credential:{...authCredential(),userId:'forged'},userId:'forged',portal:'client'}});
    assert.equal(r.status,200);assert.equal(r.data.portal,role==='customer'?'client':'team');assert.equal(r.data.user.role,role);
    assert.equal(r.cookies.length,3);assert(r.cookies.some(c=>c.startsWith('arios_access=')&&c.includes('HttpOnly')&&c.includes('Secure')));assert(r.cookies.some(c=>c.startsWith('arios_refresh=')));
    assert(!JSON.stringify(r.data).includes(TOKEN.access_token));assert(!JSON.stringify(r.data).includes(TOKEN.refresh_token));assert(!JSON.stringify(r.data).includes('private-auth-email'));
  }
});

test('profile deletion, role rejection or backend failure revokes only the newly created native session',async()=>{
  for(const status of [403,500,429]){
    const f=fixture(c=>{
      if(c.path==='/auth/v1/passkeys/authentication/verify')return json(TOKEN);
      if(c.path==='/functions/v1/arios-api/session')return json({error:'private-denial',code:'PROFILE_MISMATCH'},status);
      assert.equal(c.path,'/auth/v1/logout?scope=local');assert.equal(c.headers.get('Authorization'),'Bearer '+TOKEN.access_token);return new Response(null,{status:204});
    });
    const r=await f.call('/api/passkeys/login/verify',{cookie:'arios_passkey_login='+CHALLENGE,body:{challengeId:CHALLENGE,credential:authCredential()}});
    assert.equal(r.status,status===500?503:status);assert(r.cookies.every(c=>!c.startsWith('arios_access=')&&!c.startsWith('arios_refresh=')));assert(f.calls.some(c=>c.path.endsWith('scope=local')));assert(!JSON.stringify(r.data).includes('private-denial'));
  }
});

test('anonymous and revoked accounts cannot list, enroll or mutate passkeys',async()=>{
  const paths=['/api/passkeys','/api/passkeys/register/options','/api/passkeys/register/verify','/api/passkeys/rename','/api/passkeys/remove'];
  const f=fixture();for(const path of paths)assert.equal((await f.call(path,{method:path==='/api/passkeys'?'GET':'POST'})).status,401);assert.equal(f.calls.length,0);
  const revoked=fixture(c=>{assert.equal(c.path,'/functions/v1/arios-api/session');return json({code:'PROFILE_MISMATCH'},403);});
  assert.equal((await revoked.call('/api/passkeys/register/options',{cookie:'arios_access=revoked'})).status,403);assert.equal(revoked.calls.length,1);
});

test('management rotates an expired session before native access and strips private credential metadata',async()=>{
  const f=fixture(c=>{
    if(c.path==='/functions/v1/arios-api/session')return c.headers.get('Authorization')==='Bearer expired'?json({code:'INVALID_SESSION'},401):json(session());
    if(c.path==='/auth/v1/token?grant_type=refresh_token'){assert.deepEqual(c.body,{refresh_token:'old-refresh'});return json(TOKEN);}
    assert.equal(c.path,'/auth/v1/passkeys');assert.equal(c.headers.get('Authorization'),'Bearer '+TOKEN.access_token);return json([meta()]);
  });
  const r=await f.call('/api/passkeys',{method:'GET',cookie:'arios_access=expired; arios_refresh=old-refresh'});assert.equal(r.status,200);assert.equal(r.cookies.length,2);
  assert.deepEqual(Object.keys(r.data.passkeys[0]).sort(),['id','friendly_name','created_at','last_used_at'].sort());assert(!JSON.stringify(r.data).includes('never-return'));assert(!JSON.stringify(r.data).includes('private-owner'));
});

test('refreshed cookies are retained even when a later provider configuration error occurs',async()=>{
  const f=fixture(c=>{
    if(c.path==='/auth/v1/token?grant_type=refresh_token')return json(TOKEN);
    if(c.path==='/functions/v1/arios-api/session')return json(session());
    return json({code:'passkey_disabled',msg:'Passkeys are disabled'},404);
  });
  const r=await f.call('/api/passkeys/register/options',{cookie:'arios_refresh=old-refresh'});assert.equal(r.status,503);assert.equal(r.data.code,'PASSKEY_NOT_CONFIGURED');assert.equal(r.cookies.length,2);
});

test('registration uses the authenticated account, required verification and cookie-bound native challenges',async()=>{
  const f=fixture(c=>{
    if(c.path==='/functions/v1/arios-api/session')return json(session());
    assert.equal(c.headers.get('Authorization'),'Bearer current-user');
    if(c.path.endsWith('/registration/options'))return json(creation());
    assert.equal(c.path,'/auth/v1/passkeys/registration/verify');assert.deepEqual(Object.keys(c.body).sort(),['challenge_id','credential']);assert.equal(c.body.credential.userId,undefined);return json(meta());
  });
  const options=await f.call('/api/passkeys/register/options',{cookie:'arios_access=current-user',body:{userId:'victim'}});assert.equal(options.status,200);assert.equal(options.data.options.user.name,'staff-one');assert.equal(options.data.options.user.displayName,'همکار');assert.equal(options.data.options.authenticatorSelection.userVerification,'required');assert(!JSON.stringify(options.data).includes('internal@'));
  const verified=await f.call('/api/passkeys/register/verify',{cookie:'arios_access=current-user; arios_passkey_register='+CHALLENGE,body:{challengeId:CHALLENGE,credential:{...registrationCredential(),userId:'victim'},userId:'victim'}});assert.equal(verified.status,200);assert.equal(verified.data.passkey.id,ID);assert.equal(verified.data.passkey.public_key,undefined);assert(verified.cookies.some(c=>c.includes('arios_passkey_register=')&&c.includes('Max-Age=0')));
});

test('rename and removal act only through the current bearer token and validate identifiers and names',async()=>{
  const f=fixture(c=>{
    if(c.path==='/functions/v1/arios-api/session')return json(session());
    assert.equal(c.path,'/auth/v1/passkeys/'+ID);assert.equal(c.headers.get('Authorization'),'Bearer current-user');
    if(c.method==='PATCH'){assert.deepEqual(c.body,{friendly_name:'گوشی تازه'});return json(meta());}assert.equal(c.method,'DELETE');return new Response(null,{status:204});
  });
  assert.equal((await f.call('/api/passkeys/rename',{cookie:'arios_access=current-user',body:{id:ID,name:'  گوشی تازه  ',userId:'victim'}})).status,200);
  assert.deepEqual((await f.call('/api/passkeys/remove',{cookie:'arios_access=current-user',body:{id:ID,userId:'victim'}})).data,{ok:true});
  const before=f.calls.length;assert.equal((await f.call('/api/passkeys/remove',{cookie:'arios_access=current-user',body:{id:'../admin/users/victim'}})).status,400);assert.equal(f.calls.length,before+1);
  assert.equal((await f.call('/api/passkeys/rename',{cookie:'arios_access=current-user',body:{id:ID,name:'bad\nname'}})).status,400);
});

test('native replay failures, disabled features and redirects never create authentication cookies',async()=>{
  for(const [response,code,status] of [[json({code:'passkey_disabled',msg:'Passkeys are disabled'},404),'PASSKEY_NOT_CONFIGURED',503],[json({code:'passkey_authentication_failed',msg:'private-native-debug'},400),'PASSKEY_INVALID_RESPONSE',400],[new Response(null,{status:302,headers:{Location:'https://attacker.example'}}),'AUTH_REDIRECT_BLOCKED',502]]){
    const f=fixture(()=>response);const r=await f.call('/api/passkeys/login/verify',{cookie:'arios_passkey_login='+CHALLENGE,body:{challengeId:CHALLENGE,credential:authCredential()}});assert.equal(r.status,status);assert.equal(r.data.code,code);assert(r.cookies.every(c=>c.startsWith('arios_passkey_login=')));assert(!JSON.stringify(r.data).includes('private-native-debug'));assert.equal(f.calls.length,1);
  }
});

test('wrong domains, CSRF, foreign GET origins and unsupported methods are denied before upstream effects',async()=>{
  const f=fixture();
  for(const scenario of [{app:'https://arios-preview.vercel.app',origin:'https://arios-preview.vercel.app',code:'PASSKEY_WRONG_DOMAIN'},{origin:null,code:'ORIGIN_DENIED'},{origin:'https://attacker.example',code:'ORIGIN_DENIED'},{headers:{'Sec-Fetch-Site':'cross-site'},code:'ORIGIN_DENIED'}]){
    const r=await f.call('/api/passkeys/login/options',scenario);assert.equal(r.data.code,scenario.code);
  }
  assert.equal((await f.call('/api/passkeys',{method:'GET',headers:{Origin:'https://attacker.example'},cookie:'arios_access=private'})).data.code,'ORIGIN_DENIED');
  assert.equal((await f.call('/api/passkeys/register/options',{method:'GET'})).status,405);
  assert.equal((await f.call('/api/passkeys/unknown',{method:'GET'})).status,404);assert.equal(f.calls.length,0);
});

test('relying party misconfiguration is surfaced before a browser credential ceremony starts',async()=>{
  const f=fixture(()=>json({...authentication(),options:{...authentication().options,rpId:'arios-rouge.vercel.app'}}));
  const r=await f.call('/api/passkeys/login/options');assert.equal(r.status,503);assert.equal(r.data.code,'PASSKEY_WRONG_DOMAIN');assert.equal(r.data.canonicalUrl,APP);assert.deepEqual(r.cookies,[]);
});

test('native numeric HTTP codes do not hide the specific MFA or disabled-provider error code',async()=>{
  const disabled=fixture(()=>json({code:404,error_code:'passkey_disabled',msg:'Feature unavailable'},404));
  assert.equal((await disabled.call('/api/passkeys/login/options')).data.code,'PASSKEY_NOT_CONFIGURED');
  const mfa=fixture(c=>c.path==='/functions/v1/arios-api/session'?json(session()):json({code:403,error_code:'insufficient_aal',msg:'AAL2 required'},403));
  const r=await mfa.call('/api/passkeys/register/options',{cookie:'arios_access=current'});assert.equal(r.status,403);assert.equal(r.data.code,'PASSKEY_REAUTH_REQUIRED');
});

test('loopback ceremonies require explicit test or development opt-in and cannot bypass production policy',async()=>{
  for(const env of [{...ENV,NODE_ENV:undefined},{...ENV,ARIOS_PASSKEY_LOCAL_DEVELOPMENT:'1'}]){
    const f=fixture(undefined,env);const r=await f.call('/api/passkeys/login/options',{app:'http://localhost:4050',origin:'http://localhost:4050'});assert.equal(r.data.code,'PASSKEY_WRONG_DOMAIN');assert.equal(f.calls.length,0);
  }
  const f=fixture(()=>json({...authentication(),options:{...authentication().options,rpId:'localhost'}}),{...ENV,NODE_ENV:'test'});
  const r=await f.call('/api/passkeys/login/options',{app:'http://localhost:4050',origin:'http://localhost:4050'});assert.equal(r.status,200);assert(r.cookies.every(cookie=>!cookie.includes('; Secure')));
});


test('native actionable enrollment failures stay specific without leaking provider diagnostics',async()=>{
  for(const [upstream,expected,status] of [['webauthn_credential_exists','PASSKEY_ALREADY_REGISTERED',409],['webauthn_challenge_expired','PASSKEY_CHALLENGE_MISMATCH',400],['webauthn_challenge_not_found','PASSKEY_CHALLENGE_MISMATCH',400],['too_many_passkeys','PASSKEY_LIMIT_REACHED',409],['phone_not_confirmed','PASSKEY_ACCOUNT_UNAVAILABLE',403]]){
    const f=fixture(c=>c.path==='/functions/v1/arios-api/session'?json(session()):json({code:upstream,msg:'private-debug-details'},400));
    const r=await f.call('/api/passkeys/register/verify',{cookie:'arios_access=current-user; arios_passkey_register='+CHALLENGE,body:{challengeId:CHALLENGE,credential:registrationCredential()}});
    assert.equal(r.status,status);assert.equal(r.data.code,expected);assert(!JSON.stringify(r.data).includes('private-debug-details'));
  }
});

test('a server-owned first-password requirement blocks all passkey management before native credential access',async()=>{
  for(const topLevel of [true,false]){
    const f=fixture(c=>{assert.equal(c.path,'/functions/v1/arios-api/session');const value=session();if(topLevel)value.passwordChangeRequired=true;else value.user.passwordChangeRequired=true;return json(value);});
    for(const path of ['/api/passkeys','/api/passkeys/register/options','/api/passkeys/register/verify','/api/passkeys/rename','/api/passkeys/remove']){
      const r=await f.call(path,{method:path==='/api/passkeys'?'GET':'POST',cookie:'arios_access=temporary-login'});assert.equal(r.status,403);assert.equal(r.data.code,'PASSWORD_CHANGE_REQUIRED');
    }
    assert(f.calls.every(c=>c.path==='/functions/v1/arios-api/session'));
  }
});
