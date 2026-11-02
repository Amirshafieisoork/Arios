import {latinDigits} from './identity.mjs';
import {PROJECT_SERVICE_TYPES,customerCodeFor,dossierCasesForCustomer,dossierNumber,nextDossierNumber as nextDossierNumberForForm,storedCustomerCode,structuredProjectCode} from './project-coding.mjs';

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
  return [project.name,project.type,project.serviceCode,project.location,project.projectCode,project.dossierCode,project.dossierTitle,project.customerCode,lead?.name].some(value=>normalCode(value).replace(/ي/g,'ی').replace(/ك/g,'ک').includes(key));
}

function reviewFields(state,ctx,project={}) {
  const active=(state.users||[]).filter(user=>!user.deletedAt);
  const leads=active.filter(user=>['manager','worker'].includes(user.role));
  const reviewers=active.filter(user=>['manager','worker','accountant'].includes(user.role));
  const choices=(items,value)=>`<option value="">انتخاب مسئول…</option>${value&&!items.some(person=>person.id===value)?`<option value="" selected disabled>حساب مسئول قبلی غیرفعال است؛ جایگزین انتخاب کنید</option>`:''}${items.map(person=>`<option value="${ctx.e(person.id)}" ${person.id===value?'selected':''}>${labelOf(person,ctx)}</option>`).join('')}`;
  const configured=project.reviewChain?.length===6;
  return `<div class="project-approval-help"><strong>شش تأیید گزارش تفصیلی، به ترتیب</strong><p>برای هر جایگاه یک حساب فعال انتخاب کنید. انتخاب یک نفر برای دو مسئولیت مجاز است؛ هر تأیید جداگانه ثبت می‌شود.</p><p>افراد انتخاب‌شده امکان بررسی گزارش تفصیلی همین پروژه را دارند. نقش کلی حساب آن‌ها تغییر نمی‌کند.</p></div><ol class="project-review-settings">${PROJECT_APPROVAL_LABELS.map((label,index)=>`<li><label class="field"><span class="field-label"><b>${ctx.e(ctx.n(index+1))}</b>${ctx.e(label)}</span><select name="${index===0?'projectManagerId':'reviewer'+index}" required>${choices(index===0?leads:reviewers,index===0?project.projectManagerId:project.reviewChain?.[index]?.userId)}</select>${index===0?'<small>این فرد مسئول پروژه و نخستین بررسی‌کنندهٔ گزارش تفصیلی است.</small>':''}</label></li>`).join('')}</ol>${project.id?`<p class="muted project-review-change-note">${configured?'تغییر مسئولان روی نسخه‌های تازهٔ گزارش تفصیلی اثر دارد؛ گردش نسخهٔ ارسال‌شده حفظ می‌شود.':'برای ارسال گزارش تفصیلی، کد پروژه و هر شش مسئول را مشخص کنید.'}</p>`:''}`;
}
function safeCustomerCode(state,id){try{return customerCodeFor(state,id);}catch{return '';}}
function codedProjectFields(state,ctx,project={}){
  if(!project.id){
    const customers=(state.users||[]).filter(user=>user.role==='customer'&&!user.deletedAt);
    const customerOptions=customers.map(person=>{const code=safeCustomerCode(state,person.id);return `<option value="${ctx.e(person.id)}">${code?`${code} · `:'کد نیازمند بررسی · '}${ctx.e(person.name)}</option>`;}).join('');
    return `<fieldset class="field full project-coding-section" data-project-coding><legend>کدگذاری پروژه</legend><p class="project-coding-intro">کد پروژه با الگوی <bdi dir="ltr">کد مشتری ـ پرونده ـ نوع خدمت ـ شمارهٔ سه‌رقمی</bdi> ساخته می‌شود؛ شماره‌ها خودکار و یکتا هستند.</p><p class="project-coding-ranges">کد تأمین‌کننده: ۱۰۰۰ تا ۹۹۹۹ · کد مشتری: ۱۰۰۰۰ تا ۹۹۹۹۹ · کد پرسنلی آریوس: ۱۰۰۰۰۰ تا ۹۹۹۹۹۹</p><div class="form-grid project-coding-grid"><label class="field"><span class="field-label">مشتری <span aria-hidden="true">*</span></span><select name="customerId" required><option value="">انتخاب مشتری…</option>${customerOptions}</select><small>اگر هنوز مشتری در فهرست نیست، ابتدا از بخش «افراد و همکاری» حساب مشتری بسازید.</small></label><label class="field"><span class="field-label">کد پنج‌رقمی مشتری <span aria-hidden="true">*</span></span><input name="customerCode" data-customer-code-preview dir="ltr" inputmode="numeric" autocomplete="off" maxlength="5" required placeholder="پس از انتخاب مشتری"><small>اگر مشتری شمارهٔ قبلی دارد، همین‌جا وارد کنید؛ در غیر این صورت کد پیشنهادی را نگه دارید. کد ثبت‌شده برای مشتری قفل می‌شود.</small></label><label class="field"><span class="field-label">پروندهٔ ساختمان / شعبه / خانه <span aria-hidden="true">*</span></span><select name="dossierChoice" required disabled><option value="">ابتدا مشتری را انتخاب کنید</option></select><small>پرونده‌های قبلی را انتخاب کنید یا پروندهٔ تازه بسازید؛ سقف هر مشتری ۹۹ پرونده است.</small></label><label class="field"><span class="field-label">نام پرونده <span aria-hidden="true">*</span></span><input name="dossierTitle" maxlength="200" required placeholder="مثلاً گروه مانا مستر"></label><label class="field"><span class="field-label">نوع خدمات پروژه <span aria-hidden="true">*</span></span><select name="serviceCode" required><option value="">انتخاب نوع خدمت…</option>${PROJECT_SERVICE_TYPES.map(item=>`<option value="${item.code}">${ctx.e(item.code)} · ${ctx.e(item.label)}</option>`).join('')}</select></label><div class="field project-code-preview-field"><span class="field-label">کد پروژهٔ پیشنهادی</span><output class="project-code-output project-code-preview" data-project-code-preview aria-live="polite">مشتری، پرونده و نوع خدمت را انتخاب کنید</output><small>فرمت نمونه: ۱۰۱۵۱-۰۱-۱۱۰-۰۰۱</small></div></div><input type="hidden" name="codingMode" value="structured"><input type="hidden" name="dossierCode"><input type="hidden" name="projectCode"><output class="project-dossier-code-preview" data-dossier-code-preview aria-live="polite"></output></fieldset>`;
  }
  if(project.serviceCode){
    const service=PROJECT_SERVICE_TYPES.find(item=>item.code===project.serviceCode);
    const customerCode=project.customerCode||'';
    const fullDossier=dossierNumber(project.dossierCode,customerCode)?`${customerCode}-${dossierNumber(project.dossierCode,customerCode)}`:project.dossierCode||'';
    return `<fieldset class="field full project-coding-section project-coding-locked"><legend>کدگذاری رسمی پروژه</legend><div class="form-grid project-coding-grid"><label class="field"><span class="field-label">کد پروژه</span><input name="projectCode" dir="ltr" readonly value="${ctx.e(project.projectCode||'')}"></label><label class="field"><span class="field-label">کد مشتری</span><input name="customerCode" dir="ltr" readonly value="${ctx.e(customerCode)}"></label><label class="field"><span class="field-label">شماره پرونده</span><input name="dossierCode" dir="ltr" readonly value="${ctx.e(project.dossierCode||'')}"><small>کد کامل پرونده: <bdi dir="ltr">${ctx.e(fullDossier)}</bdi></small></label><label class="field"><span class="field-label">نام پرونده</span><input name="dossierTitle" readonly value="${ctx.e(project.dossierTitle||'')}"></label><label class="field"><span class="field-label">نوع خدمت</span><input readonly value="${ctx.e(`${project.serviceCode}${service?` · ${service.label}`:''}`)}"></label></div><input type="hidden" name="serviceCode" value="${ctx.e(project.serviceCode)}"><input type="hidden" name="codingMode" value="locked"><p class="muted">کد رسمی پس از ساخت ثابت می‌ماند؛ برای مشتری، پرونده یا خدمت متفاوت، پروژهٔ تازه بسازید.</p></fieldset>`;
  }
  return `<fieldset class="field full project-coding-section"><legend>شناسنامه پروژه</legend><div class="form-grid project-code-fields"><label class="field"><span class="field-label">کد پروژه <span aria-hidden="true">*</span></span><input name="projectCode" dir="ltr" autocomplete="off" maxlength="80" required value="${ctx.e(project.projectCode||'')}" placeholder="کد قدیمی یا قراردادی"><small>این پروژه پیش از ساختار کدینگ ثبت شده است؛ کد رسمی را فقط در صورت نیاز عوض کنید.</small></label><label class="field"><span class="field-label">شماره مشتری <small>(قدیمی / اختیاری)</small></span><input name="customerCode" dir="ltr" maxlength="80" value="${ctx.e(project.customerCode||'')}"></label><label class="field"><span class="field-label">شماره پرونده <small>(قدیمی / اختیاری)</small></span><input name="dossierCode" dir="ltr" maxlength="80" value="${ctx.e(project.dossierCode||'')}"></label><label class="field"><span class="field-label">عنوان پرونده <small>(اختیاری)</small></span><input name="dossierTitle" maxlength="200" value="${ctx.e(project.dossierTitle||'')}"></label></div></fieldset>`;
}

export function projectConfigurationFields(state,ctx,project={}) {
  return `<fieldset class="field full project-administration"><legend>${project.id?'شناسنامه و گردش تأیید پروژه':'کدگذاری و گردش تأیید پروژه'}</legend>${codedProjectFields(state,ctx,project)}<fieldset class="field full project-approval-section"><legend>مسئول پروژه و تأییدکنندگان</legend>${reviewFields(state,ctx,project)}</fieldset></fieldset>`;
}

function projectReviewPayload(form){
  const projectManagerId=String(form.get('projectManagerId')||'');
  const reviewChain=PROJECT_APPROVAL_LABELS.map((label,index)=>({label,userId:index===0?projectManagerId:String(form.get('reviewer'+index)||'')}));
  if(reviewChain.some(stage=>!stage.userId))throw new Error('مسئول هر شش مرحلهٔ تأیید را انتخاب کنید.');
  return {projectManagerId,reviewChain};
}

export function projectConfigurationPayload(form,state={},project={}) {
  const mode=String(form.get('codingMode')||'');
  if(mode==='structured'){
    const customerId=String(form.get('customerId')||''),serviceCode=String(form.get('serviceCode')||'');
    if(!customerId)throw new Error('مشتری پروژه را انتخاب کنید.');
    if(!serviceCode)throw new Error('نوع خدمات پروژه را انتخاب کنید.');
    const selection=String(form.get('dossierChoice')||'__new__');
    const generated=structuredProjectCode(state,customerId,selection==='__new__'?'':selection,serviceCode,String(form.get('customerCode')||''));
    const dossierTitle=String(form.get('dossierTitle')||'').trim();
    if(!dossierTitle)throw new Error('نام پرونده را وارد کنید.');
    return {...generated,customerId,dossierTitle,...projectReviewPayload(form)};
  }
  const projectCode=normalCode(form.get('projectCode'));
  const metadata={projectCode,customerCode:normalCode(form.get('customerCode')),dossierCode:normalCode(form.get('dossierCode')),dossierTitle:String(form.get('dossierTitle')||'').trim(),...projectReviewPayload(form)};
  if(!projectCode)throw new Error('کد پروژه را وارد کنید.');
  if(mode==='locked')metadata.serviceCode=String(form.get('serviceCode')||project.serviceCode||'');
  return metadata;
}

export function wireProjectCodingForm(state){
  const form=document.querySelector('#modal-form'),coding=form?.querySelector('[data-project-coding]');
  if(!coding)return;
  const customer=form.querySelector('[name="customerId"]'),dossier=form.querySelector('[name="dossierChoice"]'),title=form.querySelector('[name="dossierTitle"]'),service=form.querySelector('[name="serviceCode"]');
  const dossierOutput=coding.querySelector('[data-dossier-code-preview]'),projectOutput=coding.querySelector('[data-project-code-preview]');
  const customerCodeInput=form.querySelector('[name="customerCode"]'),dossierCodeInput=form.querySelector('[name="dossierCode"]'),projectCodeInput=form.querySelector('[name="projectCode"]');
  let cases=[];
  const loadCases=()=>{
    const customerId=customer.value;
    cases=[];
    if(!customerId){dossier.innerHTML='<option value="">ابتدا مشتری را انتخاب کنید</option>';dossier.disabled=true;return;}
    try{cases=dossierCasesForCustomer(state,customerId);}catch(error){dossier.innerHTML='<option value="">کد مشتری نیازمند بررسی است</option>';dossier.disabled=true;projectOutput.textContent=error.message;return;}
    const newOption=cases.length<99?'<option value="__new__">پروندهٔ جدید بسازید…</option>':'';
    dossier.innerHTML=`${newOption}${cases.map(item=>`<option value="${item.code}">${ctxlessCode(customerCodeFor(state,customerId),item.code)} · ${escapeHtml(item.title||'پرونده بدون عنوان')}</option>`).join('')}`;
    dossier.disabled=false;
    dossier.value=cases.length<99?'__new__':cases[0]?.code||'';
  };
  const updateTitle=()=>{
    const selected=cases.find(item=>item.code===dossier.value);
    if(dossier.value==='__new__'||!selected){title.readOnly=false;title.value='';title.placeholder='مثلاً گروه مانا مستر';}
    else{title.value=selected.title||'';title.readOnly=Boolean(selected.title);title.placeholder=selected.title?'':'برای این پرونده نام وارد کنید';}
  };
  const refresh=()=>{
    const customerId=customer.value;
    let customerCode='';
    try{if(customerId){customerCode=customerCodeFor(state,customerId,customerCodeInput.value);if(!customerCodeInput.value)customerCodeInput.value=customerCode;}}catch(error){projectCodeInput.value='';projectOutput.textContent=error.message;return;}
    let selectedDossier=dossier.value==='__new__'?'':dossier.value;
    if(customerId&&!selectedDossier){try{selectedDossier=nextDossierNumberForForm(state,customerId);}catch(error){dossierOutput.textContent=error.message;projectOutput.textContent=error.message;return;}}
    const fullDossier=selectedDossier?`${customerCode}-${selectedDossier}`:'';
    dossierCodeInput.value=selectedDossier;
    dossierOutput.textContent=fullDossier?`کد پرونده: ${fullDossier}`:'';
    if(!customerId||!service.value){projectCodeInput.value='';projectOutput.textContent='مشتری، پرونده و نوع خدمت را انتخاب کنید';return;}
    try{const generated=structuredProjectCode(state,customerId,selectedDossier,service.value,customerCodeInput.value);projectCodeInput.value=generated.projectCode;projectOutput.textContent=generated.projectCode;}
    catch(error){projectCodeInput.value='';projectOutput.textContent=error.message;}
  };
  customer.addEventListener('change',()=>{
    loadCases();updateTitle();
    try{const assigned=customer.value?storedCustomerCode(state,customer.value):'';customerCodeInput.readOnly=Boolean(assigned);customerCodeInput.value=assigned||(customer.value?customerCodeFor(state,customer.value):'');}catch(error){customerCodeInput.readOnly=true;customerCodeInput.value='';projectOutput.textContent=error.message;}
    refresh();
  });
  dossier.addEventListener('change',()=>{updateTitle();refresh();});
  service.addEventListener('change',refresh);title.addEventListener('input',refresh);customerCodeInput.addEventListener('input',refresh);
  loadCases();updateTitle();refresh();
}

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ctxlessCode=(customerCode,dossierCode)=>`${customerCode}-${dossierCode}`;
export function renderProjectIdentity(state,project,ctx) {
  const lead=(state.users||[]).find(person=>person.id===project.projectManagerId),customer=(state.users||[]).find(person=>person.id===project.customerId);
  const number=dossierNumber(project.dossierCode,project.customerCode),fullDossier=number?`${project.customerCode}-${number}`:project.dossierCode;
  const service=PROJECT_SERVICE_TYPES.find(item=>item.code===project.serviceCode);
  return `<section class="project-identification" aria-label="شناسنامه و مسئول پروژه"><div><span>کد پروژه</span><strong><bdi dir="ltr">${ctx.e(project.projectCode||'ثبت نشده')}</bdi></strong></div><div><span>مسئول پروژه</span><strong>${ctx.e(lead?.name||'تعیین نشده')}</strong></div>${customer?`<div><span>مشتری</span><strong>${ctx.e(customer.name)}</strong></div>`:''}${fullDossier?`<div><span>شماره پرونده</span><strong><bdi dir="ltr">${ctx.e(fullDossier)}</bdi></strong></div>`:''}${project.dossierTitle?`<div><span>عنوان پرونده</span><strong>${ctx.e(project.dossierTitle)}</strong></div>`:''}${project.customerCode?`<div><span>شماره مشتری</span><strong><bdi dir="ltr">${ctx.e(project.customerCode)}</bdi></strong></div>`:''}${service?`<div><span>نوع خدمات</span><strong>${ctx.e(`${service.code} · ${service.label}`)}</strong></div>`:''}</section>`;
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
