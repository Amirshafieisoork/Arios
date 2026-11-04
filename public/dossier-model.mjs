/** Project worksheet data is separate from payroll, receipts and invoice accounting. */
export class DossierError extends Error {
  constructor(message, status = 400, code = 'INVALID_DOSSIER') { super(message); this.name = 'DossierError'; this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new DossierError(message, status, code); };
const list = value => Array.isArray(value) ? value : [];
const clone = value => JSON.parse(JSON.stringify(value));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, clone(value[key])]));
const maxMoney = 1_000_000_000_000;
const note = (value, label, max = 2000) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} معتبر نیست.`);
  return value.trim();
};
const requiredText = (value, label, max) => { const result = note(value, label, max); if (!result) fail(`${label} را وارد کنید.`); return result; };
const money = (value, label) => { if (!Number.isSafeInteger(value) || value < 0 || value > maxMoney) fail(`${label} باید مبلغ صحیح و معتبر به تومان باشد.`); return value; };
export function dossierDate(value, optional = true) {
  if ((value === undefined || value === null || value === '') && optional) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('تاریخ معتبر نیست.');
  const parsed = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('تاریخ معتبر نیست.');
  return value;
}
export function workItemTotal(quantity, unitRate) {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.000001) fail('مقدار کار باید مثبت و حداکثر سه رقم اعشار داشته باشد.');
  money(unitRate, 'فی اجرت');
  const total = (BigInt(Math.round(quantity * 1000)) * BigInt(unitRate) + 500n) / 1000n;
  if (total > BigInt(maxMoney)) fail('مبلغ کل اجرت از محدودهٔ مجاز بیشتر است.');
  return Number(total);
}
const rowId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : crypto.randomUUID();

export function applyDossierAction(state, actor, action, payload) {
  if (action !== 'project.dossier.save') fail('عملیات فرم شناخته‌شده نیست.', 400, 'UNKNOWN_ACTION');
  const user = list(state.users).find(person => person.id === actor?.id && !person.deletedAt);
  if (!user || user.role !== actor?.role || !['manager', 'accountant'].includes(user.role)) fail('ثبت اطلاعات مالی فرم فقط برای مدیر و حسابدار مجاز است.', 403, 'FORBIDDEN');
  const project = list(state.projects).find(item => item.id === payload?.projectId);
  if (!project) fail('پروژه در دسترس نیست.', 404, 'PROJECT_NOT_FOUND');
  if (['submitted', 'approved'].includes(project.dossierSubmission?.status)) fail('نسخهٔ ارسال‌شده قفل است؛ ابتدا نتیجهٔ بررسی یا نسخهٔ تازه را ثبت کنید.', 409, 'DOSSIER_LOCKED');
  const previous = project.dossier || {}, version = Number.isSafeInteger(previous.version) ? previous.version : 0;
  if (!Number.isSafeInteger(payload.version) || payload.version !== version) fail('فرم هم‌زمان تغییر کرده است؛ آخرین نسخه را باز کنید.', 409, 'VERSION_CONFLICT');
  if (!Array.isArray(payload.workItems) || payload.workItems.length > 100 || !Array.isArray(payload.staffAllocations) || payload.staffAllocations.length > 100) fail('حداکثر ۱۰۰ ردیف در هر بخش ثبت کنید.');
  const rowIds = new Set();
  const uniqueRowId = value => { const valueId = rowId(value); if (rowIds.has(valueId)) fail('شناسهٔ ردیف‌ها نباید تکراری باشد.'); rowIds.add(valueId); return valueId; };
  const workItems = payload.workItems.map(row => {
    if (!row || typeof row !== 'object') fail('ردیف اجرت معتبر نیست.');
    const quantity = row.quantity, unitRate = row.unitRate;
    return {id: uniqueRowId(row.id), description: requiredText(row.description, 'شرح کار', 1000), quantity, unit: requiredText(row.unit, 'واحد کار', 40), unitRate, total: workItemTotal(quantity, unitRate)};
  });
  const people = new Set();
  const staffAllocations = payload.staffAllocations.map(row => {
    if (!row || typeof row !== 'object' || typeof row.userId !== 'string' || people.has(row.userId)) fail('هر همکار را فقط یک بار در تفکیک اجرت ثبت کنید.');
    people.add(row.userId);
    const person = list(state.users).find(item => item.id === row.userId);
    const historical = list(previous.staffAllocations).some(item => item.userId === row.userId);
    if (!person || person.role !== 'worker' || (!historical && (person.deletedAt || !list(project.memberIds).includes(person.id)))) fail('همکار انتخاب‌شده عضو فعال این پروژه نیست.', 403, 'INVALID_PROJECT_MEMBER');
    const wage = money(row.wage, 'اجرت همکار'), bonus = money(row.bonus ?? 0, 'پاداش'), paidAmount = money(row.paidAmount ?? 0, 'حقوق پرداخت‌شده');
    if (paidAmount > wage + bonus) fail('مبلغ پرداخت‌شده نباید از اجرت و پاداش بیشتر باشد.');
    const paymentReference = note(row.paymentReference, 'مرجع پرداخت', 120), paymentDate = dossierDate(row.paymentDate);
    if (paidAmount > 0 && (!paymentReference || !paymentDate)) fail('برای مبلغ پرداخت‌شده، تاریخ و مرجع پرداخت دستی را ثبت کنید.');
    return {id: uniqueRowId(row.id), userId: person.id, wage, bonus, paidAmount, paymentReference, paymentDate, notes: note(row.notes, 'توضیحات همکار', 1000)};
  });
  const declaredLaborAmount = payload.declaredLaborAmount === null || payload.declaredLaborAmount === undefined || payload.declaredLaborAmount === '' ? null : money(payload.declaredLaborAmount, 'اجرت اعلام‌شده');
  const finalLaborAmount = payload.finalLaborAmount === null || payload.finalLaborAmount === undefined || payload.finalLaborAmount === '' ? null : money(payload.finalLaborAmount, 'اجرت توافق‌شده');
  const total = workItems.reduce((sum, row) => sum + row.total, 0), allocated = staffAllocations.reduce((sum, row) => sum + row.wage + row.bonus, 0);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(allocated)) fail('مجموع مبالغ از محدودهٔ مجاز بیشتر است.');
  if (finalLaborAmount !== null && allocated > finalLaborAmount) fail('تفکیک اجرت و پاداش از مبلغ توافق‌شده بیشتر است.');
  const updatedAt = new Date().toISOString();
  const history = list(previous.history).slice(-49).concat({version: version + 1, actorId: user.id, at: updatedAt, workTotal: total, declaredLaborAmount, finalLaborAmount, allocated, paidTotal: staffAllocations.reduce((sum, row) => sum + row.paidAmount, 0)});
  project.dossier = {version: version + 1, workItems, staffAllocations, declaredLaborAmount, finalLaborAmount, completionDate: dossierDate(payload.completionDate), completionNotes: note(payload.completionNotes, 'توضیحات پایان پروژه', 4000), notes: note(payload.notes, 'یادداشت فرم', 4000), updatedAt, updatedBy: user.id, history};
  return {id: project.id, dossier: safeDossierWorksheet(project.dossier, true)};
}

/** Explicit projections keep financial and future private fields out of operational approvals. */
export function safeDossierWorksheet(dossier, financial) {
  if (!financial || !dossier) return undefined;
  const result = pick(dossier, ['version', 'declaredLaborAmount', 'finalLaborAmount', 'completionDate', 'completionNotes', 'notes', 'updatedAt', 'updatedBy']);
  result.workItems = list(dossier.workItems).map(row => pick(row, ['id', 'description', 'quantity', 'unit', 'unitRate', 'total']));
  result.staffAllocations = list(dossier.staffAllocations).map(row => pick(row, ['id', 'userId', 'wage', 'bonus', 'paidAmount', 'paymentReference', 'paymentDate', 'notes']));
  result.history = list(dossier.history).map(row => pick(row, ['version', 'actorId', 'at', 'workTotal', 'declaredLaborAmount', 'finalLaborAmount', 'allocated', 'paidTotal']));
  return result;
}
const safeEvidenceReport = (report, financial) => ({...pick(report, ['id', 'projectId', 'workerId', 'date', 'start', 'end', 'breakMinutes', 'description', 'output', 'status', 'minutes', 'createdAt', 'version', 'reviewNote', 'reviewedBy', 'reviewedAt', ...(financial ? ['rate', 'laborCost'] : [])]), photoIds: list(report.photoIds).filter(id => typeof id === 'string').slice(0, 6), ...(report.location ? {location: pick(report.location, ['latitude', 'longitude', 'accuracy', 'capturedAt'])} : {})});
function safeDossierSummary(summary, financial) {
  const result = pick(summary, ['from', 'to', 'totalMinutes', 'approvedMinutes', 'materialItemCount', 'completionDate', 'completionNotes']);
  result.financial = Boolean(financial);
  result.project = pick(summary?.project, ['id', 'name', 'projectCode', 'customerCode', 'dossierCode', 'dossierTitle', 'projectManagerId', 'customerId', 'memberIds', 'startDate', 'endDate', 'description', 'clientNote']);
  result.project.reviewChain = list(summary?.project?.reviewChain).map(stage => pick(stage, ['label', 'userId']));
  result.customer = summary?.customer ? pick(summary.customer, ['id', 'name', ...(financial ? ['phone'] : [])]) : null;
  result.lead = summary?.lead ? pick(summary.lead, ['id', 'name', 'employeeCode']) : null;
  result.people = list(summary?.people).map(person => pick(person, ['id', 'name', 'employeeCode', 'deletedAt']));
  result.reports = list(summary?.reports).map(report => safeEvidenceReport(report, financial));
  result.days = list(summary?.days).map(day => ({...pick(day, ['date', 'minutes', 'approvedMinutes', 'memberIds']), reports: list(day.reports).map(report => safeEvidenceReport(report, financial))}));
  result.materials = list(summary?.materials).map(material => ({...pick(material, ['id', 'code', 'name', 'unit', 'quantity', ...(financial ? ['cost'] : [])]), days: list(material.days).map(day => pick(day, ['date', 'quantity']))}));
  if (financial) {
    Object.assign(result, pick(summary, ['workTotal', 'approvedLaborCost', 'materialCost']));
    result.worksheet = safeDossierWorksheet(summary?.worksheet, true) || {};
  }
  return result;
}
export function safeDossierSubmission(submission, financial) {
  if (!submission) return undefined;
  const result = pick(submission, ['id', 'version', 'status', 'from', 'to', 'createdAt', 'updatedAt', 'submittedAt', 'submittedBy', 'reviewedAt', 'archivedAt', 'archivedBy', 'revisionReason']);
  if (submission.snapshot) result.snapshot = safeDossierSummary(submission.snapshot, financial);
  if (submission.approval) {
    result.approval = pick(submission.approval, ['cycle', 'currentStage', 'projectCode']);
    result.approval.stages = list(submission.approval.stages).map(stage => pick(stage, ['label', 'userId', 'userName', 'status', 'reviewedBy', 'reviewedByName', 'reviewedAt', 'note']));
    result.approval.history = list(submission.approval.history).map(event => pick(event, ['id', 'cycle', 'action', 'actorId', 'actorName', 'at', 'stageIndex', 'note', 'fromUserId', 'fromUserName', 'toUserId', 'toUserName', 'emergency']));
  }
  return result;
}

const matches = (date, from, to) => typeof date === 'string' && (!from || date >= from) && (!to || date <= to);
const rounded = value => Math.round(value * 1000) / 1000;
export function buildDossierSummary(state, projectId, {from = '', to = ''} = {}) {
  dossierDate(from); dossierDate(to);
  if (from && to && from > to) fail('تاریخ پایان دوره باید پس از شروع باشد.');
  const user = state?.user, project = list(state?.projects).find(item => item.id === projectId);
  if (!project || !['manager', 'accountant', 'worker'].includes(user?.role)) fail('گزارش تفصیلی در دسترس نیست.', 403, 'FORBIDDEN');
  const reviewer = list(project.reviewChain).some(stage => stage.userId === user.id) || list(project.dossierSubmission?.approval?.stages).some(stage => stage.userId === user.id) || list(project.dossierSubmissionHistory).some(submission => list(submission.approval?.stages).some(stage => stage.userId === user.id));
  if (user.role === 'worker' && !list(project.memberIds).includes(user.id) && project.projectManagerId !== user.id && !reviewer) fail('پروژه در دسترس نیست.', 403, 'FORBIDDEN');
  const financial = ['manager', 'accountant'].includes(user.role);
  const reports = list(state.reports).filter(report => !report.archivedAt && report.projectId === project.id && matches(report.date, from, to)).map(report => {
    return safeEvidenceReport(report, financial);
  }).sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const days = [];
  for (const report of reports) {
    let day = days.find(day => day.date === report.date);
    if (!day) { day = {date: report.date, reports: [], minutes: 0, approvedMinutes: 0, memberIds: []}; days.push(day); }
    day.reports.push(report); day.minutes += Number(report.minutes) || 0;
    if (report.status === 'approved') day.approvedMinutes += Number(report.minutes) || 0;
    if (!day.memberIds.includes(report.workerId)) day.memberIds.push(report.workerId);
  }
  const items = new Map();
  for (const material of list(state.materials).filter(material => !material.archivedAt && material.projectId === project.id)) {
    const returns = list(material.returns), gross = Number.isFinite(material.originalQuantity) ? material.originalQuantity : (Number(material.quantity) || 0) + returns.reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0);
    const events = [{date: material.date, quantity: gross, kind: 'consume'}].concat(returns.map(entry => ({date: entry.date, quantity: -(Number(entry.quantity) || 0), kind: 'return'}))).filter(entry => matches(entry.date, from, to));
    if (!events.length) continue;
    const key = `${material.inventoryId || material.name}\u0000${material.unit}`;
    let row = items.get(key);
    if (!row) { const stock = list(state.inventory).find(stock => stock.id === material.inventoryId); row = {id: material.inventoryId || material.id, code: material.itemCode || material.inventoryCode || stock?.itemCode || stock?.code || stock?.sku || null, name: material.name, unit: material.unit, quantity: 0, days: []}; items.set(key, row); }
    for (const event of events) {
      row.quantity = rounded(row.quantity + event.quantity);
      let day = row.days.find(day => day.date === event.date);
      if (!day) { day = {date: event.date, quantity: 0}; row.days.push(day); }
      day.quantity = rounded(day.quantity + event.quantity);
    }
    if (financial) row.cost = (row.cost || 0) + events.reduce((sum, event) => sum + event.quantity * (Number(material.unitPrice) || 0), 0);
  }
  const materials = [...items.values()].map(row => ({...row, days: row.days.sort((a, b) => a.date.localeCompare(b.date)), ...(financial ? {cost: Math.round(row.cost || 0)} : {})}));
  const relevantIds = new Set([...list(project.memberIds), project.projectManagerId, project.customerId, ...list(project.reviewChain).map(stage => stage.userId), ...reports.map(report => report.workerId), ...list(project.dossier?.staffAllocations).map(row => row.userId)]);
  const people = list(state.users).filter(person => relevantIds.has(person.id)), customer = people.find(person => person.id === project.customerId), lead = people.find(person => person.id === project.projectManagerId);
  const result = {
    project: Object.fromEntries(['id','name','projectCode','customerCode','dossierCode','dossierTitle','projectManagerId','customerId','memberIds','startDate','endDate','description','clientNote','reviewChain'].filter(key => project[key] !== undefined).map(key => [key, clone(project[key])])), from, to, financial, reports, days, materials,
    customer: customer ? {id: customer.id, name: customer.name, ...(financial && customer.phone ? {phone: customer.phone} : {})} : null,
    lead: lead ? {id: lead.id, name: lead.name, employeeCode: lead.employeeCode || lead.personnelCode || null} : null,
    totalMinutes: days.reduce((sum, day) => sum + day.minutes, 0), approvedMinutes: days.reduce((sum, day) => sum + day.approvedMinutes, 0),
    materialItemCount: materials.length,
    completionDate: project.dossier?.completionDate || '', completionNotes: project.dossier?.completionNotes || '',
    people: people.map(person => ({id: person.id, name: person.name, employeeCode: person.employeeCode || person.personnelCode || null, deletedAt: person.deletedAt})),
  };
  if (financial) {
    const dossier = safeDossierWorksheet(project.dossier, true) || {};
    result.worksheet = dossier;
    result.workTotal = list(dossier.workItems).reduce((sum, row) => sum + workItemTotal(row.quantity, row.unitRate), 0);
    result.approvedLaborCost = reports.filter(report => report.status === 'approved').reduce((sum, report) => sum + (Number(report.laborCost) || 0), 0);
    result.materialCost = materials.reduce((sum, material) => sum + (material.cost || 0), 0);
  }
  return safeDossierSummary(result, financial);
}
