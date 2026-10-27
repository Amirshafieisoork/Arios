import {managementRoleSnapshot} from './management-roles.mjs';
const rows=value=>Array.isArray(value)?value:[];
const staff=new Set(['manager','worker','warehouse','accountant']);
function details(state,ctx){return state.managementRoles||((ctx.api?.isStatic||ctx.demo)?managementRoleSnapshot(state,state.user):null);}
function candidates(state,ctx){return rows(state.users).filter(person=>person.id!==state.user.id&&!person.deletedAt&&staff.has(person.role)&&!person.loginNeedsReview&&(person.loginEnabled===true||ctx.api?.isStatic||ctx.demo));}
export function renderManagementRoleSettings(state,ctx){
  if(state.user?.role!=='manager')return '';
  const role=details(state,ctx);
  if(!role)return '<section class="card"><h2>مدیریت اصلی مجموعه</h2><p class="muted">وضعیت مدیریت دریافت نشده است؛ صفحه را دوباره باز کنید.</p></section>';
  const eligible=candidates(state,ctx);
  return `<section class="card management-role-settings"><div class="card-head"><div><h2>مدیر اصلی و مدیر فنی</h2><p class="muted">مدیر اصلی: <strong>${ctx.e(role.primaryManagerName||'نیازمند بررسی')}</strong></p></div><span class="badge">نقش شما: ${ctx.e(role.managementTitle||'مدیر فنی')}</span></div><p>مدیر اصلی اختیار مدیریت مجموعه و تعیین مدیر اصلی بعدی را دارد. پس از واگذاری، حساب شما با عنوان مدیر فنی و دسترسی‌های کاری فعلی باقی می‌ماند.</p>${role.canTransferPrimary?`<div class="actions"><button type="button" class="button primary" data-primary-manager-transfer ${!eligible.length?'disabled':''}>تعیین مدیر اصلی</button></div>${!eligible.length?'<p class="muted">ابتدا برای همکار مورد نظر حساب ورود فعال بسازید؛ مشتری یا حساب حذف‌شده قابل انتخاب نیست.</p>':''}`:'<p class="muted">تغییر مدیر اصلی فقط از حساب مدیر اصلی فعلی انجام می‌شود.</p>'}</section>`;
}
export function wireManagementRoleSettings(state,ctx){
  if(state.user?.role!=='manager')return;
  document.querySelectorAll('[data-primary-manager-transfer]').forEach(button=>button.addEventListener('click',()=>{
    const role=details(state,ctx),eligible=candidates(state,ctx);
    if(!role?.canTransferPrimary||!eligible.length)return ctx.toast('تعیین مدیر اصلی برای این حساب فعال نیست.');
    const requestId=globalThis.crypto.randomUUID();
    ctx.modal({title:'تعیین مدیر اصلی مجموعه',submitLabel:'تأیید واگذاری مدیریت اصلی',body:`<label class="field"><span>همکار دارای حساب ورود فعال</span><select name="id" required><option value="">انتخاب همکار</option>${eligible.map(person=>`<option value="${ctx.e(person.id)}">${ctx.e(person.name)}</option>`).join('')}</select></label><p class="notice">فرد انتخاب‌شده مدیر اصلی می‌شود و اختیار مدیریت کامل مجموعه را خواهد داشت. حساب «${ctx.e(state.user.name)}» به‌عنوان مدیر فنی با دسترسی‌های کاری فعلی باقی می‌ماند. تعیین مدیر اصلی بعدی در اختیار فرد انتخاب‌شده خواهد بود.</p><label class="checkbox-label"><input name="confirmed" type="checkbox" required>واگذاری مدیریت اصلی به فرد انتخاب‌شده را تأیید می‌کنم.</label>`,onSubmit:async data=>{
      const target=eligible.find(person=>person.id===data.get('id'));
      if(!target||!data.has('confirmed'))throw new Error('همکار و تأیید واگذاری را مشخص کنید.');
      await ctx.mutate('account.primary-manager.transfer',{id:target.id,expectedPrimaryManagerId:role.primaryManagerId,expectedVersion:role.version,requestId});
      ctx.toast(`«${target.name}» مدیر اصلی شد؛ حساب شما مدیر فنی باقی ماند.`);
    }});
  }));
}
