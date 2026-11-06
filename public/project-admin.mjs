import {latinDigits} from './identity.mjs';
import {hasPermission} from './permissions.mjs';

export const PROJECT_APPROVAL_LABELS = Object.freeze(['مسئول پروژه','مسئول واحد','مدیر گروه فنی','واحد فروش','واحد مالی','مدیرعامل']);

/** Fixed service type codes for structured project coding (customer-dossier-service-seq). */
export const SERVICE_TYPES = Object.freeze([
  {code:'110', label:'زیرساخت'},
  {code:'111', label:'برق ساختمان'},
  {code:'112', label:'برق صنعتی'},
  {code:'113', label:'هوشمندسازی'},
  {code:'114', label:'الکترونیک'},
  {code:'115', label:'تولید برق'},
  {code:'120', label:'دوربین مدار بسته'},
  {code:'121', label:'سیستم اعلام سرقت'},
  {code:'122', label:'درب و حفاظ'},
  {code:'123', label:'سیستم اعلام حریق'},
  {code:'130', label:'شبکه'},
  {code:'131', label:'سیستم‌های اداری'},
  {code:'132', label:'سیستم VoIP'},
  {code:'140', label:'سیستم صوتی'},
  {code:'141', label:'سیستم تصویری'},
  {code:'142', label:'سیستم نورپردازی'},
]);

const normalCode = value => latinDigits(value ?? '').normalize('NFKC').trim().replace(/[\u200c\u200e\u200f]/g,'').toUpperCase();
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
  return [project.name,project.type,project.location,project.projectCode,project.dossierCode,project.dossierTitle,lead?.name].some(value=>normalCode(value).replace(/ي/g,'ی').replace(/ك/g,'ک').includes(key));
}

/** Compute next 3-digit sequence for a given customer-dossier-service prefix from existing projects. */
export function nextProjectSequence(state, customerCode, dossierPart, serviceCode) {
  const prefix = normalCode(`${customerCode}-${dossierPart}-${serviceCode}-`);
  if (!prefix || prefix.length < 8) return '001';
  let max = 0;
  for (const project of (state.projects || [])) {
    const code = normalCode(project.projectCode || '');
    if (!code.startsWith(prefix)) continue;
    const seq = code.slice(prefix.length);
    if (/^\d{1,3}$/.test(seq)) max = Math.max(max, Number(seq));
  }
  return String(max + 1).padStart(3, '0');
}

export function projectConfigurationFields(state,ctx,project={}) {
  const active=(state.users||[]).filter(user=>!user.deletedAt);
  const leads=active.filter(user=>['manager','worker'].includes(user.role));
  const reviewers=active.filter(user=>['manager','worker','accountant'].includes(user.role));
  const choices=(items,value)=>`<option value="">انتخاب مسئول…</option>${value&&!items.some(person=>person.id===value)?`<option value="" selected disabled>حساب مسئول قبلی غیرفعال است؛ جایگزین انتخاب کنید</option>`:''}${items.map(person=>`<option value="${ctx.e(person.id)}" ${person.id===value?'selected':''}>${labelOf(person,ctx)}</option>`).join('')}`;
  const configured=project.reviewChain?.length===6;
  const isNew = !project.id;

  const serviceOptions = SERVICE_TYPES.map(s => `<option value="${s.code}">${s.code} — ${ctx.e(s.label)}</option>`).join('');
  const dossierOptions = Array.from({length: 99}, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `<option value="${n}">${n}</option>`;
  }).join('');

  // For new projects: structured coding UI that auto-builds the full project code.
  // For existing projects: keep manual fields so historical codes remain editable.
  const codeFields = isNew ? `
    <div class="form-grid project-code-fields project-code-structured" data-project-code-builder>
      <label class="field"><span class="field-label">کد مشتری (۵ رقمی) <span aria-hidden="true">*</span></span>
        <input name="customerCode" dir="ltr" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" required placeholder="مثلاً ۱۰۱۵۱" value="${ctx.e(project.customerCode||'')}">
        <small>از ۱۰۰۰۰ تا ۹۹۹۹۹</small>
      </label>
      <label class="field"><span class="field-label">شماره پرونده <span aria-hidden="true">*</span></span>
        <select name="dossierPart" required>
          <option value="">انتخاب…</option>
          ${dossierOptions}
        </select>
        <small>۰۱ تا ۹۹ — ساختمان / شعبه / خانه</small>
      </label>
      <label class="field"><span class="field-label">نوع خدمات <span aria-hidden="true">*</span></span>
        <select name="serviceCode" required>
          <option value="">انتخاب نوع خدمات…</option>
          ${serviceOptions}
        </select>
      </label>
      <label class="field"><span class="field-label">عنوان پرونده <small>(اختیاری)</small></span>
        <input name="dossierTitle" maxlength="200" value="${ctx.e(project.dossierTitle||'')}" placeholder="مثلاً گروه مانا مستر">
      </label>
      <label class="field full"><span class="field-label">کد کامل پروژه (خودکار)</span>
        <input name="projectCode" dir="ltr" readonly required maxlength="80" value="" placeholder="پس از انتخاب مشتری، پرونده و خدمات ساخته می‌شود">
        <small>فرمت: کدمشتری-پرونده-خدمات-شماره · مثال ۱۰۱۵۱-۰۱-۱۱۰-۰۰۱</small>
      </label>
      <input type="hidden" name="dossierCode" value="">
    </div>
  ` : `
    <div class="form-grid project-code-fields">
      <label class="field"><span class="field-label">کد پروژه <span aria-hidden="true">*</span></span><input name="projectCode" dir="ltr" autocomplete="off" maxlength="80" required value="${ctx.e(project.projectCode||'')}" placeholder="مثلاً ۱۰۱۵۱-۰۱-۱۱۰-۰۰۱"><small>کد رسمی پروژه؛ باید یکتا باشد.</small></label>
      <label class="field"><span class="field-label">شماره مشتری <small>(اختیاری)</small></span><input name="customerCode" dir="ltr" maxlength="80" value="${ctx.e(project.customerCode||'')}"></label>
      <label class="field"><span class="field-label">شماره پرونده <small>(اختیاری)</small></span><input name="dossierCode" dir="ltr" maxlength="80" value="${ctx.e(project.dossierCode||'')}"></label>
      <label class="field"><span class="field-label">عنوان پرونده <small>(اختیاری)</small></span><input name="dossierTitle" maxlength="200" value="${ctx.e(project.dossierTitle||'')}"></label>
    </div>
  `;

  return `<fieldset class="field full project-administration"><legend>شناسنامه و گردش تأیید پروژه</legend>
    ${codeFields}
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

  let customerCode = normalCode(form.get('customerCode'));
  let dossierCode = normalCode(form.get('dossierCode'));
  const dossierTitle = String(form.get('dossierTitle')||'').trim();
  const dossierPart = normalCode(form.get('dossierPart')||'');
  const serviceCode = normalCode(form.get('serviceCode')||'');

  // When structured fields are present (new project), rebuild dossierCode and validate shape.
  if (dossierPart && serviceCode) {
    if (!/^\d{5}$/.test(customerCode)) throw new Error('کد مشتری باید دقیقاً ۵ رقم (از ۱۰۰۰۰ تا ۹۹۹۹۹) باشد.');
    if (!/^\d{2}$/.test(dossierPart) || Number(dossierPart) < 1 || Number(dossierPart) > 99) throw new Error('شماره پرونده باید بین ۰۱ تا ۹۹ باشد.');
    if (!SERVICE_TYPES.some(s => s.code === serviceCode)) throw new Error('نوع خدمات معتبر نیست.');
    dossierCode = `${customerCode}-${dossierPart}`;
    // Ensure projectCode matches the structured format
    const expectedPrefix = `${customerCode}-${dossierPart}-${serviceCode}-`;
    if (!projectCode.startsWith(expectedPrefix) || !/^\d{3}$/.test(projectCode.slice(expectedPrefix.length))) {
      throw new Error('کد پروژه با ساختار انتخاب‌شده هم‌خوانی ندارد. لطفاً دوباره انتخاب کنید تا کد تازه ساخته شود.');
    }
  }

  return {projectCode,projectManagerId,customerCode,dossierCode,dossierTitle,reviewChain};
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

/** Wire live code generation after the modal form is shown (new project only). */
export function wireProjectCodeBuilder(state, form) {
  if (!form) return;
  const builder = form.querySelector('[data-project-code-builder]');
  if (!builder) return;

  const customerInput = form.querySelector('[name="customerCode"]');
  const dossierSelect = form.querySelector('[name="dossierPart"]');
  const serviceSelect = form.querySelector('[name="serviceCode"]');
  const projectCodeInput = form.querySelector('[name="projectCode"]');
  const dossierCodeHidden = form.querySelector('[name="dossierCode"]');

  const update = () => {
    const customer = normalCode(customerInput?.value || '');
    const dossier = normalCode(dossierSelect?.value || '');
    const service = normalCode(serviceSelect?.value || '');
    if (/^\d{5}$/.test(customer) && /^\d{2}$/.test(dossier) && service) {
      const seq = nextProjectSequence(state, customer, dossier, service);
      const full = `${customer}-${dossier}-${service}-${seq}`;
      if (projectCodeInput) projectCodeInput.value = full;
      if (dossierCodeHidden) dossierCodeHidden.value = `${customer}-${dossier}`;
    } else {
      if (projectCodeInput) projectCodeInput.value = '';
      if (dossierCodeHidden) dossierCodeHidden.value = '';
    }
  };

  customerInput?.addEventListener('input', update);
  customerInput?.addEventListener('change', update);
  dossierSelect?.addEventListener('change', update);
  serviceSelect?.addEventListener('change', update);
  update();
}
