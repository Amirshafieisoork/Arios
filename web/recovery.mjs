/** Phone accounts use a manager-approved reset; no SMS service is configured. */
export function mountPasswordRecovery() {
  const login=document.querySelector('#login-form'),form=document.querySelector('#recovery-form'),open=document.querySelector('[data-forgot-password]'),back=document.querySelector('[data-back-to-login]');
  if(!login||!form||!open||!back)return;
  const message=form.querySelector('[data-recovery-message]'),submit=form.querySelector('[type="submit"]');
  open.addEventListener('click',()=>{login.hidden=true;open.hidden=true;form.hidden=false;message.textContent='';form.querySelector('[name="identifier"]')?.focus();});
  back.addEventListener('click',()=>{form.hidden=true;login.hidden=false;open.hidden=false;login.querySelector('[name="identifier"]')?.focus();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();submit.disabled=true;message.textContent='در حال ثبت درخواست…';message.setAttribute('role','status');
    try{
      const identifier=form.querySelector('[name="identifier"]').value.trim();
      const response=await fetch('/api/password-reset/request',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier})});
      if(!response.ok)throw Error(response.status===429?'درخواست‌های زیادی ثبت شده؛ کمی بعد دوباره تلاش کنید':'ثبت درخواست انجام نشد؛ دوباره تلاش کنید');
      message.textContent='درخواست ثبت شد؛ برای تأیید هویت و دریافت رمز تازه با مدیر آریوس هماهنگ کنید. پیامک یا ایمیل خودکار ارسال نمی‌شود.';
      form.querySelector('[name="identifier"]').value='';
    }catch(error){message.textContent=error instanceof TypeError?'ارتباط برقرار نشد؛ اینترنت را بررسی و دوباره تلاش کنید':error.message;message.setAttribute('role','alert');}
    finally{submit.disabled=false;}
  });
}
