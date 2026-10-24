import test from 'node:test';
import assert from 'node:assert/strict';
import {recentMonths,financialSeries,performanceSeries,projectTypeCounts,teamSummary,analyticsCSV} from '../public/insights.mjs';
import {renderOperations,wireOperations} from '../public/operations.mjs';
import {scheduleStatus} from '../public/insight-views.mjs';
import {createSeedState,publicState} from '../public/domain.mjs';

test('monthly insights use six Persian calendar months across Nowruz without mutating source records',()=>{
  const state = {
    receipts:[{projectId:'p',amount:120,createdAt:'2026-03-20T12:00:00Z'},{projectId:'other',amount:500,createdAt:'2026-03-22T12:00:00Z'}],
    materials:[{projectId:'p',date:'2026-03-22',quantity:1.5,unitPrice:20}],
    reports:[{projectId:'p',date:'2026-03-22',status:'approved',minutes:90,laborCost:50},{projectId:'p',date:'2026-03-22',status:'submitted',minutes:60,laborCost:900},{projectId:'p',date:'invalid',status:'approved',minutes:600,laborCost:800}],
  };
  const original=structuredClone(state),months=recentMonths('2026-03-22');
  assert.equal(months.length,6);
  assert.equal(new Set(months.map(month=>month.key)).size,6);
  assert.equal(months.at(-1).key,'1405-01');
  assert.equal(months.at(-2).key,'1404-12');
  const finance=financialSeries(state,'2026-03-22','p');
  assert.equal(finance.at(-2).received,120);
  assert.equal(finance.at(-1).received,0);
  assert.equal(finance.at(-1).cost,80);
  const performance=performanceSeries(state,'2026-03-22');
  assert.equal(performance.at(-1).approved,1.5);
  assert.equal(performance.at(-1).pending,1);
  assert.deepEqual(state,original);
});

test('team and project breakdowns use active accounts and actual assignments',()=>{
  const state={users:[{id:'worker',role:'worker',name:'همکار'},{id:'archived',role:'worker',deletedAt:'2026-01-01'},{id:'client',role:'customer'}],projects:[{id:'a',name:'الف',type:'شبکه',status:'active',memberIds:['worker']},{id:'b',name:'ب',type:'شبکه',status:'completed',memberIds:['worker']},{id:'c',name:'ج',type:'برق',status:'active',memberIds:[]}],reports:[{workerId:'worker',status:'approved',minutes:150},{workerId:'worker',status:'rejected',minutes:120}]};
  assert.deepEqual(projectTypeCounts(state),[{name:'شبکه',count:2},{name:'برق',count:1}]);
  const team=teamSummary(state);
  assert.equal(team.length,1);
  assert.equal(team[0].activeProjects,1);
  assert.equal(team[0].projects.length,2);
  assert.equal(team[0].hours,2.5);
  assert.deepEqual(projectTypeCounts({projects:[{type:'CCTV'},{type:'network'},{type:'event'},{type:'خدمات ویژهٔ مشتری'}]}),[{name:'نظارت تصویری و شبکه',count:2},{name:'اجرای رویداد',count:1},{name:'خدمات ویژهٔ مشتری',count:1}]);
});

test('CSV exports escape formulas and quotes, omit credentials, and reject non-manager roles',()=>{
  const state={user:{role:'manager'},projects:[{id:'p',name:' =HYPERLINK("https://example.test")',description:'private-note',type:'برق',status:'active',progress:20}],users:[],invoices:[],inventory:[],reports:[],settings:{secret:'never-export'}};
  const csv=analyticsCSV('projects',state);
  assert(csv.startsWith('\ufeff'));
  assert(csv.includes("' =HYPERLINK("));
  assert(csv.includes('""https://example.test""'));
  assert(!csv.includes('private-note'));
  assert(!csv.includes('never-export'));
  assert.throws(()=>analyticsCSV('projects',{...state,user:{role:'worker'}}),/مدیر/);
  assert.throws(()=>analyticsCSV('unknown',state),/معتبر/);
});

test('reference analysis additions preserve customer financial boundaries and useful empty states',()=>{
  const context={e:String,n:String,money:String,date:String,icon:()=>'',badge:String,personName:String,projectName:String,today:()=> '2026-10-24',api:{isStatic:false},capabilities:{},authMode:'supabase'};
  const seed=createSeedState(),manager=publicState(seed,'manager'),customer=publicState(seed,'customer');
  const analytics=renderOperations('analytics',manager,context);
  assert.equal((analytics.match(/data-analytics-export=/g)||[]).length,4);
  assert.match(analytics,/کارکرد ماهانهٔ تیم/);
  assert.match(analytics,/حوزه‌های فعالیت پروژه‌ها/);
  assert.match(renderOperations('finance',manager,context),/روند دریافت‌ها و هزینه/);
  assert(!renderOperations('finance',customer,context).includes('روند دریافت‌ها و هزینه'));
  assert(!renderOperations('analytics',customer,context).includes('data-analytics-export'));
  manager.projects=[];manager.reports=[];manager.materials=[];manager.receipts=[];manager.invoices=[];
  assert(!/NaN|Infinity/.test(renderOperations('analytics',manager,context)));
});

test('staff schedule starts unspecified and edits availability independently from account access',async t=>{
  const ctx={e:String,n:String,money:String,date:String,icon:()=>'',badge:String,personName:String,projectName:String,api:{isStatic:false},capabilities:{},authMode:'supabase'};
  assert.match(scheduleStatus({},ctx),/وضعیت ثبت نشده/);
  assert.match(scheduleStatus({},ctx),/ساعات کاری ثبت نشده/);
  assert(!scheduleStatus({},ctx).includes('09:00'));
  const state=publicState(createSeedState(),'manager'),person=state.users.find(user=>user.role==='worker');
  let click,modal,payload;
  const previous=globalThis.document;
  globalThis.document={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-team-schedule]'?[{dataset:{teamSchedule:person.id},addEventListener:(_,handler)=>{click=handler;}}]:[]};
  t.after(()=>previous===undefined?delete globalThis.document:globalThis.document=previous);
  wireOperations('team',state,{...ctx,modal:value=>modal=value,mutate:async(action,value)=>{payload={action,value};}});
  click();
  assert.match(modal.body,/به وقت تهران/);
  const form=new FormData();form.set('availability','leave');form.set('workStart','');form.set('workEnd','');
  await modal.onSubmit(form);
  assert.deepEqual(payload,{action:'team.schedule',value:{id:person.id,availability:'leave',workStart:'',workEnd:''}});
  assert(!Object.hasOwn(payload.value,'deletedAt'));
});
