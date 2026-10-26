import {currentDossierStage,dossierAwaitingMe} from './project-review-inbox.mjs';
// Derived views use only the current user's authorized workspace snapshot.
const rows = value => Array.isArray(value) ? value : [];
const timestamp = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : 0;

export function reportProjects(state) {
  const user = state.user || {};
  if (!['manager', 'worker'].includes(user.role)) return [];
  return rows(state.projects).filter(project => project.canRecordWork!==false).filter(project => user.role === 'worker'
    ? rows(project.memberIds).includes(user.id)
    : rows(project.memberIds).some(id => rows(state.users).some(person => person.id === id && person.role === 'worker' && !person.deletedAt)));
}

export function projectWorkers(state, projectId) {
  const project = rows(state.projects).find(item => item.id === projectId);
  if (!project) return [];
  return rows(state.users).filter(person => person.role === 'worker' && !person.deletedAt && rows(project.memberIds).includes(person.id)
    && (state.user?.role === 'manager' || person.id === state.user?.id));
}

export function portalNotifications(state) {
  const user = state.user || {}, manager = user.role === 'manager';
  const projects = new Set(rows(state.projects).map(project => project.id));
  const notifications = [];
  const add = item => notifications.push(item);
  for (const project of rows(state.projects)) {
    const submission=project.dossierSubmission, stage=currentDossierStage(project);
    if (dossierAwaitingMe(project,user)) add({id:`dossier:${submission.id}`,kind:'dossier',title:`گزارش تفصیلی منتظر تأیید ${stage.label}`,detail:[project.projectCode,project.name].filter(Boolean).join(' · '),projectId:project.id,href:`#project/${encodeURIComponent(project.id)}/dossier`,date:submission.updatedAt||submission.submittedAt});
    else if (['manager','accountant'].includes(user.role)&&['changes_requested','rejected'].includes(submission?.status)) add({id:`dossier-revision:${submission.id}`,kind:'dossier',title:'گزارش تفصیلی نیازمند اصلاح',detail:submission.reviewNote||project.name,projectId:project.id,href:`#project/${encodeURIComponent(project.id)}/dossier`,date:submission.updatedAt||submission.submittedAt});
  }
  for (const report of rows(state.reports)) {
    if (!projects.has(report.projectId)) continue;
    if (manager && report.status === 'submitted') add({ id: `report:${report.id}`, kind: 'report', title: 'گزارش آمادهٔ بررسی', detail: report.description, projectId: report.projectId, href: '#reports', date: report.createdAt || report.date });
    if (user.role === 'worker' && report.workerId === user.id && ['changes_requested', 'rejected'].includes(report.status)) add({ id: `review:${report.id}`, kind: 'review', title: 'گزارش نیازمند اصلاح', detail: report.reviewNote || report.description, projectId: report.projectId, href: '#reports', date: report.reviewedAt || report.createdAt || report.date });
  }
  for (const ticket of rows(state.tickets)) {
    if (!projects.has(ticket.projectId) || ticket.status === 'resolved') continue;
    if (!manager && ticket.authorId !== user.id) continue;
    add({ id: `ticket:${ticket.id}`, kind: 'ticket', title: ticket.priority === 'high' ? 'درخواست پشتیبانی با اولویت بالا' : 'درخواست پشتیبانی باز', detail: ticket.subject, projectId: ticket.projectId, href: '#support', date: rows(ticket.replies).at(-1)?.createdAt || ticket.createdAt });
  }
  for (const invoice of rows(state.invoices)) {
    if (!['manager', 'customer'].includes(user.role) || !projects.has(invoice.projectId) || Number(invoice.amount) <= Number(invoice.paid || 0)) continue;
    add({ id: `invoice:${invoice.id}`, kind: 'invoice', title: manager ? 'صورت‌حساب دارای مانده' : 'صورت‌حساب قابل پیگیری', detail: invoice.title, projectId: invoice.projectId, href: '#finance', date: invoice.createdAt || invoice.dueDate });
  }
  for (const message of rows(state.messages)) {
    if (!projects.has(message.projectId) || message.authorId === user.id || (user.role === 'customer' && message.internal)) continue;
    add({ id: `message:${message.id}`, kind: 'message', title: message.internal ? 'یادداشت داخلی تیم' : 'پیام پروژه', detail: message.text, projectId: message.projectId, href: `#project/${encodeURIComponent(message.projectId)}/messages`, date: message.createdAt });
  }
  return notifications.sort((a, b) => timestamp(b.date) - timestamp(a.date)).slice(0, 60);
}
