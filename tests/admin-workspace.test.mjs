import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedPortalPage,portalNavigation} from '../public/access.mjs';
import {MANAGEMENT_SECTIONS,managementRecords,managementEditPayload,renderAdminWorkspace,wireAdminWorkspace} from '../public/admin-workspace.mjs';
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={e,n:String,date:value=>String(value||''),icon:()=>'',badge:value=>`<span>${e(value)}</span>`,head:(title,subtitle,actions='')=>`<h1>${e(title)}</h1><p>${e(subtitle)}</p>${actions}`};
function fixture(){return {user:{id:'owner',role:'manager'},users:[{id:'worker',name:'نیروی آزمایش',role:'worker'}],projects:[{id:'p1',name:'پروژهٔ اصلی',memberIds:['worker']}],management:{projects:[{id:'p1',name:'پروژهٔ اصلی',projectCode:'AR-1',progress:20,memberIds:['worker']},{id:'old-project',name:'پروژهٔ بایگانی',archivedAt:'2026-10-20'}],tasks:[{id:'task1',projectId:'p1',title:'اجرای نصب',assigneeId:'worker',status:'open',version:3}],reports:[{id:'report1',projectId:'p1',workerId:'worker',description:'کار امروز',status:'approved',date:'2026-10-26',start:'09:00',end:'12:00',breakMinutes:0,version:2}],materials:[],inventory:[],invoices:[],receipts:[],messages:[],tickets:[]}};}
test('management route and records are exclusive to manager even with a forged privileged snapshot',()=>{
 for(const role of ['worker','customer','warehouse','accountant']){const state={...fixture(),user:{id:'viewer',role}};assert(!allowedPortalPage('management',role));assert(!portalNavigation(role).main.some(([key])=>key==='management'));assert.deepEqual(managementRecords(state,'projects'),[]);const html=renderAdminWorkspace(state,ctx);assert(!html.includes('پروژهٔ اصلی'));assert(!html.includes('data-management-new'));}
 assert(allowedPortalPage('management','manager'));assert(portalNavigation('manager').main.some(([key])=>key==='management'));
});
test('manager can find all collections and separate active records from deleted records without losing their history',()=>{
 const state=fixture(),active=renderAdminWorkspace(state,ctx,'projects'),archive=renderAdminWorkspace(state,ctx,'projects','archived');
 for(const [key,label]of MANAGEMENT_SECTIONS){assert(active.includes(`#management/${key}`),label);}
 assert(active.includes('data-management-edit="p1"'));assert(active.includes('data-management-archive="p1"'));assert(!active.includes('data-management-restore="old-project"'));
 assert(archive.includes('data-management-restore="old-project"'));assert(!archive.includes('data-management-edit="old-project"'));assert(!archive.includes('data-management-edit="p1"'));
 assert(active.includes('#team'));assert(active.includes('#documents'));assert(active.includes('data-management-query'));
});
test('stored record content is escaped in visible text, search attributes and mutation identifiers',()=>{
 const state=fixture();state.management.messages=[{id:'bad" onclick="run()',projectId:'p1',authorId:'worker',text:'<img src=x onerror=run()>',internal:true}];
 const html=renderAdminWorkspace(state,ctx,'messages');assert(!html.includes('<img src=x'));assert(html.includes('&lt;img src=x'));assert(!html.includes('id="bad" onclick'));assert(html.includes('bad&quot; onclick=&quot;run()'));assert(html.includes('یادداشت داخلی'));
});
test('readable edit payloads preserve numeric and boolean semantics and never accept fields absent from the form contract',()=>{
 const data=new FormData();data.set('name','  کابل شبکه ');data.set('quantity','12.5');data.set('unit','متر');data.set('unitPrice','8500');data.set('date','2026-10-26');data.set('reason','اصلاح ثبت اولیه');data.set('projectId','forged-project');data.set('inventoryId','forged-stock');data.set('role','manager');
 const payload=managementEditPayload('materials',{id:'m1',projectId:'p1',version:4},data);
 assert.deepEqual(payload,{collection:'materials',id:'m1',version:4,changes:{name:'کابل شبکه',quantity:12.5,unit:'متر',unitPrice:8500,clientVisible:false,date:'2026-10-26'},reason:'اصلاح ثبت اولیه'});
 data.set('clientVisible','on');assert(managementEditPayload('materials',{id:'m1'},data).changes.clientVisible);
 assert.throws(()=>managementEditPayload('users',{id:'person'},data),/قابل ویرایش/);
});
test('project phase editor supports addition and removal without exposing JSON or inventing phase identifiers',()=>{
 const data=new FormData();data.set('name','پروژه');data.set('phaseEditor','1');data.append('phaseName',' نصب ');data.append('phaseId','existing');data.append('phaseProgress','100');data.append('phaseName','تحویل');data.append('phaseId','');data.append('phaseProgress','0');data.append('phaseName','');data.append('phaseId','removed');data.append('phaseProgress','0');
 const payload=managementEditPayload('projects',{id:'p1'},data);assert.deepEqual(payload.changes.phases,[{id:'existing',name:'نصب',progress:100},{name:'تحویل',progress:0}]);
 const empty=new FormData();empty.set('phaseEditor','1');assert.deepEqual(managementEditPayload('projects',{id:'p1'},empty).changes.phases,[]);
});
test('task changes carry project identity and version to prevent updates to another project or a stale task',()=>{
 const data=new FormData();data.set('title','نصب');data.set('description','شرح');data.set('assigneeId','worker');data.set('status','done');data.set('dueDate','');
 const payload=managementEditPayload('tasks',{id:'task1',projectId:'p1',version:3},data);assert.equal(payload.projectId,'p1');assert.equal(payload.version,3);assert.equal(payload.changes.status,'done');assert.equal(payload.changes.dueDate,'');
});
test('edit and delete controls invoke the guarded record API with selected identity and keep frozen dossier data out of forms',async()=>{
 const state=fixture(),previous=globalThis.document,handlers={},calls=[];let currentModal;
 const button=kind=>({dataset:kind==='edit'?{managementEdit:'report1',managementProject:'p1'}:{managementArchive:'report1',managementProject:'p1'},addEventListener:(_,handler)=>{handlers[kind]=handler;}});
 globalThis.document={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-management-edit]'?[button('edit')]:selector==='[data-management-archive]'?[button('archive')]:[]};
 const context={...ctx,modal:value=>{currentModal=value;},mutate:async(...args)=>{calls.push(args);}};
 try{
  wireAdminWorkspace(state,context,'reports');handlers.edit();assert(currentModal.body.includes('name="description"'));assert(currentModal.body.includes('علت اصلاح'));assert(currentModal.body.includes('بررسی دوباره'));assert(!currentModal.body.includes('dossierSubmission'));
  const data=new FormData();for(const [key,value]of Object.entries({projectId:'p1',workerId:'worker',date:'2026-10-26',start:'09:00',end:'12:00',breakMinutes:'0',description:'شرح اصلاح‌شده',output:'نتیجه',reason:'اصلاح ساعت ثبت'}))data.set(key,value);
  await currentModal.onSubmit(data);assert.equal(calls[0][0],'admin.record.update');assert.equal(calls[0][1].id,'report1');assert.equal(calls[0][1].version,2);assert.equal(calls[0][1].changes.breakMinutes,0);
  handlers.archive();assert(currentModal.body.includes('دستمزد'));assert(currentModal.body.includes('type="checkbox" required'));const reason=new FormData();reason.set('reason','ثبت تکراری');await currentModal.onSubmit(reason);assert.deepEqual(calls[1],['admin.record.archive',{collection:'reports',id:'report1',version:2,reason:'ثبت تکراری'}]);
 }finally{globalThis.document=previous;}
});
test('new inventory uses the active unit catalog without bringing back a deleted default unit',()=>{
 const state=fixture();state.catalogs={units:[{id:'unit-meter',label:'متر'},{id:'unit-count',label:'عدد',archivedAt:'2026-10-25'}]};const previous=globalThis.document;let newHandler,modal;
 globalThis.document={querySelector:selector=>selector==='[data-management-new]'?{addEventListener:(_,handler)=>{newHandler=handler;}}:null,querySelectorAll:()=>[]};
 try{wireAdminWorkspace(state,{...ctx,today:()=> '2026-10-26',modal:value=>{modal=value;}},'inventory');newHandler();assert(modal.body.includes('value="متر"'));assert(!modal.body.includes('value="عدد"'));assert(!modal.body.includes('ثبت قبلی'));}finally{globalThis.document=previous;}
});
test('records belonging to a deleted project point to project restoration and keep localized task states',()=>{
 const state=fixture();state.management.tasks[0].status='done';let html=renderAdminWorkspace(state,ctx,'tasks');assert(html.includes('انجام‌شده'));state.management.tasks[0].projectArchivedAt='2026-10-26';html=renderAdminWorkspace(state,ctx,'tasks');assert(html.includes('href="#management/projects/archived"'));assert(html.includes('ابتدا پروژه را بازگردانید'));assert(!html.includes('data-management-edit="task1"'));assert(!html.includes('data-management-archive="task1"'));
});
