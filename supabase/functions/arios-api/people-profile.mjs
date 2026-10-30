/** Optional work details saved in the same transaction as a person's account. */
import {latinDigits} from './identity.mjs';
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function fail(message,code='INVALID_PERSON_DETAILS'){const error=new Error(message);error.status=400;error.code=code;throw error;}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(`${value}T00:00:00Z`))||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)fail('تاریخ اجرای نرخ معتبر نیست.');return value;}
function time(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('ساعت کاری معتبر نیست.');return value;}
export function applyPersonProfile(person,payload={}){
  const next={};
  if(payload.personnelCode!==undefined){
    if(typeof payload.personnelCode!=='string')fail('کد پرسنلی معتبر نیست.');
    const code=latinDigits(payload.personnelCode.normalize('NFKC')).trim();
    if(code.length>40||code&&!/^[\p{L}\p{N}_-]+$/u.test(code))fail('کد پرسنلی باید تا ۴۰ نویسه و شامل حرف، عدد، خط تیره یا زیرخط باشد.');
    next.personnelCode=code;
  }
  if(payload.personDetails===undefined){Object.assign(person,next);return person;}
  const details=payload.personDetails;
  if(!plain(details)||Object.keys(details).some(key=>!['availability','workStart','workEnd','hourlyRate','effectiveDate'].includes(key)))fail('جزئیات پروندهٔ همکار معتبر نیست.');
  if(person.role!=='worker'){if(Object.keys(details).length)fail('برنامهٔ کاری و نرخ فقط برای همکار اجرایی ثبت می‌شود.');Object.assign(person,next);return person;}
  if(details.availability!==undefined){if(!['','available','busy','leave'].includes(details.availability))fail('وضعیت کاری معتبر نیست.');next.availability=details.availability;}
  if(details.workStart!==undefined||details.workEnd!==undefined){
    const start=details.workStart||'',end=details.workEnd||'';
    if(typeof start!=='string'||typeof end!=='string'||Boolean(start)!==Boolean(end))fail('شروع و پایان ساعت کاری را با هم وارد کنید.');
    if(start&&(time(end)<=time(start)))fail('پایان ساعت کاری باید پس از شروع باشد.');
    Object.assign(next,{workStart:start,workEnd:end});
  }
  if(details.hourlyRate!==undefined||details.effectiveDate!==undefined){
    if(!Number.isSafeInteger(details.hourlyRate)||details.hourlyRate<0)fail('نرخ ساعتی باید عدد صحیح نامنفی باشد.');
    const effectiveDate=date(details.effectiveDate),rateHistory=structuredClone(person.rateHistory||[]),existing=rateHistory.find(entry=>entry.effectiveDate===effectiveDate);
    if(existing&&existing.hourlyRate!==details.hourlyRate){const error=new Error('برای این تاریخ نرخ دیگری ثبت شده است؛ تاریخ تازه‌ای انتخاب کنید.');error.status=409;error.code='DUPLICATE_RATE_DATE';throw error;}
    if(!existing)rateHistory.push({effectiveDate,hourlyRate:details.hourlyRate});
    rateHistory.sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate));next.rateHistory=rateHistory;
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),applicable=rateHistory.filter(entry=>entry.effectiveDate<=today).at(-1);
    if(applicable)next.hourlyRate=applicable.hourlyRate;
  }
  Object.assign(person,next);return person;
}
