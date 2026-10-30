/** Browser WebAuthn ceremonies. Credentials are verified by the authentication service. */
const hosts=new Set(['arioshub.ir','www.arioshub.ir','localhost','127.0.0.1','[::1]']);
const roles=new Set(['manager','worker','customer','warehouse','accountant']);
const messages={
  PASSKEY_NOT_CONFIGURED:'ورود با تأیید گوشی هنوز فعال نشده است. فعلاً با رمز عبور وارد شوید.',
  PASSKEY_WRONG_DOMAIN:'برای ورود با تأیید گوشی، سایت را با نشانی arioshub.ir باز کنید.',
  PASSKEY_INVALID_RESPONSE:'تأیید گوشی پذیرفته نشد. دوباره تلاش کنید یا با رمز عبور وارد شوید.',
  PASSKEY_CHALLENGE_MISMATCH:'مهلت این درخواست تمام شده یا درخواست دیگری باز است. دوباره امتحان کنید.',
  PASSKEY_REAUTH_REQUIRED:'برای مدیریت کلیدهای ورود، دوباره با رمز حساب خود وارد شوید.',
  PASSWORD_CHANGE_REQUIRED:'ابتدا رمز اولیهٔ حساب را تغییر دهید؛ بعد می‌توانید اثر انگشت را فعال کنید.',
  UNAUTHORIZED:'برای مدیریت روش‌های ورود، دوباره با حساب خود وارد شوید.',
  RATE_LIMITED:'تعداد تلاش‌ها زیاد شده است. کمی بعد دوباره امتحان کنید.',
  PASSKEY_UNSUPPORTED:'مرورگر یا دستگاه شما این روش را پشتیبانی نمی‌کند. می‌توانید با رمز عبور وارد شوید.',
  PASSKEY_ALREADY_REGISTERED:'این دستگاه قبلاً ثبت شده است. می‌توانید با دکمهٔ ورود با اثر انگشت وارد شوید.',
  PASSKEY_LIMIT_REACHED:'تعداد کلیدهای حساب کامل است. از تنظیمات حساب، کلید قدیمی را حذف کنید.',
  PASSKEY_ACCOUNT_UNAVAILABLE:'حساب شما برای این روش ورود آماده نیست. با مدیر آریوس هماهنگ کنید.',
  PASSKEY_CANCELLED:'تأیید و ذخیره در گوشی کامل نشد. رمز این پنجره، PIN گوشی یا مدیر گذرواژه است؛ رمز آریوس نیست. می‌توانید فعلاً با رمز آریوس وارد شوید.',
};
function error(code,message){const value=new Error(message||messages[code]||'درخواست انجام نشد. دوباره تلاش کنید.');value.code=code;return value;}
export function passkeyMessage(value){
  if(messages[value?.code])return messages[value.code];
  if(['NotAllowedError','AbortError'].includes(value?.name))return messages.PASSKEY_CANCELLED;
  if(value?.name==='TimeoutError')return 'پاسخ سرویس طول کشید. اتصال اینترنت را بررسی و دوباره امتحان کنید.';
  if(value?.name==='InvalidStateError')return 'این کلید ورود قبلاً ثبت شده است. از فهرست کلیدهای ورود استفاده کنید.';
  if(value?.name==='SecurityError')return messages.PASSKEY_WRONG_DOMAIN;
  if(value?.name==='NotSupportedError')return 'ابتدا قفل صفحهٔ گوشی و مدیر گذرواژهٔ Google یا iCloud را فعال کنید؛ سپس در Chrome یا Safari دوباره امتحان کنید.';
  if(['InvalidCharacterError','DataError'].includes(value?.name))return messages.PASSKEY_INVALID_RESPONSE;
  if(value instanceof TypeError)return 'درخواست دستگاه اجرا نشد. صفحه را در Chrome یا Safari باز کنید و دوباره امتحان کنید.';
  return value?.message||'درخواست انجام نشد. دوباره تلاش کنید.';
}
export function passkeySupport(scope=globalThis){
  if(!scope.isSecureContext||!scope.PublicKeyCredential||!scope.navigator?.credentials?.create||!scope.navigator?.credentials?.get)return {supported:false,code:'PASSKEY_UNSUPPORTED'};
  if(!hosts.has(scope.location?.hostname))return {supported:false,code:'PASSKEY_WRONG_DOMAIN'};
  return {supported:true};
}
export function passkeyDeviceHelp(scope=globalThis){
  const agent=String(scope.navigator?.userAgent||'');
  if(/(?:; wv\)|\bFBAN\b|\bFBAV\b|Instagram|Telegram|Line\/)/i.test(agent))return 'این صفحه را از منوی مرورگر در Chrome یا Safari باز کنید؛ مرورگر داخل پیام‌رسان ممکن است ورود با اثر انگشت را پشتیبانی نکند.';
  if(/iPhone|iPad|iPod/i.test(agent))return 'پنجرهٔ Passwords / iCloud رمز آریوس را نمی‌خواهد؛ با Face ID، Touch ID یا رمز قفل آیفون تأیید کنید. قفل صفحه و iCloud Keychain باید فعال باشند.';
  if(/Android/i.test(agent))return 'پنجرهٔ Google Password Manager رمز آریوس را نمی‌خواهد؛ PIN قفل گوشی یا PIN مدیر گذرواژهٔ Google را می‌خواهد. پس از تأیید، ذخیرهٔ کلید ورود را بزنید.';
  return 'این مرحله یک کلید ورود تازه می‌سازد؛ لازم نیست رمز آریوس را در مدیر گذرواژه پیدا کنید. در پنجرهٔ دستگاه با اثر انگشت، چهره یا PIN قفل دستگاه تأیید کنید.';
}
export function passkeySaveHelp(){return 'اگر پنجرهٔ «ذخیرهٔ رمز عبور» مرورگر باز است، آن را ببندید؛ سپس ساخت کلید ورود را بزنید. آریوس برای ساخت کلید، رمز ذخیره‌شدهٔ Google را نمی‌خواند. قفل صفحه و مدیر گذرواژهٔ گوشی باید آماده باشند. «انتخاب همین دستگاه» فقط محل تأیید را پیشنهاد می‌دهد و PIN گوشی یا Google / iCloud را دور نمی‌زند.';}
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
export function creationOptionsFromJSON(value,scope=globalThis,{preferLocal=false}={}){
  if(!value||typeof value!=='object'||typeof value.challenge!=='string'||!value.user)throw error('PASSKEY_INVALID_RESPONSE');
  const options=typeof scope.PublicKeyCredential?.parseCreationOptionsFromJSON==='function'
    ?scope.PublicKeyCredential.parseCreationOptionsFromJSON(value)
    :{...value,challenge:decodeBase64URL(value.challenge),user:{...value.user,id:decodeBase64URL(value.user.id)},...(value.excludeCredentials?{excludeCredentials:value.excludeCredentials.map(item=>({...item,id:decodeBase64URL(item.id)}))}:{})};
  const {authenticatorAttachment,...selection}=options.authenticatorSelection||{};
  return {...options,hints:['client-device'],authenticatorSelection:{...selection,...(preferLocal?{authenticatorAttachment:'platform'}:{}),residentKey:'required',requireResidentKey:true,userVerification:'required'}};
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
  const response=await fetcher('/api/passkeys'+path,{method,...(globalThis.AbortSignal?.timeout?{signal:AbortSignal.timeout(25000)}:{}),credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body||{})})});
  let data;try{data=await response.json();}catch{throw error('PASSKEY_INVALID_RESPONSE');}
  if(!response.ok)throw error(data.code,messages[data.code]||'درخواست ورود با تأیید گوشی انجام نشد. دوباره تلاش کنید.');
  return data;
}
function startOptions(data){if(!data||typeof data.challenge_id!=='string'||!data.challenge_id||!data.options)throw error('PASSKEY_INVALID_RESPONSE');if(Number.isFinite(data.expires_at)&&data.expires_at*1000<=Date.now())throw error('PASSKEY_CHALLENGE_MISMATCH');return data;}
export async function loginWithPasskey({portal='team',fetcher=fetch,scope=globalThis,start:prepared}={}){
  supported(scope);const selected=portal==='client'?'client':'team';
  const start=prepared?startOptions(prepared):startOptions(await request('/login/options',{body:{portal:selected},fetcher}));
  const credential=await scope.navigator.credentials.get({publicKey:requestOptionsFromJSON(start.options,scope)});
  if(!credential)throw error('PASSKEY_CANCELLED');
  const result=await request('/login/verify',{body:{challengeId:start.challenge_id,credential:credentialJSON(credential),portal:selected},fetcher});
  if(!result.user||!roles.has(result.user.role))throw error('PASSKEY_INVALID_RESPONSE');return result;
}
export async function preparePasskeyRegistration({fetcher=fetch,scope=globalThis}={}){supported(scope);return startOptions(await request('/register/options',{fetcher}));}
export async function registerPasskey({fetcher=fetch,scope=globalThis,start:prepared,preferLocal=false,signal,onStage=()=>{}}={}){
  supported(scope);const start=prepared?startOptions(prepared):await preparePasskeyRegistration({fetcher,scope});
  onStage('device');
  const credential=await scope.navigator.credentials.create({publicKey:creationOptionsFromJSON(start.options,scope,{preferLocal}),...(signal?{signal}:{})});
  if(!credential)throw error('PASSKEY_CANCELLED');
  onStage('verifying');
  return request('/register/verify',{body:{challengeId:start.challenge_id,credential:credentialJSON(credential)},fetcher});
}
export async function listPasskeys({fetcher=fetch}={}){const data=await request('',{method:'GET',fetcher});if(!Array.isArray(data.passkeys))throw error('PASSKEY_INVALID_RESPONSE');return data.passkeys;}
export function passkeyAvailability({fetcher=fetch}={}){return request('/status',{method:'GET',fetcher});}
export function renamePasskey(id,name,{fetcher=fetch}={}){if(typeof name!=='string'||!name.trim()||name.trim().length>120)throw error('INVALID_INPUT','نامی تا ۱۲۰ نویسه وارد کنید.');return request('/rename',{body:{id,name:name.trim()},fetcher});}
export function removePasskey(id,{fetcher=fetch}={}){return request('/remove',{body:{id},fetcher});}
export function mountPasskeyLogin({portal='team',onSuccess,scope=globalThis,fetcher=fetch}={}){
  const doc=scope.document,button=doc?.querySelector('[data-passkey-login]');if(!button)return;
  const status=doc.querySelector('[data-passkey-login-status]'),link=doc.querySelector('[data-passkey-canonical]');
  const help=doc.querySelector('[data-passkey-login-help]');if(help)help.textContent=passkeyDeviceHelp(scope);
  let prepared;
  const prepare=async()=>{prepared=startOptions(await request('/login/options',{body:{portal:portal==='client'?'client':'team'},fetcher}));};
  if(link)link.href='https://arioshub.ir/login/'+(portal==='client'?'client':'team')+'?setup=passkey';
  const support=passkeySupport(scope);button.disabled=!support.supported;
  if(!support.supported){if(status)status.textContent=messages[support.code]+' '+passkeyDeviceHelp(scope);if(link)link.hidden=support.code!=='PASSKEY_WRONG_DOMAIN';return;}
  button.disabled=true;
  void passkeyAvailability({fetcher}).then(async data=>{
    button.disabled=data.enabled!==true||data.domainSupported===false;
    if(status)status.textContent=data.domainSupported===false?messages.PASSKEY_WRONG_DOMAIN:data.enabled===true?'':messages.PASSKEY_NOT_CONFIGURED;
    if(link)link.hidden=data.domainSupported!==false;
    if(data.enabled===true&&data.domainSupported!==false){button.disabled=true;try{await prepare();}finally{button.disabled=false;}}
  }).catch(value=>{if(status)status.textContent=passkeyMessage(value);button.disabled=false;});
  button.addEventListener('click',async()=>{
    if(button.disabled)return;button.disabled=true;if(status){status.textContent='در پنجرهٔ گوشی، حساب آریوس را انتخاب و تأیید کنید…';status.setAttribute('role','status');}
    if(!prepared||prepared.expires_at*1000<=Date.now()+5000){try{await prepare();if(status)status.textContent='درخواست تازه آماده شد؛ برای تأیید گوشی دوباره دکمهٔ ورود را بزنید.';}catch(value){if(status){status.textContent=passkeyMessage(value);status.setAttribute('role','alert');}}finally{button.disabled=false;}return;}
    try{const data=await loginWithPasskey({portal,fetcher,scope,start:prepared});if(status)status.textContent='ورود تأیید شد';if(onSuccess)await onSuccess(data);}
    catch(value){if(status){status.textContent=passkeyMessage(value);status.setAttribute('role','alert');}button.disabled=false;prepared=null;void prepare().catch(()=>{});}
  });
}

/** Offer enrollment after a password sign-in, without interrupting an established session. */
export async function offerPasskeySetupAfterLogin({scope=globalThis,fetcher=fetch,force=false}={}){
  if(!passkeySupport(scope).supported||!scope.document?.createElement)return;
  let availability,entries;
  try{[availability,entries]=await Promise.all([passkeyAvailability({fetcher}),listPasskeys({fetcher})]);}catch{return;}
  if(availability.enabled!==true||availability.domainSupported===false||entries.length&&!force)return;
  const doc=scope.document,sheet=doc.createElement('dialog');sheet.className='passkey-setup-dialog';
  sheet.setAttribute('aria-labelledby','passkey-setup-title');
  sheet.innerHTML='<h2 id="passkey-setup-title">ساخت کلید ورود جدید</h2><p>یک کلید جدید برای ورود با اثر انگشت یا قفل گوشی می‌سازیم؛ نیازی به پیدا کردن رمز آریوس در Google نیست.</p><p class="muted" data-passkey-device-help></p><p data-passkey-setup-status role="status" aria-live="polite">در حال آماده‌سازی اتصال امن…</p><div class="passkey-setup-actions"><button type="button" class="button button-primary" data-passkey-setup-activate disabled>ساخت کلید ورود روی این دستگاه</button><details class="passkey-save-help"><summary>در مرحلهٔ ذخیره متوقف می‌شود؟</summary><p data-passkey-save-help></p><button type="button" class="button button-quiet" data-passkey-setup-local disabled>انتخاب همین دستگاه</button></details><button type="button" class="button button-quiet" data-passkey-setup-skip>فعلاً ورود به پنل</button></div>';
  sheet.querySelector('[data-passkey-device-help]').textContent=passkeyDeviceHelp(scope);
  sheet.querySelector('[data-passkey-save-help]').textContent=passkeySaveHelp();
  doc.body.append(sheet);sheet.showModal();
  const button=sheet.querySelector('[data-passkey-setup-activate]'),local=sheet.querySelector('[data-passkey-setup-local]'),skip=sheet.querySelector('[data-passkey-setup-skip]'),status=sheet.querySelector('[data-passkey-setup-status]');
  const disable=value=>{button.disabled=value;local.disabled=value;};
  let prepared,closed=false,finish,controller;
  const done=new Promise(resolve=>{finish=()=>{if(closed)return;closed=true;controller?.abort();sheet.close();sheet.remove();resolve();};});
  skip.addEventListener('click',finish);sheet.addEventListener('cancel',event=>{event.preventDefault();finish();});
  const prepare=async()=>{disable(true);try{prepared=await preparePasskeyRegistration({scope,fetcher});if(closed)return;disable(false);status.textContent='برای ثبت، دکمهٔ زیر را بزنید و پیام گوشی را تأیید کنید.';}catch(value){if(!closed){status.textContent=passkeyMessage(value);button.textContent='تلاش دوباره';disable(false);}}};
  const activate=async preferLocal=>{
    if(button.disabled||closed)return;
    if(!prepared||prepared.expires_at*1000<=Date.now()+5000){status.textContent='در حال آماده‌سازی دوباره…';await prepare();return;}
    disable(true);controller=new AbortController();
    try{await registerPasskey({scope,fetcher,start:prepared,preferLocal,signal:controller.signal,onStage:stage=>{if(!closed)status.textContent=stage==='device'?'پنجرهٔ گوشی PIN قفل گوشی یا مدیر گذرواژه را می‌خواهد؛ رمز آریوس را لازم ندارد. پس از تأیید، ذخیرهٔ کلید را بزنید.':'کلید روی گوشی ساخته شد؛ در حال ثبت نهایی در آریوس…';}});if(closed)return;status.textContent='فعال شد. دفعات بعد از «ورود با اثر انگشت یا چهره» استفاده کنید.';button.hidden=true;local.hidden=true;skip.textContent='ورود به پنل';skip.focus();}
    catch(value){if(closed)return;const detail=passkeyMessage(value);status.textContent=detail;prepared=null;button.textContent='تلاش دوباره';await prepare();if(!closed)status.textContent=detail;}
  };
  button.addEventListener('click',()=>activate(false));local.addEventListener('click',()=>activate(true));
  void prepare();return done;
}
