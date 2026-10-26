const list=value=>Array.isArray(value)?value:[];
const statusLabels={submitted:'در حال بررسی',approved:'تأیید نهایی',changes_requested:'نیازمند اصلاح',rejected:'رد شده'};

export function currentDossierStage(project) {
  const submission=project?.dossierSubmission;
  return submission?.status==='submitted' && Number.isInteger(submission.approval?.currentStage)
    ? list(submission.approval.stages)[submission.approval.currentStage] || null : null;
}

export function dossierAwaitingMe(project,user) {
  return Boolean(user&&!user.deletedAt&&['manager','worker','accountant'].includes(user.role)&&currentDossierStage(project)?.userId===user.id);
}

export function dossierReviewCount(state) {
  return list(state.projects).filter(project=>dossierAwaitingMe(project,state.user)).length;
}

export function renderProjectReviewInbox(state,ctx,{projectId}={}) {
  if(!['manager','worker','accountant'].includes(state.user?.role))return '';
  const projects=list(state.projects).filter(project=>!projectId||project.id===projectId);
  if(!projects.length)return '';
  const ordered=[...projects].sort((a,b)=>Number(dossierAwaitingMe(b,state.user))-Number(dossierAwaitingMe(a,state.user)));
  return `<section class="card dossier-review-inbox"><div class="card-head"><div><h2 class="card-title">گزارش‌های تفصیلی پروژه‌ها</h2><p class="muted">جمع‌بندی کارکرد، کالا و اجرت؛ با شش تأیید جداگانه</p></div><span class="badge gold">${ctx.e(ctx.n(dossierReviewCount({...state,projects})))} در انتظار تأیید من</span></div><div class="dossier-inbox-list">${ordered.map(project=>{
    const submission=project.dossierSubmission, stage=currentDossierStage(project), waiting=dossierAwaitingMe(project,state.user);
    const name=list(state.users).find(user=>user.id===stage?.userId)?.name||'مسئول تعیین‌شده';
    const description=stage?`در انتظار ${stage.label}: ${name}`:statusLabels[submission?.status]||'هنوز برای تأیید ارسال نشده است';
    return `<a class="dossier-inbox-item${waiting?' is-waiting':''}" href="#project/${encodeURIComponent(project.id)}/dossier"><div><strong>${ctx.e(project.name)}</strong><span><bdi dir="ltr">${ctx.e(project.projectCode||'کد ثبت نشده')}</bdi> · ${ctx.e(description)}</span></div><span>${waiting?'بررسی این مرحله':submission?'مشاهدهٔ گزارش':'تهیهٔ گزارش تفصیلی'} ←</span></a>`;
  }).join('')}</div></section>`;
}
