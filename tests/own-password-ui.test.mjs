import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState} from '../public/domain.mjs';
import {renderOperations,wireOperations} from '../public/operations.mjs';
import {api} from '../public/api.mjs';

const context=extra=>({e:String,n:String,money:String,date:String,badge:String,icon:String,personName:String,projectName:String,authMode:'supabase',capabilities:{supabaseAuth:true},api:{isStatic:false},...extra});
const stateFor=role=>{const state=publicState(createSeedState(),'worker');state.user.role=role;return state;};
const data=values=>{const result=new FormData();for(const [key,value]of Object.entries({currentPassword:'old-private-password',newPassword:'new-private-password',confirmPassword:'new-private-password',...values}))result.set(key,value);return result;};
function mount(t,{result,error}={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),events={},calls=[],toasts=[],fields={};let modal,refreshes=0;
  const state=stateFor('worker'),button={addEventListener(type,callback){events[type]=callback;}};
  const response=result||{ok:true,user:{id:state.user.id,role:'worker'},passwordChangeRequired:false};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:selector=>selector.startsWith('#modal-form [name=')?(fields[selector]||={value:'must-clear'}):null,querySelectorAll:selector=>selector==='[data-change-own-password]'?[button]:[]}});
  t.after(()=>previous?Object.defineProperty(globalThis,'document',previous):delete globalThis.document);
  wireOperations('settings',state,context({api:{isStatic:false,changePassword:async payload=>{calls.push(payload);if(error)throw error;return response;}},modal:value=>modal=value,refresh:async()=>{refreshes++;},toast:value=>toasts.push(value)}));
  events.click();return {calls,toasts,fields,get modal(){return modal;},get refreshes(){return refreshes;}};
}

test('each real Supabase role can change its own password from settings while preview and other auth modes omit it',()=>{
  for(const role of ['worker','manager','customer','warehouse','accountant'])assert.match(renderOperations('settings',stateFor(role),context()),/data-change-own-password/);
  assert(!renderOperations('settings',stateFor('worker'),context({api:{isStatic:true}})).includes('data-change-own-password'));
  assert(!renderOperations('settings',stateFor('worker'),context({authMode:'chatgpt',capabilities:{hosted:true}})).includes('data-change-own-password'));
});
test('own password modal sends only current and new passwords and clears fields before refreshing the account',async t=>{
  const ui=mount(t),form=data();assert.match(ui.modal.body,/autocomplete="current-password"/);assert.equal((ui.modal.body.match(/autocomplete="new-password"/g)||[]).length,2);
  assert(!ui.modal.body.includes('name="id"'));assert(!ui.modal.body.includes('value="old-private-password"'));
  await ui.modal.onSubmit(form);assert.deepEqual(ui.calls,[{currentPassword:'old-private-password',newPassword:'new-private-password'}]);assert.equal(ui.refreshes,1);assert.match(ui.toasts[0],/تغییر کرد/);
  for(const name of ['currentPassword','newPassword','confirmPassword'])assert.equal(form.get(name),'');assert(Object.values(ui.fields).every(field=>field.value===''));
});
test('invalid confirmation, empty and unchanged passwords never submit and server failure does not refresh',async t=>{
  await t.test('invalid fields',async sub=>{const ui=mount(sub);for(const values of [{confirmPassword:'different-password'},{newPassword:'',confirmPassword:''},{newPassword:'old-private-password',confirmPassword:'old-private-password'}])await assert.rejects(ui.modal.onSubmit(data(values)));assert.deepEqual(ui.calls,[]);assert.equal(ui.refreshes,0);});
  await t.test('server failure',async sub=>{const failing=mount(sub,{error:Error('رمز فعلی درست نیست.')});await assert.rejects(failing.modal.onSubmit(data()),/رمز فعلی/);assert.equal(failing.refreshes,0);assert.deepEqual(failing.toasts,[]);});
});
test('unverified password response cannot report success or refresh and API adapter retains same-origin cookies without identity fields',async t=>{
  const ui=mount(t,{result:{ok:true,user:{id:'somebody-else'},passwordChangeRequired:false}});await assert.rejects(ui.modal.onSubmit(data()),/تأیید نشد/);assert.equal(ui.refreshes,0);assert.deepEqual(ui.toasts,[]);
  const previous=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});};t.after(()=>globalThis.fetch=previous);
  await api.changePassword({currentPassword:'old-private-password',newPassword:'new-private-password',id:'forbidden-target',role:'manager'});
  assert.equal(calls[0].url,'/api/account/password');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.method,'POST');assert.deepEqual(JSON.parse(calls[0].options.body),{currentPassword:'old-private-password',newPassword:'new-private-password'});
});
