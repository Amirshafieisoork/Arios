import {latinDigits} from './identity.mjs';

export const PROJECT_APPROVAL_LABELS = Object.freeze(['مسئول پروژه','مسئول واحد','مدیر گروه فنی','واحد فروش','واحد مالی','مدیرعامل']);
const normalCode = value => latinDigits(value ?? '').normalize('NFKC').trim().replace(/[\u200c\u200e\u200f]/g,'').toUpperCase();
const labelOf = (person,ctx) => `${ctx.e(person.name)} · ${ctx.e({manager:'مدیر',worker:'همکار',accountant:'حسابدار'}[person.role]||'')}`;

export function projectLabel(project) {
  return project ? [project.projectCode,project.name].filter(Boolean).join(' · ') : 'پروژه';
}

export function projectViewPermissions(project,user) {
  const role=user?.role, manager=role==='manager', customer=role==='customer';
  const reviewOnly=role==='accountant'||(role==='worker'&&project?.canRecordWork===false);
  const canRecord=manager||(role==='worker'&&!reviewOnly);
  const tabs={overview:'نمای کلی',...(!customer?{reports:'گزارش‌های کار',dossier:'گزارش تفصیلی'}:{}),...((manager||customer||role==='accountant')?{finance:'صورت‌حساب‌ها'}:{}),...(!reviewOnly?{materials:'تجهیزات مصرفی',...(canRecord?{tasks:'وظایف'}:{}),team:'نیروها',files:'فایل‌ها و تصاویر',messages:'گفت‌وگو',support:'پشتیبانی'}:{})};
  return {reviewOnly,canRecord,tabs};
}

export function projectMatchesQuery(project,query,users=[]) {
  const key = normalCode(query).replace(/ي/g,'ی').replace(/ك/g,'ک');
  if(!key)return true;
  const lead=users.find(user=>user.id===project.projectManagerId);
  return [project.name,project.type,project.location,project.projectCode,project.dossierCode,project.dossierTitle,lead?.name].some(value=>normalCode(value).replace(/ي/g,'ی').replace(/ك/g,'ک').includes(key));
}

export function projectConfigurationFields(state,ctx,project={}) {
  const active=(state.users||[]).filter(user=>!user.deletedAt);
  const leads=active.filter(user=>['manager','worker'].includes(user.role));
  const reviewers=active.filter(user=>['manager','worker','accountant'].includes(user.role));
  const choices=(items,value)=>`<option value="">انتخاب مسئول…</option>${value&&!items.some(person=>person.id===value)?`<option value="" selected disabled>حساب مسئول قبلی غیرفعال است؛ جایگزین انتخاب کنید</option>`:''}${items.map(person=>`<option value="${ctx.e(person.id)}" ${person.id===value?'selected':''}>${labelOf(person,ctx)}</option>`).join('')}`;
  const configured=project.reviewChain?.length===6;
  return `<fieldset class="field full project-administration"><legend>شناسنامه و گردش تأیید پروژه</legend>
    <div class="form-grid project-code-fields">
      <label class="field"><span class="field-label">کد پروژه <span aria-hidden="true">*</span></span><input name="projectCode" dir="ltr" autocomplete="off" maxlength="80" required value="${ctx.e(project.projectCode||'')}" placeholder="مثلاً AR-1405-001"><small>کد رسمی خودتان را وارد کنید؛ کد هر پروژه باید یکتا باشد.</small></label>
      <label class="field"><span class="field-label">شماره مشتری <small>(اختیاری)</small></span><input name="customerCode" dir="ltr" maxlength="80" value="${ctx.e(project.customerCode||'')}"></label>
      <label class="field"><span class="field-label">شماره پرونده <small>(اختیاری)</small></span><input name="dossierCode" dir="ltr" maxlength="80" value="${ctx.e(project.dossierCode||'')}"></label>
      <label class="field"><span class="field-label">عنوان پرونده <small>(اختیاری)</small></span><input name="dossierTitle" maxlength="200" value="${ctx.e(project.dossierTitle||'')}"></label>
    </div>
    <div class="project-approval-help"><strong>شش تأیید گزارش تفصیلی، به ترتیب</strong><p>برای هر جایگاه یک حساب فعال انتخاب کنید. انتخاب یک نفر برای دو مسئولیت مجاز است؛ هر تأیید جداگانه ثبت می‌شود.</p><p>افراد انتخاب‌شده امکان بررسی گزارش تفصیلی همین پروژه را دارند. نقش کلی حساب آن‌ها تغییر نمی‌کند.</p></div>
    <ol class="project-review-settings">${PROJECT_APPROVAL_LABELS.map((label,index)=>`<li><label class="field"><span class="field-label"><b>${ctx.n(index+1)}</b>${ctx.e(label)}</span><select name="${index===0?'projectManagerId':'reviewer'+index}" required>${choices(index===0?leads:reviewers,index===0?project.projectManagerId:project.reviewChain?.[index]?.userId)}</select>${index===0?'<small>این فرد مسئول پروژه و نخستین بررسی‌کنندهٔ گزارش تفصیلی است.</small>':''}</label></li>`).join('')}</ol>
    ${project.id?`<p class="muted project-review-change-note">${configured?'تغییر مسئولان روی نسخه‌های تازهٔ گزارش تفصیلی اثر دارد؛ گردش نسخهٔ ارسال‌شده حفظ می‌شود.':'برای ارسال گزارش تفصیلی، کد پروژه و هر شش مسئول را مشخص کنید.'}</p>`:''}
  </fieldset>`;
}

export function projectConfigurationPayload(form) {
  const projectCode=normalCode(form.get('projectCode'));
  const projectManagerId=String(form.get('projectManagerId')||'');
  const reviewChain=PROJECT_APPROVAL_LABELS.map((label,index)=>({label,userId:index===0?projectManagerId:String(form.get('reviewer'+index)||'')}));
  if(!projectCode)throw new Error('کد پروژه را وارد کنید.');
  if(reviewChain.some(stage=>!stage.userId))throw new Error('مسئول هر شش مرحلهٔ تأیید را انتخاب کنید.');
  return {projectCode,projectManagerId,customerCode:normalCode(form.get('customerCode')),dossierCode:normalCode(form.get('dossierCode')),dossierTitle:String(form.get('dossierTitle')||'').trim(),reviewChain};
}

export function renderProjectIdentity(state,project,ctx) {
  const lead=(state.users||[]).find(person=>person.id===project.projectManagerId);
  return `<section class="project-identification" aria-label="شناسنامه و مسئول پروژه"><div><span>کد پروژه</span><strong><bdi dir="ltr">${ctx.e(project.projectCode||'ثبت نشده')}</bdi></strong></div><div><span>مسئول پروژه</span><strong>${ctx.e(lead?.name||'تعیین نشده')}</strong></div>${project.dossierCode?`<div><span>شماره پرونده</span><strong><bdi dir="ltr">${ctx.e(project.dossierCode)}</bdi></strong></div>`:''}${project.dossierTitle?`<div><span>عنوان پرونده</span><strong>${ctx.e(project.dossierTitle)}</strong></div>`:''}${project.customerCode?`<div><span>شماره مشتری</span><strong><bdi dir="ltr">${ctx.e(project.customerCode)}</bdi></strong></div>`:''}</section>`;
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
