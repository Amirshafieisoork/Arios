import {latinDigits} from './identity.mjs';
import {hasPermission} from './permissions.mjs';
import {projectCodingFields,projectCodingPayload,wireProjectCodingForm} from './project-coding-form.mjs';
import {SERVICE_TYPES,normalizeCodingText} from './project-coding.mjs';
export {wireProjectCodingForm};

export const PROJECT_APPROVAL_LABELS = Object.freeze(['مسئول پروژه','مسئول واحد','مدیر گروه فنی','واحد فروش','واحد مالی','مدیرعامل']);
const normalCode = value => normalizeCodingText(value).toUpperCase();
const labelOf = (person,ctx) => `${ctx.e(person.name)} · ${ctx.e({manager:'مدیر',worker:'همکار',accountant:'حسابدار'}[person.role]||'')}`;

export function projectLabel(project) {
  return project ? [project.projectCode,project.name].filter(Boolean).join(' · ') : 'پروژه';
}

export function projectViewPermissions(project,user) {
  const role=user?.role, manager=role==='manager', customer=role==='customer';
  const reviewOnly=role==='accountant'||(role==='worker'&&project?.canRecordWork===false);
  const canRecord=hasPermission(user,'reports.submit')&&(manager||(role==='worker'&&!reviewOnly));
  const canViewPrices=hasPermission(user,'projects.prices'),canEdit=hasPermission(user,'projects.edit'),canArchive=hasPermission(user,'projects.archive');
  const tabs={overview:'نمای کلی',...(!customer?{reports:'گزارش‌های کار',dossier:'گزارش تفصیلی'}:{}),...((hasPermission(user,'finance.view')&&canViewPrices)?{finance:'صورت‌حساب‌ها'}:{}),...(!reviewOnly?{materials:'تجهیزات مصرفی',...(canRecord||hasPermission(user,'tasks.manage')?{tasks:'وظایف'}:{}),team:'نیروها',...(hasPermission(user,'documents.view')?{files:'فایل‌ها و تصاویر'}:{}),messages:'گفت‌وگو',support:'پشتیبانی'}:{})};
  return {reviewOnly,canRecord,canViewPrices,canEdit,canArchive,tabs};
}

/** Only visible financial inputs are submitted; a hidden amount is never reset to zero. */
export function projectFinancialFields(project,ctx,user) {
  if(!hasPermission(user,'projects.prices'))return '';
  const amount=(name,label)=>`<label class="field"><span class="field-label">${label} (تومان)</span><input name="${name}" type="number" min="0" step="1" required value="${ctx.e(project?.[name]??0)}"></label>`;
  return `<fieldset class="field full project-financial-fields"><legend>مبالغ پروژه</legend><div class="form-grid">${amount('budget','بودجهٔ داخلی')}${amount('contractAmount','مبلغ قرارداد')}</div><p class="muted">اصلاح این مبالغ، رسیدهای پرداخت و نسخه‌های قبلاً تأییدشدهٔ گزارش را تغییر نمی‌دهد.</p></fieldset>`;
}
export function projectFinancialPayload(form,user) {
  if(!hasPermission(user,'projects.prices'))return {};
  const result={};
  for(const key of ['budget','contractAmount'])if(form.has(key)){
    const raw=latinDigits(String(form.get(key)??'')).trim(),value=Number(raw);
    if(!/^\d+$/.test(raw)||!Number.isSafeInteger(value)||value<0)throw Error('مبلغ پروژه باید عدد صحیح نامنفی به تومان باشد.');
    result[key]=value;
  }
  return result;
}

export function projectMatchesQuery(project,query,users=[]) {
  const key = normalCode(query).replace(/ي/g,'ی').replace(/ك/g,'ک');
  if(!key)return true;
  const lead=users.find(user=>user.id===project.projectManagerId);
  return [project.name,project.type,project.location,project.projectCode,project.customerCode,project.dossierCode,project.dossierTitle,project.serviceCode,users.find(user=>user.id===project.customerId)?.name,lead?.name].some(value=>normalCode(value).replace(/ي/g,'ی').replace(/ك/g,'ک').includes(key));
}

export function projectConfigurationFields(state,ctx,project={}) {
  const active=(state.users||[]).filter(user=>!user.deletedAt);
  const leads=active.filter(user=>['manager','worker'].includes(user.role));
  const reviewers=active.filter(user=>['manager','worker','accountant'].includes(user.role));
  const choices=(items,value)=>`<option value="">انتخاب مسئول…</option>${value&&!items.some(person=>person.id===value)?`<option value="" selected disabled>حساب مسئول قبلی غیرفعال است؛ جایگزین انتخاب کنید</option>`:''}${items.map(person=>`<option value="${ctx.e(person.id)}" ${person.id===value?'selected':''}>${labelOf(person,ctx)}</option>`).join('')}`;
  const configured=project.reviewChain?.length===6;
  return `<fieldset class="field full project-administration"><legend>شناسنامه و گردش تأیید پروژه</legend>
    ${!project.id||project.codingVersion===1?projectCodingFields(state,ctx,project):`    <div class="form-grid project-code-fields" data-legacy-project-identity>
      <label class="field"><span class="field-label">کد پروژه <span aria-hidden="true">*</span></span><input name="projectCode" dir="ltr" autocomplete="off" maxlength="80" required value="${ctx.e(project.projectCode||'')}" placeholder="مثلاً AR-1405-001"><small>کد رسمی خودتان را وارد کنید؛ کد هر پروژه باید یکتا باشد.</small></label>
      <label class="field"><span class="field-label">شماره مشتری <small>(اختیاری)</small></span><input name="customerCode" dir="ltr" maxlength="80" value="${ctx.e(project.customerCode||'')}"></label>
      <label class="field"><span class="field-label">شماره پرونده <small>(اختیاری)</small></span><input name="dossierCode" dir="ltr" maxlength="80" value="${ctx.e(project.dossierCode||'')}"></label>
      <label class="field"><span class="field-label">عنوان پرونده <small>(اختیاری)</small></span><input name="dossierTitle" maxlength="200" value="${ctx.e(project.dossierTitle||'')}"></label>
      <label class="field full"><span class="field-label">مشتری پروژه</span><select name="customerId"><option value="">بدون تخصیص مشتری</option>${active.filter(person=>person.role==='customer').map(person=>`<option value="${ctx.e(person.id)}" ${person.id===project.customerId?'selected':''}>${ctx.e(person.name)}${person.customerCode?' · '+ctx.e(person.customerCode):''}</option>`).join('')}</select></label>
    </div>
<div class="project-coding-convert"><label class="checkbox-label"><input type="checkbox" name="convertProjectCoding" data-coding-convert>تبدیل این پروژه به کدینگ جدید</label><p class="muted">کد قبلی فقط با انتخاب این گزینه تغییر می‌کند؛ سوابق پروژه حفظ می‌شوند.</p><fieldset data-coding-conversion hidden disabled>${projectCodingFields(state,ctx)}</fieldset></div>`}
    <div class="project-approval-help"><strong>شش تأیید گزارش تفصیلی، به ترتیب</strong><p>برای هر جایگاه یک حساب فعال انتخاب کنید. انتخاب یک نفر برای دو مسئولیت مجاز است؛ هر تأیید جداگانه ثبت می‌شود.</p><p>افراد انتخاب‌شده امکان بررسی گزارش تفصیلی همین پروژه را دارند. نقش کلی حساب آن‌ها تغییر نمی‌کند.</p></div>
    <ol class="project-review-settings">${PROJECT_APPROVAL_LABELS.map((label,index)=>`<li><label class="field"><span class="field-label"><b>${ctx.n(index+1)}</b>${ctx.e(label)}</span><select name="${index===0?'projectManagerId':'reviewer'+index}" required>${choices(index===0?leads:reviewers,index===0?project.projectManagerId:project.reviewChain?.[index]?.userId)}</select>${index===0?'<small>این فرد مسئول پروژه و نخستین بررسی‌کنندهٔ گزارش تفصیلی است.</small>':''}</label></li>`).join('')}</ol>
    ${project.id?`<p class="muted project-review-change-note">${configured?'تغییر مسئولان روی نسخه‌های تازهٔ گزارش تفصیلی اثر دارد؛ گردش نسخهٔ ارسال‌شده حفظ می‌شود.':'برای ارسال گزارش تفصیلی، کد پروژه و هر شش مسئول را مشخص کنید.'}</p>`:''}
  </fieldset>`;
}

export function projectConfigurationPayload(form) {
  const structured=form.has('codingVersion')&&form.get('codingVersion')==='1';
  const fixed=form.has('projectCodingFixed');
  const projectCode=normalCode(form.get('projectCode'));
  const projectManagerId=String(form.get('projectManagerId')||'');
  const reviewChain=PROJECT_APPROVAL_LABELS.map((label,index)=>({label,userId:index===0?projectManagerId:String(form.get('reviewer'+index)||'')}));
  if(!structured&&!fixed&&!projectCode)throw new Error('کد پروژه را وارد کنید.');
  if(reviewChain.some(stage=>!stage.userId))throw new Error('مسئول هر شش مرحلهٔ تأیید را انتخاب کنید.');
  const responsibilities={projectManagerId,reviewChain};
  if(fixed)return responsibilities;
  if(structured)return {...projectCodingPayload(form),...responsibilities};
  return {projectCode,...responsibilities,...(form.has('customerId')?{customerId:String(form.get('customerId')||'')||null}:{}),customerCode:normalCode(form.get('customerCode')),dossierCode:normalCode(form.get('dossierCode')),dossierTitle:String(form.get('dossierTitle')||'').trim()};
}

export function renderProjectIdentity(state,project,ctx) {
  const lead=(state.users||[]).find(person=>person.id===project.projectManagerId);
  const editableDossier=project.codingVersion===1&&hasPermission(state.user,'projects.edit',state)&&(state.customerDossiers||[]).some(row=>!row.archivedAt&&(row.id===project.dossierId||row.code===project.dossierCode));
  return `<section class="project-identification" aria-label="شناسنامه و مسئول پروژه"><div><span>کد پروژه</span><strong><bdi dir="ltr">${ctx.e(project.projectCode||'ثبت نشده')}</bdi></strong></div><div><span>مسئول پروژه</span><strong>${ctx.e(lead?.name||'تعیین نشده')}</strong></div>${project.dossierCode?`<div><span>شماره پرونده</span><strong><bdi dir="ltr">${ctx.e(project.dossierCode)}</bdi></strong></div>`:''}${project.dossierTitle?`<div><span>عنوان پرونده</span><strong>${ctx.e(project.dossierTitle)}</strong>${editableDossier?'<button class="text-link project-dossier-rename" type="button" data-action="rename-customer-dossier">ویرایش نام پرونده</button>':''}</div>`:''}${project.customerCode?`<div><span>شماره مشتری</span><strong><bdi dir="ltr">${ctx.e(project.customerCode)}</bdi></strong></div>`:''}${project.serviceCode?`<div><span>نوع خدمات</span><strong>${ctx.e(SERVICE_TYPES.find(item=>item.code===project.serviceCode)?.label||project.type)} · <bdi dir="ltr">${ctx.e(project.serviceCode)}</bdi></strong></div>`:''}${project.projectNumber?`<div><span>شمارهٔ پروژه در پرونده و خدمات</span><strong><bdi dir="ltr">${ctx.e(project.projectNumber)}</bdi></strong></div>`:''}</section>`;
}

export function openCustomerDossierRename(state,ctx,project){
  if(!project||project.codingVersion!==1||!hasPermission(state.user,'projects.edit',state))return;
  const dossier=(state.customerDossiers||[]).find(row=>!row.archivedAt&&(row.id===project.dossierId||row.code===project.dossierCode));if(!dossier)return;
  ctx.modal({title:'ویرایش نام پروندهٔ مشتری',body:`<p class="muted">پروندهٔ <bdi dir="ltr">${ctx.e(dossier.code)}</bdi></p><label class="field"><span class="field-label">نام پرونده / ساختمان / شعبه</span><input name="dossierTitle" value="${ctx.e(dossier.title)}" required maxlength="200"></label><p class="muted">نام پرونده در پروژه‌های مرتبط به‌روزرسانی می‌شود؛ کدها و سوابق گزارش‌ها حفظ می‌شوند.</p>`,onSubmit:form=>{const title=String(form.get('dossierTitle')||'').trim();if(!title)throw Error('نام پرونده را وارد کنید.');return ctx.mutate('customer-dossier.update',{id:dossier.id,title});}});
}

export function renderProjectReviewChain(state,project,ctx) {
  if(!Array.isArray(project.reviewChain)||project.reviewChain.length!==6)return `<section class="card project-config-warning"><h2 class="card-title">گردش تأیید نیاز به تنظیم دارد</h2><p>مسئول پروژه و هر شش تأییدکننده هنوز برای این پروژه مشخص نشده‌اند.</p>${state.user?.role==='manager'?'<button class="button secondary" data-action="update-project">تنظیم کد و مسئولان پروژه</button>':'<p class="muted">مدیر مجموعه، کد و مسئولان پروژه را مشخص می‌کند.</p>'}</section>`;
  return `<section class="card project-review-chain"><div class="card-head"><h2 class="card-title">مسیر تأیید گزارش تفصیلی</h2><small class="muted">به ترتیب از مسئول پروژه تا مدیرعامل</small></div><ol>${PROJECT_APPROVAL_LABELS.map((label,index)=>{const person=(state.users||[]).find(user=>user.id===project.reviewChain[index]?.userId);return `<li><span>${ctx.n(index+1)}</span><div><strong>${ctx.e(label)}</strong><small>${ctx.e(person?.name||'حساب در دسترس نیست')}</small></div></li>`;}).join('')}</ol><p class="muted">هر مرحله پس از تأیید مرحلهٔ قبلی در دسترس مسئول همان جایگاه قرار می‌گیرد.</p><a class="button secondary" href="#project/${encodeURIComponent(project.id)}/dossier">گزارش تفصیلی پروژه</a></section>`;
}

export function renderReportProjectIdentity(report,state,ctx) {
  const project=(state.projects||[]).find(item=>item.id===report.projectId);
  if(!project)return '';
  const person=(state.users||[]).find(item=>item.id===project.projectManagerId);
  return `<div class="report-project-meta"><span>کد پروژه: <bdi dir="ltr">${ctx.e(project.projectCode||'ثبت نشده')}</bdi></span><span>مسئول پروژه: <strong>${ctx.e(person?.name||'تعیین نشده')}</strong></span></div>`;
}
