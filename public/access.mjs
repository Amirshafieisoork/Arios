import {hasPermission} from './permissions.mjs';
/** Navigation is presentation only; the API independently enforces capabilities. */
export const roleLabels = {manager:'مدیر فضای کار',worker:'همکار اجرایی',customer:'مشتری آریوس',warehouse:'انباردار',accountant:'حسابدار'};
export const assignableRoles = ['worker','customer','warehouse','accountant'];
const roleOf = user => typeof user === 'string' ? user : user?.role;
export function landingPage(user) {
  const role=roleOf(user),preferred=role==='warehouse'?'inventory':role==='accountant'?'finance':'dashboard';
  if(typeof user==='string'||allowedPortalPage(preferred,user))return preferred;
  return ['reports','projects','inventory','finance','settings'].find(page=>allowedPortalPage(page,user))||'settings';
}
function legacyAllowedPortalPage(page, role) {
  if (role === 'warehouse') return ['inventory','settings'].includes(page);
  if (role === 'accountant') return ['finance','reports','project','settings'].includes(page);
  if (['team','analytics','leads','customers','management'].includes(page)) return role === 'manager';
  if (['calendar','documents'].includes(page)) return ['manager','worker','customer'].includes(role);
  if (['inventory','reports','voice'].includes(page)) return ['manager','worker'].includes(role);
  if (page === 'finance') return ['manager','customer'].includes(role);
  return ['manager','worker','customer'].includes(role);
}
export function allowedPortalPage(page,user) {
  if(typeof user==='string')return legacyAllowedPortalPage(page,user);
  const role=roleOf(user),can=key=>hasPermission(user,key),staff=['manager','worker','warehouse','accountant'].includes(role);
  if(!staff&&role!=='customer'||user?.deletedAt)return false;
  if(page==='settings'||page==='notifications')return true;
  if(page==='inventory')return ['inventory.view','inventory.create','inventory.edit','inventory.archive','inventory.issue'].some(can);
  if(page==='projects')return can('projects.view')||can('projects.create');
  if(page==='project')return can('projects.view')||can('reports.review');
  if(page==='reports')return staff;
  if(page==='finance')return can('finance.view')&&can('projects.prices');
  if(page==='team'||page==='customers')return can('people.manage');
  if(page==='management')return ['projects.edit','projects.archive','inventory.edit','inventory.archive','reports.manage','finance.manage','messages.manage','catalogs.manage'].some(can);
  if(page==='voice')return can('voice.use')||can('voice.manage');
  if(page==='documents')return can('documents.view')||can('documents.upload')||can('documents.manage');
  if(page==='calendar')return can('projects.view')||can('tasks.manage');
  if(page==='messages')return can('messages.send')||can('messages.manage');
  if(page==='support')return staff||can('support.submit')||can('support.manage')||can('support.assign');
  if(page==='analytics')return role==='manager'&&can('finance.view')&&can('projects.prices');
  if(page==='leads')return role==='manager'&&can('people.manage');
  if(page==='assistant')return can('projects.view');
  if(page==='dashboard')return ['manager','worker','customer'].includes(role);
  return false;
}
function legacyPortalNavigation(role) {
  if (role === 'warehouse') return {main:[['inventory','انبار و مصرف پروژه','inventory']],links:[]};
  if (role === 'accountant') return {main:[['finance','حسابداری و صورت‌حساب','finance'],['reports','گزارش تفصیلی و تأییدها','reports']],links:[]};
  return {
    main:[['dashboard',role === 'customer' ? 'نمای کلی من' : 'داشبورد','dashboard'],['projects',role === 'customer' ? 'پروژه‌های من' : 'پروژه‌ها','projects'],
      ...(role !== 'customer' ? [['reports',role === 'worker' ? 'گزارش و مأموریت من' : 'گزارش‌ها و تأییدها','reports'],['voice','صندوق ویس‌ها','assistant'],['inventory',role === 'worker' ? 'مصرف و برگشت کالا' : 'تجهیزات و انبار','inventory']] : []),
      ...(role === 'manager' ? [['management','ویرایش و بایگانی','settings'],['team','افراد و همکاری','team'],['customers','مشتریان','team'],['leads','درخواست‌های مشاوره','support']] : []),
      ...(['manager','customer'].includes(role) ? [['finance',role === 'customer' ? 'صورت‌حساب و پرداخت' : 'حسابداری','finance']] : [])],
    links:[['calendar','تقویم و برنامه‌ریزی','calendar'],['documents','مدارک و فایل‌ها','reports'],['messages','گفت‌وگوها','messages'],['support','مرکز پشتیبانی','support'],['assistant','دستیار آریوس','assistant'],['notifications','مرکز پیگیری','bell']],
  };
}
export function portalNavigation(user) {
  if(typeof user==='string')return legacyPortalNavigation(user);
  const role=roleOf(user),all=legacyPortalNavigation(role==='customer'?'customer':'manager');
  if(role!=='customer'){
    all.main=all.main.map(row=>row[0]==='reports'?[row[0],'گزارش‌ها و وظایف من',row[2]]:row);
    if(role==='worker')all.main=all.main.map(row=>row[0]==='dashboard'?[row[0],'فضای کار من',row[2]]:row);
  }
  return {main:all.main.filter(([page])=>allowedPortalPage(page,user)),links:all.links.filter(([page])=>allowedPortalPage(page,user))};
}
