import {mountPasskeyLogin} from './passkey-client.mjs';
import {mountPasswordRecovery} from './recovery.mjs';
import {landingPage} from './portal-access.mjs';
import './install.mjs';
import {mountPasswordOnboarding} from './password-onboarding.mjs';
const portal=location.pathname.replace(/\/+$/,'').endsWith('/client')?'client':'team';
const client=portal==='client';
const setupPasskey=new URLSearchParams(location.search).get('setup')==='passkey';
const destinationPage=role=>setupPasskey?'settings':landingPage(role);
const set=(selector,value)=>{const el=document.querySelector(selector);if(el)el.textContent=value;};
document.title=(client?'ورود مشتریان':'ورود همکاران')+' | گروه آریوس';
set('[data-portal-tag]',client?'پنل اختصاصی مشتریان':'فضای کار تیم آریوس');
set('[data-story-eyebrow]',client?'همراهِ هر مرحلهٔ پروژه':'یک تیم، یک مسیر مشترک');
document.querySelector('[data-story-title]').innerHTML=client?'از روند کارتان،<br>باخبر بمانید':'کارها کنار هم،<br>روشن‌تر پیش می‌روند';
set('[data-story-description]',client?'پیشرفت پروژه، صورت‌حساب‌ها و گفتگو با تیم را در پنل اختصاصی خودتان دنبال کنید.':'پروژه‌ها، گزارش‌های فعالیت و پیگیری اجرا؛ در یک فضای منظم برای مدیران و اعضای تیم.');
set('[data-story-foot]',client?'اطلاعات پروژهٔ شما، در جای مشخص خودش.':'هر فعالیت ثبت می‌شود، هر قدم قابل پیگیری است.');
set('[data-login-title]',client?'به پنل خودتان خوش آمدید':'به فضای کار خوش آمدید');
set('[data-login-description]',client?'با حساب مشتری خود وارد شوید و پروژه‌هایتان را دنبال کنید.':'همکاران جدید: نام کاربری کد پرسنلی و رمز اولیه شماره موبایل است.');
set('[data-submit-label]',client?'ورود به پنل مشتریان':'ورود به فضای کار');
const alternate=document.querySelector('[data-portal-switch]');
alternate.href=client?'/login/team':'/login/client';
alternate.innerHTML=client?'عضو تیم هستید؟ <strong>ورود همکاران <span>←</span></strong>':'مشتری آریوس هستید؟ <strong>ورود مشتریان <span>←</span></strong>';
const password=document.querySelector('#login-password');
const toggle=document.querySelector('[data-password-toggle]');
toggle.addEventListener('click',()=>{const shown=password.type==='password';password.type=shown?'text':'password';toggle.setAttribute('aria-pressed',String(shown));toggle.setAttribute('aria-label',shown?'پنهان کردن رمز عبور':'نمایش رمز عبور');password.focus();});
const messages={INVALID_CREDENTIALS:'کد پرسنلی، نام کاربری، شماره تماس یا رمز عبور درست نیست. دوباره بررسی کنید.',UNAUTHORIZED:'کد پرسنلی، نام کاربری، شماره تماس یا رمز عبور درست نیست. دوباره بررسی کنید.',INVALID_LOGIN:'کد پرسنلی، نام کاربری، شماره تماس یا رمز عبور درست نیست. دوباره بررسی کنید.',EMAIL_NOT_CONFIRMED:'حساب شما هنوز تأیید نشده است. با مدیر آریوس هماهنگ کنید.',NOT_A_MEMBER:'این حساب هنوز به فضای کار آریوس اضافه نشده است.',FORBIDDEN:'این حساب اجازهٔ ورود به پنل انتخاب‌شده را ندارد.',PORTAL_FORBIDDEN:'این حساب اجازهٔ ورود به پنل انتخاب‌شده را ندارد.',WRONG_PORTAL:'از صفحهٔ ورود متناسب با نقش حسابتان استفاده کنید.',RATE_LIMITED:'تلاش‌های ورود زیاد شده است. کمی بعد دوباره امتحان کنید.'};
const form=document.querySelector('#login-form');
async function enterPanel(data){
 const destination=data.portal==='client'||data.portal==='team'?data.portal:data.user.role==='customer'?'client':'team';
 location.assign('/portal/?portal='+destination+'#'+destinationPage(data.user.role));
}
const onboarding=mountPasswordOnboarding({onComplete:enterPanel,onLogout:()=>location.replace('/login/'+portal)});
form.addEventListener('submit',async event=>{
 event.preventDefault();const error=document.querySelector('#login-error'),button=form.querySelector('[type="submit"]'),label=document.querySelector('[data-submit-label]');
 error.hidden=true;error.textContent='';button.disabled=true;label.textContent='در حال ورود…';
 try{
  const response=await fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier:form.elements.identifier.value.trim(),password:password.value,portal})});
  let data;try{data=await response.json();}catch{throw new Error('پاسخ سرویس ورود قابل دریافت نیست. چند لحظه بعد دوباره امتحان کنید.');}
  if(!response.ok){const raw=typeof data.error==='string'?data.error:data.error?.message;throw new Error(messages[data.code]||(response.status===429?messages.RATE_LIMITED:raw||'ورود انجام نشد. اطلاعات حساب را بررسی کنید.'));}
  if(!data.user)throw new Error('ورود تأیید نشد. لطفاً دوباره امتحان کنید.');
  if(!['manager','worker','customer','warehouse','accountant'].includes(data.user.role))throw new Error('دسترسی حساب شما هنوز آماده نیست. با مدیر آریوس هماهنگ کنید.');
  const temporaryPassword=password.value;password.value='';label.textContent='ورود انجام شد';
  if(onboarding.show(data,{temporaryPassword}))return;
  await enterPanel(data);
 }catch(err){error.textContent=err instanceof TypeError?'ارتباط برقرار نشد. اتصال اینترنت را بررسی و دوباره امتحان کنید.':err.message||'ورود انجام نشد.';error.hidden=false;button.disabled=false;label.textContent=client?'ورود به پنل مشتریان':'ورود به فضای کار';}
});

const browserKeys=document.querySelector('.passkey-login');
const nativeApp=/\bAriosAndroid\/[0-9]/.test(navigator.userAgent||'');
const nativeGuide=document.querySelector('[data-android-app-guide]');if(nativeApp&&nativeGuide)nativeGuide.hidden=true;
if(nativeApp&&browserKeys)browserKeys.hidden=true;
else if(browserKeys){let mounted=false;const mount=()=>{if(!mounted&&browserKeys.open){mounted=true;mountPasskeyLogin({portal,onSuccess:async data=>{password.value='';if(onboarding.show(data))return;await enterPanel(data);}});}};browserKeys.addEventListener('toggle',mount);mount();}
mountPasswordRecovery();
void onboarding.resume();
