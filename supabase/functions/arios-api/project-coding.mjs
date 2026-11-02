import {latinDigits} from './identity.mjs';

export const CUSTOMER_CODE_MIN=10000;
export const CUSTOMER_CODE_MAX=99999;
export const CUSTOMER_DOSSIER_LIMIT=99;
export const PROJECT_SEQUENCE_LIMIT=999;

export const PROJECT_SERVICE_TYPES=Object.freeze([
  {code:'110',label:'زیرساخت'},
  {code:'111',label:'برق ساختمان'},
  {code:'112',label:'برق صنعتی'},
  {code:'113',label:'هوشمندسازی'},
  {code:'114',label:'الکترونیک'},
  {code:'115',label:'تولید برق'},
  {code:'120',label:'دوربین مدار بسته'},
  {code:'121',label:'سیستم اعلام سرقت'},
  {code:'122',label:'درب و حفاظ'},
  {code:'123',label:'سیستم اعلام حریق'},
  {code:'130',label:'شبکه'},
  {code:'131',label:'سیستم‌های اداری'},
  {code:'132',label:'سیستم VoIP'},
  {code:'140',label:'سیستم صوتی'},
  {code:'141',label:'سیستم تصویری'},
  {code:'142',label:'سیستم نورپردازی'}
]);

const rows=value=>Array.isArray(value)?value:[];
export const normalizeCodingValue=value=>latinDigits(value??'').normalize('NFKC').replace(/[\u200c\u200e\u200f]/g,'').trim().toUpperCase();
export const serviceTypeForCode=code=>PROJECT_SERVICE_TYPES.find(item=>item.code===normalizeCodingValue(code));
export const isCustomerCode=value=>{
  const code=normalizeCodingValue(value);
  return /^\d{5}$/.test(code)&&Number(code)>=CUSTOMER_CODE_MIN&&Number(code)<=CUSTOMER_CODE_MAX;
};

export function dossierNumber(value,customerCode=''){
  const normalized=normalizeCodingValue(value);
  const customer=normalizeCodingValue(customerCode);
  const full=customer&&normalized.startsWith(`${customer}-`)?normalized.slice(customer.length+1):normalized;
  if(!/^\d{2}$/.test(full))return '';
  const number=Number(full);
  return number>=1&&number<=CUSTOMER_DOSSIER_LIMIT?String(number).padStart(2,'0'):'';
}

function customerCodeCandidates(state,customerId){
  const customer=rows(state?.users).find(person=>person.id===customerId&&person.role==='customer');
  return [
    customer?.customerCode,
    ...rows(state?.projects).filter(project=>project.customerId===customerId).map(project=>project.customerCode),
    ...rows(state?.customerDossiers).filter(item=>item.customerId===customerId).map(item=>item.customerCode)
  ].map(normalizeCodingValue).filter(isCustomerCode);
}

function codesUsedByOthers(state,customerId){
  const used=new Set();
  for(const person of rows(state?.users))if(person.role==='customer'&&person.id!==customerId&&isCustomerCode(person.customerCode))used.add(normalizeCodingValue(person.customerCode));
  for(const project of rows(state?.projects))if(project.customerId!==customerId&&isCustomerCode(project.customerCode))used.add(normalizeCodingValue(project.customerCode));
  for(const item of rows(state?.customerDossiers))if(item.customerId!==customerId&&isCustomerCode(item.customerCode))used.add(normalizeCodingValue(item.customerCode));
  return used;
}

export function storedCustomerCode(state,customerId){
  const candidates=[...new Set(customerCodeCandidates(state,customerId))];
  if(candidates.length>1)throw new Error('برای این مشتری چند کد متفاوت ثبت شده؛ پیش از ساخت پروژه اطلاعات کدینگ را بررسی کنید.');
  return candidates[0]||'';
}

/** Returns an assigned code or a deterministic preview; an administrator may enter a known legacy code once. */
export function customerCodeFor(state,customerId,requested=''){
  if(!customerId)return '';
  const candidates=[...new Set(customerCodeCandidates(state,customerId))];
  if(candidates.length>1)throw new Error('برای این مشتری چند کد متفاوت ثبت شده؛ پیش از ساخت پروژه اطلاعات کدینگ را بررسی کنید.');
  const used=codesUsedByOthers(state,customerId),input=normalizeCodingValue(requested);
  if(input){
    if(!isCustomerCode(input))throw new Error('کد مشتری باید عددی پنج‌رقمی در بازهٔ ۱۰۰۰۰ تا ۹۹۹۹۹ باشد.');
    if(candidates.length&&candidates[0]!==input)throw new Error('کد مشتری قبلاً ثبت شده و قابل تغییر نیست.');
    if(used.has(input))throw new Error('این کد قبلاً به مشتری دیگری اختصاص یافته است.');
    return input;
  }
  if(candidates.length){
    if(used.has(candidates[0]))throw new Error('کد مشتری با پروندهٔ دیگری تداخل دارد؛ پیش از ساخت پروژه آن را بررسی کنید.');
    return candidates[0];
  }
  const customers=rows(state?.users).filter(person=>person.role==='customer');
  for(const person of customers){
    const assigned=[...new Set(customerCodeCandidates(state,person.id))];
    if(assigned.length){
      if(person.id===customerId)throw new Error('کد مشتری با پروندهٔ دیگری تداخل دارد؛ پیش از ساخت پروژه آن را بررسی کنید.');
      used.add(assigned[0]);
      continue;
    }
    let available='';
    for(let code=CUSTOMER_CODE_MIN;code<=CUSTOMER_CODE_MAX;code++)if(!used.has(String(code))){available=String(code);break;}
    if(!available)throw new Error('ظرفیت کدهای مشتری تکمیل شده است.');
    if(person.id===customerId)return available;
    used.add(available);
  }
  throw new Error('حساب مشتری فعال پیدا نشد.');
}

export function dossierCasesForCustomer(state,customerId){
  if(!customerId)return [];
  const customerCode=customerCodeFor(state,customerId),byCode=new Map();
  const candidates=[...rows(state?.customerDossiers),...rows(state?.projects)];
  for(const item of candidates){
    if(item.customerId!==customerId&&normalizeCodingValue(item.customerCode)!==customerCode)continue;
    const code=dossierNumber(item.dossierCode,customerCode);
    if(!code)continue;
    const current=byCode.get(code)||{code,title:''};
    const title=String(item.title||item.dossierTitle||'').trim();
    if(title&&!current.title)current.title=title;
    byCode.set(code,current);
  }
  return [...byCode.values()].sort((a,b)=>Number(a.code)-Number(b.code));
}

export function nextDossierNumber(state,customerId){
  const used=new Set(dossierCasesForCustomer(state,customerId).map(item=>item.code));
  for(let number=1;number<=CUSTOMER_DOSSIER_LIMIT;number++){
    const code=String(number).padStart(2,'0');
    if(!used.has(code))return code;
  }
  throw new Error('این مشتری به سقف ۹۹ پرونده رسیده است.');
}

export function nextProjectSequence(state,customerCode,dossierCode,serviceCode){
  const customer=normalizeCodingValue(customerCode),dossier=dossierNumber(dossierCode,customer),service=normalizeCodingValue(serviceCode);
  if(!isCustomerCode(customer)||!dossier||!serviceTypeForCode(service))throw new Error('برای ساخت کد پروژه، مشتری، پرونده و نوع خدمت را مشخص کنید.');
  const pattern=new RegExp(`^${customer}-${dossier}-${service}-(\\d{3})$`);
  let highest=0;
  for(const project of rows(state?.projects)){
    const match=normalizeCodingValue(project.projectCode).match(pattern);
    if(match)highest=Math.max(highest,Number(match[1]));
  }
  const next=highest+1;
  if(next>PROJECT_SEQUENCE_LIMIT)throw new Error('برای این نوع خدمت و پرونده، سقف ۹۹۹ پروژه تکمیل شده است.');
  return String(next).padStart(3,'0');
}

export function structuredProjectCode(state,customerId,dossierValue,serviceValue,customerCodeOverride=''){
  const customerCode=customerCodeFor(state,customerId,customerCodeOverride),service=serviceTypeForCode(serviceValue);
  const dossier=dossierNumber(dossierValue,customerCode)||nextDossierNumber(state,customerId);
  if(!service)throw new Error('نوع خدمات پروژه را انتخاب کنید.');
  const sequence=nextProjectSequence(state,customerCode,dossier,service.code);
  return {customerCode,dossierCode:dossier,serviceCode:service.code,projectCode:`${customerCode}-${dossier}-${service.code}-${sequence}`,type:service.label};
}

/** Assigns the previewed customer code inside the same transaction as project creation. */
export function assignCustomerCode(state,customerId,requested=''){
  const customer=rows(state?.users).find(person=>person.id===customerId&&person.role==='customer'&&!person.deletedAt);
  if(!customer)throw new Error('حساب مشتری فعال یافت نشد.');
  const code=customerCodeFor(state,customerId,requested);
  customer.customerCode=code;
  return code;
}
