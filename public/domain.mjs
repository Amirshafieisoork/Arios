import { normalizePhone, normalizeUsername, internalAuthEmail } from './identity.mjs';
import { applyDossierAction, safeDossierSubmission, safeDossierWorksheet } from './dossier-model.mjs';
import { applyDossierWorkflow } from './approval-workflow.mjs';
import { applyAdminRecordAction, managementSnapshot } from './admin-records.mjs';
import { applyCatalogAction, readCatalogs } from './catalogs.mjs';
/** ARIOS domain. All amounts are whole toman; elapsed work is integer minutes. */
export class DomainError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') {
    super(message); this.name = 'DomainError'; this.status = status; this.code = code;
  }
}

const copy = value => structuredClone(value);
const allowedRoles = new Set(['manager', 'worker', 'customer', 'warehouse', 'accountant']);
const arrayNames = ['users', 'projects', 'reports', 'materials', 'invoices', 'messages', 'tickets', 'inventory', 'receipts', 'audit'];
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new DomainError(message, status, code); };
const now = () => new Date().toISOString();
const id = prefix => `${prefix}_${globalThis.crypto.randomUUID()}`;
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, copy(object[key])]));
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, label, { optional = false, max = 4000 } = {}) {
  if (value == null && optional) return '';
  if (typeof value !== 'string') fail(`${label} معتبر نیست.`);
  const result = value.trim();
  if ((!optional && !result) || result.length > max) fail(`${label} معتبر نیست.`);
  return result;
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} باید عدد صحیح معتبر باشد.`);
  return value;
}
function quantity(value, label = 'مقدار', allowZero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || !Number.isSafeInteger(Math.round(value * 1000)) || Math.abs(value * 1000 - Math.round(value * 1000)) > 0.000001) fail(`${label} باید ${allowZero ? 'نامنفی' : 'مثبت'} و حداکثر سه رقم اعشار باشد.`);
  return value;
}
function isoDate(value, label = 'تاریخ') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} معتبر نیست.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(`${label} معتبر نیست.`);
  return value;
}
function clock(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('ساعت باید با قالب HH:MM ثبت شود.');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail('مقدار بله یا خیر معتبر نیست.');
  return value;
}
function choice(value, choices, label) {
  if (!choices.includes(value)) fail(`${label} معتبر نیست.`);
  return value;
}
function find(list, value, label) {
  const item = list.find(item => item.id === value);
  if (!item) fail(`${label} یافت نشد.`, 404, 'NOT_FOUND');
  return item;
}
function getUser(state, userOrId) {
  const userId = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  const user = state.users.find(user => user.id === userId);
  if (!user || user.deletedAt || !allowedRoles.has(user.role)) fail('برای ادامه وارد حساب خود شوید.', 401, 'UNAUTHENTICATED');
  return user;
}
export function projectAccess(state, userOrId, projectId) {
  const userId = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  const user = state.users.find(item => item.id === userId);
  const project = state.projects.find(item => item.id === projectId);
  if (!user || user.deletedAt || !project || (project.archivedAt && user.role !== 'manager')) return false;
  return user.role === 'manager' || (user.role === 'customer' && project.customerId === user.id) || (user.role === 'worker' && project.memberIds.includes(user.id));
}
const reviewerRoles = ['manager', 'worker', 'accountant'];
const assignedStages = (submission, userId) => (submission?.approval?.stages || []).some(stage => stage.userId === userId);
export function projectReviewerAccess(state, userOrId, projectId) {
  const userId = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  const user = state.users.find(item => item.id === userId), project = state.projects.find(item => item.id === projectId);
  if (!user || user.deletedAt || !reviewerRoles.includes(user.role) || !project || (project.archivedAt && user.role !== 'manager')) return false;
  return project.projectManagerId === user.id || (project.reviewChain || []).some(stage => stage.userId === user.id) || assignedStages(project.dossierSubmission,user.id) || (project.dossierSubmissionHistory || []).some(submission => assignedStages(submission,user.id));
}
export function projectReadAccess(state, userOrId, projectId) {
  const userId = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  const user = state.users.find(item => item.id === userId);
  if (state.projects.some(project=>project.id===projectId&&project.archivedAt) && user?.role !== 'manager') return false;
  return projectAccess(state,userId,projectId) || Boolean(user && !user.deletedAt && user.role === 'accountant' && state.projects.some(project => project.id === projectId)) || projectReviewerAccess(state,userId,projectId);
}
export const PROJECT_APPROVAL_LABELS = Object.freeze(['مسئول پروژه', 'مسئول واحد', 'مدیر گروه فنی', 'واحد فروش', 'واحد مالی', 'مدیرعامل']);
export function normalizeProjectCode(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[۰-۹]/g,char=>String(char.charCodeAt(0)-1776)).replace(/[٠-٩]/g,char=>String(char.charCodeAt(0)-1632)).replace(/[\u200c\u200e\u200f]/g,'').trim().toUpperCase() : '';
}
function projectMetadata(state, payload, previous = {}) {
  const fields = ['projectCode','projectManagerId','customerCode','dossierCode','dossierTitle','reviewChain'];
  const values = {...pick(previous,fields),...pick(payload,fields)};
  const projectCode = normalizeProjectCode(text(values.projectCode,'کد پروژه',{max:80}));
  if (!projectCode || /[\u0000-\u001f\u007f]/.test(projectCode)) fail('کد پروژه معتبر نیست.');
  if (state.projects.some(project => project.id !== previous.id && normalizeProjectCode(project.projectCode) === projectCode)) fail('این کد قبلاً برای پروژهٔ دیگری ثبت شده است.',409,'DUPLICATE_PROJECT_CODE');
  const lead = find(state.users,text(values.projectManagerId,'مسئول پروژه',{max:120}),'مسئول پروژه');
  if (lead.deletedAt || !['manager','worker'].includes(lead.role)) fail('مسئول پروژه باید مدیر یا نیروی اجرایی فعال باشد.');
  if (!Array.isArray(values.reviewChain) || values.reviewChain.length !== 6) fail('مسئول هر شش مرحلهٔ تأیید را تعیین کنید.');
  const reviewChain = values.reviewChain.map((stage,index) => {
    if (!record(stage) || (stage.label !== undefined && stage.label !== PROJECT_APPROVAL_LABELS[index])) fail('ترتیب شش مسئولیت تأیید معتبر نیست.');
    const person = find(state.users,text(stage.userId,'تأییدکننده',{max:120}),'تأییدکننده');
    if (person.deletedAt || !reviewerRoles.includes(person.role)) fail('تأییدکننده باید حساب فعال مدیر، نیرو یا حسابدار باشد.');
    if (index === 0 && person.id !== lead.id) fail('نخستین تأیید باید با مسئول پروژه باشد.');
    return {label:PROJECT_APPROVAL_LABELS[index],userId:person.id};
  });
  return {projectCode,projectManagerId:lead.id,reviewChain,customerCode:normalizeProjectCode(text(values.customerCode,'شماره مشتری',{optional:true,max:80})),dossierCode:normalizeProjectCode(text(values.dossierCode,'شماره پرونده',{optional:true,max:80})),dossierTitle:text(values.dossierTitle,'عنوان پرونده',{optional:true,max:200})};
}
function requireProject(state, user, projectId) {
  if (!projectAccess(state, user, projectId)) fail('به این پروژه دسترسی ندارید.', 403, 'FORBIDDEN');
  const project = state.projects.find(project => project.id === projectId);
  if (project.archivedAt) fail('پروژه حذف شده است؛ ابتدا آن را بازیابی کنید.',409,'PROJECT_ARCHIVED');
  return project;
}
function manager(user) { if (user.role !== 'manager') fail('این عملیات فقط برای مدیر مجاز است.', 403, 'FORBIDDEN'); }
function roleAllowed(user, roles) { if (!roles.includes(user.role)) fail('دسترسی این عملیات برای حساب شما فعال نیست.', 403, 'FORBIDDEN'); }
function inventoryProject(state, user, projectId) {
  roleAllowed(user, ['manager', 'warehouse', 'worker']);
  const project=user.role === 'worker' ? requireProject(state, user, projectId) : find(state.projects, projectId, 'پروژه');
  if(project.archivedAt)fail('پروژه حذف شده است؛ ابتدا آن را بازیابی کنید.',409,'PROJECT_ARCHIVED');
  return project;
}
function activeStock(state, stockId) {
  const stock = find(state.inventory, stockId, 'کالای انبار');
  if (stock.archivedAt) fail('این کالا از فهرست فعال حذف شده است؛ مسئول انبار باید ابتدا آن را بازگرداند.', 409, 'STOCK_ARCHIVED');
  return stock;
}
function financialProject(state, user, projectId) {
  roleAllowed(user, ['manager', 'accountant']);
  const project=find(state.projects, projectId, 'پروژه');
  if(project.archivedAt)fail('پروژه حذف شده است؛ ابتدا آن را بازیابی کنید.',409,'PROJECT_ARCHIVED');
  return project;
}
function safeMaterial(material, showPrices = false, showInventory = false) {
  const item = pick(material, ['id', 'projectId', 'name', 'quantity', 'originalQuantity', 'returnedQuantity', 'unit', 'clientVisible', 'date', 'recordedBy', 'createdAt']);
  if (showPrices) Object.assign(item, pick(material, ['unitPrice']));
  if (showInventory) Object.assign(item, pick(material, ['inventoryId']));
  item.returns = (material.returns || []).map(entry => pick(entry, ['id', 'quantity', 'date', 'note', 'recordedBy', 'createdAt']));
  return item;
}
function audit(state, actor, action, entity, description) {
  state.audit.push({ id: id('a'), actorId: actor.id, action, entityId: entity.id, createdAt: now(), description });
}
function safeUser(user, includeRates = false) {
  const result = pick(user, ['id', 'name', 'email', 'phone', 'username', 'role', 'department', 'skill', 'deletedAt']);
  if (internalAuthEmail(result.email)) delete result.email;
  if (includeRates) Object.assign(result, pick(user, ['hourlyRate', 'rateHistory']));
  return result;
}
function safeReport(report, includeRates) {
  const result = pick(report, ['id', 'projectId', 'workerId', 'date', 'start', 'end', 'breakMinutes', 'description', 'output', 'status', 'minutes', 'createdAt', 'version', 'reviewNote', 'reviewedBy', 'location', 'photoIds']);
  if (includeRates) Object.assign(result, pick(report, ['rate', 'laborCost']));
  return result;
}
function dossierDescriptor(submission) {
  const descriptor = safeDossierSubmission({...submission,snapshot:undefined,approval:submission.approval ? {...submission.approval,history:undefined} : undefined},false);
  if (descriptor.approval) {
    delete descriptor.approval.history;
    descriptor.approval.historyCount = (submission.approval.history || []).length;
  }
  return descriptor;
}
/** Load one frozen document explicitly; account objects supplied by clients are not authority. */
export function readDossierSubmission(state,userOrId,projectId,submissionId) {
  const user = getUser(state,userOrId);
  if (!reviewerRoles.includes(user.role)) fail('گزارش تفصیلی برای حساب شما در دسترس نیست.',403,'FORBIDDEN');
  const project = find(state.projects,text(projectId,'شناسه پروژه',{max:120}),'پروژه');
  if (project.archivedAt && user.role !== 'manager') fail('این پروژه در دسترس نیست.',403,'FORBIDDEN');
  const selectedId = text(submissionId,'شناسه نسخه',{max:120});
  const submission = [project.dossierSubmission,...(project.dossierSubmissionHistory || [])].find(item=>item?.id===selectedId);
  if (!submission) fail('نسخهٔ پرونده یافت نشد.',404,'DOSSIER_SUBMISSION_NOT_FOUND');
  const financial = ['manager','accountant'].includes(user.role);
  const configuredReviewer = project.projectManagerId===user.id || (project.reviewChain || []).some(stage=>stage.userId===user.id);
  if (!financial && !configuredReviewer && !assignedStages(submission,user.id)) fail('این نسخهٔ پرونده برای شما در دسترس نیست.',403,'FORBIDDEN');
  return safeDossierSubmission(submission,financial);
}
const safeMessage = message => pick(message, ['id', 'projectId', 'authorId', 'text', 'internal', 'createdAt']);
function safeTicket(ticket) {
  const result = pick(ticket, ['id', 'projectId', 'authorId', 'subject', 'description', 'status', 'priority', 'createdAt']);
  result.replies = (ticket.replies || []).map(reply => pick(reply, ['id', 'authorId', 'text', 'createdAt']));
  return result;
}

/** Return a detached, allowlisted snapshot. Never expose credentials or another project's data. */
export function publicState(state, userId) {
  const user = getUser(state, userId);
  const isManager = user.role === 'manager';
  const isWorker = user.role === 'worker';
  const isWarehouse = user.role === 'warehouse';
  const isAccountant = user.role === 'accountant';
  const finance = isManager || isAccountant;
  const stockManager = isManager || isWarehouse;
  const projects = state.projects.filter(project => !project.archivedAt && (isWarehouse || projectReadAccess(state, user, project.id)));
  const projectIds = new Set(projects.map(project => project.id));
  const scoped = list => list.filter(item => !item.archivedAt && projectIds.has(item.projectId));
  const canExecute = projectId => projectAccess(state,user,projectId);
  const liveReviewer = project => reviewerRoles.includes(user.role) && (project.projectManagerId === user.id || (project.reviewChain || []).some(stage => stage.userId === user.id));
  const tickets = isWarehouse || isAccountant ? [] : scoped(state.tickets).filter(ticket => canExecute(ticket.projectId));
  const messages = isWarehouse || isAccountant ? [] : scoped(state.messages).filter(message => canExecute(message.projectId) && (user.role !== 'customer' || !message.internal));
  const contactIds = new Set([user.id]);
  const referenceIds = new Set();
  if (!isWarehouse && !isAccountant) for (const project of projects) {
    for (const memberId of project.memberIds || []) (canExecute(project.id) ? contactIds : referenceIds).add(memberId);
    for (const contactId of project.contactIds || []) if (canExecute(project.id)) contactIds.add(contactId);
    if (project.customerId) (canExecute(project.id) ? contactIds : referenceIds).add(project.customerId);
    if (project.projectManagerId) referenceIds.add(project.projectManagerId);
    for (const stage of project.reviewChain || []) referenceIds.add(stage.userId);
    if (liveReviewer(project)) for (const report of state.reports.filter(report=>report.projectId===project.id)) referenceIds.add(report.workerId);
    for (const submission of [project.dossierSubmission,...(project.dossierSubmissionHistory || [])]) if (assignedStages(submission,user.id)) {
      for (const stage of submission.approval.stages || []) referenceIds.add(stage.userId);
    }
  }
  for (const material of scoped(state.materials)) {
    if (material.recordedBy) referenceIds.add(material.recordedBy);
    for (const returned of material.returns || []) if (returned.recordedBy) referenceIds.add(returned.recordedBy);
  }
  for (const message of messages) contactIds.add(message.authorId);
  for (const ticket of tickets) { contactIds.add(ticket.authorId); for (const reply of ticket.replies || []) contactIds.add(reply.authorId); }
  if (!isWarehouse && !isAccountant) for (const person of state.users) if (person.role === 'manager') contactIds.add(person.id);
  const result = {
    user: safeUser(user, finance),
    users: state.users.filter(person => finance || contactIds.has(person.id) || referenceIds.has(person.id)).map(person => {
      if (person.id === user.id || isManager) return {...safeUser(person, finance),...(isManager?pick(person,['availability','workStart','workEnd']):{})};
      if (isWarehouse) return pick(person, ['id', 'name', 'role', 'deletedAt']);
      if (isAccountant) return pick(person, ['id', 'name', 'role', 'hourlyRate', 'rateHistory', 'deletedAt']);
      return contactIds.has(person.id) ? safeUser(person) : pick(person,['id','name','role','deletedAt','employeeCode','personnelCode']);
    }),
    projects: projects.map(project => {
      if (isWarehouse) return pick(project, ['id', 'name', 'type', 'status', 'projectCode']);
      const item = pick(project, isAccountant ? ['id', 'name', 'type', 'customerId', 'memberIds', 'status', 'progress', 'startDate', 'endDate', 'cover'] : ['id', 'name', 'type', 'customerId', 'memberIds', 'contactIds', 'location', 'status', 'progress', 'startDate', 'endDate', 'description', 'phases', 'cover', 'clientNote']);
      Object.assign(item,pick(project,['projectCode','projectManagerId','customerCode','dossierCode','dossierTitle']));
      item.canRecordWork = ['manager','worker'].includes(user.role) && canExecute(project.id);
      if (finance || isWorker) {
        item.dossierVersion = project.dossier?.version || 0;
        Object.assign(item,pick(project,['reviewChain']));
        if (finance && project.dossier) item.dossier = safeDossierWorksheet(project.dossier,true);
        if (project.dossierSubmission && (finance || liveReviewer(project) || assignedStages(project.dossierSubmission,user.id))) item.dossierSubmission = dossierDescriptor(project.dossierSubmission);
        if (project.dossierSubmissionHistory) item.dossierSubmissionHistory = project.dossierSubmissionHistory.filter(submission=>finance || liveReviewer(project) || assignedStages(submission,user.id)).map(dossierDescriptor);
      }
      if (!isAccountant) {
        if ((isManager || isWorker) && canExecute(project.id)) item.tasks = (project.tasks || []).filter(task=>!task.archivedAt).map(task => pick(task, ['id', 'title', 'description', 'assigneeId', 'dueDate', 'status', 'version', 'createdAt', 'updatedAt']));
      }
      const reviewPhotoIds = new Set();
      if (liveReviewer(project)) for (const report of state.reports.filter(report=>report.projectId===project.id)) for (const photoId of report.photoIds || []) reviewPhotoIds.add(photoId);
      for (const submission of [project.dossierSubmission,...(project.dossierSubmissionHistory || [])]) if (assignedStages(submission,user.id)) for (const report of submission.snapshot?.reports || []) for (const photoId of report.photoIds || []) reviewPhotoIds.add(photoId);
      if (!isAccountant || reviewPhotoIds.size) item.files = (project.files || []).filter(file => !file.archivedAt && file.status === 'ready' && (!file.draftId || file.reportId || file.uploadedBy === user.id) && (canExecute(project.id) ? (user.role !== 'customer' || file.clientVisible === true) : reviewPhotoIds.has(file.id) && ['image/jpeg','image/png','image/webp'].includes(file.mimeType) && (!file.draftId || file.reportId))).map(file => pick(file, ['id', 'name', 'mimeType', 'size', 'uploadedBy', 'createdAt', 'clientVisible', 'reportId']));
      if(isManager)item.archivedFiles=(project.files||[]).filter(file=>file.archivedAt&&file.status==='ready'&&(!file.draftId||file.reportId||file.uploadedBy===user.id)).map(file=>pick(file,['id','name','mimeType','size','uploadedBy','createdAt','clientVisible','reportId','archivedAt','archivedBy','updatedAt']));
      if (finance) {
        Object.assign(item, pick(project, ['budget', 'contractAmount']));
        if (isManager) Object.assign(item, pick(project, ['publicVisible', 'publicTitle', 'publicSummary']));
        item.laborCost = state.reports.filter(report => !report.archivedAt && report.projectId === project.id && report.status === 'approved').reduce((sum, report) => sum + report.laborCost, 0);
      } else if (!isWorker) Object.assign(item, pick(project, ['contractAmount']));
      return item;
    }),
    reports: user.role === 'customer' || isWarehouse ? [] : scoped(state.reports).filter(report => finance || (report.workerId === user.id && canExecute(report.projectId)) || liveReviewer(state.projects.find(project=>project.id===report.projectId))).map(report => safeReport(report, finance)),
    materials: scoped(state.materials).filter(material => (isWarehouse || finance || canExecute(material.projectId) || liveReviewer(state.projects.find(project=>project.id===material.projectId))) && (user.role !== 'customer' || material.clientVisible)).map(material => safeMaterial(material, !isWorker, stockManager || isWorker)),
    invoices: isWorker || isWarehouse ? [] : scoped(state.invoices).map(invoice => pick(invoice, ['id', 'projectId', 'title', 'amount', 'paid', 'dueDate', 'status'])),
    messages: messages.map(safeMessage),
    tickets: tickets.map(safeTicket),
    inventory: stockManager || isAccountant ? state.inventory.filter(item => !item.archivedAt).map(item => pick(item, ['id', 'name', 'unit', 'quantity', 'minQuantity', 'unitPrice'])) : [],
    archivedInventory: stockManager || isAccountant ? state.inventory.filter(item => item.archivedAt).map(item => pick(item, ['id', 'name', 'unit', 'quantity', 'minQuantity', 'unitPrice', 'archivedAt', 'archivedBy'])) : [],
    stockCatalog: isWorker ? state.inventory.filter(item => !item.archivedAt).map(item => pick(item, ['id', 'name', 'unit', 'quantity'])) : [],
    receipts: isWorker || isWarehouse ? [] : scoped(state.receipts).map(receipt => pick(receipt, ['id', 'invoiceId', 'projectId', 'amount', 'reference', 'method', 'recordedBy', 'createdAt'])),
    audit: isManager ? state.audit.map(entry => pick(entry, ['id', 'actorId', 'action', 'entityId', 'createdAt', 'description'])) : [],
    reportDrafts: (isManager || isWorker) ? (state.reportDrafts || []).filter(entry => entry.authorId === user.id && !entry.reportId && projectIds.has(entry.projectId)).map(entry => pick(entry, ['id', 'projectId', 'workerId', 'date', 'start', 'end', 'breakMinutes', 'description', 'output', 'location', 'photoIds', 'version', 'updatedAt'])) : [],
    catalogs: readCatalogs(state,{includeArchived:isManager}),
  };
  if(isManager)result.management=managementSnapshot(state,user);
  return result;
}

function historicalRate(worker, date) {
  const histories = worker.rateHistory || [];
  if (!histories.length) return integer(worker.hourlyRate ?? 0, 'نرخ ساعتی');
  const rate = histories.filter(entry => entry.effectiveDate <= date).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  if (!rate) fail('برای تاریخ این گزارش نرخ دستمزد تعریف نشده است.');
  return integer(rate.hourlyRate, 'نرخ ساعتی');
}
function roundedLabor(rate, minutes) {
  const numerator = BigInt(rate) * BigInt(minutes);
  const result = (numerator + 30n) / 60n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('هزینه دستمزد از محدوده مجاز بیشتر است.');
  return Number(result);
}

function reportLocation(value) {
  if (value === undefined || value === null) return null;
  if (!record(value) || typeof value.latitude !== 'number' || !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 || typeof value.longitude !== 'number' || !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180 || typeof value.accuracy !== 'number' || !Number.isFinite(value.accuracy) || value.accuracy < 0 || value.accuracy > 100000 || typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) fail('موقعیت ثبت‌شده معتبر نیست.');
  return { latitude: value.latitude, longitude: value.longitude, accuracy: value.accuracy, capturedAt: new Date(value.capturedAt).toISOString() };
}
function reportPhotos(project, value, user, draftId) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 6 || value.some(item => typeof item !== 'string')) fail('تصاویر گزارش معتبر نیستند.');
  return [...new Set(value)].map(fileId => {
    const file = (project.files || []).find(file => file.id === fileId && !file.archivedAt && file.status === 'ready' && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimeType));
    if (!file || (file.draftId && file.draftId !== draftId && !file.reportId) || (user.role !== 'manager' && file.uploadedBy !== user.id)) fail('تصویر انتخابی در دسترس این گزارش نیست.', 403, 'FORBIDDEN');
    return fileId;
  });
}

/** Validate and commit atomically. Any thrown error leaves the caller's state untouched. */
export function applyAction(state, userId, action, payload = {}) {
  if (!record(payload)) fail('ورودی عملیات معتبر نیست.');
  if(typeof action!=='string'||!action)fail('عملیات معتبر نیست.');
  const draft = copy(state);
  for (const name of arrayNames) if (!Array.isArray(draft[name])) fail('ساختار اطلاعات معتبر نیست.', 500, 'INVALID_STATE');
  const user = getUser(draft, userId);
  let result;
  if(!action.startsWith('admin.record.')&&!action.startsWith('catalog.')){
    const collectionByPrefix={report:'reports',material:'materials',invoice:'invoices',ticket:'tickets'};
    const prefix=action.split('.')[0];
    const target=collectionByPrefix[prefix]&&payload.id?draft[collectionByPrefix[prefix]].find(row=>row.id===payload.id):action==='payment.record'?draft.invoices.find(row=>row.id===payload.invoiceId):null;
    const sourceDraft=action.startsWith('report.draft.')&&payload.id?(draft.reportDrafts||[]).find(row=>row.id===payload.id):null;
    // Check canonical parents as well as requested destinations. Irrelevant client IDs must never mask an archived origin.
    const projectIds=new Set([payload.projectId,target?.projectId,sourceDraft?.projectId,...(prefix==='project'?[payload.id]:[])].filter(Boolean));
    if(draft.projects.some(row=>projectIds.has(row.id)&&row.archivedAt))fail('پروژه حذف شده است؛ ابتدا آن را بازیابی کنید.',409,'PROJECT_ARCHIVED');
    const project=draft.projects.find(row=>row.id===payload.projectId);
    if(target?.archivedAt)fail('رکورد حذف شده است؛ ابتدا آن را بازیابی کنید.',409,'RECORD_ARCHIVED');
    if(prefix==='task'&&project?.tasks?.some(task=>task.id===payload.id&&task.archivedAt))fail('وظیفه حذف شده است؛ ابتدا آن را بازیابی کنید.',409,'RECORD_ARCHIVED');
  }
  if (action.startsWith('admin.record.')) {
    result=applyAdminRecordAction(draft,user,action,payload,{fail,historicalRate,reportLocation,reportPhotos,run:(operation,input)=>applyAction(draft,user.id,operation,input)});
    audit(draft,user,action,{id:payload.id},`مدیریت ${payload.collection}: ${payload.reason||'اصلاح یا بازیابی رکورد'}`);
  } else if(action.startsWith('catalog.')) {
    result=applyCatalogAction(draft,user,action,payload);
    audit(draft,user,action,result,'فهرست دسته‌بندی‌های سازمان به‌روزرسانی شد.');
  } else if (action === 'project.create') {
    manager(user);
    const name = text(payload.name, 'نام پروژه', { max: 160 });
    const type = text(payload.type, 'نوع پروژه', { max: 80 });
    const customerId = payload.customerId || null;
    if (customerId && (() => { const person = find(draft.users, customerId, 'مشتری'); return person.deletedAt || person.role !== 'customer'; })()) fail('حساب انتخابی مشتری نیست.');
    if (!Array.isArray(payload.memberIds) || payload.memberIds.some(memberId => typeof memberId !== 'string')) fail('اعضای پروژه معتبر نیستند.');
    const memberIds = [...new Set(payload.memberIds)];
    for (const memberId of memberIds) if ((() => { const person = find(draft.users, memberId, 'نیرو'); return person.deletedAt || person.role !== 'worker'; })()) fail('فقط نیروی اجرایی به پروژه تخصیص دهید.');
    const startDate = isoDate(payload.startDate, 'تاریخ شروع');
    const endDate = isoDate(payload.endDate, 'تاریخ پایان');
    if (endDate < startDate) fail('پایان پروژه نباید پیش از شروع باشد.');
    const cover = /event|مراسم|همایش/i.test(type) ? 'event' : /electric|برق/i.test(type) ? 'electric' : /media|رسانه/i.test(type) ? 'media' : 'building';
    result = { id: id('p'), name, type, customerId, memberIds, location: text(payload.location, 'موقعیت', { max: 240 }), status: 'active', progress: 0, budget: integer(payload.budget, 'بودجه'), contractAmount: integer(payload.contractAmount, 'مبلغ قرارداد'), startDate, endDate, description: text(payload.description, 'شرح پروژه', { optional: true }), phases: ['برنامه‌ریزی', 'اجرا', 'آزمایش و تحویل'].map(name => ({ id: id('ph'), name, progress: 0 })), cover, clientNote: '', publicVisible: bool(payload.publicVisible), publicTitle: text(payload.publicTitle, 'عنوان عمومی', { optional: true, max: 160 }), publicSummary: text(payload.publicSummary, 'شرح عمومی', { optional: true, max: 1000 }) };
    Object.assign(result,projectMetadata(draft,payload));
    draft.projects.push(result); audit(draft, user, action, result, 'پروژه ایجاد شد.');
  } else if (action === 'project.update') {
    manager(user);
    const project = find(draft.projects, payload.id, 'پروژه');
    for(const [key,label,max] of [['name','نام پروژه',160],['type','نوع پروژه',80],['location','موقعیت',240]])if(payload[key]!==undefined)project[key]=text(payload[key],label,{max});
    if(payload.description!==undefined)project.description=text(payload.description,'شرح پروژه',{optional:true});
    if(payload.budget!==undefined)project.budget=integer(payload.budget,'بودجه');
    if(payload.contractAmount!==undefined)project.contractAmount=integer(payload.contractAmount,'مبلغ قرارداد');
    if(payload.startDate!==undefined)project.startDate=isoDate(payload.startDate,'تاریخ شروع');
    if(payload.endDate!==undefined)project.endDate=isoDate(payload.endDate,'تاریخ پایان');
    if(project.endDate<project.startDate)fail('پایان پروژه نباید پیش از شروع باشد.');
    if(payload.phases!==undefined){
      if(!Array.isArray(payload.phases)||payload.phases.length>50)fail('حداکثر ۵۰ مرحله برای پروژه ثبت کنید.');
      const phaseIds=new Set();project.phases=payload.phases.map(phase=>{if(!record(phase))fail('مرحلهٔ پروژه معتبر نیست.');const phaseId=phase.id?text(phase.id,'شناسهٔ مرحله',{max:120}):id('ph');if(phaseIds.has(phaseId))fail('شناسهٔ مراحل تکراری است.');phaseIds.add(phaseId);return{id:phaseId,name:text(phase.name,'نام مرحله',{max:160}),progress:integer(phase.progress??0,'پیشرفت مرحله',0,100)};});
    }
    if (['projectCode','projectManagerId','customerCode','dossierCode','dossierTitle','reviewChain'].some(key=>payload[key]!==undefined)) Object.assign(project,projectMetadata(draft,payload,project));
    if (payload.customerId !== undefined) {
      const customerId = payload.customerId === null || payload.customerId === '' ? null : text(payload.customerId, 'مشتری', { max: 100 });
      if (customerId && (() => { const person = find(draft.users, customerId, 'مشتری'); return person.deletedAt || person.role !== 'customer'; })()) fail('حساب انتخابی مشتری نیست.');
      project.customerId = customerId;
    }
    if (payload.memberIds !== undefined) {
      if (!Array.isArray(payload.memberIds) || payload.memberIds.some(memberId => typeof memberId !== 'string')) fail('اعضای پروژه معتبر نیستند.');
      const memberIds = [...new Set(payload.memberIds)];
      for (const memberId of memberIds) if ((() => { const person = find(draft.users, memberId, 'نیرو'); return person.deletedAt || person.role !== 'worker'; })()) fail('فقط نیروی اجرایی به پروژه تخصیص دهید.');
      project.memberIds = memberIds;
    }
    if (payload.progress !== undefined) project.progress = integer(payload.progress, 'پیشرفت', 0, 100);
    if (payload.status !== undefined) project.status = choice(payload.status, ['active', 'attention', 'completed'], 'وضعیت پروژه');
    if (payload.clientNote !== undefined) project.clientNote = text(payload.clientNote, 'یادداشت مشتری', { optional: true });
    if (payload.publicVisible !== undefined) project.publicVisible = bool(payload.publicVisible);
    if (payload.publicTitle !== undefined) project.publicTitle = text(payload.publicTitle, 'عنوان عمومی', { optional: true, max: 160 });
    if (payload.publicSummary !== undefined) project.publicSummary = text(payload.publicSummary, 'شرح عمومی', { optional: true, max: 1000 });
    result = project; audit(draft, user, action, project, 'اطلاعات پروژه به‌روزرسانی شد.');
  } else if (action === 'project.dossier.save' || action.startsWith('project.dossier.')) {
    result = action === 'project.dossier.save' ? applyDossierAction(draft,user,action,payload) : applyDossierWorkflow(draft,user,action,payload,PROJECT_APPROVAL_LABELS);
    audit(draft,user,action,{id:payload.projectId},'پروندهٔ گزارش تفصیلی به‌روزرسانی شد.');
  } else if (action === 'task.create' || action === 'task.update') {
    roleAllowed(user, ['manager', 'worker']);
    const project = requireProject(draft, user, payload.projectId);
    project.tasks ||= [];
    if (action === 'task.create') {
      manager(user);
      if (project.tasks.length >= 300) fail('حداکثر ۳۰۰ وظیفه برای این پروژه قابل ثبت است.');
      const assigneeId = payload.assigneeId || null;
      if (assigneeId && (!project.memberIds.includes(assigneeId) || !draft.users.some(person=>person.id===assigneeId&&person.role==='worker'&&!person.deletedAt))) fail('مسئول وظیفه باید نیروی فعال همین پروژه باشد.');
      const dueDate = payload.dueDate ? isoDate(payload.dueDate, 'مهلت وظیفه') : null;
      result = { id: id('task'), title: text(payload.title, 'عنوان وظیفه', {max: 240}), description: text(payload.description, 'شرح مأموریت', {optional: true, max: 2000}), assigneeId, dueDate, status: 'open', version: 1, createdAt: now(), updatedAt: now() };
      project.tasks.push(result);
    } else {
      const task = find(project.tasks, payload.id, 'وظیفه');
      if (payload.version !== task.version) fail('وظیفه تغییر کرده است؛ صفحه را تازه کنید.', 409, 'VERSION_CONFLICT');
      if (user.role !== 'manager' && task.assigneeId !== user.id) fail('فقط وضعیت وظیفهٔ خود را تغییر دهید.', 403, 'FORBIDDEN');
      if (user.role !== 'manager' && ['title', 'description', 'assigneeId', 'dueDate'].some(key => payload[key] !== undefined)) fail('ویرایش برنامهٔ وظیفه برای مدیر مجاز است.', 403, 'FORBIDDEN');
      if (payload.title !== undefined) task.title = text(payload.title, 'عنوان وظیفه', {max: 240});
      if (payload.description !== undefined) task.description = text(payload.description, 'شرح مأموریت', {optional: true, max: 2000});
      if (payload.assigneeId !== undefined) { if (payload.assigneeId && (!project.memberIds.includes(payload.assigneeId)||!draft.users.some(person=>person.id===payload.assigneeId&&person.role==='worker'&&!person.deletedAt))) fail('مسئول وظیفه باید نیروی فعال همین پروژه باشد.'); task.assigneeId = payload.assigneeId || null; }
      if (payload.dueDate !== undefined) task.dueDate = payload.dueDate ? isoDate(payload.dueDate, 'مهلت وظیفه') : null;
      if (payload.status !== undefined) task.status = choice(payload.status, ['open', 'in_progress', 'done'], 'وضعیت وظیفه');
      task.version += 1; task.updatedAt = now(); result = task;
    }
    audit(draft, user, action, result, action === 'task.create' ? 'وظیفهٔ پروژه ثبت شد.' : 'وظیفهٔ پروژه به‌روزرسانی شد.');
  } else if (action === 'report.draft.save' || action === 'report.draft.delete') {
    roleAllowed(user, ['manager', 'worker']);
    draft.reportDrafts ||= [];
    let entry = payload.id ? find(draft.reportDrafts, payload.id, 'پیش‌نویس') : null;
    if (entry && entry.authorId !== user.id) fail('پیش‌نویس فقط برای نویسنده در دسترس است.', 403, 'FORBIDDEN');
    if (entry?.reportId) fail('این پیش‌نویس قبلاً ارسال شده است.', 409, 'DRAFT_SUBMITTED');
    if (entry && entry.version !== payload.version) fail('پیش‌نویس تغییر کرده است؛ صفحه را تازه کنید.', 409, 'VERSION_CONFLICT');
    if (action === 'report.draft.delete') {
      if (!entry) fail('پیش‌نویس یافت نشد.', 404, 'NOT_FOUND');
      for(const project of draft.projects)for(const file of project.files||[])if(file.draftId===entry.id&&!file.reportId)file.status='removed';
      draft.reportDrafts = draft.reportDrafts.filter(row => row.id !== entry.id); result = {id: entry.id};
    } else {
      const project = requireProject(draft, user, payload.projectId);
      const workerId = user.role === 'worker' ? user.id : payload.workerId;
      if (workerId && !project.memberIds.includes(workerId)) fail('نیرو باید عضو همین پروژه باشد.');
      if (!entry && draft.reportDrafts.filter(row => row.authorId === user.id && !row.reportId).length >= 30) fail('حداکثر ۳۰ پیش‌نویس فعال نگه دارید.');
      const fields = {projectId:project.id,workerId:workerId || null,date:payload.date ? isoDate(payload.date) : '',start:payload.start ? (clock(payload.start), payload.start) : '',end:payload.end ? (clock(payload.end), payload.end) : '',breakMinutes:integer(payload.breakMinutes ?? 0,'استراحت',0,1439),description:text(payload.description,'شرح کار',{optional:true}),output:text(payload.output,'خروجی کار',{optional:true}),location:reportLocation(payload.location)};
      entry ||= {id:id('rd'),authorId:user.id,version:0,createdAt:now()};
      fields.photoIds=reportPhotos(project,payload.photoIds,user,entry.id);
      Object.assign(entry,fields,{version:entry.version+1,updatedAt:now()});
      if (!draft.reportDrafts.some(row=>row.id===entry.id)) draft.reportDrafts.push(entry);
      result=pick(entry,['id','projectId','workerId','date','start','end','breakMinutes','description','output','location','photoIds','version','updatedAt']);
    }
  } else if (action === 'team.schedule') {
    manager(user);
    const person=find(draft.users,payload.id,'نیرو');
    if(person.deletedAt||person.role!=='worker')fail('برنامه فقط برای نیروی فعال اجرایی ثبت می‌شود.');
    const availability=choice(payload.availability,['available','busy','leave'],'وضعیت حضور');
    const workStart=payload.workStart||'',workEnd=payload.workEnd||'';
    if(Boolean(workStart)!==Boolean(workEnd))fail('شروع و پایان ساعت کاری را با هم وارد کنید.');
    if(workStart&&clock(workEnd)<=clock(workStart))fail('پایان ساعت کاری باید پس از شروع باشد.');
    Object.assign(person,{availability,workStart,workEnd});result={id:person.id,availability,workStart,workEnd};audit(draft,user,action,result,'وضعیت حضور و برنامهٔ کاری نیرو ثبت شد.');
  } else if (action === 'account.update') {
    manager(user);
    const person = find(draft.users, text(payload.id, 'شناسه حساب', { max: 120 }), 'حساب');
    if (person.deletedAt) fail('پیش از ویرایش، حساب حذف‌شده را بازیابی کنید.', 409, 'ACCOUNT_ARCHIVED');
    if (payload.password !== undefined && payload.password !== '') fail('تغییر رمز را جدا از ویرایش اطلاعات حساب انجام دهید.');
    if (payload.name !== undefined) person.name = text(payload.name, 'نام', { max: 120 });
    if (payload.phone !== undefined) {
      let phone;
      try { phone = normalizePhone(payload.phone); } catch { fail('شماره تماس معتبر نیست.', 400, 'INVALID_PHONE'); }
      const duplicate = draft.users.some(other => { try { return other.id !== person.id && other.phone && normalizePhone(other.phone) === phone; } catch { return false; } });
      if (duplicate) fail('این شماره تماس برای حساب دیگری ثبت شده است.', 409, 'DUPLICATE_PHONE');
      person.phone = phone;
    }
    if (payload.username !== undefined) {
      let username = '';
      try { username = payload.username === '' ? '' : normalizeUsername(payload.username); } catch { fail('نام کاربری معتبر نیست.', 400, 'INVALID_USERNAME'); }
      if (username && draft.users.some(other => other.id !== person.id && other.username && normalizeUsername(other.username) === username)) fail('این نام کاربری قبلاً ثبت شده است.', 409, 'DUPLICATE_USERNAME');
      if (username) person.username = username; else delete person.username;
    }
    if (payload.department !== undefined) person.department = text(payload.department, 'واحد', { optional: true, max: 100 });
    if (payload.skill !== undefined) person.skill = text(payload.skill, 'مهارت', { optional: true, max: 200 });
    const requestedRole = payload.role === undefined ? person.role : payload.role;
    if (person.role === 'manager' && requestedRole !== 'manager') fail('نقش مدیر اصلی از این فرم تغییر نمی‌کند.', 403, 'MANAGER_ROLE_PROTECTED');
    if (person.role !== 'manager' && !['worker', 'customer', 'warehouse', 'accountant'].includes(requestedRole)) fail('نقش حساب معتبر نیست.');
    if (requestedRole === 'warehouse' && !person.username) fail('برای انباردار نام کاربری مجزا ثبت کنید.', 400, 'USERNAME_REQUIRED');
    const projectIds = payload.projectIds ?? [];
    if (!Array.isArray(projectIds) || projectIds.length > 100 || projectIds.some(value => typeof value !== 'string') || new Set(projectIds).size !== projectIds.length) fail('فهرست پروژه‌ها معتبر نیست.');
    const selectedProjects = projectIds.map(value => find(draft.projects, value, 'پروژه'));
    if(selectedProjects.some(project=>project.archivedAt))fail('انتساب تازه به پروژهٔ حذف‌شده مجاز نیست؛ ابتدا پروژه را بازیابی کنید.',409,'PROJECT_ARCHIVED');
    const warnings = [];
    if (requestedRole === 'worker') {
      if (person.hourlyRate === undefined) person.hourlyRate = 0;
      if (!Array.isArray(person.rateHistory)) person.rateHistory = [];
      for (const project of draft.projects) {
        if (project.customerId === person.id) { project.customerId = null; project.memberIds = [...new Set([...(project.memberIds || []), person.id])]; }
      }
      for (const project of selectedProjects) project.memberIds = [...new Set([...(project.memberIds || []), person.id])];
    } else if (requestedRole === 'customer') {
      const candidates = new Set(selectedProjects.map(project => project.id));
      for (const project of draft.projects) {
        if ((project.memberIds || []).includes(person.id)) candidates.add(project.id);
        project.memberIds = (project.memberIds || []).filter(value => value !== person.id);
      }
      for (const project of draft.projects.filter(project => candidates.has(project.id))) {
        if (!project.customerId || project.customerId === person.id) project.customerId = person.id;
        else warnings.push(`پروژهٔ «${project.name}» مشتری دیگری دارد؛ نقش حساب تغییر کرد و مشتری پروژه دست‌نخورده ماند.`);
      }
    }
    if (['warehouse', 'accountant'].includes(requestedRole)) for (const project of draft.projects) {
      project.memberIds = (project.memberIds || []).filter(value => value !== person.id);
      if (project.customerId === person.id) project.customerId = null;
      project.contactIds = (project.contactIds || []).filter(value => value !== person.id);
    }
    person.role = requestedRole;
    result = { ...safeUser(person, true), warnings };
    audit(draft, user, action, person, 'اطلاعات تماس و نقش حساب به‌روزرسانی شد.');
  } else if (action === 'account.archive' || action === 'account.restore') {
    manager(user);
    const person = find(draft.users, text(payload.id, 'شناسه حساب', { max: 120 }), 'حساب');
    if (person.id === user.id || person.role === 'manager') fail('حساب مدیر از این بخش حذف نمی‌شود.', 403, 'MANAGER_ROLE_PROTECTED');
    if (action === 'account.archive') {
      person.deletedAt ||= now();
    } else {
      if (person.phone && draft.users.some(other => other.id !== person.id && !other.deletedAt && other.phone && normalizePhone(other.phone) === normalizePhone(person.phone))) fail('شماره تماس برای حساب فعال دیگری ثبت شده است.', 409, 'DUPLICATE_PHONE');
      if (person.username && draft.users.some(other => other.id !== person.id && !other.deletedAt && other.username && normalizeUsername(other.username) === normalizeUsername(person.username))) fail('نام کاربری برای حساب فعال دیگری ثبت شده است.', 409, 'DUPLICATE_USERNAME');
      delete person.deletedAt;
    }
    result = safeUser(person, true);
    audit(draft, user, action, person, action === 'account.archive' ? 'حساب از کاربران فعال حذف شد؛ سوابق حفظ شد.' : 'دسترسی حساب بازیابی شد.');
  } else if (action === 'report.create') {
    if (!['worker', 'manager'].includes(user.role)) fail('ثبت گزارش برای این حساب مجاز نیست.', 403, 'FORBIDDEN');
    const sourceDraft = payload.draftId ? find(draft.reportDrafts || [], payload.draftId, 'پیش‌نویس') : null;
    if (sourceDraft && sourceDraft.authorId !== user.id) fail('پیش‌نویس در دسترس نیست.',403,'FORBIDDEN');
    if (sourceDraft) requireProject(draft,user,sourceDraft.projectId);
    if (sourceDraft?.reportId) return safeReport(find(draft.reports,sourceDraft.reportId,'گزارش'),user.role==='manager');
    const project = requireProject(draft, user, payload.projectId);
    if (user.role === 'worker' && payload.workerId !== undefined && payload.workerId !== user.id) fail('گزارش را فقط برای خود ثبت کنید.', 403, 'FORBIDDEN');
    const workerId = user.role === 'worker' ? user.id : payload.workerId;
    if (sourceDraft && (sourceDraft.projectId!==project.id || sourceDraft.workerId!==workerId)) fail('پروژه و نیروی پیش‌نویس باید با گزارش یکسان باشند.');
    const worker = find(draft.users, workerId, 'نیروی اجرایی');
    if (worker.deletedAt || worker.role !== 'worker' || !project.memberIds.includes(worker.id)) fail('نیروی انتخابی عضو این پروژه نیست.', 403, 'FORBIDDEN');
    const date = isoDate(payload.date);
    const start = clock(payload.start); const end = clock(payload.end);
    if (end <= start) fail('ساعت پایان باید پس از ساعت شروع باشد.');
    const breakMinutes = integer(payload.breakMinutes ?? 0, 'دقیقه استراحت', 0, end - start - 1);
    const minutes = end - start - breakMinutes;
    result = { id: id('r'), projectId: project.id, workerId, date, start: payload.start, end: payload.end, breakMinutes, description: text(payload.description, 'شرح کار'), output: text(payload.output, 'خروجی کار', { optional: true }), status: 'submitted', minutes, createdAt: now(), version: 1, rate: historicalRate(worker, date), laborCost: 0 };
    result.location=reportLocation(payload.location);
    result.photoIds=reportPhotos(project,payload.photoIds,user,sourceDraft?.id);
    if (sourceDraft) {sourceDraft.reportId=result.id;sourceDraft.completedAt=now();for(const file of project.files||[])if(result.photoIds.includes(file.id))file.reportId=result.id;}
    draft.reports.push(result); audit(draft, user, action, result, 'گزارش برای بررسی ثبت شد.');
    result = safeReport(result, user.role === 'manager');
  } else if (action === 'report.update') {
    if (!['worker', 'manager'].includes(user.role)) fail('اصلاح گزارش برای این حساب مجاز نیست.', 403, 'FORBIDDEN');
    const report = find(draft.reports, payload.id, 'گزارش');
    requireProject(draft, user, report.projectId);
    if (user.role === 'worker' && report.workerId !== user.id) fail('فقط گزارش خود را اصلاح کنید.', 403, 'FORBIDDEN');
    if (!['submitted', 'changes_requested', 'rejected'].includes(report.status)) fail('گزارش تأییدشده تغییرپذیر نیست.', 409, 'IMMUTABLE_REPORT');
    integer(payload.version, 'نسخه گزارش', 1);
    if (payload.version !== report.version) fail('گزارش تغییر کرده است؛ صفحه را تازه‌سازی کنید.', 409, 'VERSION_CONFLICT');
    if (payload.workerId !== undefined && payload.workerId !== report.workerId) fail('نیروی گزارش قابل تغییر نیست.', 403, 'FORBIDDEN');
    const project = requireProject(draft, user, payload.projectId);
    const worker = find(draft.users, report.workerId, 'نیروی اجرایی');
    if (worker.deletedAt || worker.role !== 'worker' || !project.memberIds.includes(worker.id)) fail('نیروی انتخابی عضو این پروژه نیست.', 403, 'FORBIDDEN');
    const date = isoDate(payload.date);
    const start = clock(payload.start), end = clock(payload.end);
    if (end <= start) fail('ساعت پایان باید پس از ساعت شروع باشد.');
    const breakMinutes = integer(payload.breakMinutes ?? 0, 'دقیقه استراحت', 0, end - start - 1);
    const description = text(payload.description, 'شرح کار');
    const output = text(payload.output, 'خروجی کار', { optional: true });
    const rate = date === report.date ? report.rate : historicalRate(worker, date);
    const moved=report.projectId!==project.id;
    const location=payload.location!==undefined?reportLocation(payload.location):(moved?null:report.location??null);
    const photoIds=payload.photoIds!==undefined?reportPhotos(project,payload.photoIds,user,undefined):(moved?[]:report.photoIds||[]);
    Object.assign(report, { projectId: project.id, date, start: payload.start, end: payload.end, breakMinutes, description, output, minutes: end - start - breakMinutes, rate, laborCost: 0, status: 'submitted', version: report.version + 1, location, photoIds });
    delete report.reviewNote;
    delete report.reviewedBy;
    audit(draft, user, action, report, 'گزارش اصلاح و دوباره برای بررسی ارسال شد.');
    result = safeReport(report, user.role === 'manager');
  } else if (action === 'report.review') {
    manager(user);
    const report = find(draft.reports, payload.id, 'گزارش');
    const status = choice(payload.status, ['approved', 'changes_requested', 'rejected'], 'وضعیت بررسی');
    if (report.status === 'approved') {
      if (status !== 'approved') fail('گزارش تأییدشده تغییرپذیر نیست.', 409, 'IMMUTABLE_REPORT');
      return safeReport(report, true);
    }
    if (status === 'approved') {
      const overlapping = draft.reports.some(other => !other.archivedAt && other.id !== report.id && other.workerId === report.workerId && other.date === report.date && other.status === 'approved' && clock(report.start) < clock(other.end) && clock(other.start) < clock(report.end));
      if (overlapping) fail('این بازه با گزارش تأییدشده همین نیرو هم‌پوشانی دارد.', 409, 'TIME_OVERLAP');
    }
    report.status = status;
    report.reviewNote = text(payload.reviewNote, 'یادداشت بررسی', { optional: true });
    report.reviewedBy = user.id;
    report.laborCost = status === 'approved' ? roundedLabor(report.rate, report.minutes) : 0;
    report.version += 1;
    result = report; audit(draft, user, action, report, status === 'approved' ? 'گزارش تأیید شد.' : 'گزارش بررسی شد.');
  } else if (action === 'material.consume') {
    const project = inventoryProject(draft, user, payload.projectId);
    const stock = activeStock(draft, payload.inventoryId);
    // Inventory identity and price always come from canonical stock, never the browser.
    for (const key of ['name', 'unit', 'unitPrice']) if (payload[key] !== undefined) fail('مشخصات و بهای کالای انبار از اطلاعات ثبت‌شده خوانده می‌شود.');
    if (user.role === 'worker' && payload.clientVisible !== undefined && payload.clientVisible !== false) fail('انتشار هزینه برای مشتری فقط توسط مسئول مجاز است.', 403, 'FORBIDDEN');
    const amount = quantity(payload.quantity), date = isoDate(payload.date);
    const available = Math.round(stock.quantity * 1000), consumed = Math.round(amount * 1000);
    if (consumed > available) fail('موجودی انبار کافی نیست.', 409, 'INSUFFICIENT_STOCK');
    if (!Number.isSafeInteger(Math.round(amount * stock.unitPrice))) fail('هزینه کالا از محدوده مجاز بیشتر است.');
    stock.quantity = (available - consumed) / 1000;
    const material = { id: id('m'), projectId: project.id, inventoryId: stock.id, name: stock.name, quantity: amount, originalQuantity: amount, returnedQuantity: 0, returns: [], unit: stock.unit, unitPrice: stock.unitPrice, clientVisible: user.role === 'worker' ? false : bool(payload.clientVisible), date, recordedBy: user.id, createdAt: now() };
    draft.materials.push(material); audit(draft, user, action, material, 'برداشت کالا از انبار برای پروژه ثبت شد.');
    result = safeMaterial(material, user.role !== 'worker', true);
  } else if (action === 'material.return') {
    roleAllowed(user, ['manager', 'warehouse', 'worker']);
    const material = find(draft.materials, payload.id, 'مصرف کالا');
    inventoryProject(draft, user, material.projectId);
    if (!material.inventoryId) fail('برای قلم مستقل از انبار، برگشت موجودی ثبت نمی‌شود.', 409, 'NO_STOCK_SOURCE');
    const stock = find(draft.inventory, material.inventoryId, 'کالای انبار');
    if (stock.unit !== material.unit) fail('واحد کالای انبار با مصرف ثبت‌شده یکسان نیست.', 409, 'STOCK_UNIT_MISMATCH');
    const amount = quantity(payload.quantity), returned = Math.round(amount * 1000), remaining = Math.round(material.quantity * 1000);
    const date = isoDate(payload.date);
    if (date < material.date) fail('تاریخ برگشت نباید پیش از مصرف باشد.');
    if (returned > remaining) fail('مقدار برگشت از مصرف باقی‌مانده بیشتر است.', 409, 'EXCESS_RETURN');
    const sum = Math.round(stock.quantity * 1000) + returned;
    if (!Number.isSafeInteger(sum)) fail('موجودی از محدوده مجاز بیشتر است.');
    material.originalQuantity ??= Math.round((material.quantity + (material.returnedQuantity || 0)) * 1000) / 1000;
    material.returnedQuantity = (Math.round((material.returnedQuantity || 0) * 1000) + returned) / 1000;
    material.quantity = (remaining - returned) / 1000;
    material.returns ||= [];
    material.returns.push({ id: id('mr'), quantity: amount, date, note: text(payload.note, 'یادداشت برگشت', { optional: true, max: 1000 }), recordedBy: user.id, createdAt: now() });
    stock.quantity = sum / 1000;
    audit(draft, user, action, material, 'برگشت کالا از پروژه به انبار ثبت شد.');
    result = safeMaterial(material, user.role !== 'worker', true);
  } else if (action === 'material.create') {
    manager(user);
    const project = requireProject(draft, user, payload.projectId);
    const amount = quantity(payload.quantity);
    const unit = text(payload.unit, 'واحد', { max: 40 });
    const unitPrice = integer(payload.unitPrice, 'قیمت واحد');
    const name = text(payload.name, 'نام کالا', { max: 160 });
    const date = isoDate(payload.date);
    const clientVisible = bool(payload.clientVisible);
    let inventoryId;
    if (payload.inventoryId) {
      const stock = activeStock(draft, payload.inventoryId);
      if (stock.unit !== unit) fail('واحد مصرف با واحد انبار یکسان نیست.');
      if (Math.round(stock.quantity * 1000) < Math.round(amount * 1000)) fail('موجودی انبار کافی نیست.', 409, 'INSUFFICIENT_STOCK');
      stock.quantity = (Math.round(stock.quantity * 1000) - Math.round(amount * 1000)) / 1000;
      inventoryId = stock.id;
    }
    if (!Number.isSafeInteger(Math.round(amount * unitPrice))) fail('هزینه کالا از محدوده مجاز بیشتر است.');
    result = { id: id('m'), projectId: project.id, name, quantity: amount, unit, unitPrice, clientVisible, date, ...(inventoryId ? { inventoryId } : {}) };
    draft.materials.push(result); audit(draft, user, action, result, 'مصرف کالا ثبت شد.');
  } else if (action === 'invoice.create') {
    const project = financialProject(draft, user, payload.projectId);
    result = { id: id('i'), projectId: project.id, title: text(payload.title, 'عنوان صورت‌حساب', { max: 200 }), amount: integer(payload.amount, 'مبلغ صورت‌حساب', 1), paid: 0, dueDate: isoDate(payload.dueDate, 'سررسید'), status: 'issued' };
    draft.invoices.push(result); audit(draft, user, action, result, 'صورت‌حساب صادر شد.');
  } else if (action === 'payment.record') {
    roleAllowed(user, ['manager', 'accountant']); const invoice = find(draft.invoices, payload.invoiceId, 'صورت‌حساب');
    const amount = integer(payload.amount, 'مبلغ دریافت', 1);
    const reference = text(payload.reference, 'شماره پیگیری', { max: 120 });
    if (draft.receipts.some(receipt => receipt.reference === reference)) fail('این شماره پیگیری قبلاً ثبت شده است.', 409, 'DUPLICATE_REFERENCE');
    if (amount > invoice.amount - invoice.paid) fail('مبلغ دریافت از مانده صورت‌حساب بیشتر است.', 409, 'OVERPAYMENT');
    invoice.paid += amount; invoice.status = invoice.paid === invoice.amount ? 'paid' : 'issued';
    result = { id: id('rc'), invoiceId: invoice.id, projectId: invoice.projectId, amount, reference, method: 'manual', recordedBy: user.id, createdAt: now() };
    draft.receipts.push(result); audit(draft, user, action, result, 'دریافت دستی با شماره پیگیری ثبت شد.');
  } else if (action === 'message.send') {
    const project = requireProject(draft, user, payload.projectId);
    const internal = bool(payload.internal);
    if (user.role === 'customer' && internal) fail('مشتری امکان ارسال پیام داخلی ندارد.', 403, 'FORBIDDEN');
    result = { id: id('msg'), projectId: project.id, authorId: user.id, text: text(payload.text, 'متن پیام'), internal, createdAt: now() };
    draft.messages.push(result); audit(draft, user, action, result, 'پیام پروژه ارسال شد.');
  } else if (action === 'ticket.create') {
    const project = requireProject(draft, user, payload.projectId);
    result = { id: id('t'), projectId: project.id, authorId: user.id, subject: text(payload.subject, 'موضوع تیکت', { max: 200 }), description: text(payload.description, 'شرح مشکل', { max: 12000 }), priority: choice(payload.priority ?? 'normal', ['normal', 'high'], 'اولویت'), status: 'open', createdAt: now(), replies: [] };
    draft.tickets.push(result); audit(draft, user, action, result, 'تیکت پشتیبانی ثبت شد.');
  } else if (action === 'ticket.reply') {
    const ticket = find(draft.tickets, payload.id, 'تیکت'); requireProject(draft, user, ticket.projectId);
    const reply = { id: id('tr'), authorId: user.id, text: text(payload.text, 'پاسخ تیکت'), createdAt: now() };
    ticket.replies.push(reply); result = safeTicket(ticket); audit(draft, user, action, ticket, 'پاسخ تیکت ثبت شد.');
  } else if (action === 'ticket.update') {
    manager(user); const ticket = find(draft.tickets, payload.id, 'تیکت');
    ticket.status = choice(payload.status, ['open', 'in_progress', 'resolved'], 'وضعیت تیکت');
    result = safeTicket(ticket); audit(draft, user, action, ticket, 'وضعیت تیکت به‌روزرسانی شد.');
  } else if (action === 'worker.create') {
    manager(user); const email = text(payload.email, 'ایمیل کاری', { max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('ایمیل کاری معتبر نیست.');
    if (draft.users.some(person => typeof person.email === 'string' && person.email.toLowerCase() === email)) fail('این ایمیل قبلاً ثبت شده است.', 409, 'DUPLICATE_EMAIL');
    result = { id: id('u'), name: text(payload.name, 'نام نیرو', { max: 120 }), email, role: 'worker', department: text(payload.department, 'واحد', { optional: true, max: 100 }), skill: text(payload.skill, 'مهارت', { optional: true, max: 200 }), hourlyRate: 0, rateHistory: [] };
    draft.users.push(result); audit(draft, user, action, result, 'پرونده نیرو ایجاد شد؛ حساب ورود نیست.');
  } else if (action === 'worker.rate') {
    manager(user); const worker = find(draft.users, payload.id, 'نیرو');
    if (worker.role !== 'worker') fail('نرخ فقط برای نیروی اجرایی تعریف می‌شود.');
    const effectiveDate = isoDate(payload.effectiveDate, 'تاریخ اعتبار');
    const hourlyRate = integer(payload.hourlyRate, 'نرخ ساعتی');
    worker.rateHistory ||= [];
    if (worker.rateHistory.some(entry => entry.effectiveDate === effectiveDate)) fail('برای این تاریخ نرخ ثبت شده و قابل بازنویسی نیست.', 409, 'DUPLICATE_RATE_DATE');
    worker.rateHistory.push({ effectiveDate, hourlyRate });
    worker.rateHistory.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const applicable = worker.rateHistory.filter(entry => entry.effectiveDate <= today).at(-1);
    if (applicable) worker.hourlyRate = applicable.hourlyRate;
    result = safeUser(worker, true); audit(draft, user, action, worker, 'نرخ تاریخ‌دار نیرو ثبت شد.');
  } else if (action === 'inventory.create') {
    roleAllowed(user, ['manager', 'warehouse']);
    result = { id: id('inv'), name: text(payload.name, 'نام کالا', { max: 160 }), unit: text(payload.unit, 'واحد', { max: 40 }), quantity: quantity(payload.quantity, 'موجودی اولیه', true), minQuantity: quantity(payload.minQuantity, 'حداقل موجودی', true), unitPrice: integer(payload.unitPrice, 'قیمت واحد') };
    draft.inventory.push(result); audit(draft, user, action, result, 'کالای جدید به انبار افزوده شد.');
  } else if (action === 'inventory.receive') {
    roleAllowed(user, ['manager', 'warehouse']); const stock = activeStock(draft, payload.id);
    const received = quantity(payload.quantity);
    const sum = Math.round(stock.quantity * 1000) + Math.round(received * 1000);
    if (!Number.isSafeInteger(sum)) fail('موجودی از محدوده مجاز بیشتر است.');
    stock.quantity = sum / 1000; result = stock; audit(draft, user, action, stock, 'ورود کالا به انبار ثبت شد.');
  } else if (action === 'inventory.delete') {
    roleAllowed(user, ['manager', 'warehouse']);
    const stock = find(draft.inventory, payload.id, 'کالای انبار');
    if (payload.confirmed !== true) fail('حذف کالا از فهرست فعال باید تأیید شود.', 400, 'CONFIRMATION_REQUIRED');
    const expected = quantity(payload.expectedQuantity, 'موجودی نمایش‌داده‌شده', true);
    if (Math.round(expected * 1000) !== Math.round(stock.quantity * 1000)) fail('موجودی این کالا تغییر کرده است؛ مقدار تازه را بررسی و دوباره تأیید کنید.', 409, 'STOCK_CHANGED');
    const referenced = draft.materials.some(material => material.inventoryId === stock.id);
    if (stock.quantity === 0 && !referenced && !stock.archivedAt) {
      draft.inventory = draft.inventory.filter(item => item.id !== stock.id);
      result = { id: stock.id, removed: true, archived: false };
      audit(draft, user, action, stock, `کالای بدون موجودی و سابقهٔ مصرف حذف شد: ${stock.name}`);
    } else {
      if (!stock.archivedAt) {
        stock.archivedAt = now(); stock.archivedBy = user.id;
        audit(draft, user, action, stock, `کالا با حفظ موجودی و سوابق از فهرست فعال حذف شد: ${stock.name}`);
      }
      result = { id: stock.id, removed: false, archived: true, quantity: stock.quantity };
    }
  } else if (action === 'inventory.restore') {
    roleAllowed(user, ['manager', 'warehouse']);
    const stock = find(draft.inventory, payload.id, 'کالای انبار');
    if (stock.archivedAt) {
      delete stock.archivedAt; delete stock.archivedBy;
      audit(draft, user, action, stock, `کالا به فهرست فعال انبار بازگردانده شد: ${stock.name}`);
    }
    result = stock;
  } else fail('عملیات شناخته‌شده نیست.', 400, 'UNKNOWN_ACTION');
  const detachedResult = copy(result);
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, draft);
  return detachedResult;
}

/** Entirely fictional data for the explicit ARIOS demo. */
export function createSeedState() {
  const users = [
    { id: 'manager', name: 'آرمان رضایی', email: 'manager@arios.example', role: 'manager', department: 'مدیریت' },
    { id: 'worker', name: 'علی رضایی', email: 'ali@arios.example', role: 'worker', department: 'فنی و شبکه', skill: 'نصب دوربین و شبکه', hourlyRate: 150000, rateHistory: [{ effectiveDate: '2026-01-01', hourlyRate: 150000 }] },
    { id: 'worker2', name: 'مهدی احمدی', email: 'mehdi@arios.example', role: 'worker', department: 'فنی و شبکه', skill: 'کابل‌کشی و تست', hourlyRate: 130000, rateHistory: [{ effectiveDate: '2026-01-01', hourlyRate: 130000 }] },
    { id: 'worker3', name: 'سارا موسوی', email: 'sara@arios.example', role: 'worker', department: 'برق و رسانه', skill: 'برق و هماهنگی اجرا', hourlyRate: 170000, rateHistory: [{ effectiveDate: '2026-01-01', hourlyRate: 170000 }] },
    { id: 'customer', name: 'نیما شریفی', email: 'aftab@customer.example', role: 'customer' },
    { id: 'customer2', name: 'نگار کریمی', email: 'pars@customer.example', role: 'customer' },
  ];
  const phases = (prefix, values) => ['طراحی و برنامه‌ریزی', 'تأمین و اجرا', 'تست و تحویل'].map((name, index) => ({ id: `${prefix}_phase${index + 1}`, name, progress: values[index] }));
  const projects = [
    { id: 'p1', name: 'مجتمع آفتاب', type: 'CCTV', customerId: 'customer', memberIds: ['worker', 'worker2'], contactIds: ['manager'], location: 'تهران، سعادت‌آباد', status: 'active', progress: 75, budget: 65000000, contractAmount: 88000000, startDate: '2026-10-01', endDate: '2026-10-28', description: 'نصب ۸ دوربین تحت شبکه، کابل‌کشی و راه‌اندازی ضبط و دسترسی مجاز.', phases: phases('p1', [100, 85, 40]), cover: 'building', clientNote: '۶ دوربین راه‌اندازی شده؛ تست نهایی و آموزش بهره‌برداری در مرحله بعد است.' },
    { id: 'p2', name: 'همایش ایده‌پرداز', type: 'event', customerId: null, memberIds: ['worker2', 'worker3'], location: 'تهران، سالن همایش میلاد', status: 'attention', progress: 40, budget: 120000000, contractAmount: 175000000, startDate: '2026-10-10', endDate: '2026-11-02', description: 'هماهنگی عوامل، نور و صدا و اجرای همایش سالانه.', phases: phases('p2', [100, 20, 0]), cover: 'event', clientNote: 'برنامه اجرایی در حال نهایی‌سازی است.' },
    { id: 'p3', name: 'ساختمان پارس', type: 'electric', customerId: 'customer2', memberIds: ['worker', 'worker3'], contactIds: ['manager'], location: 'تهران، نیاوران', status: 'active', progress: 90, budget: 68000000, contractAmount: 95000000, startDate: '2026-09-15', endDate: '2026-10-25', description: 'تکمیل برق مشاعات و تابلوها، تست ایمنی و تحویل مدارک.', phases: phases('p3', [100, 100, 70]), cover: 'electric', clientNote: 'تست نهایی تابلو برق و تحویل در برنامه این هفته است.' },
    { id: 'p4', name: 'کمپین رسانه‌ای یارا', type: 'media', customerId: null, memberIds: ['worker3'], location: 'تهران، استودیو آریوس', status: 'active', progress: 55, budget: 35000000, contractAmount: 58000000, startDate: '2026-10-05', endDate: '2026-11-05', description: 'تولید محتوای تصویری، تدوین و آماده‌سازی کمپین معرفی.', phases: phases('p4', [100, 65, 0]), cover: 'media', clientNote: 'نسخه اولیه محتوای تصویری در حال تدوین است.' },
  ];
  const reports = [
    { id: 'r1', projectId: 'p1', workerId: 'worker', date: '2026-10-15', start: '08:00', end: '14:00', breakMinutes: 30, description: 'نصب و تنظیم چهار دوربین ورودی و پارکینگ.', output: '۴ دوربین تست و راه‌اندازی شد.', status: 'approved', minutes: 330, createdAt: '2026-10-15T11:00:00.000Z', version: 2, rate: 150000, laborCost: 825000, reviewedBy: 'manager', reviewNote: 'تست تصویر تأیید شد.' },
    { id: 'r2', projectId: 'p1', workerId: 'worker2', date: '2026-10-17', start: '09:00', end: '13:30', breakMinutes: 30, description: 'کابل‌کشی طبقه دوم و تست اتصالات شبکه.', output: '۹۰ متر کابل و ۶ اتصال تست شد.', status: 'submitted', minutes: 240, createdAt: '2026-10-17T10:10:00.000Z', version: 1, rate: 130000, laborCost: 0 },
    { id: 'r3', projectId: 'p3', workerId: 'worker3', date: '2026-10-16', start: '08:30', end: '12:30', breakMinutes: 0, description: 'نصب ماژول‌های تابلو و کنترل مدارهای مشاعات.', output: '۱۲ ماژول نصب و ۸ مدار کنترل شد.', status: 'approved', minutes: 240, createdAt: '2026-10-16T09:15:00.000Z', version: 2, rate: 170000, laborCost: 680000, reviewedBy: 'manager', reviewNote: '' },
    { id: 'r4', projectId: 'p2', workerId: 'worker2', date: '2026-10-18', start: '09:00', end: '11:00', breakMinutes: 0, description: 'بازدید سالن و بررسی جایگاه نور و صدا.', output: 'چک‌لیست تجهیزات و نقشه اولیه آماده شد.', status: 'submitted', minutes: 120, createdAt: '2026-10-18T07:45:00.000Z', version: 1, rate: 130000, laborCost: 0 },
  ];
  return {
    schemaVersion: 1, users, projects, reports,
    materials: [
      { id: 'm1', projectId: 'p1', name: 'دوربین تحت شبکه', quantity: 8, unit: 'عدد', unitPrice: 3600000, clientVisible: true, date: '2026-10-12', inventoryId: 'inv1' },
      { id: 'm2', projectId: 'p1', name: 'کابل شبکه Cat6', quantity: 180, unit: 'متر', unitPrice: 28000, clientVisible: true, date: '2026-10-15', inventoryId: 'inv2' },
      { id: 'm3', projectId: 'p1', name: 'ابزار و ملزومات داخلی', quantity: 1, unit: 'بسته', unitPrice: 750000, clientVisible: false, date: '2026-10-15' },
      { id: 'm4', projectId: 'p3', name: 'ماژول تابلو برق', quantity: 12, unit: 'عدد', unitPrice: 1850000, clientVisible: true, date: '2026-10-16', inventoryId: 'inv3' },
    ],
    invoices: [
      { id: 'i1', projectId: 'p1', title: 'پیش‌پرداخت قرارداد آفتاب', amount: 40000000, paid: 40000000, dueDate: '2026-10-05', status: 'paid' },
      { id: 'i2', projectId: 'p1', title: 'مرحله تأمین و نصب تجهیزات', amount: 48000000, paid: 15000000, dueDate: '2026-10-22', status: 'issued' },
      { id: 'i3', projectId: 'p3', title: 'اجرای برق ساختمان پارس', amount: 95000000, paid: 45000000, dueDate: '2026-10-25', status: 'issued' },
    ],
    messages: [
      { id: 'msg1', projectId: 'p1', authorId: 'manager', text: 'سلام، پیشرفت و صورت‌حساب‌های پروژه از این پنل قابل پیگیری است.', internal: false, createdAt: '2026-10-16T08:00:00.000Z' },
      { id: 'msg2', projectId: 'p1', authorId: 'customer', text: 'ممنون. لطفاً زمان آموزش کار با دستگاه ضبط را هماهنگ کنید.', internal: false, createdAt: '2026-10-16T09:10:00.000Z' },
      { id: 'msg3', projectId: 'p1', authorId: 'worker', text: 'تیم اجرا: دو آداپتور برای تکمیل نصب نیاز است.', internal: true, createdAt: '2026-10-17T10:30:00.000Z' },
      { id: 'msg4', projectId: 'p3', authorId: 'manager', text: 'تست نهایی تابلوها برای هفته جاری هماهنگ شده است.', internal: false, createdAt: '2026-10-17T07:00:00.000Z' },
    ],
    tickets: [
      { id: 't1', projectId: 'p1', authorId: 'customer', subject: 'هماهنگی دسترسی تصاویر روی موبایل', description: 'برای مشاهده تصاویر در شبکه داخلی راهنمایی می‌خواهم.', status: 'in_progress', priority: 'normal', createdAt: '2026-10-17T09:00:00.000Z', replies: [{ id: 'tr1', authorId: 'manager', text: 'در زمان تحویل، دسترسی مجاز و آموزش روی موبایل شما تنظیم می‌شود.', createdAt: '2026-10-17T09:25:00.000Z' }] },
      { id: 't2', projectId: 'p3', authorId: 'customer2', subject: 'هماهنگی زمان بازدید نهایی', description: 'لطفاً زمان حضور کارشناس برای تست نهایی را اعلام کنید.', status: 'open', priority: 'normal', createdAt: '2026-10-18T07:00:00.000Z', replies: [] },
    ],
    inventory: [
      { id: 'inv1', name: 'دوربین تحت شبکه', unit: 'عدد', quantity: 25, minQuantity: 8, unitPrice: 3600000 },
      { id: 'inv2', name: 'کابل شبکه Cat6', unit: 'متر', quantity: 500, minQuantity: 150, unitPrice: 28000 },
      { id: 'inv3', name: 'ماژول تابلو برق', unit: 'عدد', quantity: 20, minQuantity: 5, unitPrice: 1850000 },
      { id: 'inv4', name: 'آداپتور دوربین', unit: 'عدد', quantity: 3, minQuantity: 10, unitPrice: 350000 },
    ],
    receipts: [
      { id: 'rc1', invoiceId: 'i1', projectId: 'p1', amount: 40000000, reference: 'DEMO-AFTAB-001', method: 'manual', recordedBy: 'manager', createdAt: '2026-10-05T08:00:00.000Z' },
      { id: 'rc2', invoiceId: 'i2', projectId: 'p1', amount: 15000000, reference: 'DEMO-AFTAB-002', method: 'manual', recordedBy: 'manager', createdAt: '2026-10-14T08:00:00.000Z' },
      { id: 'rc3', invoiceId: 'i3', projectId: 'p3', amount: 45000000, reference: 'DEMO-PARS-001', method: 'manual', recordedBy: 'manager', createdAt: '2026-10-01T08:00:00.000Z' },
    ],
    audit: [{ id: 'a1', actorId: 'manager', action: 'demo.seed', entityId: 'p1', createdAt: '2026-10-18T06:00:00.000Z', description: 'اطلاعات ساختگی برای نمایش مستقل آریوس آماده شد.' }],
  };
}
