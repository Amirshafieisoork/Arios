import {latinDigits} from './identity.mjs';
import {hasPermission} from './permissions.mjs';
import {SERVICE_TYPES,nextDossierNumber,nextProjectNumber} from './project-coding.mjs';

const digits=value=>latinDigits(String(value??'')).trim();
const customerCode=value=>/^[1-9]\d{4}$/.test(digits(value))?digits(value):'';
const pad=(value,size)=>String(value).padStart(size,'0');
const activeCustomers=state=>(state.users||[]).filter(person=>person.role==='customer'&&!person.deletedAt);
const allProjects=state=>[...(state.projects||[]),...(state.management?.projects||[])];
const dossierRows=(state,id)=>(state.customerDossiers||[]).filter(row=>row.customerId===id&&!row.archivedAt);

/** The preview is advisory: the server allocates against the complete, locked state. */
export function projectCodePreview(state,{customerId,customerCode:code,dossierId,dossierNumber,serviceCode,projectNumber}={}){
  const person=activeCustomers(state).find(item=>item.id===customerId);
  code=customerCode(person?.customerCode)||customerCode(code);
  const previewState={...state,projects:allProjects(state),users:(state.users||[]).map(item=>item.id===customerId?{...item,customerCode:code}:item)};
  const dossier=dossierRows(state,customerId).find(row=>row.id===dossierId);
  let number=dossier?.number||digits(dossierNumber);
  if(!number&&code){
    try{number=nextDossierNumber(previewState,customerId||code);}catch{number='';}
  }
  if(number&&/^\d{1,2}$/.test(number)&&Number(number)>0&&Number(number)<=99)number=pad(Number(number),2);else number='';
  serviceCode=digits(serviceCode);
  if(!SERVICE_TYPES.some(item=>item.code===serviceCode))serviceCode='';
  let sequence=digits(projectNumber);
  if(!sequence&&code&&number&&serviceCode){
    try{sequence=nextProjectNumber(previewState,`${code}-${number}`,serviceCode);}catch{sequence='';}
  }
  if(sequence&&/^\d{1,3}$/.test(sequence)&&Number(sequence)>0&&Number(sequence)<=999)sequence=pad(Number(sequence),3);else sequence='';
  return {customerCode:code,dossierNumber:number,serviceCode,projectNumber:sequence,code:[code||'-----',number||'--',serviceCode||'---',sequence||'---'].join('-'),complete:Boolean(code&&number&&serviceCode&&sequence)};
}

export function projectCodingFields(state,ctx,project={}){
  const immutable=project.codingVersion===1;
  const person=activeCustomers(state).find(item=>item.id===project.customerId);
  if(immutable)return `<fieldset class="field full project-coding" data-project-coding-fixed><legend>کدینگ پروژه</legend><input type="hidden" name="projectCodingFixed" value="1"><div class="project-code-preview"><span>کد ثبت‌شدهٔ پروژه</span><bdi dir="ltr">${ctx.e(project.projectCode)}</bdi></div><div class="project-code-summary"><span>مشتری: <strong>${ctx.e(person?.name||'مشتری پروژه')}</strong> · <bdi dir="ltr">${ctx.e(project.customerCode)}</bdi></span><span>پرونده: <strong>${ctx.e(project.dossierTitle||'ثبت نشده')}</strong> · <bdi dir="ltr">${ctx.e(project.dossierCode)}</bdi></span><span>خدمات: <strong>${ctx.e(SERVICE_TYPES.find(item=>item.code===project.serviceCode)?.label||project.type)}</strong> · <bdi dir="ltr">${ctx.e(project.serviceCode)}</bdi></span></div><p class="muted">کد و مشتری پروژه حفظ می‌شوند. برای فعالیت تازه، پروژهٔ جدیدی در همین پرونده ایجاد کنید.</p></fieldset>`;
  const canAssign=hasPermission(state.user,'people.manage',state);
  return `<fieldset class="field full project-coding" data-project-coding><legend>۱. مشتری، پرونده و نوع خدمات</legend><input type="hidden" name="codingVersion" value="1"><div class="form-grid">
    <label class="field full"><span class="field-label">مشتری</span><select name="customerId" required data-coding-customer><option value="">مشتری را انتخاب کنید…</option>${activeCustomers(state).map(item=>`<option value="${ctx.e(item.id)}">${ctx.e(item.name)} · ${ctx.e(customerCode(item.customerCode)||'کد مشتری ثبت نشده')}</option>`).join('')}</select>${!activeCustomers(state).length?'<small>ابتدا مشتری را از بخش افراد ثبت کنید.</small>':''}</label>
    <label class="field" data-coding-customer-code><span class="field-label">کد مشتری (۵ رقمی)</span><input name="customerCode" inputmode="numeric" dir="ltr" maxlength="5" autocomplete="off" placeholder="مثلاً 10151" ${canAssign?'':'readonly'}><small data-coding-customer-help>${canAssign?'اگر مشتری کد ندارد، کد پنج‌رقمی او را همین‌جا ثبت کنید.':'مدیر مجموعه باید کد پنج‌رقمی مشتری را در پروندهٔ او ثبت کند.'}</small></label>
    <label class="field"><span class="field-label">پروندهٔ مشتری</span><select name="dossierId" required data-coding-dossier disabled><option value="">ابتدا مشتری را انتخاب کنید</option></select></label>
    <div class="field full project-new-dossier" data-coding-new-dossier hidden><div class="form-grid"><label class="field"><span class="field-label">نام پرونده / ساختمان / شعبه</span><input name="dossierTitle" maxlength="200" placeholder="مثلاً گروه مانا مستر" disabled></label><label class="field"><span class="field-label">شمارهٔ پرونده (اختیاری)</span><input name="dossierNumber" inputmode="numeric" dir="ltr" maxlength="2" placeholder="خودکار از 01 تا 99" disabled><small>خالی بگذارید تا شمارهٔ بعدی انتخاب شود.</small></label></div></div>
    <label class="field full"><span class="field-label">نوع خدمات پروژه</span><select name="serviceCode" required><option value="">نوع خدمات را انتخاب کنید…</option>${SERVICE_TYPES.map(item=>`<option value="${ctx.e(item.code)}">${ctx.e(item.code)} · ${ctx.e(item.label)}</option>`).join('')}</select></label>
    <details class="field full project-coding-advanced"><summary>ثبت شمارهٔ پروژهٔ موجود</summary><label class="field"><span class="field-label">شمارهٔ پروژه در این پرونده و خدمات (اختیاری)</span><input name="projectNumber" inputmode="numeric" dir="ltr" maxlength="3" placeholder="خودکار از 001 تا 999"><small>برای ثبت پروژهٔ جدید خالی بگذارید. شمارهٔ تکراری پذیرفته نمی‌شود.</small></label></details>
  </div><div class="project-code-preview" aria-live="polite" aria-atomic="true"><span>پیش‌نمایش کد پروژه</span><output data-coding-preview dir="ltr">-----–--–---–---</output><small data-coding-preview-note>با انتخاب مشتری، پرونده و خدمات تکمیل می‌شود.</small></div><p class="project-code-parts"><span>۵ رقم مشتری</span><span>۲ رقم پرونده</span><span>۳ رقم خدمات</span><span>۳ رقم پروژه</span></p></fieldset>`;
}

export function projectCodingPayload(form){
  const result={codingVersion:1};
  const id=String(form.get('customerId')||'');
  if(!id)throw Error('مشتری پروژه را انتخاب کنید.');
  result.customerId=id;
  const code=digits(form.get('customerCode'));
  if(code){if(!customerCode(code))throw Error('کد مشتری باید پنج‌رقمی و بین ۱۰۰۰۰ تا ۹۹۹۹۹ باشد.');result.customerCode=code;}
  const serviceCode=digits(form.get('serviceCode'));
  if(!SERVICE_TYPES.some(item=>item.code===serviceCode))throw Error('نوع خدمات پروژه را انتخاب کنید.');
  result.serviceCode=serviceCode;
  const dossierId=String(form.get('dossierId')||'');
  if(!dossierId)throw Error('پروندهٔ مشتری را انتخاب کنید.');
  if(dossierId==='__new__'){
    result.createDossier=true;result.dossierTitle=String(form.get('dossierTitle')||'').trim();
    if(!result.dossierTitle)throw Error('نام پروندهٔ جدید را وارد کنید.');
    const number=digits(form.get('dossierNumber'));
    if(number){if(!/^\d{1,2}$/.test(number)||Number(number)<1||Number(number)>99)throw Error('شمارهٔ پرونده باید بین ۰۱ تا ۹۹ باشد.');result.dossierNumber=pad(Number(number),2);}
  }else result.dossierId=dossierId;
  const number=digits(form.get('projectNumber'));
  if(number){if(!/^\d{1,3}$/.test(number)||Number(number)<1||Number(number)>999)throw Error('شمارهٔ پروژه باید بین ۰۰۱ تا ۹۹۹ باشد.');result.projectNumber=pad(Number(number),3);}
  return result;
}

export function wireProjectCodingForm(state,ctx,form=globalThis.document?.querySelector('#modal-form')){
  const root=form?.querySelector('[data-project-coding]');if(!root)return;
  const convert=form.querySelector('[data-coding-convert]'),conversion=form.querySelector('[data-coding-conversion]'),legacy=form.querySelector('[data-legacy-project-identity]');
  if(convert&&conversion){const toggle=()=>{conversion.hidden=conversion.disabled=!convert.checked;for(const input of legacy?.querySelectorAll('input,select,textarea')||[])input.disabled=convert.checked;};convert.addEventListener('change',toggle);toggle();}
  const get=name=>root.querySelector(`[name="${name}"]`),customer=get('customerId'),code=get('customerCode'),dossier=get('dossierId'),title=get('dossierTitle'),number=get('dossierNumber'),service=get('serviceCode'),sequence=get('projectNumber'),name=form.querySelector('[name="name"]');
  const preview=root.querySelector('[data-coding-preview]'),note=root.querySelector('[data-coding-preview-note]'),newDossier=root.querySelector('[data-coding-new-dossier]'),help=root.querySelector('[data-coding-customer-help]');
  const canAssign=hasPermission(state.user,'people.manage',state);let generatedName='',selectedCustomer='';
  const refresh=()=>{
    const person=activeCustomers(state).find(item=>item.id===customer.value),canonical=customerCode(person?.customerCode);
    if(selectedCustomer!==customer.value){
      selectedCustomer=customer.value;code.value=canonical;
      const rows=dossierRows(state,customer.value);
      dossier.innerHTML=person?`<option value="">پرونده را انتخاب کنید…</option>${rows.map(row=>`<option value="${ctx.e(row.id)}">${ctx.e(row.code)} · ${ctx.e(row.title)}</option>`).join('')}<option value="__new__">＋ ایجاد پروندهٔ جدید</option>`:'<option value="">ابتدا مشتری را انتخاب کنید</option>';
      dossier.value=person&&!rows.length?'__new__':'';title.value='';number.value='';
    }
    code.readOnly=Boolean(canonical)||!canAssign;code.required=Boolean(person)&&!canonical&&canAssign;code.disabled=!person;
    code.setCustomValidity(code.value&&!customerCode(code.value)?'کد مشتری باید پنج‌رقمی و بین ۱۰۰۰۰ تا ۹۹۹۹۹ باشد.':'');
    customer.setCustomValidity(person&&!canonical&&!canAssign?'ابتدا مدیر مجموعه باید کد پنج‌رقمی این مشتری را ثبت کند.':'');
    if(help)help.textContent=canonical?'کد ثبت‌شدهٔ مشتری؛ برای اصلاح به بخش افراد بروید.':canAssign?'کد پنج‌رقمی مشتری را وارد کنید؛ همراه پروژه ذخیره می‌شود.':'مدیر مجموعه باید کد پنج‌رقمی مشتری را در پروندهٔ او ثبت کند.';
    dossier.disabled=!person;const isNew=dossier.value==='__new__';newDossier.hidden=!isNew;title.disabled=number.disabled=!isNew;title.required=isNew;
    const value=projectCodePreview(state,{customerId:customer.value,customerCode:code.value,dossierId:dossier.value,dossierNumber:number.value,serviceCode:service.value,projectNumber:sequence.value});
    if(preview)preview.textContent=value.code;
    if(note)note.textContent=value.complete?'شمارهٔ نهایی هنگام ذخیره تعیین می‌شود تا کد تکراری ساخته نشود.':'مشتری، پرونده و نوع خدمات را انتخاب کنید تا کد تکمیل شود.';
    const row=dossierRows(state,customer.value).find(item=>item.id===dossier.value),label=SERVICE_TYPES.find(item=>item.code===service.value)?.label;
    const nextName=label&&(isNew?title.value.trim():row?.title)?`${label} · ${isNew?title.value.trim():row.title}`.slice(0,160):'';
    if(name&&(!name.value||name.value===generatedName)){name.value=nextName;generatedName=nextName;}
  };
  for(const input of [customer,dossier,service])input?.addEventListener('change',refresh);
  for(const input of [code,title,number,sequence])input?.addEventListener('input',refresh);
  refresh();
}
