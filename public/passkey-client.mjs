/** Browser WebAuthn ceremonies. Credentials are verified by the authentication service. */
const hosts=new Set(['arioshub.ir','www.arioshub.ir','localhost','127.0.0.1','[::1]']);
const roles=new Set(['manager','worker','customer','warehouse','accountant']);
const messages={
  PASSKEY_NOT_CONFIGURED:'ورود با تأیید گوشی هنوز فعال نشده است. فعلاً با رمز عبور وارد شوید.',
  PASSKEY_WRONG_DOMAIN:'برای ورود با تأیید گوشی، سایت را با نشانی arioshub.ir باز کنید.',
  PASSKEY_INVALID_RESPONSE:'تأیید گوشی پذیرفته نشد. دوباره تلاش کنید یا با رمز عبور وارد شوید.',
  PASSKEY_CHALLENGE_MISMATCH:'مهلت این درخواست تمام شده یا درخواست دیگری باز است. دوباره امتحان کنید.',
  PASSKEY_REAUTH_REQUIRED:'برای مدیریت کلیدهای ورود، دوباره با رمز حساب خود وارد شوید.',
  UNAUTHORIZED:'برای مدیریت روش‌های ورود، دوباره با حساب خود وارد شوید.',
  RATE_LIMITED:'تعداد تلاش‌ها زیاد شده است. کمی بعد دوباره امتحان کنید.',
  PASSKEY_UNSUPPORTED:'مرورگر یا دستگاه شما این روش را پشتیبانی نمی‌کند. می‌توانید با رمز عبور وارد شوید.',
  PASSKEY_CANCELLED:'تأیید گوشی کامل نشد. دوباره امتحان کنید یا با رمز عبور وارد شوید.',
};
function error(code,message){const value=new Error(message||messages[code]||'درخواست انجام نشد. دوباره تلاش کنید.');value.code=code;return value;}
export function passkeyMessage(value){
  if(messages[value?.code])return messages[value.code];
  if(['NotAllowedError','AbortError'].includes(value?.name))return messages.PASSKEY_CANCELLED;
  if(value?.name==='InvalidStateError')return 'این کلید ورود قبلاً ثبت شده است. از فهرست کلیدهای ورود استفاده کنید.';
  if(value?.name==='SecurityError')return messages.PASSKEY_WRONG_DOMAIN;
  if(value?.name==='NotSupportedError')return messages.PASSKEY_UNSUPPORTED;
  if(['InvalidCharacterError','DataError'].includes(value?.name))return messages.PASSKEY_INVALID_RESPONSE;
  if(value instanceof TypeError)return 'ارتباط برقرار نشد. اینترنت را بررسی و دوباره امتحان کنید.';
  return value?.message||'درخواست انجام نشد. دوباره تلاش کنید.';
}
export function passkeySupport(scope=globalThis){
  if(!scope.isSecureContext||!scope.PublicKeyCredential||!scope.navigator?.credentials?.create||!scope.navigator?.credentials?.get)return {supported:false,code:'PASSKEY_UNSUPPORTED'};
  if(!hosts.has(scope.location?.hostname))return {supported:false,code:'PASSKEY_WRONG_DOMAIN'};
  return {supported:true};
}
function supported(scope){const support=passkeySupport(scope);if(!support.supported)throw error(support.code);}
export function decodeBase64URL(value){
  if(typeof value!=='string'||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw error('PASSKEY_INVALID_RESPONSE');
  const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
  return Uint8Array.from(raw,char=>char.charCodeAt(0)).buffer;
}
export function encodeBase64URL(value){
  const bytes=value instanceof ArrayBuffer?new Uint8Array(value):ArrayBuffer.isView(value)?new Uint8Array(value.buffer,value.byteOffset,value.byteLength):null;
  if(!bytes)throw error('PASSKEY_INVALID_RESPONSE');
  let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function creationOptionsFromJSON(value,scope=globalThis){
  if(!value||typeof value!=='object'||typeof value.challenge!=='string'||!value.user)throw error('PASSKEY_INVALID_RESPONSE');
  const options=typeof scope.PublicKeyCredential?.parseCreationOptionsFromJSON==='function'
    ?scope.PublicKeyCredential.parseCreationOptionsFromJSON(value)
    :{...value,challenge:decodeBase64URL(value.challenge),user:{...value.user,id:decodeBase64URL(value.user.id)},...(value.excludeCredentials?{excludeCredentials:value.excludeCredentials.map(item=>({...item,id:decodeBase64URL(item.id)}))}:{})};
  return {...options,authenticatorSelection:{...options.authenticatorSelection,authenticatorAttachment:'platform',residentKey:'required',userVerification:'required'}};
}
export function requestOptionsFromJSON(value,scope=globalThis){
  if(!value||typeof value!=='object'||typeof value.challenge!=='string')throw error('PASSKEY_INVALID_RESPONSE');
  const options=typeof scope.PublicKeyCredential?.parseRequestOptionsFromJSON==='function'
    ?scope.PublicKeyCredential.parseRequestOptionsFromJSON(value)
    :{...value,challenge:decodeBase64URL(value.challenge),...(value.allowCredentials?{allowCredentials:value.allowCredentials.map(item=>({...item,id:decodeBase64URL(item.id)}))}:{})};
  return {...options,userVerification:'required'};
}
export function credentialJSON(credential){
  if(!credential||credential.type!=='public-key'||typeof credential.id!=='string'||!credential.response)throw error('PASSKEY_INVALID_RESPONSE');
  if(typeof credential.toJSON==='function')return credential.toJSON();
  const response={};
  for(const key of ['clientDataJSON','attestationObject','authenticatorData','signature'])if(credential.response[key])response[key]=encodeBase64URL(credential.response[key]);
  if('userHandle' in credential.response)response.userHandle=credential.response.userHandle?encodeBase64URL(credential.response.userHandle):null;
  if(typeof credential.response.getTransports==='function')response.transports=credential.response.getTransports();
  return {id:credential.id,rawId:encodeBase64URL(credential.rawId),type:'public-key',response,clientExtensionResults:credential.getClientExtensionResults?.()||{},...(credential.authenticatorAttachment?{authenticatorAttachment:credential.authenticatorAttachment}:{})};
}
async function request(path,{method='POST',body,fetcher=fetch}={}){
  const response=await fetcher('/api/passkeys'+path,{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body||{})})});
  let data;try{data=await response.json();}catch{throw error('PASSKEY_INVALID_RESPONSE');}
  if(!response.ok)throw error(data.code,messages[data.code]||'درخواست ورود با تأیید گوشی انجام نشد. دوباره تلاش کنید.');
  return data;
}
function startOptions(data){if(!data||typeof data.challenge_id!=='string'||!data.challenge_id||!data.options)throw error('PASSKEY_INVALID_RESPONSE');if(Number.isFinite(data.expires_at)&&data.expires_at*1000<=Date.now())throw error('PASSKEY_CHALLENGE_MISMATCH');return data;}
export async function loginWithPasskey({portal='team',fetcher=fetch,scope=globalThis}={}){
  supported(scope);const selected=portal==='client'?'client':'team';
  const start=startOptions(await request('/login/options',{body:{portal:selected},fetcher}));
  const credential=await scope.navigator.credentials.get({publicKey:requestOptionsFromJSON(start.options,scope)});
  if(!credential)throw error('PASSKEY_CANCELLED');
  const result=await request('/login/verify',{body:{challengeId:start.challenge_id,credential:credentialJSON(credential),portal:selected},fetcher});
  if(!result.user||!roles.has(result.user.role))throw error('PASSKEY_INVALID_RESPONSE');return result;
}
export async function registerPasskey({fetcher=fetch,scope=globalThis}={}){
  supported(scope);const start=startOptions(await request('/register/options',{fetcher}));
  const credential=await scope.navigator.credentials.create({publicKey:creationOptionsFromJSON(start.options,scope)});
  if(!credential)throw error('PASSKEY_CANCELLED');
  return request('/register/verify',{body:{challengeId:start.challenge_id,credential:credentialJSON(credential)},fetcher});
}
export async function listPasskeys({fetcher=fetch}={}){const data=await request('',{method:'GET',fetcher});if(!Array.isArray(data.passkeys))throw error('PASSKEY_INVALID_RESPONSE');return data.passkeys;}
export function passkeyAvailability({fetcher=fetch}={}){return request('/status',{method:'GET',fetcher});}
export function renamePasskey(id,name,{fetcher=fetch}={}){if(typeof name!=='string'||!name.trim()||name.trim().length>120)throw error('INVALID_INPUT','نامی تا ۱۲۰ نویسه وارد کنید.');return request('/rename',{body:{id,name:name.trim()},fetcher});}
export function removePasskey(id,{fetcher=fetch}={}){return request('/remove',{body:{id},fetcher});}
export function mountPasskeyLogin({portal='team',onSuccess,scope=globalThis,fetcher=fetch}={}){
  const doc=scope.document,button=doc?.querySelector('[data-passkey-login]');if(!button)return;
  const status=doc.querySelector('[data-passkey-login-status]'),link=doc.querySelector('[data-passkey-canonical]');
  if(link)link.href='https://arioshub.ir/login/'+(portal==='client'?'client':'team');
  const support=passkeySupport(scope);button.disabled=!support.supported;
  if(!support.supported){if(status)status.textContent=messages[support.code];if(link)link.hidden=support.code!=='PASSKEY_WRONG_DOMAIN';return;}
  button.disabled=true;
  void passkeyAvailability({fetcher}).then(data=>{
    button.disabled=data.enabled!==true||data.domainSupported===false;
    if(status)status.textContent=data.domainSupported===false?messages.PASSKEY_WRONG_DOMAIN:data.enabled===true?'':messages.PASSKEY_NOT_CONFIGURED;
    if(link)link.hidden=data.domainSupported!==false;
  }).catch(value=>{if(status)status.textContent=passkeyMessage(value);button.disabled=false;});
  button.addEventListener('click',async()=>{
    if(button.disabled)return;button.disabled=true;if(status){status.textContent='در انتظار تأیید گوشی…';status.setAttribute('role','status');}
    try{const data=await loginWithPasskey({portal,fetcher,scope});if(status)status.textContent='ورود تأیید شد';if(onSuccess)await onSuccess(data);}
    catch(value){if(status){status.textContent=passkeyMessage(value);status.setAttribute('role','alert');}button.disabled=false;}
  });
}
