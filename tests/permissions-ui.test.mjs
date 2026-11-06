import test from 'node:test';
import assert from 'node:assert/strict';
import {PERMISSION_KEYS} from '../public/permissions.mjs';
import {allowedPortalPage,portalNavigation} from '../public/access.mjs';
import {renderPersonPermissionFields,personProfilePayload,renderPeopleWorkspace,wirePersonDetailsForm} from '../public/people-workspace.mjs';
import {renderInventoryWorkspace,wireInventoryWorkspace} from '../public/inventory-workspace.mjs';
import {renderFinanceWorkspace,openBusinessExpense,openFinanceReversal,financeCSV} from '../public/finance-workspace.mjs';
import {renderPersonalStockWorkspace,openPersonalStockIssue} from '../public/personal-stock-workspace.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ctx=extra=>({e:escape,n:String,money:value=>'COST:'+value,date:String,today:()=> '2026-11-01',...extra});
const fields=values=>{const form=new FormData();for(const [key,value] of Object.entries(values))form.set(key,value);return form;};
function state(permissions,role='worker'){
  const user={id:'staff',name:'همکار',role,permissions};
  return {user,users:[user,{id:'other',name:'همکار دیگر',role:'worker'}],projects:[{id:'project',name:'پروژهٔ مجاز',memberIds:['staff']}],materials:[],inventory:[{id:'stock',name:'کالا',unit:'عدد',quantity:5,minQuantity:1}],stockCatalog:[],archivedInventory:[],employeeFinance:{entries:[],accounts:[],pettyAccounts:[],projectAccounts:[]},invoices:[],personalStock:{issues:[],accounts:[],settlements:[]}};
}
function docFor(t,action,id='stock'){
  const before=globalThis.document;
  const button={dataset:{inventoryAction:action,inventoryId:id},addEventListener:(_,listener)=>button.click=listener};
  globalThis.document={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-inventory-action]'?[button]:[]};
  t.after(()=>before===undefined?delete globalThis.document:globalThis.document=before);
  return button;
}

test('person access form emits real editable key fields, protects the primary and omits grants the editor cannot change',()=>{
  const manager={id:'manager',name:'مدیر اصلی',role:'manager'};
  const person={id:'staff',name:'همکار',role:'worker',permissions:{'inventory.create':true}};
  const whole={user:manager,users:[manager,person]};
  const html=renderPersonPermissionFields(whole,ctx(),person);
  assert(!html.includes('${PERMISSION_KEYS'));
  assert.equal((html.match(/name="permissionEditableKeys"/g)||[]).length,PERMISSION_KEYS.length);
  assert.match(html,/data-permission-key="inventory.create"[^>]*checked/);
  const primary=renderPersonPermissionFields(whole,ctx(),manager);
  assert.match(primary,/data-person-permissions[^>]*disabled/);
  assert(!primary.includes('name="personPermissionsForm"'));
  const limited={id:'limited',name:'مدیر محدود',role:'manager',permissions:{'projects.prices':false}};
  const partial=renderPersonPermissionFields({user:limited,users:[manager,limited,person]},ctx(),person);
  assert.match(partial,/data-permission-key="projects.prices"[^>]*data-permission-readonly="true"[^>]*disabled/);
  assert(!partial.includes('name="permissionEditableKeys" value="projects.prices"'));
  const form=fields({role:'worker',personPermissionsForm:'1'});
  form.append('permissionEditableKeys','inventory.create');form.append('permissionEditableKeys','inventory.archive');form.append('permissionKeys','inventory.create');
  assert.deepEqual(personProfilePayload(form).permissions,{'inventory.create':true,'inventory.archive':false});
});

test('manager-only grants are labelled and stay disabled when an operational account role changes',t=>{
  const manager={id:'manager',role:'manager'},person={id:'staff',role:'worker'};
  const html=renderPersonPermissionFields({user:manager,users:[manager,person]},ctx(),person);
  for(const key of ['people.manage','permissions.manage','integrations.manage','backups.manage','voice.manage']){
    assert.match(html,new RegExp('data-permission-key="'+key.replace('.','\\.')+'"[^>]*data-permission-manager-only="true"[^>]*disabled'));
  }
  assert.match(html,/ویژه حساب مدیر/);
  const role={value:'worker',addEventListener:(_,handler)=>role.changed=handler};
  const inputs=['people.manage','projects.create'].map(key=>({dataset:{permissionKey:key,permissionReadonly:'false'},checked:false,disabled:false,addEventListener(){}}));
  const permissions={disabled:false,querySelectorAll:()=>inputs,querySelector:()=>null};
  const form={querySelector:selector=>selector==='[name="role"]'?role:selector==='[data-person-permissions]'?permissions:null};
  const previous=globalThis.document;globalThis.document={querySelector:()=>form};
  t.after(()=>previous===undefined?delete globalThis.document:globalThis.document=previous);
  wirePersonDetailsForm(person);assert.equal(inputs[0].disabled,true);
  role.value='manager';role.changed();assert.equal(inputs[0].disabled,false);assert.equal(inputs[0].checked,true);
  role.value='worker';role.changed();assert.equal(inputs[0].disabled,true);assert.equal(inputs[0].checked,false);
  assert.equal(inputs[1].disabled,false);
});

test('delegated inventory creation is reachable and never submits hidden prices or gains unrelated stock actions',async t=>{
  const s=state({'inventory.create':true,'inventory.issue':false}),changes=[];let modal;
  assert(allowedPortalPage('inventory',s.user));assert(portalNavigation(s.user).main.some(([key])=>key==='inventory'));
  const html=renderInventoryWorkspace(s,ctx());
  assert.match(html,/data-inventory-action="create"/);assert(!html.includes('data-inventory-action="delete"'));assert(!html.includes('COST:'));
  const create=docFor(t,'create');wireInventoryWorkspace(s,ctx({modal:value=>modal=value,mutate:async(action,payload)=>changes.push({action,payload})}));create.click();
  assert(!modal.body.includes('name="unitPrice"'));
  await modal.onSubmit(fields({name:'کالای تازه',unit:'عدد',quantity:'2.5',minQuantity:'1',unitPrice:'999999'}));
  assert.equal(changes[0].action,'inventory.create');assert.equal(changes[0].payload.quantity,2.5);assert(!('unitPrice' in changes[0].payload));
});

test('stock edit preserves undisclosed monetary fields and read-only stock cannot open injected edit controls',async t=>{
  const s=state({'inventory.view':true,'inventory.edit':true,'inventory.issue':false}),changes=[];let modal;
  const edit=docFor(t,'edit');wireInventoryWorkspace(s,ctx({modal:value=>modal=value,mutate:async(action,payload)=>changes.push({action,payload})}));edit.click();
  assert(!modal.body.includes('name="unitPrice"'));
  await modal.onSubmit(fields({name:'کالای اصلاح‌شده',unit:'عدد',quantity:'4',minQuantity:'1',unitPrice:'0'}));
  assert.equal(changes[0].action,'admin.record.update');assert.equal(changes[0].payload.collection,'inventory');assert(!('unitPrice' in changes[0].payload.changes));
  s.user.permissions['inventory.edit']=false;modal=undefined;edit.inventoryBound=false;
  wireInventoryWorkspace(s,ctx({modal:value=>modal=value}));edit.click();assert.equal(modal,undefined);
});

test('read-only delegated finance shows authorized history and export while all mutation entrypoints stay closed',t=>{
  const s=state({'finance.view':true,'finance.manage':false,'projects.prices':true,'inventory.issue':false});
  s.employeeFinance.entries=[{id:'entry',type:'expense',amount:12000,date:'2026-11-01',note:'هزینه ثبت‌شده'}];
  const html=renderFinanceWorkspace(s,ctx());
  assert.match(html,/data-finance-workspace/);assert.match(html,/COST:12000/);assert.match(html,/data-finance-export/);
  for(const action of ['advance','payroll','repay','petty','expense','reverse'])assert(!html.includes('data-finance-'+action+'>')&&!new RegExp('data-finance-'+action+'(?:=|\\s)').test(html));
  let opened=0;const c=ctx({modal:()=>opened++});openBusinessExpense(s,c);openFinanceReversal(s,c,'entry');assert.equal(opened,0);
  assert.match(financeCSV(s),/12000/);
  s.user.permissions['projects.prices']=false;
  assert.equal(allowedPortalPage('finance',s.user),false);assert.equal(renderFinanceWorkspace(s,ctx()),'');assert.throws(()=>financeCSV(s));
});

test('hidden personnel and personal-stock amounts are marked confidential rather than painted as zero',t=>{
  const s=state({'people.manage':true,'projects.prices':false,'inventory.view':true,'inventory.issue':true,'inventory.prices':false});
  s.personalStock.accounts=[{employeeId:'other'}];s.personalStock.issues=[{id:'issue',employeeId:'other',name:'کالا',unit:'عدد',quantity:1,date:'2026-11-01'}];
  const html=renderPersonalStockWorkspace(s,ctx());assert.match(html,/محرمانه/);assert(!html.includes('COST:0'));
  const directory=renderPeopleWorkspace(s,ctx(),{supabaseAuth:true});assert(!directory.includes('COST:0'));
  let modal;docFor(t,'unused');openPersonalStockIssue(s,ctx({modal:value=>modal=value}));assert(modal);assert(!modal.body.includes('name="unitPrice"'));assert.match(modal.body,/محرمانه/);
});

test('financial entry creation and reversal are independent capabilities in the visible controls and modal entrypoints',()=>{
  const s=state({'finance.view':true,'finance.manage':true,'finance.reverse':false,'projects.prices':true,'inventory.issue':false});
  s.employeeFinance.entries=[{id:'entry',type:'expense',amount:12000,date:'2026-11-01',note:'هزینه ثبت‌شده',version:1}];
  const html=renderFinanceWorkspace(s,ctx());
  assert.match(html,/data-finance-expense/);assert(!html.includes('data-finance-reverse='));
  let modal;const c=ctx({modal:value=>modal=value});
  openFinanceReversal(s,c,'entry');assert.equal(modal,undefined);
  s.user.permissions['finance.reverse']=true;
  assert.match(renderFinanceWorkspace(s,ctx()),/data-finance-reverse="entry"/);
  openFinanceReversal(s,c,'entry');assert.match(modal.title,/ابطال/);
});
