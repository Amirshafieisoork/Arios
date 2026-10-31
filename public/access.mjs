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

/**
 * Every destination is listed once, inside the group where a user would look for it.
 * `analytics` is intentionally absent: it is a drill-down from «گزارش‌ها و تأییدها», not a top-level section.
 */
const PORTAL_GROUPS = {
  manager: [
    ['کار روزانه', [
      ['dashboard', 'داشبورد', 'dashboard'],
      ['projects', 'پروژه‌ها', 'projects'],
      ['reports', 'گزارش‌ها و تأییدها', 'reports'],
      ['calendar', 'تقویم و برنامه‌ریزی', 'calendar'],
      ['voice', 'ویس‌ها و گزارش صوتی', 'assistant'],
    ]],
    ['تیم و منابع', [
      ['team', 'افراد و همکاری', 'team'],
      ['inventory', 'انبار و مصرف', 'inventory'],
      ['documents', 'مدارک پروژه‌ها', 'file'],
    ]],
    ['مالی و مشتریان', [
      ['finance', 'حسابداری و صورت‌حساب', 'finance'],
      ['customers', 'مشتریان و فروش', 'team'],
      ['leads', 'درخواست‌های مشاوره', 'inbox'],
    ]],
    ['گفت‌وگو و پیگیری', [
      ['messages', 'گفت‌وگوهای پروژه', 'messages'],
      ['support', 'پشتیبانی', 'support'],
      ['notifications', 'مرکز پیگیری', 'bell'],
      ['assistant', 'دستیار آریوس', 'assistant'],
    ]],
    ['ابزارهای مدیر', [
      ['management', 'ویرایش و بایگانی داده‌ها', 'database'],
    ]],
  ],
  worker: [
    ['کار من', [
      ['dashboard', 'فضای کار من', 'dashboard'],
      ['projects', 'پروژه‌های من', 'projects'],
      ['reports', 'گزارش و مأموریت من', 'reports'],
      ['voice', 'ویس‌ها و گزارش صوتی', 'assistant'],
      ['inventory', 'مصرف و برگشت کالا', 'inventory'],
    ]],
    ['همراهی', [
      ['calendar', 'تقویم و برنامه‌ریزی', 'calendar'],
      ['documents', 'مدارک پروژه‌ها', 'file'],
      ['messages', 'گفت‌وگوهای پروژه', 'messages'],
      ['support', 'پشتیبانی', 'support'],
      ['notifications', 'مرکز پیگیری', 'bell'],
      ['assistant', 'دستیار آریوس', 'assistant'],
    ]],
  ],
  customer: [
    ['پروژه‌های من', [
      ['dashboard', 'نمای کلی من', 'dashboard'],
      ['projects', 'پروژه‌های من', 'projects'],
      ['finance', 'صورت‌حساب و پرداخت', 'finance'],
      ['calendar', 'تقویم و برنامه‌ریزی', 'calendar'],
    ]],
    ['ارتباط با تیم آریوس', [
      ['documents', 'مدارک پروژه‌ها', 'file'],
      ['messages', 'گفت‌وگو با تیم', 'messages'],
      ['support', 'پشتیبانی', 'support'],
      ['notifications', 'مرکز پیگیری', 'bell'],
      ['assistant', 'دستیار آریوس', 'assistant'],
    ]],
  ],
  accountant: [
    ['مالی', [
      ['finance', 'حسابداری و صورت‌حساب', 'finance'],
      ['reports', 'گزارش تفصیلی و تأییدها', 'reports'],
    ]],
  ],
  warehouse: [
    ['انبار', [
      ['inventory', 'انبار و مصرف پروژه', 'inventory'],
    ]],
  ],
};

/** Grouped destinations for the sidebar, in display order. */
export function portalGroups(role) {
  const groups = PORTAL_GROUPS[role] || PORTAL_GROUPS.customer;
  return groups.map(([title, items]) => ({title, items:items.map(item => [...item])}));
}

/** `main` stays a flat list so existing access checks and tests keep a single source of truth. */
export function portalNavigation(role) {
  const groups = portalGroups(role);
  return {groups, main:groups.flatMap(group => group.items), links:[]};
}
