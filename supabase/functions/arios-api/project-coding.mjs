/** Official ARIOS party → customer dossier → service → project numbering. */
import {latinDigits} from './identity.mjs';
import {hasPermission,requirePermission} from './permissions.mjs';

export const SERVICE_TYPES=Object.freeze([
 ['110','زیرساخت'],['111','برق ساختمان'],['112','برق صنعتی'],['113','هوشمند سازی'],['114','الکترونیک'],['115','تولید برق'],
 ['120','دوربین مدار بسته'],['121','سیستم اعلام سرقت'],['122','درب و حفاظ'],['123','سیستم اعلام حریق'],
 ['130','شبکه'],['131','سیستم های اداری'],['132','سیستم voip'],['140','سیستم صوتی'],['141','سیستم تصویری'],['142','سیستم نور پردازی'],
].map(([code,label])=>Object.freeze({code,label})));
const services=new Map(SERVICE_TYPES.map(item=>[item.code,item]));
const list=value=>Array.isArray(value)?value:[];
const fail=(message,status=400,code='INVALID_PROJECT_CODING')=>{const error=new Error(message);error.status=status;error.code=code;throw error;};
export const normalizeCodingText=value=>latinDigits(value??'').normalize('NFKC').replace(/[\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').replace(/[\u0640\u2010-\u2015\u2212\ufe63\uff0d]/g,'-').trim().replace(/\s*-\s*/g,'-');
export function normalizePartyCode(value,kind,{optional=false}={}){
 const text=normalizeCodingText(value),ranges={supplier:[4,1000,9999,'تأمین‌کننده'],customer:[5,10000,99999,'مشتری'],personnel:[6,100000,999999,'پرسنلی'],staff:[6,100000,999999,'پرسنلی']},range=ranges[kind];
 if(!range)fail('گروه کد اشخاص معتبر نیست.',400,'INVALID_PARTY_CODE');
 if(optional&&!text)return '';
 if(!new RegExp(`^\\d{${range[0]}}$`).test(text)||Number(text)<range[1]||Number(text)>range[2])fail(`کد ${range[3]} باید ${range[0]} رقمی و از ${range[1]} تا ${range[2]} باشد.`,400,'INVALID_PARTY_CODE');
 return text;
}
function serial(value,width,label){
 const text=normalizeCodingText(value);
 if(!new RegExp(`^\\d{1,${width}}$`).test(text)||Number(text)<1||Number(text)>10**width-1)fail(`${label} باید از ${'1'.padStart(width,'0')} تا ${'9'.repeat(width)} باشد.`);
 return String(Number(text)).padStart(width,'0');
}
export function serviceType(value){const code=normalizeCodingText(value),service=services.get(code);if(!service)fail('نوع خدمات پروژه را از کدهای مشخص‌شده انتخاب کنید.');return service;}
export function parseProjectCode(value){
 const code=normalizeCodingText(value),match=/^([1-9]\d{4})-(\d{2})-(\d{3})-(\d{3})$/.exec(code);
 if(!match||match[2]==='00'||match[4]==='000'||!services.has(match[3]))return null;
 return {projectCode:code,customerCode:match[1],dossierCode:`${match[1]}-${match[2]}`,dossierNumber:match[2],serviceCode:match[3],projectNumber:match[4]};
}
const dossierParts=value=>{const match=/^([1-9]\d{4})-(\d{2})$/.exec(normalizeCodingText(value));return match&&match[2]!=='00'?{customerCode:match[1],number:match[2],code:`${match[1]}-${match[2]}`}:null;};
/** Read only, including historical structured codes without mutating old project records. */
export function readCustomerDossiers(state,{includeArchived=false}={}){
 const rows=list(state?.customerDossiers).map(row=>structuredClone(row)),seen=new Set(rows.map(row=>normalizeCodingText(row.code)));
 for(const project of list(state?.projects)){
  const parsed=parseProjectCode(project.projectCode),parts=dossierParts(project.dossierCode)||parsed&&{customerCode:parsed.customerCode,number:parsed.dossierNumber,code:parsed.dossierCode};
  if(!parts||!project.customerId||seen.has(parts.code))continue;
  rows.push({id:`legacy-dossier-${project.customerId}-${parts.number}`,customerId:project.customerId,...parts,title:project.dossierTitle||project.name||parts.code,legacy:true});seen.add(parts.code);
 }
 return rows.filter(row=>includeArchived||!row.archivedAt);
}
export function assertCustomerCodeAvailable(state,customerId,value){
 const code=normalizePartyCode(value,'customer');
 if(list(state?.users).some(person=>person.id!==customerId&&normalizeCodingText(person.customerCode)===code))fail('این کد مشتری قبلاً به شخص دیگری اختصاص یافته است.',409,'DUPLICATE_CUSTOMER_CODE');
 if(readCustomerDossiers(state,{includeArchived:true}).some(row=>row.customerId!==customerId&&normalizeCodingText(row.customerCode)===code)||list(state?.projects).some(project=>project.customerId&&project.customerId!==customerId&&(normalizeCodingText(project.customerCode)===code||parseProjectCode(project.projectCode)?.customerCode===code)))fail('این کد در پرونده یا پروژهٔ مشتری دیگری استفاده شده است.',409,'DUPLICATE_CUSTOMER_CODE');
 return code;
}
export function nextDossierNumber(state,customer){
 const person=list(state?.users).find(row=>row.id===customer),code=normalizeCodingText(person?.customerCode||customer);
 const used=new Set(readCustomerDossiers(state,{includeArchived:true}).filter(row=>row.customerId===customer||normalizeCodingText(row.customerCode)===code).map(row=>Number(row.number)));
 let next=1;while(next<=99&&used.has(next))next+=1;
 if(next>99)fail('این مشتری به سقف ۹۹ پرونده رسیده است.',409,'CUSTOMER_DOSSIER_LIMIT');
 return String(next).padStart(2,'0');
}
export function nextProjectNumber(state,dossierCode,serviceCode){
 const dossier=normalizeCodingText(dossierCode),service=serviceType(serviceCode).code;
 const used=list(state?.projects).map(project=>parseProjectCode(project.projectCode)).filter(project=>project?.dossierCode===dossier&&project.serviceCode===service).map(project=>Number(project.projectNumber));
 const next=Math.max(0,...used)+1;
 if(next>999)fail('این نوع خدمات در این پرونده به سقف ۹۹۹ پروژه رسیده است.',409,'PROJECT_NUMBER_LIMIT');
 return String(next).padStart(3,'0');
}
function customerFor(state,actor,payload){
 const customer=list(state.users).find(person=>person.id===payload.customerId);
 if(!customer||customer.deletedAt||customer.role!=='customer')fail('یک مشتری فعال برای پروژه انتخاب کنید.');
 let code=normalizeCodingText(customer.customerCode);
 const supplied=normalizeCodingText(payload.customerCode);
 if(!code){
  if(!supplied)fail('ابتدا کد پنج‌رقمی مشتری را در پروندهٔ شخص ثبت کنید.',400,'CUSTOMER_CODE_REQUIRED');
  requirePermission(actor,'people.manage',state);
  code=assertCustomerCodeAvailable(state,customer.id,supplied);customer.customerCode=code;
 }else{
  code=assertCustomerCodeAvailable(state,customer.id,code);
  if(supplied&&supplied!==code)fail('کد واردشده با کد ثبت‌شدهٔ مشتری مطابقت ندارد.',409,'CUSTOMER_CODE_MISMATCH');
 }
 return {customer,code};
}
function title(value){if(typeof value!=='string'||!value.trim()||value.trim().length>200||/[\u0000-\u001f\u007f]/.test(value))fail('عنوان پرونده را حداکثر در ۲۰۰ نویسه وارد کنید.');return value.trim();}
function storeDossier(state,row){
 state.customerDossiers ||= [];
 if(!state.customerDossiers.some(item=>item.id===row.id)){const copy=structuredClone(row);delete copy.legacy;state.customerDossiers.push(copy);return copy;}
 return state.customerDossiers.find(item=>item.id===row.id);
}
export function createCustomerDossier(state,actor,payload){
 requirePermission(actor,'projects.create',state);
 const {customer,code}=customerFor(state,actor,payload),number=payload.dossierNumber!==undefined&&payload.dossierNumber!==''?serial(payload.dossierNumber,2,'شمارهٔ پرونده'):nextDossierNumber(state,customer.id),dossierCode=`${code}-${number}`;
 if(readCustomerDossiers(state,{includeArchived:true}).some(row=>normalizeCodingText(row.code)===dossierCode))fail('این شمارهٔ پرونده قبلاً ثبت شده است؛ پروندهٔ موجود را انتخاب کنید.',409,'DUPLICATE_DOSSIER_CODE');
 const row={id:`cd_${globalThis.crypto.randomUUID()}`,customerId:customer.id,customerCode:code,number,code:dossierCode,title:title(payload.dossierTitle??payload.title),createdAt:new Date().toISOString(),createdBy:actor.id};
 return storeDossier(state,row);
}
/** The caller owns a copied state and the store compare-and-swap retry. */
export function allocateProjectCoding(state,actor,payload,previous={}){
 const {customer,code}=customerFor(state,actor,payload),service=serviceType(payload.serviceCode);
 if(payload.createDossier!==undefined&&typeof payload.createDossier!=='boolean')fail('روش انتخاب پرونده معتبر نیست.');
 let dossier;
 if(payload.createDossier===true){
  if(payload.dossierId)fail('برای پروندهٔ جدید، پروندهٔ موجود انتخاب نکنید.');
  dossier=createCustomerDossier(state,actor,payload);
 }else{
  const all=readCustomerDossiers(state,{includeArchived:true}),number=payload.dossierNumber?serial(payload.dossierNumber,2,'شمارهٔ پرونده'):null;
  dossier=all.find(row=>payload.dossierId?row.id===payload.dossierId:row.customerId===customer.id&&row.number===number);
  if(!dossier||dossier.customerId!==customer.id||normalizeCodingText(dossier.customerCode)!==code)fail('پروندهٔ انتخاب‌شده متعلق به این مشتری نیست.',400,'CUSTOMER_DOSSIER_MISMATCH');
  if(dossier.archivedAt)fail('پرونده بایگانی شده است؛ ابتدا آن را بازیابی کنید.',409,'CUSTOMER_DOSSIER_ARCHIVED');
  if(number&&number!==dossier.number)fail('شمارهٔ پرونده با پروندهٔ انتخابی مطابقت ندارد.');
  dossier=storeDossier(state,dossier);
 }
 const projectNumber=payload.projectNumber?serial(payload.projectNumber,3,'شمارهٔ پروژه'):nextProjectNumber(state,dossier.code,service.code),projectCode=`${code}-${dossier.number}-${service.code}-${projectNumber}`;
 if(list(state.projects).some(project=>project.id!==previous.id&&normalizeCodingText(project.projectCode)===projectCode))fail('این کد قبلاً برای پروژهٔ دیگری ثبت شده است.',409,'DUPLICATE_PROJECT_CODE');
 for(const [key,value]of Object.entries({projectCode,dossierCode:dossier.code,dossierTitle:dossier.title}))if(payload[key]!==undefined&&normalizeCodingText(payload[key])!==normalizeCodingText(value))fail('اجزای کد با مشتری، پرونده و خدمات انتخاب‌شده مطابقت ندارند.',400,'PROJECT_CODE_MISMATCH');
 return {codingVersion:1,customerId:customer.id,customerCode:code,dossierId:dossier.id,dossierCode:dossier.code,dossierNumber:dossier.number,dossierTitle:dossier.title,serviceCode:service.code,projectNumber,projectCode,type:service.label};
}
/** Codes on issued documents stay stable; names and workflow settings remain editable. */
export function assertProjectCodingUpdate(state,payload,previous){
 if(previous.codingVersion!==1)return;
 const fields=['codingVersion','customerId','customerCode','dossierId','dossierCode','dossierNumber','serviceCode','projectNumber','projectCode'];
 for(const key of fields)if(payload[key]!==undefined&&normalizeCodingText(payload[key])!==normalizeCodingText(previous[key]))fail('کد و مشتری پروژهٔ کدگذاری‌شده ثابت هستند؛ برای پرونده یا خدمات دیگر پروژهٔ تازه ایجاد کنید.',409,'PROJECT_CODING_IMMUTABLE');
 if(payload.type!==undefined&&payload.type!==serviceType(previous.serviceCode).label)fail('نوع فعالیت این پروژه از کد خدمات آن مشخص می‌شود.',409,'PROJECT_CODING_IMMUTABLE');
 if(payload.dossierTitle!==undefined&&payload.dossierTitle!==previous.dossierTitle)fail('عنوان پرونده را از ویرایش پروندهٔ مشتری تغییر دهید.',409,'PROJECT_CODING_IMMUTABLE');
 const canonical=list(state.users).find(person=>person.id===previous.customerId);
 if(canonical&&canonical.customerCode&&normalizeCodingText(canonical.customerCode)!==previous.customerCode)fail('کد پروندهٔ مشتری با این پروژه مطابقت ندارد.',409,'CUSTOMER_CODE_MISMATCH');
}
export function applyCustomerDossierAction(state,actor,action,payload){
 if(action==='customer-dossier.create')return createCustomerDossier(state,actor,payload);
 if(!['customer-dossier.update','customer-dossier.archive','customer-dossier.restore'].includes(action))fail('عملیات پروندهٔ مشتری شناخته‌شده نیست.');
 requirePermission(actor,action==='customer-dossier.update'?'projects.edit':'projects.archive',state);
 const found=readCustomerDossiers(state,{includeArchived:true}).find(row=>row.id===payload.id);
 if(!found)fail('پروندهٔ مشتری یافت نشد.',404,'CUSTOMER_DOSSIER_NOT_FOUND');
 const references=list(state.projects).filter(project=>project.dossierId===found.id||project.customerId===found.customerId&&normalizeCodingText(project.dossierCode)===found.code);
 if(actor.role!=='manager'&&found.createdBy!==actor.id&&(!references.length||references.some(project=>project.createdBy!==actor.id&&!list(project.memberIds).includes(actor.id))))fail('به این پروندهٔ مشتری دسترسی ندارید.',403,'FORBIDDEN');
 const row=storeDossier(state,found),timestamp=new Date().toISOString();
 if(action==='customer-dossier.update'){
  if(row.archivedAt)fail('ابتدا پروندهٔ بایگانی‌شده را بازیابی کنید.',409,'CUSTOMER_DOSSIER_ARCHIVED');
  row.title=title(payload.title??payload.dossierTitle);row.updatedAt=timestamp;
  for(const project of references){project.dossierTitle=row.title;project.dossierId=row.id;}
 }else if(action==='customer-dossier.archive'){
  if(references.some(project=>!project.archivedAt))fail('این پرونده پروژهٔ فعال دارد؛ ابتدا پروژه‌های آن را بایگانی کنید.',409,'CUSTOMER_DOSSIER_IN_USE');
  row.archivedAt ||=timestamp;row.archivedBy=actor.id;
 }else{delete row.archivedAt;delete row.archivedBy;row.updatedAt=timestamp;}
 return structuredClone(row);
}
export function customerDossiersSnapshot(state,actor,visibleProjectIds=[]){
 const directory=hasPermission(actor,'projects.create',state)||hasPermission(actor,'projects.edit',state),visible=new Set(visibleProjectIds);
 const allowed=new Set(list(state.projects).filter(project=>visible.has(project.id)).map(project=>project.dossierId||`${project.customerId}:${normalizeCodingText(project.dossierCode)}`));
 return readCustomerDossiers(state,{includeArchived:actor.role==='manager'}).filter(row=>actor.role==='manager'||directory||actor.role==='customer'&&row.customerId===actor.id||allowed.has(row.id)||allowed.has(`${row.customerId}:${row.code}`)).map(row=>Object.fromEntries(['id','customerId','customerCode','number','code','title','createdBy','archivedAt'].filter(key=>row[key]!==undefined).map(key=>[key,structuredClone(row[key])])));
}
