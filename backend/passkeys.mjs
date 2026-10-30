/** Native Supabase WebAuthn ceremonies; credential verification stays in Supabase Auth. */
const CANONICAL='https://arioshub.ir';
const ROLES=new Set(['manager','worker','customer','warehouse','accountant']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BASE64=/^[A-Za-z0-9_-]+$/;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
const error=(message,status=400,code='INVALID_PASSKEY_INPUT')=>{const e=new Error(message);e.status=status;e.code=code;throw e;};
function validOrigin(request,env){
  const url=new URL(request.url),loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  return [CANONICAL,'https://www.arioshub.ir'].includes(url.origin)||(loopback&&env.NODE_ENV!=='production'&&(env.NODE_ENV==='test'||env.ARIOS_PASSKEY_LOCAL_DEVELOPMENT==='1')&&['http:','https:'].includes(url.protocol));
}
function metadata(value){
  if(!object(value)||typeof value.id!=='string'||!UUID.test(value.id)||typeof value.created_at!=='string'||!Number.isFinite(Date.parse(value.created_at)))error('پاسخ ورود امن معتبر نیست.',502,'PASSKEY_INVALID_UPSTREAM');
  const result=own(value,['id','created_at']);
  if(typeof value.friendly_name==='string')result.friendly_name=value.friendly_name.slice(0,120);
  if(typeof value.last_used_at==='string'&&Number.isFinite(Date.parse(value.last_used_at)))result.last_used_at=value.last_used_at;
  return result;
}
function credentialBody(body,registration){
  if(typeof body.challengeId!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(body.challengeId))error('درخواست ورود امن معتبر نیست.');
  const c=body.credential;
  const encoded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&BASE64.test(value);
  if(!object(c)||c.type!=='public-key'||!encoded(c.id,4096)||!encoded(c.rawId,4096)||!object(c.response)||!encoded(c.response.clientDataJSON,16384))error('پاسخ دستگاه معتبر نیست. دوباره تلاش کنید.');
  if(registration?!encoded(c.response.attestationObject,60000):(!encoded(c.response.authenticatorData,16384)||!encoded(c.response.signature,4096)||(c.response.userHandle!=null&&!encoded(c.response.userHandle,4096))))error('پاسخ دستگاه معتبر نیست. دوباره تلاش کنید.');
  const response=own(c.response,registration?['clientDataJSON','attestationObject','transports','publicKeyAlgorithm','publicKey','authenticatorData']:['clientDataJSON','authenticatorData','signature','userHandle']);
  if(response.transports!==undefined&&(!Array.isArray(response.transports)||response.transports.length>10||response.transports.some(v=>typeof v!=='string'||v.length>30)))error('پاسخ دستگاه معتبر نیست.');
  const credential={id:c.id,rawId:c.rawId,type:c.type,response};
  if(object(c.clientExtensionResults))credential.clientExtensionResults=c.clientExtensionResults;
  if(['platform','cross-platform'].includes(c.authenticatorAttachment))credential.authenticatorAttachment=c.authenticatorAttachment;
  return {challenge_id:body.challengeId,credential};
}
function challengeCookie(name,value,secure,maxAge=300){return `arios_passkey_${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure?'; Secure':''}`;}
function optionsPayload(value,registration,request,user){
  if(!object(value)||typeof value.challenge_id!=='string'||!/^[A-Za-z0-9_-]{8,256}$/.test(value.challenge_id)||!object(value.options)||!Number.isSafeInteger(value.expires_at)||value.expires_at<=Math.floor(Date.now()/1000)||typeof value.options.challenge!=='string'||!BASE64.test(value.options.challenge))error('درخواست ورود امن دریافت نشد؛ دوباره تلاش کنید.',502,'PASSKEY_INVALID_UPSTREAM');
  const options=own(value.options,registration?['challenge','rp','user','pubKeyCredParams','timeout','excludeCredentials','authenticatorSelection','attestation','attestationFormats','extensions','hints']:['challenge','timeout','rpId','allowCredentials','userVerification','extensions','hints']);
  const origin=new URL(request.url),expectedRp=['localhost','127.0.0.1','[::1]'].includes(origin.hostname)?origin.hostname:'arioshub.ir';
  if((registration?options.rp?.id:options.rpId)!==expectedRp)error('ورود با اثر انگشت را در دامنهٔ arioshub.ir انجام دهید.',503,'PASSKEY_WRONG_DOMAIN');
  if(registration){
    if(!object(options.rp)||!object(options.user)||typeof options.user.id!=='string'||!Array.isArray(options.pubKeyCredParams))error('درخواست فعال‌سازی معتبر نیست.',502,'PASSKEY_INVALID_UPSTREAM');
    options.rp=own(options.rp,['id','name']);
    options.user={id:options.user.id,name:String(user?.username||user?.phone||user?.name||'آریوس').slice(0,120),displayName:String(user?.name||'حساب آریوس').slice(0,120)};
    options.authenticatorSelection={...(object(options.authenticatorSelection)?options.authenticatorSelection:{}),residentKey:'required',userVerification:'required'};
  }else options.userVerification='required';
  return {challenge_id:value.challenge_id,options,expires_at:value.expires_at};
}

export async function handlePasskeys({path,request,c,saved,secure,fetcher,env,helpers}){
  if(path!=='/passkeys'&&!path.startsWith('/passkeys/'))return null;
  const {json,boundedJSON,readBody,edgeRequest,authRequest,sessionCookies,clearCookies}=helpers;
  const updated=[];
  const native=async(route,{method='POST',body,token}={})=>{
    const headers=new Headers({apikey:c.key,'Content-Type':'application/json','X-Supabase-Api-Version':'2024-01-01',Origin:new URL(request.url).origin});
    if(token)headers.set('Authorization','Bearer '+token);
    let response;try{response=await fetcher(c.url+'/auth/v1/'+route,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{error('ارتباط با سرویس ورود برقرار نشد؛ دوباره تلاش کنید.',503,'AUTH_UNAVAILABLE');}
    if(response.status>=300&&response.status<400)error('نشانی سرویس ورود تأیید نشد.',502,'AUTH_REDIRECT_BLOCKED');
    const data=response.status===204?{}:await boundedJSON(response,131072);
    if(!response.ok){
      const code=typeof data?.error_code==='string'?data.error_code:typeof data?.code==='string'?data.code:'',message=String(data?.msg||data?.message||data?.error_description||'');
      if(code==='passkey_disabled'||/passkeys? (?:are |is )?disabled|passkey.*not enabled/i.test(message))error('ورود با اثر انگشت هنوز در سرویس ورود فعال نشده است.',503,'PASSKEY_NOT_CONFIGURED');
      if(['webauthn_challenge_not_found','webauthn_challenge_expired'].includes(code))error('مهلت تأیید تمام شده است؛ دوباره تلاش کنید.',400,'PASSKEY_CHALLENGE_MISMATCH');
      if(code==='webauthn_credential_exists')error('این دستگاه قبلاً برای حساب ثبت شده است.',409,'PASSKEY_ALREADY_REGISTERED');
      if(code==='too_many_passkeys')error('تعداد کلیدهای ورود حساب کامل است؛ یک کلید قدیمی را حذف کنید.',409,'PASSKEY_LIMIT_REACHED');
      if(['email_not_confirmed','phone_not_confirmed','user_banned'].includes(code))error('حساب شما برای این روش ورود آماده نیست؛ با مدیر هماهنگ کنید.',403,'PASSKEY_ACCOUNT_UNAVAILABLE');
      if(response.status===429)error('تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.',429,'RATE_LIMITED');
      if(code==='insufficient_aal')error('برای مدیریت ورود امن، دوباره وارد حساب شوید و تأیید دومرحله‌ای را کامل کنید.',403,'PASSKEY_REAUTH_REQUIRED');
      if(response.status>=500)error('سرویس ورود موقتاً در دسترس نیست.',503,'AUTH_UNAVAILABLE');
      if(response.status===401&&token){updated.push(...clearCookies(secure));error('نشست منقضی شده است؛ دوباره وارد حساب شوید.',401,'UNAUTHORIZED');}
      error('تأیید دستگاه انجام نشد؛ دوباره تلاش کنید یا با رمز وارد شوید.',response.status===404?404:400,'PASSKEY_INVALID_RESPONSE');
    }
    return data;
  };
  const revoke=async token=>{try{await fetcher(c.url+'/auth/v1/logout?scope=local',{method:'POST',headers:{apikey:c.key,Authorization:'Bearer '+token},redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{}};
  const protectedSession=async()=>{
    let token=saved.arios_access,result=token?await edgeRequest(c,'/session',new Request(request.url,{method:'GET'}),token,fetcher):null;
    if((!result||result.response.status===401)&&saved.arios_refresh){
      let session;try{session=await authRequest(c,'token?grant_type=refresh_token',{refresh_token:saved.arios_refresh},fetcher);}catch(e){updated.push(...clearCookies(secure));throw e;}
      if(typeof session.access_token!=='string'||!session.access_token||typeof session.refresh_token!=='string'||!session.refresh_token){updated.push(...clearCookies(secure));error('نشست منقضی شده است؛ دوباره وارد شوید.',401,'UNAUTHORIZED');}
      token=session.access_token;updated.push(...sessionCookies(session,secure));result=await edgeRequest(c,'/session',new Request(request.url,{method:'GET'}),token,fetcher);
    }
    if(result?.response.status>=500)error('فضای کار موقتاً در دسترس نیست؛ دوباره تلاش کنید.',503,'BACKEND_UNAVAILABLE');
    if(result?.response.status===429)error('تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.',429,'RATE_LIMITED');
    if(!result||!result.response.ok||!ROLES.has(result.data?.user?.role)){
      if(!result||result.response.status===401)updated.push(...clearCookies(secure));
      error('برای مدیریت ورود امن، با حساب فعال خود وارد شوید.',result?.response.status===403?403:401,result?.data?.code||'UNAUTHORIZED');
    }
    if(result.data.passwordChangeRequired===true||result.data.user.passwordChangeRequired===true)error('ابتدا رمز اولیهٔ حساب را تغییر دهید؛ سپس ورود با اثر انگشت را فعال کنید.',403,'PASSWORD_CHANGE_REQUIRED');
    return {token,user:result.data.user};
  };
  try{
    if(path==='/passkeys/status'&&request.method==='GET'){
      const data=await native('settings',{method:'GET'});
      return json({enabled:data?.passkeys_enabled===true,domainSupported:validOrigin(request,env),canonicalUrl:CANONICAL},200);
    }
    if(!validOrigin(request,env))error('برای ورود با اثر انگشت، سایت arioshub.ir را باز کنید.',400,'PASSKEY_WRONG_DOMAIN');
    if(request.headers.get('sec-fetch-site')==='cross-site'||request.headers.has('origin')&&request.headers.get('origin')!==new URL(request.url).origin)error('مبدأ درخواست مجاز نیست.',403,'ORIGIN_DENIED');
    const methods={'/passkeys':'GET','/passkeys/login/options':'POST','/passkeys/login/verify':'POST','/passkeys/register/options':'POST','/passkeys/register/verify':'POST','/passkeys/rename':'POST','/passkeys/remove':'POST'};
    if(!Object.hasOwn(methods,path))error('مسیر ورود امن یافت نشد.',404,'NOT_FOUND');
    if(request.method!==methods[path])error('روش درخواست مجاز نیست.',405,'METHOD_NOT_ALLOWED');
    const body=request.method==='POST'?await readBody(request):{};
    if(path==='/passkeys/login/options'){
      const data=optionsPayload(await native('passkeys/authentication/options',{body:{gotrue_meta_security:{}}}),false,request);
      updated.push(challengeCookie('login',data.challenge_id,secure,Math.min(300,data.expires_at-Math.floor(Date.now()/1000))));
      return json(data,200,updated);
    }
    if(path==='/passkeys/login/verify'){
      updated.push(challengeCookie('login','',secure,0));
      const payload=credentialBody(body,false);
      if(saved.arios_passkey_login!==payload.challenge_id)error('درخواست ورود منقضی شده است؛ دوباره شروع کنید.',400,'PASSKEY_CHALLENGE_MISMATCH');
      const session=await native('passkeys/authentication/verify',{body:payload});
      if(typeof session.access_token!=='string'||!session.access_token||typeof session.refresh_token!=='string'||!session.refresh_token){if(typeof session.access_token==='string')await revoke(session.access_token);error('پاسخ ورود معتبر نیست.',502,'PASSKEY_INVALID_UPSTREAM');}
      let verified;try{verified=await edgeRequest(c,'/session',new Request(request.url,{method:'GET'}),session.access_token,fetcher);}catch(e){await revoke(session.access_token);throw e;}
      if(!verified.response.ok||!ROLES.has(verified.data?.user?.role)){
        await revoke(session.access_token);
        if(verified.response.status>=500)error('فضای کار موقتاً در دسترس نیست؛ دوباره تلاش کنید.',503,'BACKEND_UNAVAILABLE');
        if(verified.response.status===429)error('تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.',429,'RATE_LIMITED');
        error('این حساب دسترسی فعال به آریوس ندارد.',403,'NOT_A_MEMBER');
      }
      const portal=verified.data.user.role==='customer'?'client':'team';
      return json({...verified.data,portal},200,[...updated,...sessionCookies(session,secure)]);
    }
    const current=await protectedSession();
    if(path==='/passkeys'){
      const data=await native('passkeys',{method:'GET',token:current.token});
      if(!Array.isArray(data)||data.length>1000)error('فهرست ورودهای امن معتبر نیست.',502,'PASSKEY_INVALID_UPSTREAM');
      return json({passkeys:data.map(metadata)},200,updated);
    }
    if(path==='/passkeys/register/options'){
      const data=optionsPayload(await native('passkeys/registration/options',{body:{},token:current.token}),true,request,current.user);
      updated.push(challengeCookie('register',data.challenge_id,secure,Math.min(300,data.expires_at-Math.floor(Date.now()/1000))));
      return json(data,200,updated);
    }
    if(path==='/passkeys/register/verify'){
      updated.push(challengeCookie('register','',secure,0));
      const payload=credentialBody(body,true);
      if(saved.arios_passkey_register!==payload.challenge_id)error('درخواست فعال‌سازی منقضی شده است؛ دوباره شروع کنید.',400,'PASSKEY_CHALLENGE_MISMATCH');
      const data=await native('passkeys/registration/verify',{body:payload,token:current.token});
      return json({passkey:metadata(data)},200,updated);
    }
    if(typeof body.id!=='string'||!UUID.test(body.id))error('شناسهٔ ورود امن معتبر نیست.');
    if(path==='/passkeys/rename'){
      if(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>120||/[\u0000-\u001f\u007f]/.test(body.name))error('نام دستگاه باید بین ۱ تا ۱۲۰ نویسه باشد.');
      const data=await native('passkeys/'+body.id,{method:'PATCH',body:{friendly_name:body.name.trim()},token:current.token});
      return json({passkey:metadata(data)},200,updated);
    }
    await native('passkeys/'+body.id,{method:'DELETE',token:current.token});
    return json({ok:true},200,updated);
  }catch(e){return json({error:e.status?e.message:'ورود امن انجام نشد؛ دوباره تلاش کنید.',code:e.code||'PASSKEY_UNAVAILABLE',...(e.code==='PASSKEY_WRONG_DOMAIN'?{canonicalUrl:CANONICAL}:{})},e.status||500,updated);}
}
