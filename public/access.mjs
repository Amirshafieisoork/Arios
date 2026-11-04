/** Navigation is presentation only; the API independently enforces these roles. */
export const roleLabels = {manager:'مدیر فضای کار',worker:'همکار اجرایی',customer:'مشتری آریوس',warehouse:'انباردار',accountant:'حسابدار'};
export const assignableRoles = ['worker','customer','warehouse','accountant'];
export const landingPage = role => role === 'warehouse' ? 'inventory' : role === 'accountant' ? 'finance' : 'dashboard';
export function allowedPortalPage(page, role) {
  if (role === 'warehouse') return ['inventory','settings'].includes(page);
  if (role === 'accountant') return ['finance','reports','project','settings'].includes(page);
  if (['team','analytics','leads','customers','management'].includes(page)) return role === 'manager';
  if (['calendar','documents'].includes(page)) return ['manager','worker','customer'].includes(role);
  if (['inventory','reports','voice'].includes(page)) return ['manager','worker'].includes(role);
  if (page === 'finance') return ['manager','customer'].includes(role);
  return ['manager','worker','customer'].includes(role);
}
export function portalNavigation(role) {
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
