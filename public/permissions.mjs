/** Per-person capabilities. Only canonical server state is authority. */
import {primaryManager} from './management-roles.mjs';
const groups=[
 ['projects','پروژه‌ها',[['projects.view','مشاهدهٔ پروژه‌های مجاز'],['projects.create','تعریف پروژه'],['projects.edit','ویرایش پروژه'],['projects.archive','حذف و بازیابی پروژه'],['projects.prices','مشاهده و ویرایش قیمت‌های پروژه']]],
 ['inventory','انبار',[['inventory.view','مشاهدهٔ موجودی انبار'],['inventory.create','ثبت کالا'],['inventory.edit','ویرایش کالا'],['inventory.archive','حذف و بازیابی کالا'],['inventory.issue','ثبت مصرف و برگشت کالا'],['inventory.prices','مشاهده و ویرایش قیمت کالا']]],
 ['reports','گزارش و وظایف',[['reports.submit','ثبت گزارش کار'],['reports.review','تأیید گزارش در نوبت تعیین‌شده'],['reports.manage','ویرایش و بایگانی گزارش‌ها'],['tasks.manage','تعریف و ارجاع وظیفه']]],
 ['support','پشتیبانی',[['support.submit','ثبت درخواست پشتیبانی'],['support.manage','بررسی و تأیید پشتیبانی'],['support.assign','ارجاع تیکت به همکار']]],
 ['finance','مالی',[['finance.view','مشاهدهٔ اطلاعات مالی مجاز'],['finance.manage','ثبت و اصلاح اسناد مالی'],['finance.reverse','ابطال اسناد مالی با حفظ سابقه']]],
 ['people','افراد و تنظیمات',[['people.manage','مدیریت پروندهٔ افراد'],['permissions.manage','تعیین سطح دسترسی افراد'],['catalogs.manage','ویرایش دسته‌بندی‌ها']]],
 ['documents','مدارک و ارتباط',[['documents.view','مشاهدهٔ مدارک مجاز'],['documents.upload','افزودن فایل پروژه'],['documents.manage','ویرایش و حذف مدارک'],['messages.send','ارسال پیام پروژه'],['messages.manage','ویرایش و حذف پیام‌ها']]],
 ['services','اتصال‌ها',[['voice.use','استفاده از صندوق ویس'],['voice.manage','مدیریت ویس‌های تیم'],['integrations.manage','مدیریت اتصال‌ها'],['backups.manage','مدیریت نسخهٔ پشتیبان']]],
];
export const PERMISSION_GROUPS=Object.freeze(groups.map(([id,label,items])=>Object.freeze({id,label,items:Object.freeze(items.map(([key,label])=>Object.freeze({key,label})))})));
export const PERMISSION_KEYS=Object.freeze(PERMISSION_GROUPS.flatMap(group=>group.items.map(item=>item.key)));
const keys=new Set(PERMISSION_KEYS),roles=new Set(['manager','worker','warehouse','accountant','customer']);
const defaults={
 manager:PERMISSION_KEYS,
 worker:['projects.view','inventory.issue','reports.submit','reports.review','support.submit','documents.view','documents.upload','messages.send','voice.use'],
 warehouse:['projects.view','inventory.view','inventory.create','inventory.edit','inventory.archive','inventory.issue','inventory.prices','documents.view'],
 accountant:['projects.view','projects.prices','inventory.view','inventory.prices','reports.review','finance.view','finance.manage','documents.view'],
 customer:['projects.view','projects.prices','support.submit','finance.view','documents.view','messages.send'],
};
const customerKeys=new Set(defaults.customer);
const managerOnlyKeys=new Set(['people.manage','permissions.manage','integrations.manage','backups.manage','voice.manage']);
export const permissionRoleAllows=(role,key)=>keys.has(key)&&roles.has(role)&&(role!=='customer'||customerKeys.has(key))&&(!managerOnlyKeys.has(key)||role==='manager');
const fail=(message,status=400,code='INVALID_PERMISSIONS')=>{const error=new Error(message);error.status=status;error.code=code;throw error;};
export function permissionDefaults(role){return Object.fromEntries(PERMISSION_KEYS.map(key=>[key,(defaults[role]||[]).includes(key)]));}
export function normalizePermissions(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.has(key)||typeof value[key]!=='boolean'))fail('سطح دسترسی باید از گزینه‌های مشخص‌شده انتخاب شود.');
 return Object.fromEntries(Object.entries(value));
}
export function effectivePermissions(user,state){
 const canonical=Array.isArray(state?.users)?state.users.find(person=>person.id===user?.id):user;
 const result=permissionDefaults(canonical?.role);
 if(!canonical||canonical.deletedAt||!roles.has(canonical.role))return Object.fromEntries(PERMISSION_KEYS.map(key=>[key,false]));
 const primary=state?primaryManager(state)?.id===canonical.id:canonical.managementRole==='primary';
 if(primary)return permissionDefaults('manager');
 const overrides=canonical.permissionOverrides??canonical.permissions??{};
 for(const key of PERMISSION_KEYS)if(typeof overrides[key]==='boolean')result[key]=overrides[key];
 for(const key of PERMISSION_KEYS)if(!permissionRoleAllows(canonical.role,key))result[key]=false;
 return result;
}
export const hasPermission=(user,key,state)=>keys.has(key)&&effectivePermissions(user,state)[key]===true;
export function requirePermission(user,key,state){if(!hasPermission(user,key,state))fail('دسترسی این عملیات برای حساب شما فعال نیست.',403,'FORBIDDEN');}
export function applyPermissionOverrides(state,actor,target,input){
 requirePermission(actor,'permissions.manage',state);
 if(actor.role!=='manager')fail('تعیین سطح دسترسی فقط برای مدیر مجاز است.',403,'FORBIDDEN');
 const value=normalizePermissions(input);
 if(primaryManager(state)?.id===target.id){if(Object.values(value).some(allowed=>!allowed))fail('دسترسی کامل مدیر اصلی قابل محدودکردن نیست.',403,'PRIMARY_MANAGER_REQUIRED');return target;}
 if(target.role==='customer'&&Object.entries(value).some(([key,allowed])=>allowed&&!customerKeys.has(key)))fail('مجوز اجرایی را فقط به اعضای تیم بدهید.');
 if(Object.entries(value).some(([key,allowed])=>allowed&&!permissionRoleAllows(target.role,key)))fail('این مجوز ویژهٔ حساب مدیر است.',400,'ROLE_PERMISSION_REQUIRED');
 if(Object.entries(value).some(([key,allowed])=>allowed&&!hasPermission(actor,key,state)))fail('واگذاری دسترسی بیشتر از دسترسی خود مجاز نیست.',403,'FORBIDDEN');
 target.permissions={...(target.permissions||{}),...value};return target;
}
const collectionKeys={projects:'projects',inventory:'inventory',materials:'inventory',reports:'reports',tasks:'tasks',tickets:'support',invoices:'finance',receipts:'finance',messages:'messages'};
export function actionPermission(action,payload={}){
 if(action==='account.permissions.update')return 'permissions.manage';
 if(action==='account.primary-manager.transfer')return 'permissions.manage';
 if(action.startsWith('account.')||action==='worker.create'||action.startsWith('team.'))return 'people.manage';
 if(action.startsWith('catalog.'))return 'catalogs.manage';
 if(action==='finance.entry.reverse')return 'finance.reverse';
 if(action.startsWith('finance.')||action==='payment.record'||action==='invoice.create')return 'finance.manage';
 if(action==='personalStock.settle'||action.startsWith('personalStock.settlement.'))return 'finance.manage';
 if(action.startsWith('personalStock.'))return 'inventory.issue';
 if(action.startsWith('admin.record.')){const type=collectionKeys[payload.collection];return type==='projects'?'projects.'+(action.endsWith('.update')?'edit':'archive'):type==='inventory'?'inventory.'+(action.endsWith('.update')?'edit':'archive'):type==='reports'?'reports.manage':type==='tasks'?'tasks.manage':type==='support'?'support.manage':type==='finance'?'finance.manage':type==='messages'?'messages.manage':null;}
 if(action==='project.create')return 'projects.create';
 if(action==='project.update')return 'projects.edit';
 if(action.startsWith('customer-dossier.'))return action.endsWith('.create')?'projects.create':action.endsWith('.update')?'projects.edit':'projects.archive';
 if(action.startsWith('project.dossier.'))return action.endsWith('.review')?'reports.review':action.endsWith('.reassign')?'projects.edit':null;
 if(action==='task.create')return 'tasks.manage';
 if(action==='report.review')return 'reports.review';
 if(action==='report.update')return null;
 if(action.startsWith('report.'))return 'reports.submit';
 if(action==='inventory.create')return 'inventory.create';
 if(action==='inventory.update'||action==='inventory.receive')return 'inventory.edit';
 if(action==='inventory.archive'||action==='inventory.delete'||action==='inventory.restore')return 'inventory.archive';
 if(action==='inventory.consume'||action==='material.consume'||action==='material.return')return 'inventory.issue';
 if(action==='material.create')return 'inventory.issue';
 if(action==='message.send')return 'messages.send';
 if(action==='ticket.create')return 'support.submit';
 if(action==='ticket.status'||action==='ticket.approve'||action==='ticket.reject')return 'support.manage';
 if(action==='ticket.assign'||action==='ticket.cancel'||action==='ticket.unassign')return 'support.assign';
 return null;
}
export function assertActionPermission(user,action,payload,state){const key=actionPermission(action,payload);if(key)requirePermission(user,key,state);}

const monetaryKeys=new Set(['budget','contractAmount','laborCost','rate','hourlyRate','rateHistory','unitPrice','unitRate','amount','paid','total','wage','bonus','declaredWage','agreedWage','totalWages','totalMaterials','totalLabor','totalAmount','netAmount','balance','outstanding','cost','costs','totalCost','grandTotal','paymentAmount','settledAmount','advanceDeduction','approvedAllowances','earnedTotal']);
const moneyKey=key=>!/quantity$/i.test(key)&&(monetaryKeys.has(key)||/(?:price|amount|wage|payroll|payable|receivable|salary|deduction|balance|cost|cashflow|cashin|cashout|invoiced|received|issued|spent|returned|repaid|settled|recoveries|expenses)/i.test(key));
export function omitMoney(value){
 if(Array.isArray(value))return value.map(omitMoney);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!moneyKey(key)).map(([key,item])=>[key,(['permissions','permissionOverrides'].includes(key)&&item&&typeof item==='object'&&!Array.isArray(item)&&Object.entries(item).every(([permission,allowed])=>keys.has(permission)&&typeof allowed==='boolean'))?structuredClone(item):omitMoney(item)]));
 return value;
}
/** Scope is applied before this second pass; monetary restrictions cover every duplicated representation. */
export function redactProjectionPrices(snapshot,user,state){
 const result=structuredClone(snapshot),projectPrices=hasPermission(user,'projects.prices',state),stockPrices=hasPermission(user,'inventory.prices',state),finance=hasPermission(user,'finance.view',state);
 if(!projectPrices){
  for(const key of ['projects','reports','invoices','receipts','users','user','management','personalStock','employeeFinance'])if(result[key])result[key]=omitMoney(result[key]);
  if(result.materials&&!stockPrices)result.materials=omitMoney(result.materials);
  result.audit=[];
 }
 if(!stockPrices){
  for(const key of ['inventory','archivedInventory','stockCatalog','personalStock'])if(result[key])result[key]=omitMoney(result[key]);
  if(result.management?.inventory)result.management.inventory=omitMoney(result.management.inventory);
 }
 if(!finance){result.invoices=[];result.receipts=[];if(result.employeeFinance)result.employeeFinance=omitMoney(result.employeeFinance);}
 return result;
}
export function redactActionResult(value,action,payload,user,state){
 if(action==='account.permissions.update')return structuredClone(value);
 const material=action.startsWith('material.')||action.startsWith('admin.record.')&&payload.collection==='materials';
 if(material)return hasPermission(user,'inventory.prices',state)||hasPermission(user,'projects.prices',state)?structuredClone(value):omitMoney(value);
 const inventory=action.startsWith('inventory.')||action.startsWith('personalStock.')||action.startsWith('admin.record.')&&payload.collection==='inventory';
 return hasPermission(user,inventory?'inventory.prices':'projects.prices',state)?structuredClone(value):omitMoney(value);
}
export function requireFullBackupAccess(user,state){
 requirePermission(user,'backups.manage',state);
 for(const key of ['projects.view','projects.prices','inventory.prices','finance.view','people.manage'])requirePermission(user,key,state);
 if(user?.role!=='manager')fail('دریافت نسخهٔ کامل پشتیبان فقط برای مدیر مجاز است.',403,'FORBIDDEN');
}
export function canAdministerPerson(state,actor,target){
 const mine=effectivePermissions(actor,state),theirs=effectivePermissions(target,state);
 return PERMISSION_KEYS.every(key=>!theirs[key]||mine[key]);
}
