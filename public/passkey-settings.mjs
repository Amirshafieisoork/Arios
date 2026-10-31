import {listPasskeys,registerPasskey,renamePasskey,removePasskey,passkeySupport,passkeyMessage,passkeyAvailability,preparePasskeyRegistration,passkeyDeviceHelp,passkeySaveHelp} from './passkey-client.mjs';
const roles=new Set(['manager','worker','customer','warehouse','accountant']);
export const nativeBiometricApp=(scope=globalThis)=>/\bAriosAndroid\/[0-9]/.test(scope.navigator?.userAgent||'');
export function renderPasskeySettings(state,ctx,{scope=globalThis}={}){
  if(!state.user||!roles.has(state.user.role))return '';
  if(nativeBiometricApp(scope))return '<section class="card native-biometric-settings"><h2>قفل برنامه با اثر انگشت گوشی</h2><p>برای فعال‌سازی یا تغییر قفل، دکمهٔ قفل بالای برنامه را بزنید. تأیید با حسگر خود گوشی انجام می‌شود و ساخت گذرکلید یا اتصال به گوگل لازم نیست.</p></section>';
  return `<section class="card passkey-settings" data-passkey-settings-user="${ctx.e(state.user.id)}"><div class="card-head"><div><h2>اثر انگشت در اپ اندروید آریوس</h2><p class="muted">ورود با حسگر خود گوشی از قفل نسخهٔ اندروید مدیریت می‌شود.</p></div></div><p>در اپ اندروید، یک‌بار با شماره تماس و رمز وارد شوید؛ سپس قفل اثر انگشت را از دکمهٔ قفل بالای برنامه فعال کنید. ورود معمولی سایت با شماره تماس و رمز انجام می‌شود.</p><p><a class="button primary" href="/downloads/arios-android.apk" download>دانلود اپ اندروید با قفل اثر انگشت</a></p><details class="passkey-save-help" data-passkey-browser-settings><summary>تنظیمات اختیاری گذرکلید مرورگر</summary><p>این روش به ساخت گذرکلید در مرورگر نیاز دارد. فقط اگر می‌خواهید گذرکلیدهای مرورگر را مدیریت کنید این بخش را باز کنید.</p><p class="muted" data-passkey-device-help></p><a class="text-link" href="https://arioshub.ir/login/${state.user.role==='customer'?'client':'team'}?setup=passkey" data-passkey-settings-canonical hidden>ورود و فعال‌سازی در دامنهٔ اصلی آریوس</a><div class="actions"><button type="button" class="button primary" data-passkey-register disabled>ساخت کلید ورود روی این دستگاه</button><button type="button" class="button secondary" data-passkey-reload>تازه‌سازی فهرست</button></div><details class="passkey-save-help"><summary>در مرحلهٔ ذخیره متوقف می‌شود؟</summary><p>${ctx.e(passkeySaveHelp())}</p><button type="button" class="button secondary" data-passkey-register-local disabled>انتخاب همین دستگاه</button></details><p class="passkey-status muted" data-passkey-settings-status role="status" aria-live="polite">در حال دریافت کلیدهای ورود…</p><div class="passkey-device-list" data-passkey-devices></div><p class="muted">ورود با رمز عبور هم در دسترس می‌ماند. اگر کلیدی را نمی‌شناسید یا دیگر از آن استفاده نمی‌کنید، آن را حذف کنید.</p></details></section>`;
}
export function passkeyDeviceHTML(entries,ctx){
  return entries.map(entry=>`<article class="passkey-device"><div><strong>${ctx.e(entry.friendly_name||'کلید ورود من')}</strong>${entry.created_at?`<p class="muted">ثبت: ${ctx.e(ctx.date(entry.created_at))}</p>`:''}<p class="muted">${entry.last_used_at?'آخرین ورود: '+ctx.e(ctx.date(entry.last_used_at)):'هنوز برای ورود استفاده نشده است.'}</p></div><div class="actions"><button type="button" class="button secondary small" data-passkey-rename="${ctx.e(entry.id)}">تغییر نام</button><button type="button" class="button secondary small" data-passkey-remove="${ctx.e(entry.id)}">حذف کلید</button></div></article>`).join('')||'<p class="muted">هنوز کلید ورودی برای این حساب ثبت نشده است.</p>';
}
export function wirePasskeySettings(state,ctx,{scope=globalThis,fetcher=fetch}={}){
  if(!state.user||!roles.has(state.user.role)||nativeBiometricApp(scope))return;
  const root=scope.document?.querySelector?.('[data-passkey-settings-user]');if(!root)return;
  const status=root.querySelector('[data-passkey-settings-status]'),devices=root.querySelector('[data-passkey-devices]'),enroll=root.querySelector('[data-passkey-register]'),local=root.querySelector('[data-passkey-register-local]'),reload=root.querySelector('[data-passkey-reload]');
  const disable=value=>{enroll.disabled=value;if(local)local.disabled=value;};
  const current=()=>root.isConnected!==false&&root.dataset.passkeySettingsUser===state.user.id;
  const message=(text,failed=false)=>{if(current()){status.textContent=text;status.setAttribute('role',failed?'alert':'status');}};
  if(ctx.api?.isStatic||ctx.demo){disable(true);reload.disabled=true;message('برای فعال‌سازی این روش، وارد حساب اصلی آریوس شوید.');return;}
  const help=root.querySelector('[data-passkey-device-help]');if(help)help.textContent=passkeyDeviceHelp(scope);
  const canonical=root.querySelector('[data-passkey-settings-canonical]');
  const support=passkeySupport(scope);disable(true);if(canonical)canonical.hidden=support.code!=='PASSKEY_WRONG_DOMAIN';
  let entries=[],loading=false,configured=true,prepared;
  const prepare=async()=>{prepared=null;disable(true);try{const value=await preparePasskeyRegistration({scope,fetcher});if(current()){prepared=value;disable(false);}}catch(value){message(passkeyMessage(value),true);}};
  const load=async()=>{
    if(loading||!current())return;loading=true;reload.disabled=true;
    try{const [availability,result]=await Promise.all([passkeyAvailability({fetcher}),listPasskeys({fetcher})]);if(!current())return;configured=availability.enabled===true&&availability.domainSupported!==false;entries=result;devices.innerHTML=passkeyDeviceHTML(entries,ctx);wireEntries();message(!support.supported?passkeyMessage({code:support.code}):!configured?passkeyMessage({code:availability.domainSupported===false?'PASSKEY_WRONG_DOMAIN':'PASSKEY_NOT_CONFIGURED'}):'در حال آماده‌سازی اتصال امن این دستگاه…');if(support.supported&&configured){await prepare();if(prepared)message(entries.length?'برای افزودن کلید روی این دستگاه، فعال‌سازی را بزنید.':'آماده است؛ فعال‌سازی را بزنید و پنجرهٔ خود گوشی را تأیید کنید.');}}
    catch(value){message(passkeyMessage(value),true);if(['PASSKEY_NOT_CONFIGURED','PASSWORD_CHANGE_REQUIRED'].includes(value.code))disable(true);}
    finally{loading=false;if(current())reload.disabled=false;}
  };
  const wireEntries=()=>{
    root.querySelectorAll('[data-passkey-rename]').forEach(button=>button.addEventListener('click',()=>{
      const entry=entries.find(item=>item.id===button.dataset.passkeyRename);if(!entry)return;
      ctx.modal({title:'تغییر نام کلید ورود',submitLabel:'ذخیرهٔ نام',body:`<label class="field"><span>نام آشنا برای تشخیص این کلید</span><input name="name" required maxlength="120" value="${ctx.e(entry.friendly_name||'کلید ورود من')}"></label>`,onSubmit:async form=>{await renamePasskey(entry.id,form.get('name'),{fetcher});await load();}});
    }));
    root.querySelectorAll('[data-passkey-remove]').forEach(button=>button.addEventListener('click',()=>{
      const entry=entries.find(item=>item.id===button.dataset.passkeyRemove);if(!entry)return;
      ctx.modal({title:'حذف کلید ورود',submitLabel:'حذف این کلید',body:`<p><strong>${ctx.e(entry.friendly_name||'کلید ورود من')}</strong></p><p>پس از حذف، این کلید دیگر برای ورود به آریوس قابل استفاده نیست. ورود با رمز عبور همچنان در دسترس است.</p>`,onSubmit:async()=>{await removePasskey(entry.id,{fetcher});await load();}});
    }));
  };
  const activate=async preferLocal=>{
    if(enroll.disabled||!current())return;
    if(!prepared||prepared.expires_at*1000<=Date.now()+5000){message('مهلت اتصال تمام شد؛ در حال آماده‌سازی دوباره…');await prepare();if(prepared)message('آماده است؛ برای تأیید گوشی دوباره فعال‌سازی را بزنید.');return;}
    disable(true);reload.disabled=true;
    try{await registerPasskey({fetcher,scope,start:prepared,preferLocal,onStage:stage=>message(stage==='device'?'در پنجرهٔ گوشی با اثر انگشت، چهره یا PIN گوشی / مدیر گذرواژه تأیید کنید؛ رمز آریوس لازم نیست.':'گوشی کلید ورود را ساخت؛ در حال ثبت نهایی در آریوس…')});if(!current())return;await load();message('کلید ورود ثبت شد؛ از این پس می‌توانید با تأیید گوشی وارد شوید.');}
    catch(value){const detail=passkeyMessage(value);await prepare();message(detail,true);}
    finally{if(current()){disable(!support.supported||!configured||!prepared);reload.disabled=false;}}
  };
  enroll.addEventListener('click',()=>activate(false));
  local?.addEventListener('click',()=>activate(true));
  reload.addEventListener('click',load);
  const disclosure=root.querySelector('[data-passkey-browser-settings]');let opened=false;
  const open=()=>{if(!opened&&(!disclosure||disclosure.open)){opened=true;void load();}};
  disclosure?.addEventListener('toggle',open);if(!disclosure||disclosure.open)open();
}
