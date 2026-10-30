/** First-login password changes stay inside the authenticated, same-origin flow. */
export const passwordChangeRequired = data => data?.passwordChangeRequired === true || data?.user?.passwordChangeRequired === true;

export function passwordChangeURL(role = 'worker') {
  return '/login/' + (role === 'customer' ? 'client' : 'team') + '?change=password';
}

export function mountPasswordOnboarding({scope=globalThis,fetcher=fetch,onComplete=async()=>{},onLogout=()=>{}}={}) {
  const doc=scope.document,form=doc?.querySelector?.('#first-password-form');
  if(!form||typeof form.querySelector!=='function')return {show:()=>false,resume:async()=>false};
  const current=form.querySelector('[name="currentPassword"]'),next=form.querySelector('[name="newPassword"]'),confirm=form.querySelector('[name="confirmPassword"]'),error=form.querySelector('[data-password-change-error]'),submit=form.querySelector('[type="submit"]'),status=form.querySelector('[data-password-change-status]');
  let viewer=null,busy=false;
  const active=()=>form.isConnected!==false&&!form.hidden;
  const message=(text,failed=false)=>{error.textContent=text;error.hidden=!text;error.setAttribute('role',failed?'alert':'status');};
  const clear=()=>{current.value='';next.value='';confirm.value='';viewer=null;};
  const hideLogin=hidden=>{
    for(const selector of ['#login-form','.passkey-login','[data-forgot-password]','#recovery-form','[data-portal-switch]']){
      const node=doc.querySelector(selector);if(node)node.hidden=selector==='#recovery-form'?true:hidden;
    }
  };
  const show=(data,{temporaryPassword=''}={})=>{
    if(!passwordChangeRequired(data)||!data.user)return false;
    viewer=data.user;hideLogin(true);form.hidden=false;submit.disabled=false;message('');
    current.value=typeof temporaryPassword==='string'?temporaryPassword:'';next.value='';confirm.value='';
    const heading=doc.querySelector('[data-login-title]'),description=doc.querySelector('[data-login-description]');
    if(heading)heading.textContent='رمز شخصی خودتان را انتخاب کنید';
    if(description)description.textContent='این اولین ورود شماست. برای بازشدن پنل، رمز اولیهٔ شماره تماس را تغییر دهید.';
    if(status)status.textContent='اطلاعات حسابتان تا ثبت رمز تازه باز نمی‌شود.';
    const url=passwordChangeURL(viewer.role),setup=new URLSearchParams(scope.location?.search||'').get('setup')==='passkey';
    try{scope.history?.replaceState?.(null,'',url+(setup?'&setup=passkey':''));}catch{}
    next.focus();return true;
  };
  form.querySelector('[data-password-change-toggle]')?.addEventListener('click',event=>{
    const shown=next.type==='password';for(const input of [current,next,confirm])input.type=shown?'text':'password';
    const button=event.currentTarget;button.setAttribute('aria-pressed',String(shown));button.textContent=shown?'پنهان کردن رمزها':'نمایش رمزها';
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!active())return;message('');
    if(typeof next.value!=='string'||next.value.length<6||next.value.length>128){message('رمز تازه باید بین ۶ تا ۱۲۸ نویسه باشد.',true);next.focus();return;}
    if(next.value!==confirm.value){message('تکرار رمز تازه با خود رمز یکسان نیست.',true);confirm.focus();return;}
    if(!current.value){message('رمز فعلی حساب را وارد کنید؛ برای ورود اول همان شماره تماس است.',true);current.focus();return;}
    if(next.value===current.value){message('رمز تازه باید با رمز اولیه متفاوت باشد.',true);next.focus();return;}
    busy=true;submit.disabled=true;if(status)status.textContent='در حال ذخیرهٔ رمز شخصی شما…';
    try{
      const response=await fetcher('/api/account/password',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:current.value,newPassword:next.value})});
      let data;try{data=await response.json();}catch{throw Error('پاسخ سرویس دریافت نشد؛ دوباره تلاش کنید.');}
      if(!response.ok){const text=typeof data.error==='string'?data.error:'تغییر رمز انجام نشد؛ دوباره تلاش کنید.';throw Error(text);}
      if(!data.user||data.user.id!==viewer?.id||passwordChangeRequired(data))throw Error('ثبت رمز هنوز تأیید نشده است؛ دوباره تلاش کنید.');
      clear();form.hidden=true;if(status)status.textContent='رمز شخصی ذخیره شد؛ در حال ورود به پنل…';await onComplete(data);
    }catch(value){if(active()){message(value instanceof TypeError?'ارتباط برقرار نشد؛ اتصال اینترنت را بررسی کنید.':value.message||'تغییر رمز انجام نشد.',true);if(status)status.textContent='پس از ثبت موفق رمز، پنل باز می‌شود.';}}
    finally{busy=false;if(active())submit.disabled=false;}
  });
  form.querySelector('[data-password-change-logout]')?.addEventListener('click',async()=>{
    if(busy)return;busy=true;submit.disabled=true;
    try{const response=await fetcher('/api/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error('خروج انجام نشد؛ دوباره تلاش کنید.');clear();onLogout();}
    catch(value){message(value.message||'خروج انجام نشد.',true);}
    finally{busy=false;if(active())submit.disabled=false;}
  });
  const resume=async()=>{
    if(new URLSearchParams(scope.location?.search||'').get('change')!=='password')return false;
    try{const response=await fetcher('/api/session',{credentials:'same-origin'});if(!response.ok)return false;const data=await response.json();if(show(data))return true;if(data.user)await onComplete(data);return Boolean(data.user);}
    catch{message('برای ادامه دوباره با شماره تماس و رمز فعلی وارد شوید.',true);return false;}
  };
  return {show,resume};
}
