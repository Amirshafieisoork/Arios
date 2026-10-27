import {listPasskeys,registerPasskey,renamePasskey,removePasskey,passkeySupport,passkeyMessage,passkeyAvailability} from './passkey-client.mjs';
const roles=new Set(['manager','worker','customer','warehouse','accountant']);
export function renderPasskeySettings(state,ctx){
  if(!state.user||!roles.has(state.user.role))return '';
  return `<section class="card passkey-settings" data-passkey-settings-user="${ctx.e(state.user.id)}"><div class="card-head"><div><h2>ورود با اثر انگشت یا چهره</h2><p class="muted">با یک‌بار فعال‌سازی، دفعات بعد با تأیید گوشی وارد شوید.</p></div></div><p>اطلاعات اثر انگشت یا چهره روی دستگاه شما می‌ماند. بسته به تنظیم گوشی، تأیید با اثر انگشت، تشخیص چهره یا رمز قفل دستگاه انجام می‌شود.</p><div class="actions"><button type="button" class="button primary" data-passkey-register>فعال‌سازی ورود با اثر انگشت</button><button type="button" class="button secondary" data-passkey-reload>تازه‌سازی فهرست</button></div><p class="passkey-status muted" data-passkey-settings-status role="status" aria-live="polite">در حال دریافت کلیدهای ورود…</p><div class="passkey-device-list" data-passkey-devices></div><p class="muted">ورود با رمز عبور هم در دسترس می‌ماند. اگر کلیدی را نمی‌شناسید یا دیگر از آن استفاده نمی‌کنید، آن را حذف کنید.</p></section>`;
}
export function passkeyDeviceHTML(entries,ctx){
  return entries.map(entry=>`<article class="passkey-device"><div><strong>${ctx.e(entry.friendly_name||'کلید ورود من')}</strong>${entry.created_at?`<p class="muted">ثبت: ${ctx.e(ctx.date(entry.created_at))}</p>`:''}<p class="muted">${entry.last_used_at?'آخرین ورود: '+ctx.e(ctx.date(entry.last_used_at)):'هنوز برای ورود استفاده نشده است.'}</p></div><div class="actions"><button type="button" class="button secondary small" data-passkey-rename="${ctx.e(entry.id)}">تغییر نام</button><button type="button" class="button secondary small" data-passkey-remove="${ctx.e(entry.id)}">حذف کلید</button></div></article>`).join('')||'<p class="muted">هنوز کلید ورودی برای این حساب ثبت نشده است.</p>';
}
export function wirePasskeySettings(state,ctx,{scope=globalThis,fetcher=fetch}={}){
  if(!state.user||!roles.has(state.user.role))return;
  const root=scope.document?.querySelector?.('[data-passkey-settings-user]');if(!root)return;
  const status=root.querySelector('[data-passkey-settings-status]'),devices=root.querySelector('[data-passkey-devices]'),enroll=root.querySelector('[data-passkey-register]'),reload=root.querySelector('[data-passkey-reload]');
  const current=()=>root.isConnected!==false&&root.dataset.passkeySettingsUser===state.user.id;
  const message=(text,failed=false)=>{if(current()){status.textContent=text;status.setAttribute('role',failed?'alert':'status');}};
  if(ctx.api?.isStatic||ctx.demo){enroll.disabled=true;reload.disabled=true;message('برای فعال‌سازی این روش، وارد حساب اصلی آریوس شوید.');return;}
  const support=passkeySupport(scope);if(!support.supported)enroll.disabled=true;
  let entries=[],loading=false,configured=true;
  const load=async()=>{
    if(loading||!current())return;loading=true;reload.disabled=true;
    try{const [availability,result]=await Promise.all([passkeyAvailability({fetcher}),listPasskeys({fetcher})]);if(!current())return;configured=availability.enabled===true&&availability.domainSupported!==false;enroll.disabled=!support.supported||!configured;entries=result;devices.innerHTML=passkeyDeviceHTML(entries,ctx);wireEntries();message(!support.supported?passkeyMessage({code:support.code}):!configured?passkeyMessage({code:availability.domainSupported===false?'PASSKEY_WRONG_DOMAIN':'PASSKEY_NOT_CONFIGURED'}):'');}
    catch(value){message(passkeyMessage(value),true);if(value.code==='PASSKEY_NOT_CONFIGURED')enroll.disabled=true;}
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
  enroll.addEventListener('click',async()=>{
    if(enroll.disabled||!current())return;enroll.disabled=true;message('در انتظار تأیید گوشی…');
    try{await registerPasskey({fetcher,scope});if(!current())return;await load();message('کلید ورود ثبت شد؛ از این پس می‌توانید با تأیید گوشی وارد شوید.');}
    catch(value){message(passkeyMessage(value),true);}
    finally{if(current())enroll.disabled=!support.supported||!configured;}
  });
  reload.addEventListener('click',load);void load();
}
