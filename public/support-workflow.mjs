/** Support approval and assignment share the same persisted project task. */
import {hasPermission} from './permissions.mjs';
const list=value=>Array.isArray(value)?value:[];
const staffRoles=new Set(['manager','worker','warehouse','accountant']);
const now=()=>new Date().toISOString();
const id=prefix=>`${prefix}_${crypto.randomUUID()}`;
const fail=(message,status=400,code='INVALID_SUPPORT_ACTION')=>{const error=new Error(message);error.status=status;error.code=code;throw error;};
const select=(row,keys)=>Object.fromEntries(keys.filter(key=>row?.[key]!==undefined).map(key=>[key,structuredClone(row[key])]));
function text(value,label,{optional=false,max=12000}={}){if(value==null&&optional)return '';if(typeof value!=='string'||!value.trim()&&!optional||typeof value==='string'&&value.trim().length>max)fail(`${label} معتبر نیست.`);return value.trim();}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)fail('روز انجام وظیفه معتبر نیست.');return value;}
function actorInState(state,actor){const person=list(state.users).find(row=>row.id===actor?.id);if(!person||person.deletedAt||person.role!==actor?.role)fail('حساب فعال معتبر نیست.',403,'FORBIDDEN');return person;}
function projectInState(state,projectId){const project=list(state.projects).find(row=>row.id===projectId);if(!project)fail('پروژه یافت نشد.',404,'NOT_FOUND');if(project.archivedAt)fail('ابتدا پروژهٔ حذف‌شده را بازیابی کنید.',409,'PROJECT_ARCHIVED');return project;}
function accessible(state,actor,project,helpers){return helpers.projectAccess?helpers.projectAccess(state,actor,project.id):actor.role==='manager'||actor.role==='customer'&&project.customerId===actor.id||staffRoles.has(actor.role)&&list(project.memberIds).includes(actor.id);}
function requireAccess(state,actor,project,helpers){if(!accessible(state,actor,project,helpers))fail('به این پروژه دسترسی ندارید.',403,'FORBIDDEN');}
const manage=(state,actor)=>hasPermission(actor,'support.manage',state);
const assign=(state,actor)=>hasPermission(actor,'support.assign',state);
function requireManage(state,actor){if(!manage(state,actor))fail('تأیید و مدیریت تیکت برای حساب شما مجاز نیست.',403,'FORBIDDEN');}
function requireAssign(state,actor){if(!assign(state,actor))fail('ارجاع تیکت برای حساب شما مجاز نیست.',403,'FORBIDDEN');}
const revision=ticket=>Number.isSafeInteger(ticket.version)?ticket.version:0;
function checkVersion(ticket,payload,required=true){if(payload.version===undefined&&!required)return;if(!Number.isSafeInteger(payload.version)||payload.version!==revision(ticket))fail('تیکت تغییر کرده است؛ آخرین نسخه را باز کنید.',409,'VERSION_CONFLICT');}
function shape(payload,keys){if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!keys.includes(key)))fail('فیلد درخواست پشتیبانی مجاز نیست.');}
function history(ticket,actor,action,detail={}){ticket.assignmentHistory ||= [];if(ticket.assignmentHistory.length>=1000)fail('تاریخچهٔ تیکت به حد مجاز رسیده است.',409,'SUPPORT_HISTORY_LIMIT');ticket.assignmentHistory.push({id:id('sh'),action,actorId:actor.id,createdAt:now(),...detail});}
function changed(ticket){ticket.version=revision(ticket)+1;ticket.updatedAt=now();}
function audit(state,actor,action,ticket){state.audit ||= [];state.audit.push({id:id('a'),actorId:actor.id,action,entityId:ticket.id,createdAt:now(),description:'تأیید، ارجاع یا پیگیری تیکت پشتیبانی ثبت شد.'});}
function linkedTask(project,ticket){return list(project.tasks).find(task=>task.id===ticket.taskId&&task.sourceTicketId===ticket.id);}
function cancelTask(state,actor,project,ticket,note){const task=linkedTask(project,ticket);if(task&&!task.archivedAt){task.archivedAt=now();task.archivedBy=actor.id;task.archiveReason=note||'ارجاع تیکت لغو شد.';task.version=(Number(task.version)||0)+1;task.updatedAt=now();}ticket.assigneeId=null;ticket.dueDate=null;ticket.assignmentNote='';ticket.assignmentStatus='cancelled';}
const taskDescription=ticket=>[ticket.assignmentNote?'دستور ارجاع: '+ticket.assignmentNote:'',ticket.description].filter(Boolean).join('\n\n').slice(0,2000);
function completeWork(project,ticket,status){const task=linkedTask(project,ticket);if(!task||task.archivedAt||task.assigneeId!==ticket.assigneeId)fail('ارجاع فعال تیکت پیدا نشد.',409,'SUPPORT_ASSIGNMENT_CHANGED');task.status=status;task.version=(Number(task.version)||0)+1;task.updatedAt=now();ticket.status=status==='done'?'resolved':status==='in_progress'?'in_progress':'open';ticket.assignmentStatus=status==='done'?'completed':status==='in_progress'?'in_progress':'assigned';return task;}

export function supportTicketSnapshot(ticket){const row=select(ticket,['id','projectId','authorId','subject','description','priority','status','createdAt','updatedAt','version','approvalStatus','approvedBy','approvedAt','approvalNote','assigneeId','taskId','dueDate','assignmentNote','assignmentStatus']);row.replies=list(ticket.replies).map(reply=>select(reply,['id','authorId','text','createdAt']));row.assignmentHistory=list(ticket.assignmentHistory).map(entry=>select(entry,['id','action','actorId','createdAt','fromAssigneeId','assigneeId','dueDate','note','status']));return row;}
export function supportTicketVisible(ticket,actor,state){return !ticket.archivedAt&&(manage(state,actor)||assign(state,actor)||ticket.authorId===actor.id||ticket.assigneeId===actor.id);}

/** Return handled:false so ordinary project tasks retain their own workflow. */
export function applySupportAction(state,suppliedActor,action,payload={},helpers={}){
  const actor=actorInState(state,suppliedActor);
  if(action==='task.update'){
    const project=list(state.projects).find(row=>row.id===payload.projectId),task=list(project?.tasks).find(row=>row.id===payload.id);
    if(!task?.sourceTicketId)return {handled:false};
    projectInState(state,project.id);requireAccess(state,actor,project,helpers);
    const ticket=list(state.tickets).find(row=>row.id===task.sourceTicketId&&row.projectId===project.id&&!row.archivedAt);
    if(!ticket||ticket.taskId!==task.id||task.archivedAt||ticket.assigneeId!==task.assigneeId||ticket.approvalStatus!=='approved')fail('این ارجاع دیگر فعال نیست.',409,'SUPPORT_ASSIGNMENT_CHANGED');
    if(payload.version!==task.version)fail('وظیفه تغییر کرده است؛ صفحه را تازه کنید.',409,'VERSION_CONFLICT');
    shape(payload,['id','projectId','version','status']);
    if(ticket.assigneeId!==actor.id&&!manage(state,actor))fail('فقط وظیفهٔ ارجاع‌شده به خودتان را به‌روز کنید.',403,'FORBIDDEN');
    if(!['open','in_progress','done'].includes(payload.status))fail('وضعیت وظیفه معتبر نیست.');
    const result=completeWork(project,ticket,payload.status);changed(ticket);history(ticket,actor,'progress',{status:payload.status});audit(state,actor,action,ticket);return {handled:true,result:structuredClone(result)};
  }
  if(!action.startsWith('ticket.'))return {handled:false};
  if(action==='ticket.create'){
    shape(payload,['projectId','subject','description','priority']);if(!hasPermission(actor,'support.submit',state))fail('ثبت پشتیبانی برای حساب شما مجاز نیست.',403,'FORBIDDEN');const project=projectInState(state,payload.projectId);requireAccess(state,actor,project,helpers);
    if(!['normal','high'].includes(payload.priority??'normal'))fail('اولویت معتبر نیست.');
    const ticket={id:id('t'),projectId:project.id,authorId:actor.id,subject:text(payload.subject,'موضوع',{max:200}),description:text(payload.description,'شرح مشکل'),priority:payload.priority??'normal',status:'open',approvalStatus:'pending',assignmentStatus:'unassigned',version:1,createdAt:now(),replies:[],assignmentHistory:[]};state.tickets.push(ticket);audit(state,actor,action,ticket);return {handled:true,result:supportTicketSnapshot(ticket)};
  }
  const ticket=list(state.tickets).find(row=>row.id===payload.id);if(!ticket)fail('تیکت یافت نشد.',404,'NOT_FOUND');if(ticket.archivedAt)fail('ابتدا تیکت حذف‌شده را بازیابی کنید.',409,'RECORD_ARCHIVED');
  const project=projectInState(state,ticket.projectId);requireAccess(state,actor,project,helpers);
  if(action==='ticket.reply'){
    shape(payload,['id','text','version']);checkVersion(ticket,payload,false);if(!supportTicketVisible(ticket,actor,state))fail('پاسخ این تیکت برای شما مجاز نیست.',403,'FORBIDDEN');
    const reply={id:id('tr'),authorId:actor.id,text:text(payload.text,'پاسخ',{max:8000}),createdAt:now()};ticket.replies ||= [];ticket.replies.push(reply);changed(ticket);audit(state,actor,action,ticket);return {handled:true,result:supportTicketSnapshot(ticket)};
  }
  if(action==='ticket.work.update'){
    shape(payload,['id','version','status']);checkVersion(ticket,payload);if(ticket.assigneeId!==actor.id||ticket.approvalStatus!=='approved')fail('این وظیفه به شما ارجاع نشده است.',403,'FORBIDDEN');if(!['open','in_progress','done'].includes(payload.status))fail('وضعیت وظیفه معتبر نیست.');completeWork(project,ticket,payload.status);history(ticket,actor,'progress',{status:payload.status});
  }else if(action==='ticket.approve'){
    shape(payload,['id','version','note']);requireManage(state,actor);checkVersion(ticket,payload);if(ticket.approvalStatus==='approved')return {handled:true,result:supportTicketSnapshot(ticket)};
    if(ticket.status==='resolved')fail('ابتدا تیکت بسته‌شده را باز کنید.',409,'SUPPORT_CLOSED');ticket.approvalStatus='approved';ticket.approvedBy=actor.id;ticket.approvedAt=now();ticket.approvalNote=text(payload.note,'توضیح تأیید',{optional:true,max:2000});history(ticket,actor,'approve',{note:ticket.approvalNote});
  }else if(action==='ticket.reject'){
    shape(payload,['id','version','note']);requireManage(state,actor);checkVersion(ticket,payload);const note=text(payload.note,'دلیل رد',{max:2000});cancelTask(state,actor,project,ticket,note);ticket.approvalStatus='rejected';ticket.approvalNote=note;ticket.status='resolved';history(ticket,actor,'reject',{note});
  }else if(action==='ticket.assign'){
    shape(payload,['id','version','assigneeId','dueDate','note']);requireAssign(state,actor);checkVersion(ticket,payload);if(ticket.approvalStatus!=='approved')fail('ابتدا مدیر باید تیکت را تأیید کند.',409,'SUPPORT_APPROVAL_REQUIRED');if(ticket.status==='resolved')fail('ابتدا تیکت بسته‌شده را باز کنید.',409,'SUPPORT_CLOSED');
    const person=list(state.users).find(row=>row.id===payload.assigneeId&&!row.deletedAt&&staffRoles.has(row.role));if(!person||(person.role!=='manager'&&!list(project.memberIds).includes(person.id)))fail('پشتیبان باید عضو فعال همین پروژه باشد.',403,'INVALID_SUPPORT_ASSIGNEE');const dueDate=date(payload.dueDate),note=text(payload.note,'شرح ارجاع',{optional:true,max:2000});
    let task=linkedTask(project,ticket);if(task&&!task.archivedAt&&ticket.assigneeId===person.id&&ticket.dueDate===dueDate&&(ticket.assignmentNote||'')===note&&task.status!=='done')return {handled:true,result:supportTicketSnapshot(ticket)};
    project.tasks ||= [];if(!task&&project.tasks.length>=300)fail('تعداد وظایف پروژه به حد مجاز رسیده است.',409,'TASK_LIMIT');const previous=ticket.assigneeId||null;
    if(!task){task={id:id('task'),sourceTicketId:ticket.id,createdAt:now(),version:0};project.tasks.push(task);}delete task.archivedAt;delete task.archivedBy;delete task.archiveReason;
    Object.assign(ticket,{assigneeId:person.id,taskId:task.id,dueDate,assignmentNote:note,assignmentStatus:'assigned',status:'open'});Object.assign(task,{title:`پشتیبانی: ${ticket.subject}`,description:taskDescription(ticket),assigneeId:person.id,dueDate,status:'open',version:(Number(task.version)||0)+1,updatedAt:now()});history(ticket,actor,'assign',{fromAssigneeId:previous,assigneeId:person.id,dueDate,note});
  }else if(action==='ticket.unassign'){
    shape(payload,['id','version','note']);requireAssign(state,actor);checkVersion(ticket,payload);const note=text(payload.note,'دلیل لغو ارجاع',{max:2000});const previous=ticket.assigneeId||null;cancelTask(state,actor,project,ticket,note);history(ticket,actor,'unassign',{fromAssigneeId:previous,note});
  }else if(action==='ticket.update'){
    shape(payload,['id','version','status','subject','description','priority']);requireManage(state,actor);checkVersion(ticket,payload,false);
    if(payload.subject!==undefined)ticket.subject=text(payload.subject,'موضوع',{max:200});if(payload.description!==undefined)ticket.description=text(payload.description,'شرح مشکل');if(payload.priority!==undefined){if(!['normal','high'].includes(payload.priority))fail('اولویت معتبر نیست.');ticket.priority=payload.priority;}
    if(payload.status!==undefined){if(!['open','in_progress','resolved'].includes(payload.status))fail('وضعیت تیکت معتبر نیست.');const task=linkedTask(project,ticket);if(task&&!task.archivedAt&&ticket.assigneeId){if(ticket.approvalStatus!=='approved')fail('تیکت هنوز تأیید نشده است.',409,'SUPPORT_APPROVAL_REQUIRED');completeWork(project,ticket,payload.status==='resolved'?'done':payload.status);}else{ticket.status=payload.status;if(payload.status==='open'&&ticket.approvalStatus==='rejected'){ticket.approvalStatus='pending';ticket.assignmentStatus='unassigned';}}}
    const task=linkedTask(project,ticket);if(task&&!task.archivedAt){task.title=`پشتیبانی: ${ticket.subject}`;task.description=taskDescription(ticket);if(payload.status===undefined)task.version=(Number(task.version)||0)+1;task.updatedAt=now();}
    history(ticket,actor,'update',{status:ticket.status});
  }else fail('عملیات پشتیبانی شناخته‌شده نیست.',400,'UNKNOWN_ACTION');
  changed(ticket);audit(state,actor,action,ticket);return {handled:true,result:supportTicketSnapshot(ticket)};
}

/** Admin record edits keep linkage intact; restoring records never restores an old assignment silently. */
export function syncSupportRecord(state,actor,collection,row,operation,reason=''){
  if(collection!=='tickets'&&collection!=='tasks')return;
  const ticket=collection==='tickets'?row:list(state.tickets).find(item=>item.id===row.sourceTicketId);if(!ticket)return;
  const project=list(state.projects).find(item=>item.id===ticket.projectId);if(!project)return;
  if(collection==='tasks'&&row.sourceTicketId&&operation==='restore')fail('برای فعال‌کردن دوبارهٔ این وظیفه، از تیکت پشتیبانی دوباره ارجاع دهید.',409,'SUPPORT_TASK_LINKED');
  if(operation==='update'){
    if(collection==='tasks'&&row.sourceTicketId)fail('ویرایش برنامهٔ این وظیفه از تیکت پشتیبانی انجام می‌شود.',409,'SUPPORT_TASK_LINKED');
    const task=linkedTask(project,ticket);if(task&&!task.archivedAt){task.title=`پشتیبانی: ${ticket.subject}`;task.description=taskDescription(ticket);task.version=(Number(task.version)||0)+1;task.updatedAt=now();}
  }else if(['archive','restore'].includes(operation)){
    const previous=ticket.assigneeId||null;cancelTask(state,actor,project,ticket,reason||'رکورد پشتیبانی حذف یا بازیابی شد.');if(operation==='restore'&&collection==='tickets')ticket.status='open';history(ticket,actor,operation,{fromAssigneeId:previous,note:reason});
  }
  changed(ticket);
}
