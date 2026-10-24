/** Derived views only. Source arrays are already restricted by the server's role snapshot. */
const rows = value => Array.isArray(value) ? value : [];
const amount = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {year:'numeric',month:'2-digit',timeZone:'Asia/Tehran'});
const label = new Intl.DateTimeFormat('fa-IR', {month:'short',year:'numeric',timeZone:'Asia/Tehran'});
function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const result = new Date(value.length === 10 ? value + 'T12:00:00Z' : value);
  return Number.isFinite(result.getTime()) ? result : null;
}
function monthKey(value) {
  const date = value instanceof Date ? value : dateValue(value);
  if (!date) return '';
  const p = Object.fromEntries(parts.formatToParts(date).map(part => [part.type,part.value]));
  return p.year + '-' + p.month;
}
export function recentMonths(today = new Date().toISOString().slice(0,10)) {
  const end = dateValue(today) || new Date(), seen = new Map();
  for (let day = 0; seen.size < 6 && day < 200; day++) {
    const date = new Date(end.getTime() - day * 86400000), key = monthKey(date);
    if (!seen.has(key)) seen.set(key,{key,label:label.format(date)});
  }
  return [...seen.values()].reverse();
}
export function financialSeries(state, today, projectId = '') {
  const series = recentMonths(today).map(month => ({...month,received:0,cost:0}));
  const byMonth = new Map(series.map(month => [month.key,month]));
  const allowed = row => !projectId || row.projectId === projectId;
  for (const receipt of rows(state.receipts).filter(allowed)) {
    const month = byMonth.get(monthKey(receipt.createdAt || receipt.date));
    if (month) month.received += amount(receipt.amount);
  }
  for (const material of rows(state.materials).filter(allowed)) {
    const month = byMonth.get(monthKey(material.date));
    if (month) month.cost += amount(material.quantity) * amount(material.unitPrice);
  }
  for (const report of rows(state.reports).filter(row => allowed(row) && row.status === 'approved')) {
    const month = byMonth.get(monthKey(report.date));
    if (month) month.cost += amount(report.laborCost);
  }
  return series;
}
export function performanceSeries(state, today) {
  const series = recentMonths(today).map(month => ({...month,approved:0,pending:0}));
  const byMonth = new Map(series.map(month => [month.key,month]));
  for (const report of rows(state.reports)) {
    const month = byMonth.get(monthKey(report.date));
    if (month && ['approved','submitted'].includes(report.status)) month[report.status === 'approved' ? 'approved' : 'pending'] += amount(report.minutes) / 60;
  }
  return series;
}
export function projectTypeCounts(state) {
  const counts = new Map();
  for (const project of rows(state.projects)) {
    const raw = String(project.type || 'سایر').trim() || 'سایر';
    const type = ({cctv:'نظارت تصویری و شبکه',network:'نظارت تصویری و شبکه',electric:'برق و هوشمندسازی',event:'اجرای رویداد',media:'رسانه و محتوا',support:'پشتیبانی فنی',other:'سایر خدمات'})[raw.toLowerCase()] || raw;
    counts.set(type,(counts.get(type)||0)+1);
  }
  return [...counts].map(([name,count]) => ({name,count})).sort((a,b)=>b.count-a.count);
}
export function teamSummary(state) {
  return rows(state.users).filter(user=>user.role==='worker'&&!user.deletedAt).map(user=>{
    const projects = rows(state.projects).filter(project=>rows(project.memberIds).includes(user.id));
    const reports = rows(state.reports).filter(report=>report.workerId===user.id&&report.status==='approved');
    return {user,projects,activeProjects:projects.filter(project=>project.status!=='completed').length,hours:reports.reduce((total,report)=>total+amount(report.minutes)/60,0)};
  });
}
function csvCell(value) {
  let result = String(value ?? '');
  // Spreadsheet software treats formulas even inside quoted CSV cells as executable.
  if (/^[\s]*[=+\-@\t\r]/.test(result)) result = "'" + result;
  return '"' + result.replaceAll('"','""') + '"';
}
export function analyticsCSV(kind, state) {
  if (state.user?.role !== 'manager') throw new Error('خروجی تحلیل فقط برای مدیر فعال است.');
  let table;
  const projectName = id => rows(state.projects).find(project=>project.id===id)?.name || '';
  if (kind === 'projects') table = [['پروژه','نوع','محل','وضعیت','پیشرفت درصد','شروع','پایان'],...rows(state.projects).map(p=>[p.name,p.type,p.location,p.status,p.progress,p.startDate,p.endDate])];
  else if (kind === 'finance') table = [['پروژه','عنوان صورت‌حساب','مبلغ تومان','وصول شده تومان','مانده تومان','سررسید','وضعیت'],...rows(state.invoices).map(i=>[projectName(i.projectId),i.title,i.amount,i.paid,amount(i.amount)-amount(i.paid),i.dueDate,i.status])];
  else if (kind === 'team') table = [['همکار','تخصص','پروژه‌های در جریان','پروژه‌های تخصیص یافته','ساعت تأییدشده'],...teamSummary(state).map(row=>[row.user.name,row.user.skill,row.activeProjects,row.projects.map(p=>p.name).join('، '),row.hours])];
  else if (kind === 'equipment') table = [['کالا','واحد','موجودی','حداقل موجودی','بهای واحد تومان','ارزش موجودی تومان'],...rows(state.inventory).map(i=>[i.name,i.unit,i.quantity,i.minQuantity,i.unitPrice,amount(i.quantity)*amount(i.unitPrice)])];
  else throw new Error('نوع خروجی معتبر نیست.');
  return '\ufeff' + table.map(row=>row.map(csvCell).join(',')).join('\r\n');
}
