import { DossierError, buildDossierSummary, safeDossierSubmission, dossierDate } from './dossier-model.mjs';

const copy = value => structuredClone(value);
const list = value => Array.isArray(value) ? value : [];
const fail = (message, status = 400, code = 'INVALID_DOSSIER') => { throw new DossierError(message,status,code); };
const timestamp = () => new Date().toISOString();
const key = () => crypto.randomUUID();
const finance = user => ['manager','accountant'].includes(user.role);
const reviewerRoles = ['manager','worker','accountant'];
const note = (value, required = false) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.trim().length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (required && !value.trim())) fail('یادداشت و دلیل بررسی باید حداکثر ۵۰۰ نویسه باشد.');
  return value.trim();
};
function version(actual, supplied) {
  if (!Number.isSafeInteger(supplied) || actual !== supplied) fail('پرونده هم‌زمان تغییر کرده است؛ آخرین نسخه را باز کنید.',409,'VERSION_CONFLICT');
}
function activeReviewer(state, userId, stageIndex) {
  const user = state.users.find(person=>person.id === userId && !person.deletedAt);
  if (!user || !(stageIndex === 0 ? ['manager','worker'] : reviewerRoles).includes(user.role)) fail('مسئول این مرحله باید حساب فعال و مجاز داشته باشد؛ مدیر مسئول را اصلاح کند.',409,'INACTIVE_REVIEWER');
  return user;
}
function configuredStages(state,project,labels) {
  if (!project.projectCode || !project.projectManagerId || list(project.reviewChain).length !== 6) fail('پیش از ارسال، کد پروژه و مسئول هر شش تأیید را ثبت کنید.',409,'PROJECT_APPROVAL_NOT_CONFIGURED');
  return project.reviewChain.map((stage,index)=> {
    if (stage.label !== labels[index] || (index === 0 && stage.userId !== project.projectManagerId)) fail('ترتیب مسئولان تأیید پروژه معتبر نیست.',409,'PROJECT_APPROVAL_NOT_CONFIGURED');
    const person = activeReviewer(state,stage.userId,index);
    return {label:labels[index],userId:person.id,userName:person.name,status:'pending'};
  });
}
function entry(submission,user,action,details = {}) {
  const event = {id:key(),cycle:submission.approval.cycle,action,actorId:user.id,actorName:user.name,at:timestamp(),...details};
  if (submission.approval.history.length >= 1020) fail('سقف سابقهٔ این نسخه تکمیل است؛ مسئول سامانه باید نسخه را بررسی کند.',409,'APPROVAL_HISTORY_LIMIT');
  if (action === 'reassigned' && !details.emergency && snapshotBytes(submission.approval.history.concat(event)) > 2*1024*1024) fail('حجم سابقهٔ تغییر مسئول تکمیل است؛ بررسی همین مرحله همچنان در دسترس است.',409,'APPROVAL_HISTORY_LIMIT');
  submission.approval.history.push(event);
}
const snapshotBytes = snapshot => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
function response(project,user) {
  return {id:project.id,projectId:project.id,dossierSubmission:safeDossierSubmission(project.dossierSubmission,finance(user))};
}

/** Mutates only the detached atomic state draft supplied by the domain. */
export function applyDossierWorkflow(state,actor,action,payload,labels) {
  const user = state.users.find(person=>person.id===actor.id && !person.deletedAt);
  if (!user || !reviewerRoles.includes(user.role)) fail('این عملیات برای حساب شما مجاز نیست.',403,'FORBIDDEN');
  const project = state.projects.find(project=>project.id===payload.projectId);
  if (!project) fail('پروژه یافت نشد.',404,'PROJECT_NOT_FOUND');
  const current = project.dossierSubmission;
  if (action === 'project.dossier.submit') {
    if (!finance(user) && !(user.role === 'worker' && project.projectManagerId === user.id)) fail('ارسال پرونده برای مسئول پروژه، مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
    version(project.dossier?.version || 0,payload.version);
    if (current) {
      version(current.version,payload.submissionVersion);
      if (!['changes_requested','rejected'].includes(current.status)) fail('این نسخه در گردش تأیید یا نهایی است؛ برای اصلاح، نسخهٔ جدید بسازید.',409,'IMMUTABLE_DOSSIER');
      if (list(current.approval?.history).length >= 1000 || snapshotBytes(current.approval?.history || []) >= 2*1024*1024) fail('سقف سابقهٔ این نسخه تکمیل است؛ ابتدا نسخهٔ تازه ایجاد کنید.',409,'APPROVAL_HISTORY_LIMIT');
    }
    const stages = configuredStages(state,project,labels);
    const from = dossierDate(payload.from), to = dossierDate(payload.to);
    if (from && to && from > to) fail('تاریخ پایان دوره باید پس از شروع باشد.');
    // Capture the complete server-side worksheet; submit authority was checked above.
    // Operational reviewers receive a separately allowlisted, nonfinancial projection.
    const snapshot = buildDossierSummary({...state,user:{...user,role:'manager'}},project.id,{from,to});
    if (!snapshot.reports.length && !snapshot.materials.length && !list(snapshot.worksheet?.workItems).length) fail('گزارش تفصیلی خالی است؛ ابتدا کارکرد، کالا یا اجرت ثبت کنید.',409,'EMPTY_DOSSIER');
    const bytes = snapshotBytes(snapshot);
    if (bytes > 1024 * 1024) fail('حجم گزارش این دوره زیاد است؛ بازهٔ زمانی کوتاه‌تری انتخاب کنید.',409,'DOSSIER_SNAPSHOT_TOO_LARGE');
    const archivedBytes = list(project.dossierSubmissionHistory).reduce((sum,item)=>sum+snapshotBytes(item.snapshot || {}),0) + (current ? snapshotBytes(current.snapshot || {}) : 0);
    if (archivedBytes + bytes > 8 * 1024 * 1024) fail('حجم نسخه‌های ثبت‌شدهٔ این پروژه به سقف رسیده است؛ بازهٔ کوچک‌تری انتخاب کنید. سوابق قبلی حفظ می‌شوند.',409,'DOSSIER_STORAGE_LIMIT');
    const maxCycle = Math.max(0,current?.approval?.cycle || 0,...list(project.dossierSubmissionHistory).map(item=>item.approval?.cycle || 0));
    const submittedAt = timestamp();
    if (current) {
      if (list(project.dossierSubmissionHistory).length >= 20) fail('سقف بیست نسخهٔ بایگانی‌شده تکمیل است؛ سوابق قبلی حفظ می‌شوند.',409,'DOSSIER_REVISION_LIMIT');
      project.dossierSubmissionHistory = list(project.dossierSubmissionHistory).concat({...copy(current),archivedAt:submittedAt,archivedBy:user.id,revisionReason:'اصلاح و ارسال مجدد پس از بررسی'});
    }
    project.dossierSubmission = {id:key(),version:1,status:'submitted',from,to,createdAt:submittedAt,updatedAt:submittedAt,submittedAt,submittedBy:user.id,snapshot:copy(snapshot),approval:{cycle:maxCycle+1,currentStage:0,projectCode:project.projectCode,stages,history:copy(current?.approval?.history || [])}};
    entry(project.dossierSubmission,user,'submitted');
    return response(project,user);
  }
  if (!current || current.id !== payload.id) fail('نسخهٔ پرونده یافت نشد؛ صفحه را تازه کنید.',404,'DOSSIER_SUBMISSION_NOT_FOUND');
  version(current.version,payload.version);
  if (action === 'project.dossier.revise') {
    if (!finance(user)) fail('ایجاد نسخهٔ تازه برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
    if (!['approved','changes_requested','rejected'].includes(current.status)) fail('پروندهٔ در حال تأیید باید ابتدا توسط مسئول مرحله بررسی شود.',409,'IMMUTABLE_DOSSIER');
    const reason = note(payload.reason,true);
    if (list(project.dossierSubmissionHistory).length >= 20) fail('سقف بیست نسخهٔ بایگانی‌شده تکمیل است؛ سوابق قبلی حفظ می‌شوند.',409,'DOSSIER_REVISION_LIMIT');
    entry(current,user,'revised',{note:reason});
    project.dossierSubmissionHistory = list(project.dossierSubmissionHistory).concat({...copy(current),archivedAt:timestamp(),archivedBy:user.id,revisionReason:reason});
    delete project.dossierSubmission;
    project.dossier = {...(project.dossier || {}),version:(project.dossier?.version || 0)+1};
    return {id:project.id,projectId:project.id,dossierVersion:project.dossier.version};
  }
  if (current.status !== 'submitted') fail('این نسخه اکنون در انتظار تأیید نیست.',409,'IMMUTABLE_DOSSIER');
  const index = current.approval.currentStage, stage = list(current.approval.stages)[index];
  if (!stage || current.approval.stages.length !== 6) fail('ترتیب تأیید پرونده معتبر نیست.',409,'INVALID_APPROVAL_STATE');
  if (action === 'project.dossier.reassign') {
    if (user.role !== 'manager') fail('تغییر مسئول مرحله فقط برای مدیر مجاز است.',403,'FORBIDDEN');
    const assigned = state.users.find(person=>person.id===stage.userId && !person.deletedAt);
    const assignmentActive = assigned && (index === 0 ? ['manager','worker'] : reviewerRoles).includes(assigned.role);
    const controlBound = list(current.approval.history).length >= 1000 || snapshotBytes(current.approval.history) >= 2*1024*1024;
    const emergency = Boolean(controlBound && !assignmentActive);
    if (controlBound && !emergency) fail('سقف تغییر مسئول تکمیل است؛ تأیید یا بازگرداندن همین مرحله همچنان در دسترس است.',409,'APPROVAL_HISTORY_LIMIT');
    if (emergency && current.approval.history.some(event=>event.cycle===current.approval.cycle && event.stageIndex===index && event.emergency===true)) fail('بازیابی اضطراری این مرحله قبلاً ثبت شده است؛ دسترسی مسئول جایگزین را بازیابی کنید.',409,'APPROVAL_HISTORY_LIMIT');
    const reason = note(payload.reason,true), replacement = activeReviewer(state,payload.userId,index);
    if (stage.userId === replacement.id) fail('مسئول جدید با مسئول فعلی یکسان است.');
    entry(current,user,'reassigned',{stageIndex:index,note:reason,fromUserId:stage.userId,fromUserName:stage.userName,toUserId:replacement.id,toUserName:replacement.name,...(emergency?{emergency:true}:{})});
    stage.userId = replacement.id; stage.userName = replacement.name;
  } else if (action === 'project.dossier.review') {
    activeReviewer(state,stage.userId,index);
    if (stage.userId !== user.id) fail('این مرحله فقط برای مسئول تعیین‌شده باز است.',403,'FORBIDDEN');
    if (!['approved','changes_requested','rejected'].includes(payload.status)) fail('وضعیت بررسی معتبر نیست.');
    const reviewNote = note(payload.reviewNote,payload.status !== 'approved');
    const reviewedAt = timestamp();
    Object.assign(stage,{status:payload.status,reviewedBy:user.id,reviewedByName:user.name,reviewedAt,note:reviewNote});
    entry(current,user,payload.status,{stageIndex:index,note:reviewNote});
    if (payload.status === 'approved') {
      current.approval.currentStage += 1;
      if (current.approval.currentStage === 6) {current.status='approved';current.reviewedAt=reviewedAt;}
    } else current.status=payload.status;
  } else fail('عملیات پرونده شناخته‌شده نیست.',400,'UNKNOWN_ACTION');
  current.version += 1; current.updatedAt = timestamp();
  return response(project,user);
}
