import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedPortalPage,portalNavigation,landingPage} from '../public/access.mjs';
import {landingPage as loginLanding} from '../web/portal-access.mjs';
import {mountPasswordRecovery} from '../web/recovery.mjs';
import {renderOperations,wireOperations} from '../public/operations.mjs';
import {createSeedState,publicState} from '../public/domain.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx=extra=>({e:escape,n:String,money:String,date:String,badge:String,icon:String,personName:String,projectName:String,authMode:'supabase',capabilities:{supabaseAuth:true},api:{isStatic:false},...extra});
function global(t,name,value){const previous=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});t.after(()=>previous?Object.defineProperty(globalThis,name,previous):delete globalThis[name]);}
const element=(extra={})=>({hidden:false,disabled:false,textContent:'',value:'',events:{},addEventListener(type,fn){this.events[type]=fn;},setAttribute(name,value){this[name]=value;},focus(){this.focused=true;},...extra});

test('specialized role navigation and direct routes remain limited to their assigned workspace',()=>{
  for(const [role,page] of [['warehouse','inventory'],['accountant','finance']]){
    assert.equal(landingPage(role),page);assert.equal(loginLanding(role),page);
    assert.deepEqual(portalNavigation(role).main.map(row=>row[0]),[page]);
    for(const denied of ['dashboard','projects','project','team','voice','assistant','messages','support','analytics','reports'])assert.equal(allowedPortalPage(denied,role),false,`${role}:${denied}`);
    assert(allowedPortalPage('settings',role));assert(allowedPortalPage(page,role));
  }
  assert(allowedPortalPage('inventory','worker'));
  assert(!allowedPortalPage('finance','worker'));
  assert(!allowedPortalPage('inventory','customer'));
});

test('archived accounts have restore controls and no active edit/reset/rate buttons',()=>{
  const seed=createSeedState();seed.users.find(u=>u.id==='worker').deletedAt='2026-10-22T08:00:00Z';
  seed.users.push({id:'warehouse-test',name:'انباردار نمونه',role:'warehouse',username:'store.arios',phone:'+989123456780'});
  const html=renderOperations('team',publicState(seed,'manager'),ctx());
  assert(html.includes('data-restore-account="worker"'));
  for(const attr of ['data-edit-account','data-reset-account','data-rate','data-archive-account'])assert(!html.includes(`${attr}="worker"`));
  assert(html.includes('store.arios'));assert(html.includes('data-edit-account="warehouse-test"'));
  assert(!html.includes('data-reset-account="manager"'));
  assert.match(html,/سوابق مالی حفظ شده/);
});

test('accountant can issue invoices and record receipts but cannot open team administration',()=>{
  const seed=createSeedState();seed.users.push({id:'finance-test',name:'حسابدار نمونه',role:'accountant'});
  const state=publicState(seed,'finance-test');
  const html=renderOperations('finance',state,ctx());
  assert(html.includes('data-new-invoice'));assert(html.includes('data-receipt='));
  assert(html.includes('کارکرد و دستمزد تأییدشده'));
  assert(!html.includes('data-coordinate-payment'));
  assert.match(renderOperations('team',state,ctx()),/این بخش برای نقش شما در دسترس نیست/);
});

test('manager reset requires matching passwords and never resends contact or account-role fields',async t=>{
  const state=publicState(createSeedState(),'manager'),events={},mutations=[];let modal,refreshes=0;
  global(t,'document',{querySelector:()=>null,querySelectorAll:selector=>selector==='[data-reset-account]'?[{dataset:{resetAccount:'worker'},addEventListener:(_,fn)=>events.reset=fn}]:[]});
  wireOperations('team',state,ctx({modal:value=>modal=value,mutate:async(action,payload)=>{mutations.push({action,payload});return{id:'worker'};},refresh:async()=>refreshes++}));
  events.reset();assert.match(modal.body,/minlength="6"/);assert.match(modal.body,/پیامک یا ایمیل خودکار ارسال نمی‌شود/);
  const data=new FormData();data.set('password','123456');data.set('confirmPassword','654321');
  await assert.rejects(modal.onSubmit(data),/یکسان نیستند/);assert.equal(mutations.length,0);
  data.set('confirmPassword','123456');await modal.onSubmit(data);
  assert.deepEqual(mutations,[{action:'account.password.reset',payload:{id:'worker',password:'123456'}}]);assert.equal(refreshes,0);
});

test('public recovery sends only identifier and gives the same manager-assisted acknowledgement',async t=>{
  const identifier=element({value:'store.arios'}),message=element(),submit=element(),login=element({querySelector:()=>identifier}),open=element(),back=element();
  const form=element({hidden:true,querySelector:selector=>({'[name="identifier"]':identifier,'[data-recovery-message]':message,'[type="submit"]':submit}[selector])});
  const nodes={'#login-form':login,'#recovery-form':form,'[data-forgot-password]':open,'[data-back-to-login]':back};
  const calls=[];global(t,'document',{querySelector:selector=>nodes[selector]});
  global(t,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({error:'do-not-show-private-provider-text'}),{status:200});});
  mountPasswordRecovery();open.events.click();assert(login.hidden);assert(!form.hidden);assert(identifier.focused);
  await form.events.submit({preventDefault(){}});
  assert.equal(calls[0].url,'/api/password-reset/request');assert.deepEqual(JSON.parse(calls[0].options.body),{identifier:'store.arios'});
  assert.equal(calls[0].options.credentials,'same-origin');assert.match(message.textContent,/تأیید هویت/);assert.match(message.textContent,/خودکار ارسال نمی‌شود/);assert(!message.textContent.includes('private-provider'));
  assert.equal(identifier.value,'');assert.equal(submit.disabled,false);
  back.events.click();assert(form.hidden);assert(!login.hidden);
});

test('recovery failures allow retry without inventing an SMS delivery',async t=>{
  const identifier=element({value:'09121234567'}),message=element(),submit=element(),login=element(),open=element(),back=element();
  const form=element({querySelector:selector=>({'[name="identifier"]':identifier,'[data-recovery-message]':message,'[type="submit"]':submit}[selector])});
  global(t,'document',{querySelector:selector=>({'#login-form':login,'#recovery-form':form,'[data-forgot-password]':open,'[data-back-to-login]':back}[selector])});
  global(t,'fetch',async()=>new Response('private-upstream',{status:429}));
  mountPasswordRecovery();await form.events.submit({preventDefault(){}});
  assert.equal(message.role,'alert');assert.match(message.textContent,/کمی بعد/);assert(!message.textContent.includes('private-upstream'));assert.equal(identifier.value,'09121234567');assert(!submit.disabled);
});
