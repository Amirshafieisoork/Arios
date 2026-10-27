import { renderVoiceAudio, wireVoiceAudio, audioPlaybackActive } from './voice-player.mjs';
// Voice reports are drafts until a person confirms their project and working hours.
// Provider keys and Telegram tokens never enter browser storage or this module's state.
const views = new Map();
let poll;
let audioCleanup;
const list = value => Array.isArray(value) ? value : [];
const statusLabels = {pending:'در صف پردازش',processing:'در حال تبدیل',ready:'آمادهٔ بررسی',failed:'نیازمند پیگیری',submitted:'گزارش ثبت شد'};
const sourceLabels = {telegram:'تلگرام',upload:'فایل صوتی',text:'متن'};
const field = (title,content,full=false) => `<label class="field ${full?'full':''}"><span class="field-label">${title}</span>${content}</label>`;
function memory(userId){if(!views.has(userId))views.set(userId,{loaded:false,loading:false,data:null,error:'',query:'',filter:'all',syncing:false,text:'',projectId:'',pendingRender:false,testing:false,diagnostics:null,processingIds:new Set(),retrying:false,retryProgress:'',reminders:null,reminderError:'',reminderLoading:false});return views.get(userId);}
const current = userId => document.querySelector('[data-voice-user]')?.dataset.voiceUser===userId;
const isManager = state => state.user.role==='manager';
export function retryableTelegramDrafts(drafts,now=Date.now()){
 const seen=new Set();
 return list(drafts).filter(d=>{
  if(d?.source!=='telegram'||!['failed','pending'].includes(d.status)||typeof d.id!=='string'||!d.id||seen.has(d.id)||d.audio?.available!==true)return false;
  if(d.audio.expiresAt&&!(Date.parse(d.audio.expiresAt)>now))return false;
  seen.add(d.id);return true;
 });
}
export function voiceRetryMessage(draft){
 if(draft?.status==='ready')return 'تبدیل انجام شد؛ متن ویس و پیش‌نویس گزارش آمادهٔ بررسی است';
 if(draft?.status==='failed')return draft.error||'پردازش کامل نشد؛ جزئیات را در پیش‌نویس ببینید و دوباره تلاش کنید';
 if(draft?.status==='processing')return 'این ویس در حال پردازش است؛ نتیجه با تازه‌سازی نمایش داده می‌شود';
 if(draft?.status==='pending')return 'ویس در صف پردازش است؛ نتیجه هنوز آماده نشده است';
 if(draft?.status==='submitted')return 'گزارش این ویس قبلاً ثبت شده است';
 return 'نتیجهٔ پردازش دریافت نشد؛ وضعیت پیش‌نویس را تازه کنید';
}
/** One explicit action retries a finite snapshot sequentially, never a polling loop. */
export async function retryTelegramDrafts({drafts,retry,onResult=()=>{},isActive=()=>true,limit=10,now=Date.now()}){
 const eligible=retryableTelegramDrafts(drafts,now),queue=eligible.slice(0,Math.max(0,Math.min(10,Math.floor(limit)||0)));
 const summary={attempted:0,ready:0,failed:0,pending:0,remaining:eligible.length,stopped:false};
 for(const draft of queue){
  if(!isActive()){summary.stopped=true;break;}
  let result,error;
  try{result=await retry(draft.id);}
  catch(cause){error=cause;}
  summary.attempted++;summary.remaining--;
  if(result?.status==='ready')summary.ready++;
  else if(error||result?.status==='failed')summary.failed++;
  else summary.pending++;
  await onResult({draft,result,error,summary:{...summary}});
  if(error&&[401,403,429].includes(error.status)||['AI_QUOTA_EXCEEDED','AI_AUTH_FAILED','AI_NOT_CONFIGURED','AI_CONFIG_INVALID','AI_REGION_UNSUPPORTED','UPSTREAM_RATE_LIMITED'].includes(result?.processing?.code)){summary.stopped=true;break;}
 }
 return summary;
}
const AI_SERVICES = Object.freeze({
 'https://api.avalai.ir/v1':Object.freeze({label:'AvalAI',aiModel:'gpt-4o-mini',transcriptionModel:'whisper-1'}),
 'https://api.openai.com/v1':Object.freeze({label:'OpenAI',aiModel:'gpt-4o-mini',transcriptionModel:'whisper-1'}),
 'https://api.groq.com/openai/v1':Object.freeze({label:'Groq',aiModel:'openai/gpt-oss-20b',transcriptionModel:'whisper-large-v3-turbo'}),
});
const defaultProvider = 'https://api.avalai.ir/v1';
export function voiceProviderDefaults(base){return Object.hasOwn(AI_SERVICES,base)?{...AI_SERVICES[base]}:null;}
export function voiceConnectionPayload(form,current={}){
 const payload=Object.fromEntries(form),service=voiceProviderDefaults(payload.aiBaseUrl);
 if(!service)throw new Error('سرویس انتخاب‌شده معتبر نیست');
 const key=typeof payload.aiApiKey==='string'?payload.aiApiKey.trim():'';
 if((!current.aiConfigured||payload.aiBaseUrl!==(current.aiBaseUrl||defaultProvider))&&!key)throw new Error(`کلید اختصاصی ${service.label} را وارد کنید؛ کلید سرویس قبلی برای این اتصال استفاده نمی‌شود`);
 if(key)payload.aiApiKey=key;else delete payload.aiApiKey;
 if(typeof payload.telegramBotToken!=='string'||!payload.telegramBotToken.trim())delete payload.telegramBotToken;
 return payload;
}
export function wireVoiceConnectionForm(form,current={}){
 if(!form)return()=>{};
 const select=form.querySelector('[name="aiBaseUrl"]'),key=form.querySelector('[name="aiApiKey"]'),report=form.querySelector('[name="aiModel"]'),transcription=form.querySelector('[name="transcriptionModel"]'),note=form.querySelector('[data-ai-provider-note]');
 if(!select||!key)return()=>{};
 const savedProvider=current.aiBaseUrl||defaultProvider;
 const update=changed=>{
  const service=voiceProviderDefaults(select.value);if(!service)return;
  const sameProvider=select.value===savedProvider;
  if(changed){key.value='';if(report)report.value=sameProvider?(current.aiModel||service.aiModel):service.aiModel;if(transcription)transcription.value=sameProvider?(current.transcriptionModel||service.transcriptionModel):service.transcriptionModel;}
  key.required=!current.aiConfigured||!sameProvider;
  key.placeholder=key.required?`کلید اختصاصی ${service.label}`:'کلید ذخیره شده؛ برای حفظ، خالی بگذارید';
  if(note)note.textContent=service.label==='Groq'?'Groq پلن رایگان با سهمیه و محدودیت مصرف دارد؛ سهمیهٔ دقیق را در حساب خود بررسی کنید. برای اتصال، کلید اختصاصی Groq لازم است.':'کلید اختصاصی همین سرویس را وارد کنید. تغییر سرویس، کلید ذخیره‌شدهٔ سرویس قبلی را منتقل نمی‌کند.';
 };
 const change=()=>update(true);select.addEventListener('change',change);update(false);
 return()=>select.removeEventListener('change',change);
}
function projectOptions(state,ctx,selected='',placeholder='انتخاب نشده؛ از متن تشخیص داده شود'){
  return `<option value="">${placeholder}</option>${state.projects.map(p=>`<option value="${ctx.e(p.id)}" ${selected===p.id?'selected':''}>${ctx.e(p.name)}</option>`).join('')}`;
}
function statusBadge(value){return `<span class="badge ${value==='submitted'?'green':value==='ready'?'blue':value==='failed'?'red':'gold'}"><i></i>${statusLabels[value]||'وضعیت نامشخص'}</span>`;}
function intro(ctx){return `<div class="page-head"><div><div class="eyebrow">ARIOS / VOICE REPORTS</div><h1 class="page-title">ویس و گزارش هوشمند</h1><p class="page-subtitle">از صدای تیم تا گزارشی روشن، قابل بررسی و قابل پیگیری.</p></div><div class="actions"><button class="button secondary" data-voice-reload>${ctx.icon('clock')}تازه‌سازی</button></div></div>`;}
function diagnostics(m,ctx){
 if(m.testing)return '<p class="notice" role="status">در حال بررسی ساخت گزارش و تبدیل گفتار…</p>';
 if(!m.diagnostics)return '';
 if(m.diagnostics.error)return `<p class="alert" role="status">${ctx.e(m.diagnostics.error)}</p>`;
 return `<div class="voice-service-tests" role="status"><h3>نتیجهٔ بررسی سرویس${m.diagnostics.provider?' · '+ctx.e(m.diagnostics.provider):''}</h3>${[['chat','ساخت گزارش و گفتگو'],['transcription','تبدیل گفتار به متن']].map(([key,label])=>{const stage=m.diagnostics[key]||{};return `<div class="voice-service-test"><strong>${label}</strong><span class="badge ${stage.ok?'green':'red'}">${stage.ok?'موفق':'نیازمند بررسی'}</span><p>${ctx.e(stage.message||(stage.ok?'سرویس پاسخ معتبر داد':'سرویس پاسخ معتبر نداد'))}</p></div>`;}).join('')}<small class="muted">این یک آزمون کوتاه اتصال است؛ کیفیت تبدیل ویس واقعی جداگانه بررسی می‌شود</small></div>`;
}
function updateDiagnostics(state,ctx){
 if(!current(state.user.id))return;const m=memory(state.user.id),target=document.querySelector('[data-voice-diagnostics]'),button=document.querySelector('[data-voice-test]'),configButton=document.querySelector('[data-voice-config]');
 if(target){target.innerHTML=diagnostics(m,ctx);target.setAttribute('aria-busy',String(m.testing));}
 if(button){button.disabled=m.testing||ctx.api.isStatic;button.textContent=m.testing?'در حال بررسی…':'بررسی واقعی سرویس';}
 if(configButton)configButton.disabled=m.testing;
}
async function testConnections(state,ctx){
 const m=memory(state.user.id);if(m.testing||!isManager(state))return;m.testing=true;m.diagnostics=null;updateDiagnostics(state,ctx);
 try{m.diagnostics=await ctx.api.integrationsTest();}
 catch(error){m.diagnostics={error:error?.code==='AI_NOT_CONFIGURED'?'ابتدا کلید و مدل‌های سرویس را در تنظیم اتصال‌ها ثبت کنید':error?.status===401?'نشست شما منقضی شده؛ دوباره وارد حساب شوید':error?.status===403?'این بررسی فقط برای مدیر فضای کار مجاز است':'آزمون اتصال کامل نشد؛ دوباره تلاش کنید'};}
 finally{m.testing=false;updateDiagnostics(state,ctx);}
}
export function telegramMemberChoices(state,links=[]) {
 const connected=new Set(list(links).map(link=>link.userId));
 return list(state.users).filter(user=>!user.deletedAt&&(['manager','worker','warehouse','accountant'].includes(user.role))).map(user=>({id:user.id,name:user.name,linked:connected.has(user.id)}));
}
export function telegramBotStartLink(botUsername,code) {
 if(typeof botUsername!=='string'||!/^\w{5,32}$/.test(botUsername)||typeof code!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(code))return null;
 return `https://t.me/${botUsername}?start=${encodeURIComponent(code)}`;
}
export function schedulerHeartbeatHealthy(data,now=Date.now()) {
 const tick=typeof data?.lastTickAt==='string'?Date.parse(data.lastTickAt):NaN;
 return data?.configured===true&&data?.schedulerConfigured===true&&Number.isFinite(tick)&&tick<=now+60000&&now-tick<=10*60000;
}
export function renderReminderStatus(data,ctx,{error='',loading=false,now=Date.now()}={}) {
 if(!data)return `<section class="card voice-reminder-status"><div class="card-head"><h2 class="card-title">یادآوری کارهای فردا</h2></div><p class="muted">${error?ctx.e(error):loading?'در حال دریافت وضعیت یادآوری…':'وضعیت یادآوری هنوز دریافت نشده است.'}</p><button class="button secondary small" data-reminder-reload ${loading?'disabled':''}>بررسی وضعیت</button></section>`;
 const active=data.enabled===true&&schedulerHeartbeatHealthy(data,now);
 const tick=typeof data.lastTickAt==='string'?Date.parse(data.lastTickAt):NaN;
 const label=!data.enabled?'متوقف':!data.configured||!data.schedulerConfigured?'نیازمند تکمیل اتصال':!Number.isFinite(tick)?'منتظر اولین بررسی سرور':active?'فعال':'نیازمند بررسی زمان‌بند';
 const lastCheck=Number.isFinite(tick)?`آخرین بررسی سرور: ${new Intl.DateTimeFormat('fa-IR',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tehran'}).format(new Date(tick))} به وقت تهران`:'هنوز دریافت زمان‌بند تأیید نشده است.';
 const statusLabels={pending:'در صف',sending:'در حال ارسال',sent:'ارسال‌شده',failed:'ناموفق',unknown:'نتیجه نامشخص',cancelled:'لغوشده'};
 const summary=data.summary||{};
 const errorLabels={TELEGRAM_BLOCKED:'عضو دریافت پیام از بات را مسدود کرده است',TELEGRAM_RATE_LIMITED:'محدودیت تلگرام؛ تلاش پس از زمان مجاز',DELIVERY_UNKNOWN:'نتیجهٔ ارسال نامشخص است؛ پیام خودکار تکرار نمی‌شود',TELEGRAM_DELIVERY_UNCERTAIN:'نتیجهٔ ارسال نامشخص است؛ پیام خودکار تکرار نمی‌شود',TELEGRAM_RESPONSE_UNCERTAIN:'نتیجهٔ ارسال نامشخص است؛ پیام خودکار تکرار نمی‌شود'};
 return `<section class="card voice-reminder-status"><div class="card-head"><div><h2 class="card-title">یادآوری کارهای فردا</h2><p class="muted">هر شب ساعت ۲۱ به وقت تهران · فقط برای همکار دارای مأموریت فردا</p></div><span class="badge ${active?'green':'gold'}">${ctx.e(label)}</span></div><p class="muted">${ctx.n(data.linkedCount||0)} عضو متصل · ${ctx.n(data.assignedCount||0)} عضو با مأموریت باز برای ${ctx.e(ctx.date(data.targetDate))}</p><p class="muted">${ctx.n(data.recipientCount??Math.min(data.linkedCount||0,data.assignedCount||0))} دریافت‌کنندهٔ یادآوری شبانه؛ به همکار بدون مأموریت فردا پیامی ارسال نمی‌شود.</p>${data.unlinkedAssignedCount?`<p class="notice">${ctx.n(data.unlinkedAssignedCount)} همکار با مأموریت فردا هنوز به تلگرام وصل نیستند و پیام دریافت نمی‌کنند. از «اتصال حساب تلگرام» آن‌ها را متصل کنید.</p>`:''}${data.lastSentAt?`<p class="muted">آخرین تأیید ارسال تلگرام: ${ctx.e(new Intl.DateTimeFormat('fa-IR',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Tehran'}).format(new Date(data.lastSentAt)))} به وقت تهران</p>`:''}${list(data.coverage).length?`<details class="reminder-coverage"><summary>وضعیت دریافت اعضای تیم</summary>${list(data.coverage).map(person=>`<div class="list-item"><strong>${ctx.e(person.name||'عضو تیم')}</strong><p class="muted">${ctx.n(person.taskCount||0)} مأموریت · ${ctx.e(person.linked?(person.taskCount?'متصل؛ خلاصهٔ مأموریت‌ها ارسال می‌شود':'متصل؛ بدون مأموریت، پیام ارسال نمی‌شود'):'تلگرام متصل نیست')}</p></div>`).join('')}</details>`:''}<p class="muted" data-reminder-last-check>${ctx.e(lastCheck)}</p>${!data.configured?'<p class="voice-sync-note">بات تلگرام هنوز تنظیم نشده است.</p>':!data.schedulerConfigured?'<p class="voice-sync-note">زمان‌بندی سرور هنوز آماده نیست؛ ارسال خودکار تأیید نشده است.</p>':''}<div class="reminder-summary">${['sent','pending','failed','unknown'].map(status=>`<span>${statusLabels[status]} <b>${ctx.n(summary[status]||0)}</b></span>`).join('')}</div><div class="actions"><button type="button" class="button secondary small" data-reminder-toggle="${data.enabled?'false':'true'}">${data.enabled?'توقف یادآوری شبانه':'فعال کردن یادآوری شبانه'}</button><button type="button" class="button secondary small" data-reminder-reload>تازه‌سازی وضعیت</button></div>${error?`<p class="voice-error" role="alert">${ctx.e(error)}</p>`:''}${list(data.deliveries).length?`<details class="reminder-deliveries"><summary>جزئیات پیگیری ارسال‌ها</summary>${data.deliveries.map(delivery=>`<div class="list-item"><div class="row between"><strong>${ctx.e(delivery.name||'عضو تیم')}</strong><span>${ctx.e(statusLabels[delivery.status]||'در حال بررسی')}</span></div><small>${ctx.e(ctx.date(delivery.targetDate))} · ${ctx.n(delivery.taskCount||0)} مأموریت</small>${delivery.errorCode?`<p class="muted">${ctx.e(errorLabels[delivery.errorCode]||'ارسال نیازمند بررسی است؛ وضعیت اتصال عضو را بررسی کنید.')}</p>`:''}</div>`).join('')}</details>`:''}</section>`;
}
function integrations(state,ctx,data){
 const c=data.integration||{}, t=data.telegram||{},provider=voiceProviderDefaults(c.aiBaseUrl);
 return `<section class="card voice-connections"><div class="card-head"><div><h2 class="card-title">اتصال‌های آریوس</h2><p class="muted">${isManager(state)?'تنظیمات اختصاصی همین فضای کار':'وضعیت سرویس‌های گزارش صوتی'}</p></div><span class="voice-connection-state ${c.aiConfigured?'connected':''}"><i></i>${c.aiConfigured?'سرویس تبدیل تنظیم شده':'سرویس تبدیل تنظیم نشده'}</span></div><div class="voice-connection-list"><div><span>تبدیل صوت و ساخت گزارش</span><strong>${c.aiConfigured?(provider?ctx.e(provider.label)+' · ':'')+'کلید اختصاصی ثبت شده':'نیازمند کلید اختصاصی'}</strong></div><div><span>بات تلگرام</span><strong dir="ltr">${t.botUsername?'@'+ctx.e(t.botUsername):(t.configured?'تنظیم شده':'تنظیم نشده')}</strong></div><div><span>حساب تلگرام شما</span><strong>${t.linked?'متصل':'متصل نشده'}</strong></div></div>${isManager(state)?`<div class="actions"><button class="button secondary" data-voice-config ${memory(state.user.id).testing?'disabled':''}>${ctx.icon('settings')}تنظیم اتصال‌ها</button><button class="button secondary" data-voice-test ${memory(state.user.id).testing||ctx.api.isStatic?'disabled':''}>${memory(state.user.id).testing?'در حال بررسی…':'بررسی واقعی سرویس'}</button></div><div data-voice-diagnostics aria-live="polite" aria-busy="${memory(state.user.id).testing}">${diagnostics(memory(state.user.id),ctx)}</div>`:''}${t.configured?`<button class="button secondary" data-telegram-link>${ctx.icon('team')}${isManager(state)?'اتصال حساب عضو تیم':'اتصال حساب من'}</button>`:''}${isManager(state)&&list(t.links).length?`<div class="voice-linked-accounts"><h3>حساب‌های متصل (${ctx.e(ctx.n(list(t.links).length))})</h3>${t.links.map(l=>`<div class="row between"><span>${ctx.e(l.name)}</span><button class="button secondary small" data-telegram-unlink="${ctx.e(l.userId)}">قطع اتصال</button></div>`).join('')}</div>`:t.linked?'<button class="button secondary small" data-telegram-unlink>قطع اتصال من</button>':''}</section>`;
}
function drafts(state,ctx,m){
 const all=list(m.data?.drafts), rows=all.filter(d=>(m.filter==='all'||d.status===m.filter)&&(!m.query||[d.transcript,d.fields?.description,d.fields?.output,ctx.projectName(d.fields?.projectId)].join(' ').includes(m.query)));
 return `<section class="card voice-drafts"><div class="card-head"><div><h2 class="card-title">صندوق پیش‌نویس‌ها</h2><p class="muted">متن اصلی را با گزارش مقایسه کنید، سپس برای بررسی مدیر بفرستید.</p></div><div class="actions"><span class="badge gray">${ctx.e(ctx.n(all.length))} مورد</span>${isManager(state)?`<button class="button secondary small" data-voice-retry-all ${m.retrying||m.processingIds.size||m.syncing||!m.data?.integration?.aiConfigured||ctx.api.isStatic||!retryableTelegramDrafts(all).length?'disabled':''}>${m.retrying?'در حال پردازش ویس‌ها…':'پردازش ویس‌های باقی‌مانده'}</button>`:''}</div></div>${isManager(state)?`<p class="muted" data-voice-retry-progress role="status" aria-live="polite">${ctx.e(m.retryProgress)}</p>`:''}<div class="voice-filters"><label class="searchbox">${ctx.icon('search')}<input data-voice-search aria-label="جست‌وجو در پیش‌نویس‌ها" placeholder="جست‌وجو در متن و گزارش…" value="${ctx.e(m.query)}"></label><label class="field"><span class="sr-only">وضعیت پیش‌نویس</span><select data-voice-filter><option value="all">همهٔ وضعیت‌ها</option>${Object.entries(statusLabels).map(([k,v])=>`<option value="${k}" ${m.filter===k?'selected':''}>${v}</option>`).join('')}</select></label></div><div class="voice-draft-list">${rows.length?rows.map(d=>`<article class="voice-draft"><div class="row between"><div class="voice-draft-origin"><span class="voice-source-icon">${ctx.icon(d.source==='telegram'?'send':d.source==='upload'?'reports':'assistant')}</span><div><strong>${ctx.e(sourceLabels[d.source]||'گزارش')}</strong><small>${ctx.e(ctx.date(d.createdAt))}${isManager(state)?' · '+ctx.e(ctx.personName(d.userId)):''}</small></div></div>${statusBadge(m.processingIds.has(d.id)?'processing':d.status)}</div><h3>${ctx.e(d.fields?.projectId?ctx.projectName(d.fields.projectId):'پروژه هنوز مشخص نشده')}</h3><p class="voice-excerpt">${ctx.e((d.fields?.description||d.transcript||'منتظر دریافت متن صوت…').slice(0,240))}</p>${d.error?`<p class="voice-error" role="status">${ctx.e(d.error)}</p>`:''}${renderVoiceAudio(d,{escape:ctx.e,date:ctx.date})}${list(d.fields?.warnings).length?`<div class="voice-missing">${ctx.icon('bell')} ${ctx.e(ctx.n(d.fields.warnings.length))} نکته برای بررسی</div>`:''}<div class="row between voice-draft-foot"><small>${d.fields?.date?ctx.e(ctx.date(d.fields.date)):'تاریخ نیازمند بررسی'}${d.fields?.start&&d.fields?.end?' · '+ctx.e(d.fields.start)+' تا '+ctx.e(d.fields.end):''}</small><div class="actions">${d.transcript?`<button class="button secondary small" data-voice-download="${ctx.e(d.id)}" aria-label="دریافت متن پیش‌نویس">${ctx.icon('download')}</button>`:''}${d.status==='ready'?`<button class="button primary small" data-voice-review="${ctx.e(d.id)}">بررسی و ثبت ${ctx.icon('arrow')}</button>`:['failed','pending'].includes(d.status)?`<button class="button secondary small" data-voice-retry="${ctx.e(d.id)}" ${m.processingIds.has(d.id)||m.retrying?'disabled':''}>${m.processingIds.has(d.id)?'در حال پردازش…':d.status==='pending'?'پردازش ویس':'تلاش دوباره'}</button>`:d.status==='submitted'?'<a class="button secondary small" href="#reports">گزارش‌های کار</a>':'<span class="muted">در حال آماده‌سازی…</span>'}</div></div>${d.transcript?`<details class="voice-transcript"><summary>متن اصلی ${d.source==='text'?'گزارش':'ویس'}</summary><p class="pre-wrap">${ctx.e(d.transcript)}</p></details>`:''}</article>`).join(''):`<div class="voice-empty">${ctx.icon('reports')}<h3>${all.length?'پیش‌نویسی با این مشخصات پیدا نشد':'اولین گزارش را با صدای خودتان بسازید'}</h3><p>${all.length?'فیلتر یا عبارت جست‌وجو را تغییر دهید.':'فایل ویس را بارگذاری کنید، متن بنویسید یا حسابتان را به بات تلگرام وصل کنید.'}</p></div>`}</div></section>`;
}
export function renderVoice(state,ctx){
 if(!['manager','worker'].includes(state.user.role))return '<section class="card"><p>گزارش‌های صوتی برای تیم اجرایی و مدیر در دسترس است.</p></section>';
 const m=memory(state.user.id),data=m.data||{drafts:[],integration:{},telegram:{}};
 const disabled=!data.integration?.aiConfigured||ctx.api.isStatic;
 return `${intro(ctx)}<div data-voice-user="${ctx.e(state.user.id)}" class="voice-workspace">${ctx.api.isStatic?'<div class="notice">این نسخه نمایشی است. تبدیل واقعی ویس و اتصال تلگرام در فضای کار سروری فعال می‌شود.</div>':''}${m.error?`<div class="alert" role="alert">${ctx.e(m.error)} <button class="button secondary small" data-voice-reload>تلاش دوباره</button></div>`:''}<section class="voice-hero"><div><span class="hero-kicker">بگویید چه کاری انجام شد</span><h2>گزارش کار، از دلِ گفتگو</h2><p>ویس به متن تبدیل می‌شود و جزئیات گزارش در یک پیش‌نویس می‌آید. پروژه، تاریخ و ساعت‌های نامشخص را پیش از ثبت تکمیل کنید.</p><div class="voice-steps"><span><b>۱</b>دریافت ویس</span><i>←</i><span><b>۲</b>ساخت پیش‌نویس</span><i>←</i><span><b>۳</b>بررسی و ثبت</span></div></div><div class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><span>${ctx.icon('assistant')}</span></div></section>${!m.loaded?'<p class="voice-loading" role="status">در حال دریافت پیش‌نویس‌ها و وضعیت اتصال…</p>':''}<div class="voice-input-grid"><section class="card voice-upload-card"><div class="card-head"><div><h2 class="card-title">فایل صوتی یا متن گزارش</h2><p class="muted">ویس فارسی، بدون نیاز به تغییر فرمت</p></div>${ctx.icon('reports')}</div><label class="field"><span class="field-label">پروژه (اختیاری)</span><select data-voice-project>${projectOptions(state,ctx,m.projectId)}</select></label><form data-voice-upload class="voice-upload-form"><label class="voice-dropzone" for="voice-file"><span class="voice-upload-icon">${ctx.icon('download')}</span><strong>ویس تلگرام یا فایل صوتی را انتخاب کنید</strong><span>OGG · MP3 · M4A · WAV · WEBM · OPUS — حداکثر ۲۰ مگابایت</span><input id="voice-file" name="file" type="file" accept="audio/*,.ogg,.opus,.mp3,.m4a,.wav,.webm" ${disabled?'disabled':''} required></label><p class="voice-file-name" data-voice-file-name aria-live="polite"></p><button class="button primary full" type="submit" ${disabled?'disabled':''}>${ctx.icon('assistant')}تبدیل صوت به پیش‌نویس</button></form><details class="voice-text-entry"><summary>متن گزارش را خودم وارد می‌کنم</summary><form data-voice-text>${field('متن فعالیت',`<textarea name="transcript" maxlength="16000" rows="5" required placeholder="مثلاً امروز در پروژهٔ آفتاب از ساعت ۹ تا ۱۳ کابل‌کشی طبقهٔ دوم را انجام دادم…" ${disabled?'disabled':''}>${ctx.e(m.text)}</textarea>`,true)}<button class="button secondary" type="submit" ${disabled?'disabled':''}>ساخت پیش‌نویس از متن</button></form></details><p class="voice-privacy">صوت و متن برای تبدیل به سرویس انتخابی مدیر فرستاده می‌شود. صوت اصلی حداکثر هفت روز به‌صورت خصوصی نگه‌داری می‌شود. گزارش نهایی پس از بررسی شما ذخیره می‌شود.</p>${disabled?`<div class="notice">${isManager(state)?'برای شروع، کلید اختصاصی سرویس تبدیل را در «تنظیم اتصال‌ها» وارد کنید.':'مدیر باید ابتدا سرویس تبدیل صوت را تنظیم کند.'}</div>`:''}</section><div class="voice-side">${integrations(state,ctx,data)}${isManager(state)?renderReminderStatus(m.reminders,ctx,{error:m.reminderError,loading:m.reminderLoading}):''}<section class="card voice-telegram-card"><div class="card-head"><h2 class="card-title">دریافت از تلگرام</h2><span class="voice-telegram-mark">${ctx.icon('send')}</span></div><ol class="voice-guide"><li>حساب عضو تیم را با کد یک‌بارمصرف به بات وصل کنید.</li><li>ویس را در گفت‌وگوی خصوصی بات بفرستید.</li><li>${isManager(state)?'دریافت را همگام کنید و پیش‌نویس را همین‌جا بررسی کنید.':'پس از دریافت و پردازش، پیش‌نویس خود را اینجا بررسی کنید.'}</li></ol><div class="voice-sync-note"><i class="status-dot"></i>${isManager(state)?(schedulerHeartbeatHealthy(m.reminders)?'دریافت پیام‌های بات با زمان‌بندی سرور انجام می‌شود، حتی وقتی این صفحه بسته است. برای دریافت فوری، دکمهٔ زیر را بزنید.':'تا آماده شدن زمان‌بندی سرور، هنگام باز بودن این صفحه دریافت هر ۳۰ ثانیه بررسی می‌شود. برای دریافت فوری، دکمهٔ زیر را بزنید.'):'این صفحه وضعیت پیش‌نویس‌های شما را هر ۳۰ ثانیه تازه می‌کند. پیام‌ها پس از دریافت و پردازش در صندوق شما نمایش داده می‌شوند.'}</div>${isManager(state)?`<button class="button secondary full" data-telegram-sync ${!data.telegram?.configured||ctx.api.isStatic||m.syncing?'disabled':''}>${ctx.icon('clock')}${m.syncing?'در حال دریافت…':'همگام‌سازی تلگرام'}</button>`:''}${m.lastSync?`<small class="voice-last-sync">آخرین بررسی: ${ctx.e(m.lastSync)}</small>`:''}</section></div></div>${drafts(state,ctx,m)}</div>`;
}
async function reload(state,ctx,{quiet=false}={}){
 const m=memory(state.user.id);if(m.loading)return;m.loading=true;
 try{const reminder=isManager(state)&&!ctx.api.isStatic&&typeof ctx.api.reminders==='function'?ctx.api.reminders().then(data=>{m.reminders=data;m.reminderError='';}).catch(()=>{m.reminderError='دریافت وضعیت یادآوری انجام نشد؛ دوباره بررسی کنید.';}):Promise.resolve();m.data=await ctx.api.voice();await reminder;m.loaded=true;m.error='';}
 catch(error){m.error=error.message||'دریافت پیش‌نویس‌ها انجام نشد.';m.loaded=true;}
 finally{m.loading=false;if(current(state.user.id)&&!quiet){if(audioPlaybackActive(document))m.pendingRender=true;else{m.pendingRender=false;await ctx.refresh();}}}
}
function listen(selector,fn){document.querySelectorAll(selector).forEach(el=>el.addEventListener('click',()=>fn(el)));}
async function withButton(button,ctx,fn){if(button.disabled)return;button.disabled=true;try{await fn();}catch(error){ctx.toast(error.message||'عملیات انجام نشد.');}finally{if(button.isConnected)button.disabled=false;}}
function connectionModal(state,ctx){
 const m=memory(state.user.id),c=m.data?.integration||{},base=voiceProviderDefaults(c.aiBaseUrl)?c.aiBaseUrl:defaultProvider,defaults=voiceProviderDefaults(base);
 ctx.modal({title:'اتصال سرویس‌ها به آریوس',submitLabel:'ذخیرهٔ اتصال‌ها',body:`<p class="muted">فقط اطلاعات اختصاصی همین پروژه را وارد کنید. کلیدها در خروجی داده‌ها و مرورگر ذخیره نمی‌شوند. برای حفظ کلید همان سرویس، ورودی را خالی بگذارید؛ تغییر سرویس به کلید اختصاصی تازه نیاز دارد.</p><div class="form-grid">${field('سرویس تبدیل و هوش مصنوعی',`<select name="aiBaseUrl">${Object.entries(AI_SERVICES).map(([url,service])=>`<option value="${url}" ${base===url?'selected':''}>${service.label}${service.label==='Groq'?' · دارای پلن رایگان':''}</option>`).join('')}</select>`,true)}${field('کلید اختصاصی سرویس',`<input name="aiApiKey" type="password" dir="ltr" autocomplete="new-password" maxlength="512" placeholder="${c.aiConfigured?'کلید ذخیره شده؛ برای حفظ، خالی بگذارید':'کلید API'}">`,true)}<p class="muted full" data-ai-provider-note></p>${field('مدل ساخت گزارش',`<input name="aiModel" dir="ltr" required maxlength="100" value="${ctx.e(c.aiModel||defaults.aiModel)}">`)}${field('مدل تبدیل گفتار',`<input name="transcriptionModel" dir="ltr" required maxlength="100" value="${ctx.e(c.transcriptionModel||defaults.transcriptionModel)}">`)}${field('توکن بات تلگرام',`<input name="telegramBotToken" type="password" dir="ltr" autocomplete="new-password" maxlength="200" placeholder="${c.telegramConfigured?'توکن ذخیره شده؛ برای حفظ، خالی بگذارید':'توکن اختصاصی بات از BotFather'}">`,true)}</div><p class="muted"><a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">ساخت یا دریافت کلید Groq</a> · پس از ذخیره، «بررسی واقعی سرویس» را اجرا کنید</p><div class="notice">دریافت تلگرام از طریق همگام‌سازی انجام می‌شود. اگر این بات وب‌هوک فعالی داشته باشد، پیش از استفاده باید روش دریافت آن را در تلگرام بررسی کنید.</div>`,onSubmit:async form=>{const payload=voiceConnectionPayload(form,c);await ctx.api.integrations(payload);await reload(state,ctx);ctx.toast('تنظیم اتصال‌ها ذخیره شد.');}});
 wireVoiceConnectionForm(document.querySelector('#modal-form'),c);
}
function linkModal(state,ctx){
 const workers=telegramMemberChoices(state,memory(state.user.id).data?.telegram?.links);
 ctx.modal({title:'اتصال حساب تلگرام',submitLabel:'ساخت کد اتصال',body:`<p class="muted">کد یک‌بارمصرف را فقط به همان عضو بدهید. برای پیدا کردن سریع عضو، نام او را جست‌وجو کنید.</p>${isManager(state)?`${field('جست‌وجوی عضو', '<input type="search" data-telegram-member-search placeholder="نام عضو…" autocomplete="off">')}${field('عضو تیم',`<select name="userId" required size="${Math.min(6,Math.max(2,workers.length))}">${workers.map(user=>`<option value="${ctx.e(user.id)}">${ctx.e(user.name)}${user.linked?' · متصل':''}</option>`).join('')}</select>`)}<p class="muted" data-telegram-member-count>${ctx.n(workers.length)} حساب قابل انتخاب</p>`:`<p>حساب آریوس: <strong>${ctx.e(state.user.name)}</strong></p>`}`,onSubmit:async form=>{const result=await ctx.api.telegramLink(isManager(state)?{userId:form.get('userId')}:{});const deepLink=telegramBotStartLink(result.botUsername,result.code);const body=`<p>این دستور را در گفت‌وگوی خصوصی ${result.botUsername?`بات <strong dir="ltr">@${ctx.e(result.botUsername)}</strong>`:'بات آریوس'} بفرستید:</p><div class="voice-link-code" dir="ltr" data-telegram-command>/start ${ctx.e(result.code)}</div><div class="actions">${deepLink?`<a class="button primary" href="${ctx.e(deepLink)}" target="_blank" rel="noopener noreferrer">باز کردن تلگرام با کد اتصال</a>`:''}<button type="button" class="button secondary" data-telegram-copy>کپی دستور اتصال</button></div><p class="muted" data-telegram-copy-status role="status"></p><p class="muted">کد یک‌بارمصرف است و ${result.expiresAt?'تا '+ctx.e(new Intl.DateTimeFormat('fa-IR',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tehran'}).format(new Date(result.expiresAt)))+' به وقت تهران':'مدت محدودی'} اعتبار دارد. عضو باید دکمهٔ Start بات را بزند. وضعیت اتصال با دریافت بعدی تلگرام به‌روز می‌شود؛ برای دریافت فوری «همگام‌سازی تلگرام» را بزنید.</p>`;setTimeout(()=>{ctx.modal({title:'کد اتصال آماده است',submitLabel:'متوجه شدم',body,onSubmit:async()=>{}});document.querySelector('[data-telegram-copy]')?.addEventListener('click',async()=>{const status=document.querySelector('[data-telegram-copy-status]');try{await navigator.clipboard.writeText('/start '+result.code);status.textContent='دستور اتصال کپی شد.';}catch{status.textContent='کپی خودکار ممکن نشد؛ دستور بالا را انتخاب و کپی کنید.';}});},0);}});
 const form=document.querySelector('#modal-form'),search=form.querySelector('[data-telegram-member-search]'),select=form.querySelector('[name="userId"]');
 search?.addEventListener('input',()=>{const query=search.value.trim().replace(/ي/g,'ی').replace(/ك/g,'ک');let found=0;for(const option of select.options){option.hidden=!option.textContent.replace(/ي/g,'ی').replace(/ك/g,'ک').includes(query);if(!option.hidden)found++;}if(select.selectedOptions[0]?.hidden)select.value=[...select.options].find(option=>!option.hidden)?.value||'';form.querySelector('[data-telegram-member-count]').textContent=`${ctx.n(found)} حساب قابل انتخاب`;});
}

function reviewModal(draft,state,ctx){
 const f=draft.fields||{},manager=isManager(state);
 const input=(name,type,value,extra='')=>`<input name="${name}" type="${type}" value="${ctx.e(value??'')}" ${extra}>`;
 const workerOptions=(projectId,selected)=>{const p=state.projects.find(p=>p.id===projectId);return '<option value="">انتخاب نیروی اجرایی</option>'+state.users.filter(u=>u.role==='worker'&&!u.deletedAt&&(!p||p.memberIds.includes(u.id))).map(u=>`<option value="${ctx.e(u.id)}" ${selected===u.id?'selected':''}>${ctx.e(u.name)}</option>`).join('');};
 ctx.modal({title:'بررسی و تکمیل گزارش کار',submitLabel:'ثبت و ارسال برای بررسی مدیر',body:`<div class="notice">فقط فعالیت واقعی را ثبت کنید. این مرحله گزارش را برای بررسی می‌فرستد و به‌تنهایی هزینهٔ دستمزد ایجاد نمی‌کند.</div>${list(f.warnings).length?`<ul class="voice-warning-list">${f.warnings.map(w=>`<li>${ctx.e(w)}</li>`).join('')}</ul>`:''}<details class="voice-review-transcript"><summary>مقایسه با متن اصلی</summary><p class="pre-wrap">${ctx.e(draft.transcript||'')}</p></details><div class="form-grid">${field('پروژه',`<select name="projectId" required>${projectOptions(state,ctx,f.projectId,'انتخاب پروژه')}</select>`,true)}${manager?field('نیروی اجرایی',`<select name="workerId" required>${workerOptions(f.projectId,draft.userId)}</select>`,true):''}${field('تاریخ فعالیت',input('date','date',f.date,'required'))}${field('ساعت شروع',input('start','time',f.start,'required'))}${field('ساعت پایان',input('end','time',f.end,'required'))}${field('استراحت (دقیقه)',input('breakMinutes','number',f.breakMinutes,'required min="0" max="1439" step="1"'))}${field('شرح فعالیت',`<textarea name="description" rows="5" required maxlength="4000">${ctx.e(f.description||'')}</textarea>`,true)}${field('نتیجه و کار باقی‌مانده',`<textarea name="output" rows="4" maxlength="4000">${ctx.e(f.output||'')}</textarea>`,true)}</div>`,onSubmit:async form=>{const fields=Object.fromEntries(form);fields.breakMinutes=Number(fields.breakMinutes);await ctx.api.voiceSubmit(draft.id,fields);await reload(state,ctx);ctx.toast('گزارش برای بررسی مدیر ثبت شد.');}});
 document.querySelector('#modal-form [name="projectId"]')?.addEventListener('change',event=>{const select=document.querySelector('#modal-form [name="workerId"]');if(select)select.innerHTML=workerOptions(event.target.value,select.value);});
}
export function voiceDraftText(draft,ctx){
 const f=draft.fields||{};return [`گزارش کار آریوس — ${statusLabels[draft.status]||draft.status}`,`پروژه: ${f.projectId?ctx.projectName(f.projectId):'مشخص نشده'}`,`تاریخ: ${f.date?ctx.date(f.date):'مشخص نشده'}`,`ساعت: ${f.start||'—'} تا ${f.end||'—'}`,`استراحت: ${f.breakMinutes??'مشخص نشده'}`,`\nشرح فعالیت:\n${f.description||''}`,`\nنتیجه و کار باقی‌مانده:\n${f.output||''}`,`\nمتن اصلی:\n${draft.transcript||''}`].join('\n');
}
function download(draft,state,ctx){
 const text=voiceDraftText(draft,ctx);
 const url=URL.createObjectURL(new Blob(['\uFEFF'+text],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`ARIOS-report-${String(draft.id).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function rememberResult(m,result){
 if(!result?.id||!m.data)return;
 const index=list(m.data.drafts).findIndex(d=>d.id===result.id);
 if(index>=0)m.data.drafts[index]=result;
}
function updateRetryControls(state,ctx){
 if(!current(state.user.id))return;
 const m=memory(state.user.id),busy=m.retrying||m.processingIds.size>0;
 for(const button of document.querySelectorAll('[data-voice-retry]')){
  const processing=m.processingIds.has(button.dataset.voiceRetry),draft=list(m.data?.drafts).find(d=>d.id===button.dataset.voiceRetry);
  button.disabled=busy||m.syncing;
  button.textContent=processing?'در حال پردازش…':draft?.status==='pending'?'پردازش ویس':'تلاش دوباره';
 }
 const all=document.querySelector('[data-voice-retry-all]');
 if(all){all.disabled=busy||m.syncing||ctx.api.isStatic||!m.data?.integration?.aiConfigured||!retryableTelegramDrafts(m.data?.drafts).length;all.textContent=m.retrying?'در حال پردازش ویس‌ها…':'پردازش ویس‌های باقی‌مانده';}
 const progress=document.querySelector('[data-voice-retry-progress]');if(progress)progress.textContent=m.retryProgress;
 const syncButton=document.querySelector('[data-telegram-sync]');if(syncButton)syncButton.disabled=busy||m.syncing||!m.data?.telegram?.configured||ctx.api.isStatic;
}
async function retryDraft(id,state,ctx){
 const m=memory(state.user.id);if(!id||m.retrying||m.processingIds.size||m.syncing)return;
 m.processingIds.add(id);updateRetryControls(state,ctx);
 try{
  const result=await ctx.api.voiceRetry(id);rememberResult(m,result);
  if(current(state.user.id))ctx.toast(voiceRetryMessage(result));
 }catch(error){if(current(state.user.id))ctx.toast(error.message||'پردازش انجام نشد؛ دوباره تلاش کنید');}
 finally{m.processingIds.delete(id);await reload(state,ctx);updateRetryControls(state,ctx);}
}
async function retryRemaining(state,ctx){
 const m=memory(state.user.id);if(!isManager(state)||m.retrying||m.processingIds.size||m.syncing||ctx.api.isStatic||!m.data?.integration?.aiConfigured)return;
 const drafts=retryableTelegramDrafts(m.data?.drafts);if(!drafts.length)return;
 m.retrying=true;m.retryProgress='ویس‌ها به‌ترتیب پردازش می‌شوند؛ می‌توانید صوت‌ها را بشنوید';updateRetryControls(state,ctx);
 try{
  const result=await retryTelegramDrafts({drafts,isActive:()=>current(state.user.id),retry:async id=>{
   m.processingIds.add(id);updateRetryControls(state,ctx);
   try{return await ctx.api.voiceRetry(id);}finally{m.processingIds.delete(id);}
  },onResult:async({result,error,summary})=>{
   rememberResult(m,result);
   m.retryProgress=`${ctx.n(summary.attempted)} ویس بررسی شد؛ ${ctx.n(summary.ready)} پیش‌نویس آماده و ${ctx.n(summary.failed)} مورد نیازمند پیگیری${error?' · '+(error.message||'ارتباط کامل نشد'):''}`;
   updateRetryControls(state,ctx);
  }});
  m.retryProgress=`${ctx.n(result.ready)} پیش‌نویس آمادهٔ بررسی؛ ${ctx.n(result.failed)} مورد ناموفق${result.pending?'؛ '+ctx.n(result.pending)+' مورد هنوز در صف یا در حال پردازش':''}${result.remaining?'؛ '+ctx.n(result.remaining)+' ویس بررسی‌نشده باقی مانده است':''}`;
  if(current(state.user.id))ctx.toast(m.retryProgress);
 }finally{m.retrying=false;m.processingIds.clear();await reload(state,ctx);updateRetryControls(state,ctx);}
}
async function sync(state,ctx,automatic=false){
 if(!isManager(state))return;const m=memory(state.user.id);if(m.syncing||m.retrying||m.processingIds.size||!m.data?.telegram?.configured)return;m.syncing=true;
 const button=document.querySelector('[data-telegram-sync]');if(button){button.disabled=true;button.textContent='در حال دریافت…';}
 updateRetryControls(state,ctx);
 try{const result=await ctx.api.telegramSync();m.lastSync=new Intl.DateTimeFormat('fa-IR',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tehran'}).format(new Date());if(!automatic||result.received||result.failed)ctx.toast(result.warning||`${ctx.n(result.received||0)} پیام دریافت شد؛ ${ctx.n(result.processed||0)} مورد پردازش شد.${result.failed?' '+ctx.n(result.failed)+' مورد نیازمند پیگیری است.':''}`);await reload(state,ctx);}
 catch(error){if(!automatic&&current(state.user.id))ctx.toast(error.message||'دریافت از تلگرام انجام نشد.');}
 finally{m.syncing=false;if(current(state.user.id)){const b=document.querySelector('[data-telegram-sync]');if(b){b.disabled=false;b.innerHTML=ctx.icon('clock')+'همگام‌سازی تلگرام';}updateRetryControls(state,ctx);}}
}
export function stopVoice(){clearInterval(poll);poll=undefined;audioCleanup?.();audioCleanup=undefined;}
export function wireVoice(state,ctx){
 stopVoice();if(!['manager','worker'].includes(state.user.role)||!current(state.user.id))return;
 const m=memory(state.user.id);
 m.pendingRender=false;
 audioCleanup=wireVoiceAudio(document.querySelector('[data-voice-user]'),{getAudio:id=>ctx.api.voiceAudio(id),onIdle:()=>{if(!m.pendingRender||!current(state.user.id)||audioPlaybackActive(document))return;m.pendingRender=false;void ctx.refresh();}});
 if(!m.loaded&&!m.loading){void reload(state,ctx);}
 listen('[data-voice-reload]',()=>{void reload(state,ctx);});
 listen('[data-voice-config]',()=>connectionModal(state,ctx));
 listen('[data-voice-test]',()=>{void testConnections(state,ctx);});
 listen('[data-telegram-link]',()=>linkModal(state,ctx));
 listen('[data-telegram-unlink]',el=>{const userId=el.dataset.telegramUnlink||state.user.id,name=state.users.find(u=>u.id===userId)?.name||state.user.name;ctx.modal({title:'قطع اتصال تلگرام',submitLabel:'قطع اتصال',body:`<p>اتصال تلگرام <strong>${ctx.e(name)}</strong> قطع شود؟</p><p class="muted">پیش‌نویس‌های قبلی حفظ می‌شوند. برای دریافت ویس‌های بعدی باید کد اتصال جدید بسازید.</p>`,onSubmit:async()=>{await ctx.api.telegramUnlink({userId});await reload(state,ctx);ctx.toast('اتصال تلگرام قطع شد.');}});});
 listen('[data-telegram-sync]',()=>{void sync(state,ctx);});
 listen('[data-reminder-reload]',button=>{if(!isManager(state)||typeof ctx.api.reminders!=='function')return;void withButton(button,ctx,async()=>{m.reminderLoading=true;try{m.reminders=await ctx.api.reminders();m.reminderError='';}catch(error){m.reminderError='دریافت وضعیت یادآوری انجام نشد؛ دوباره بررسی کنید.';throw error;}finally{m.reminderLoading=false;}await ctx.refresh();});});
 listen('[data-reminder-toggle]',button=>{if(!isManager(state)||typeof ctx.api.reminderSettings!=='function')return;void withButton(button,ctx,async()=>{m.reminders=await ctx.api.reminderSettings({enabled:button.dataset.reminderToggle==='true'});m.reminderError='';await ctx.refresh();ctx.toast(m.reminders.enabled?'یادآوری شبانه فعال شد.':'یادآوری شبانه متوقف شد.');});});
 document.querySelector('[data-voice-project]')?.addEventListener('change',event=>{m.projectId=event.target.value;});
 document.querySelector('[data-voice-filter]')?.addEventListener('change',event=>{m.filter=event.target.value;ctx.refresh();});
 document.querySelector('[data-voice-search]')?.addEventListener('input',event=>{m.query=event.target.value;const pos=event.target.selectionStart;void ctx.refresh().then(()=>{const el=document.querySelector('[data-voice-search]');el?.focus();el?.setSelectionRange(pos,pos);});});
 document.querySelector('#voice-file')?.addEventListener('change',event=>{const file=event.target.files?.[0];document.querySelector('[data-voice-file-name]').textContent=file?file.name+' · '+ctx.n(file.size/1024/1024)+' مگابایت':'';});
 document.querySelector('[data-voice-upload]')?.addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget,file=form.querySelector('[name="file"]').files?.[0];if(!file)return ctx.toast('فایل صوتی را انتخاب کنید.');if(file.size<1)return ctx.toast('فایل صوتی خالی است.');if(file.size>20*1024*1024)return ctx.toast('حجم فایل باید حداکثر ۲۰ مگابایت باشد.');if(!/\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(file.name)&&!file.type.startsWith('audio/'))return ctx.toast('یک فایل صوتی معتبر انتخاب کنید.');void withButton(form.querySelector('button'),ctx,async()=>{const draft=await ctx.api.voiceUpload(file,m.projectId);await reload(state,ctx);ctx.toast(draft.status==='failed'?(draft.error||'فایل دریافت شد اما تبدیل کامل نشد؛ وضعیت را در صندوق ببینید.'):'فایل دریافت شد؛ وضعیت تبدیل را در صندوق پیش‌نویس‌ها ببینید.');});});
 const textForm=document.querySelector('[data-voice-text]');textForm?.querySelector('textarea')?.addEventListener('input',event=>{m.text=event.target.value;});
 textForm?.addEventListener('submit',event=>{event.preventDefault();const text=m.text.trim();if(!text)return ctx.toast('متن فعالیت را بنویسید.');void withButton(event.currentTarget.querySelector('button'),ctx,async()=>{const draft=await ctx.api.voiceText({transcript:text,...(m.projectId?{projectId:m.projectId}:{})});if(draft.status!=='failed')m.text='';await reload(state,ctx);ctx.toast(draft.status==='failed'?(draft.error||'متن حفظ شد اما ساخت گزارش کامل نشد؛ دوباره تلاش کنید.'):'متن دریافت شد؛ وضعیت ساخت گزارش را در صندوق ببینید.');});});
 listen('[data-voice-review]',el=>{const d=list(m.data?.drafts).find(d=>d.id===el.dataset.voiceReview);if(d)reviewModal(d,state,ctx);});
 listen('[data-voice-download]',el=>{const d=list(m.data?.drafts).find(d=>d.id===el.dataset.voiceDownload);if(d)download(d,state,ctx);});
 listen('[data-voice-reupload]',()=>{const input=document.querySelector('#voice-file');input?.scrollIntoView({behavior:'smooth',block:'center'});input?.focus();ctx.toast('فایل صوتی را دوباره انتخاب و بارگذاری کنید.');});
 listen('[data-voice-retry]',el=>{void retryDraft(el.dataset.voiceRetry,state,ctx);});
 listen('[data-voice-retry-all]',()=>{void retryRemaining(state,ctx);});
 if(!ctx.api.isStatic)poll=setInterval(()=>{const file=document.querySelector('#voice-file')?.files?.[0];if(!current(state.user.id)||document.visibilityState!=='visible'||document.querySelector('#modal-form')||file||m.text||m.testing||m.retrying||m.processingIds.size||audioPlaybackActive(document))return;if(isManager(state)&&m.data?.telegram?.configured)void sync(state,ctx,true);else void reload(state,ctx);},30000);
}
