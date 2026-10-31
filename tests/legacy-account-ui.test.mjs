import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState} from '../public/domain.mjs';
import {renderOperations,wireOperations} from '../public/operations.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const context=extra=>({e:escape,n:String,money:String,date:String,badge:String,icon:String,personName:String,projectName:String,authMode:'supabase',capabilities:{supabaseAuth:true},api:{isStatic:false},...extra});
function fixture(){
  const state=publicState(createSeedState(),'manager');
  for(const person of state.users)person.loginEnabled=true;
  state.users.find(person=>person.id==='worker').loginEnabled=false;
  return state;
}
function mount(t,state,selector,dataset){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),events={},mutations=[],toasts=[];let modal;
  const button={dataset,addEventListener(type,callback){events[type]=callback;}};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null,querySelectorAll:value=>value===selector?[button]:[]}});
  t.after(()=>previous?Object.defineProperty(globalThis,'document',previous):delete globalThis.document);
  wireOperations('team',state,context({modal:value=>modal=value,mutate:async(action,payload)=>{mutations.push({action,payload});return{id:payload.id};},toast:value=>toasts.push(value)}));
  return {events,mutations,toasts,get modal(){return modal;}};
}
const activationData=()=>{
  const data=new FormData();
  for(const[name,value]of Object.entries({phone:'۰۹۱۲۱۲۳۴۵۶۷',username:'legacy.worker',password:'123456',confirmPassword:'123456'}))data.set(name,value);
  return data;
};

test('a profile without login remains editable and has activation rather than password-reset controls',()=>{
  const html=renderOperations('team',fixture(),context());
  assert(html.includes('data-edit-account="worker"'));
  assert(html.includes('data-archive-account="worker"'));
  assert(html.includes('data-activate-account="worker"'));
  assert(!html.includes('data-reset-account="worker"'));
  assert.match(html,/ورود فعال نشده/);
  assert(html.includes('data-reset-account="customer"'));
  assert(!html.includes('data-activate-account="customer"'));
});

test('editing a legacy profile submits only its existing ID and contact/role fields without creating login',async t=>{
  const state=fixture(),ui=mount(t,state,'[data-edit-account]',{editAccount:'worker'});
  ui.events.click();
  assert(!ui.modal.body.includes('name="password"'));
  assert.match(ui.modal.body,/ذخیرهٔ اطلاعات به‌تنهایی ورود را فعال نمی‌کند/);
  const data=new FormData();
  for(const[name,value]of Object.entries({name:'کارمند قدیمی',phone:'09121234567',role:'worker',username:'',department:'نصب',skill:'شبکه'}))data.set(name,value);
  await ui.modal.onSubmit(data);
  assert.deepEqual(ui.mutations,[{action:'account.update',payload:{id:'worker',name:'کارمند قدیمی',phone:'09121234567',role:'worker',username:'',department:'نصب',skill:'شبکه'}}]);
});

test('explicit activation accepts any chosen password and keeps the same profile ID and role',async t=>{
  const ui=mount(t,fixture(),'[data-activate-account]',{activateAccount:'worker'});
  ui.events.click();
  assert.match(ui.modal.body,/name="phone"[^>]*required/);
  assert.match(ui.modal.body,/name="password"[^>]*minlength="1"/);
  assert(!ui.modal.body.includes('name="role"'));
  assert(!ui.modal.body.includes('name="projectIds"'));
  assert(!ui.modal.body.includes('name="email"'));
  assert.match(ui.modal.body,/فرد دوباره ثبت نمی‌شود/);
  const data=activationData();data.set('confirmPassword','654321');
  await assert.rejects(ui.modal.onSubmit(data),/یکسان نیستند/);
  data.set('password','');data.set('confirmPassword','');
  await assert.rejects(ui.modal.onSubmit(data),/رمز ورود را وارد کنید/);
  assert.equal(ui.mutations.length,0);
  data.set('password','12345');data.set('confirmPassword','12345');
  await ui.modal.onSubmit(data);
  assert.deepEqual(ui.mutations,[{action:'account.activate',payload:{id:'worker',phone:'۰۹۱۲۱۲۳۴۵۶۷',username:'legacy.worker',password:'12345'}}]);
});

test('warehouse activation requires a username while ordinary worker activation keeps it optional',t=>{
  const state=fixture(),person=state.users.find(person=>person.id==='worker');person.role='warehouse';
  const ui=mount(t,state,'[data-activate-account]',{activateAccount:'worker'});
  ui.events.click();assert.match(ui.modal.body,/name="username"[^>]*required/);
  person.role='worker';ui.events.click();assert(!/name="username"[^>]*required/.test(ui.modal.body));
});

test('mapped role mismatches require a profile edit and cannot be activated or reset from stale controls',t=>{
  const state=fixture(),person=state.users.find(person=>person.id==='worker');person.loginEnabled=true;person.loginNeedsReview=true;
  const html=renderOperations('team',state,context());
  assert(html.includes('data-edit-account="worker"'));
  assert(!html.includes('data-activate-account="worker"'));
  assert(!html.includes('data-reset-account="worker"'));
  assert.match(html,/ورود نیازمند هماهنگی نقش/);
  const ui=mount(t,state,'[data-reset-account]',{resetAccount:'worker'});
  ui.events.click();assert.equal(ui.modal,undefined);assert.equal(ui.mutations.length,0);assert.match(ui.toasts[0],/ویرایش و دوباره ذخیره/);
});

test('restoring a profile-only record does not promise an existing password or activate login',async t=>{
  const state=fixture();state.users.find(person=>person.id==='worker').deletedAt='2026-10-23T00:00:00Z';
  const ui=mount(t,state,'[data-restore-account]',{restoreAccount:'worker'});
  ui.events.click();assert.match(ui.modal.body,/فعال‌سازی ورود/);assert(!ui.modal.body.includes('رمز فعلی حفظ می‌شود'));
  await ui.modal.onSubmit();assert.deepEqual(ui.mutations,[{action:'account.restore',payload:{id:'worker'}}]);
});
