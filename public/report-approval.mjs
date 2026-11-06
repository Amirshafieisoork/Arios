import {hasPermission} from './permissions.mjs';

/** One frozen, ordered chain per submitted daily-report cycle. */
export const REPORT_APPROVAL_LABELS=Object.freeze(['مسئول پروژه','مسئول واحد','مدیر گروه فنی','واحد فروش','واحد مالی','مدیرعامل']);
const list=value=>Array.isArray(value)?value:[];
const copy=value=>structuredClone(value);
const now=()=>new Date().toISOString();
function fail(message,status=400,code='INVALID_REPORT_APPROVAL'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function canonicalUser(state,actor){const person=list(state.users).find(user=>user.id===actor?.id&&!user.deletedAt);if(!person)fail('حساب فعال نیست.',403,'FORBIDDEN');return person;}
function reviewer(state,id){const person=list(state.users).find(user=>user.id===id&&!user.deletedAt);if(!person||person.role==='customer'||!hasPermission(person,'reports.review',state))fail('دسترسی مسئول این مرحله فعال نیست؛ مدیر مسئول پروژه را اصلاح کند.',409,'INACTIVE_REVIEWER');return person;}
function configured(project){return Boolean(project&&!project.archivedAt&&project.projectCode&&project.projectManagerId&&list(project.reviewChain).length===6&&project.reviewChain.every((stage,index)=>stage?.label===REPORT_APPROVAL_LABELS[index]&&typeof stage.userId==='string'&&stage.userId&&(!index?stage.userId===project.projectManagerId:true)));}
function stagesFor(state,project){
  if(!configured(project))fail('پیش از بررسی گزارش، کد پروژه و مسئول هر شش مرحله را در تنظیمات پروژه تعیین کنید.',409,'PROJECT_APPROVAL_NOT_CONFIGURED');
  return project.reviewChain.map((stage,index)=>{const person=reviewer(state,stage.userId);return {label:REPORT_APPROVAL_LABELS[index],userId:person.id,userName:person.name,status:'pending'};});
}
const snapshot=report=>Object.fromEntries(['id','projectId','workerId','date','start','end','breakMinutes','minutes','description','output','location','photoIds'].filter(key=>report[key]!==undefined).map(key=>[key,copy(report[key])]));
function historyEntry(approval,actor,action,details={}){
  const event={id:crypto.randomUUID(),cycle:approval.cycle,action,actorId:actor.id,actorName:actor.name,at:now(),...details};
  if(list(approval.history).length>=600||new TextEncoder().encode(JSON.stringify([...list(approval.history),event])).byteLength>1024*1024)fail('سابقهٔ بررسی این گزارش به سقف رسیده است؛ مدیر گزارش را بررسی کند.',409,'APPROVAL_HISTORY_LIMIT');
  approval.history.push(event);
}

export function startReportApproval(state,actor,report,project,{allowUnconfigured=true,previousApproval,action='submitted'}={}){
  const person=canonicalUser(state,actor),previous=previousApproval===undefined?report.approval:previousApproval;
  const cycle=(Number.isSafeInteger(previous?.cycle)?previous.cycle:0)+1;
  if(cycle>50)fail('سقف دوره‌های اصلاح این گزارش تکمیل شده است؛ سوابق حفظ می‌شوند.',409,'APPROVAL_HISTORY_LIMIT');
  let stages,configurationRequired=false;
  try{stages=stagesFor(state,project);}catch(error){if(!allowUnconfigured||!['PROJECT_APPROVAL_NOT_CONFIGURED','INACTIVE_REVIEWER'].includes(error.code))throw error;stages=[];configurationRequired=true;}
  const approval={cycle,currentStage:0,projectCode:project?.projectCode||'',projectId:project?.id||report.projectId,stages,history:copy(list(previous?.history)),configurationRequired};
  historyEntry(approval,person,action,{snapshot:snapshot(report),stages:stages.map(stage=>({label:stage.label,userId:stage.userId,userName:stage.userName}))});
  report.approval=approval;report.status='submitted';report.laborCost=0;
  delete report.reviewNote;delete report.reviewedBy;delete report.reviewedAt;
  return approval;
}

/** Admin amendments use the same restart path; previous signed steps never survive an edit as approvals. */
export function restartReportApproval(state,report,actor,{previous}={}){
  const project=list(state.projects).find(item=>item.id===report.projectId);
  return startReportApproval(state,actor,report,project,{previousApproval:previous?.approval===undefined?report.approval:previous.approval});
}

export function currentReportStage(report,project){
  if(report?.status!=='submitted'||report.archivedAt)return null;
  const approval=report.approval;
  if(list(approval?.stages).length===6&&Number.isInteger(approval.currentStage)&&approval.currentStage>=0&&approval.currentStage<6)return approval.stages[approval.currentStage]||null;
  // A legacy pending report can only start with the configured project lead.
  return configured(project)?{...project.reviewChain[0],status:'pending'}:null;
}
export function reportAwaitingMe(report,user,project){return Boolean(user&&!user.deletedAt&&user.role!=='customer'&&hasPermission(user,'reports.review')&&currentReportStage(report,project)?.userId===user.id);}
export function reportReviewCount(state){return list(state.reports).filter(report=>reportAwaitingMe(report,state.user,list(state.projects).find(project=>project.id===report.projectId))).length;}

function clock(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('زمان ثبت‌شدهٔ گزارش معتبر نیست.',409,'INVALID_REPORT_TIME');return Number(value.slice(0,2))*60+Number(value.slice(3));}
function labor(rate,minutes){if(!Number.isSafeInteger(rate)||rate<0||!Number.isSafeInteger(minutes)||minutes<1)fail('نرخ یا مدت گزارش معتبر نیست.',409,'INVALID_REPORT_COST');const amount=(BigInt(rate)*BigInt(minutes)+30n)/60n;if(amount>BigInt(Number.MAX_SAFE_INTEGER))fail('هزینه از محدودهٔ مجاز بیشتر است.');return Number(amount);}

/** Version checks prevent a double click from approving two roles held by one person. */
export function applyReportReview(state,actor,report,project,payload,{roundedLabor=labor}={}){
  const person=canonicalUser(state,actor);
  if(!hasPermission(person,'reports.review',state)||person.role==='customer')fail('اجازهٔ بررسی گزارش برای این حساب فعال نیست.',403,'FORBIDDEN');
  if(!report||report.archivedAt||!project||project.archivedAt||project.id!==report.projectId)fail('گزارش یا پروژه در دسترس نیست.',409,'REPORT_UNAVAILABLE');
  if(!Number.isSafeInteger(payload.version)||payload.version!==report.version)fail('گزارش تغییر کرده است؛ آخرین نسخه را باز کنید.',409,'VERSION_CONFLICT');
  if(report.status!=='submitted')fail('این گزارش اکنون در انتظار تأیید نیست.',409,'IMMUTABLE_REPORT');
  const status=payload.status;
  if(!['approved','changes_requested','rejected'].includes(status))fail('وضعیت بررسی معتبر نیست.');
  if(payload.reviewNote!==undefined&&typeof payload.reviewNote!=='string')fail('یادداشت بررسی معتبر نیست.');
  const note=(payload.reviewNote||'').trim();
  if(note.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)||(status!=='approved'&&!note))fail('برای بازگرداندن یا رد، دلیل بررسی را تا ۲۰۰۰ نویسه ثبت کنید.');
  // Build a detached candidate so failed legacy setup or overlap leaves no half-approved step.
  const candidate=copy(report);
  if(list(candidate.approval?.stages).length!==6||candidate.approval?.configurationRequired)startReportApproval(state,person,candidate,project,{allowUnconfigured:false,action:'initialized'});
  const approval=candidate.approval,index=approval.currentStage,stage=list(approval.stages)[index];
  if(!Number.isInteger(index)||index<0||index>5||!stage||approval.projectId!==project.id||approval.stages.some((entry,i)=>entry.label!==REPORT_APPROVAL_LABELS[i]||(i<index?entry.status!=='approved':entry.status!=='pending')))fail('ترتیب بررسی گزارش معتبر نیست.',409,'INVALID_APPROVAL_STATE');
  reviewer(state,stage.userId);
  if(stage.userId!==person.id)fail('بررسی این گزارش فقط برای مسئول مرحلهٔ جاری در دسترس است.',403,'FORBIDDEN');
  if(payload.stageIndex!==undefined&&payload.stageIndex!==index)fail('مرحلهٔ بررسی تغییر کرده است؛ گزارش را تازه کنید.',409,'VERSION_CONFLICT');
  const finalApproval=status==='approved'&&index===5;
  if(finalApproval){
    const start=clock(candidate.start),end=clock(candidate.end);
    if(list(state.reports).some(other=>other.id!==candidate.id&&!other.archivedAt&&other.workerId===candidate.workerId&&other.date===candidate.date&&other.status==='approved'&&start<clock(other.end)&&clock(other.start)<end))fail('این بازه با گزارش تأییدشدهٔ همین نیرو هم‌پوشانی دارد.',409,'TIME_OVERLAP');
    candidate.laborCost=roundedLabor(candidate.rate,candidate.minutes);
  }else candidate.laborCost=0;
  const at=now();
  Object.assign(stage,{status,reviewedBy:person.id,reviewedByName:person.name,reviewedAt:at,note});
  historyEntry(approval,person,status,{stageIndex:index,note});
  if(status==='approved'){approval.currentStage=index+1;if(finalApproval){candidate.status='approved';candidate.reviewedBy=person.id;candidate.reviewedAt=at;}}
  else{candidate.status=status;candidate.reviewedBy=person.id;candidate.reviewedAt=at;}
  candidate.reviewNote=note;candidate.updatedAt=at;candidate.version+=1;
  Object.assign(report,candidate);return report;
}

export function safeReportApproval(report){
  const approval=report?.approval;if(!approval)return undefined;
  return {cycle:approval.cycle,currentStage:approval.currentStage,projectCode:approval.projectCode,projectId:approval.projectId,configurationRequired:approval.configurationRequired===true,
    stages:list(approval.stages).map(stage=>Object.fromEntries(['label','userId','userName','status','reviewedBy','reviewedByName','reviewedAt','note'].filter(key=>stage[key]!==undefined).map(key=>[key,copy(stage[key])]))),
    history:list(approval.history).map(event=>Object.fromEntries(['id','cycle','action','actorId','actorName','at','stageIndex','note'].filter(key=>event[key]!==undefined).map(key=>[key,copy(event[key])])))};
}

export function renderReportApproval(report,state,ctx){
  if(report?.status==='approved'&&!report.approval)return '<p class="muted">گزارش تأییدشدهٔ پیشین</p>';
  const project=list(state.projects).find(item=>item.id===report.projectId),stage=currentReportStage(report,project),approval=report.approval;
  const done=list(approval?.stages).filter(item=>item.status==='approved').length;
  const waiting=reportAwaitingMe(report,state.user,project);
  const text=stage?`${done} از ۶ تأیید · ${waiting?'در انتظار تأیید شما':`در انتظار ${stage.label}: ${stage.userName||list(state.users).find(user=>user.id===stage.userId)?.name||'مسئول تعیین‌شده'}`}`:report.status==='submitted'?'مسیر تأیید نیازمند تنظیم مسئولان پروژه است.':report.status==='approved'?'هر شش مرحله تأیید شده است.':'برای اصلاح و ارسال مجدد به ثبت‌کننده بازگردانده شد.';
  const events={submitted:'ارسال برای تأیید',initialized:'آغاز مسیر تأیید گزارش پیشین',approved:'تأیید مرحله',changes_requested:'درخواست اصلاح',rejected:'رد گزارش'};
  return `<div class="report-approval-progress"><p class="${waiting?'notice':'muted'}">${ctx.e(text)}</p>${list(approval?.stages).length?`<details><summary>مسیر و سابقهٔ تأیید</summary><ol>${approval.stages.map(item=>`<li>${ctx.e(item.label)} · ${ctx.e(item.userName||'مسئول تعیین‌شده')} · ${ctx.e({pending:'در انتظار',approved:'تأییدشده',changes_requested:'نیازمند اصلاح',rejected:'ردشده'}[item.status]||'در انتظار')}${item.note?`<p>${ctx.e(item.note)}</p>`:''}</li>`).join('')}</ol>${list(approval.history).length?`<p class="muted">${ctx.e(ctx.n(approval.history.length))} رویداد در ${ctx.e(ctx.n(approval.cycle))} دورهٔ بررسی ثبت شده است.</p><ul>${approval.history.slice(-50).map(event=>`<li>${ctx.e(events[event.action]||'رویداد بررسی')} · ${ctx.e(event.actorName||'مسئول مرحله')}${Number.isInteger(event.stageIndex)?` · ${ctx.e(REPORT_APPROVAL_LABELS[event.stageIndex]||'')}`:''}${event.at&&ctx.date?` · ${ctx.e(ctx.date(event.at))}`:''}${event.note?`<p>${ctx.e(event.note)}</p>`:''}</li>`).join('')}</ul>`:''}</details>`:''}</div>`;
}
