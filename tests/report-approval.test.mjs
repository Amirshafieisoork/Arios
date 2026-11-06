import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {REPORT_APPROVAL_LABELS,startReportApproval,restartReportApproval,applyReportReview,currentReportStage,reportAwaitingMe,reportReviewCount,safeReportApproval,renderReportApproval} from '../public/report-approval.mjs';
import {portalNotifications} from '../public/portal-workflows.mjs';

function fixture(){
 const users=[['manager','مدیر اصلی','manager'],['author','نویسنده','worker'],['lead','مسئول پروژه','worker'],['unit','مسئول واحد','worker'],['technical','مدیر فنی','worker'],['sales','فروش','worker'],['finance','مالی','accountant'],['ceo','مدیرعامل','manager']].map(([id,name,role])=>({id,name,role}));
 const project={id:'p',name:'پروژهٔ نمونه',projectCode:'P-1',projectManagerId:'lead',memberIds:['author','lead'],reviewChain:['lead','unit','technical','sales','finance','ceo'].map((userId,index)=>({label:REPORT_APPROVAL_LABELS[index],userId})),tasks:[]};
 const report={id:'r',projectId:'p',workerId:'author',date:'2026-10-30',start:'09:00',end:'11:00',minutes:120,breakMinutes:0,description:'شرح واقعی اجرا',output:'خروجی',rate:600000,laborCost:0,status:'submitted',version:1};
 const state={users,projects:[project],reports:[report],tickets:[],invoices:[],messages:[]};
 const person=id=>users.find(user=>user.id===id);
 const start=()=>startReportApproval(state,person('author'),report,project);
 const review=(id,status='approved',extra={})=>applyReportReview(state,person(id),report,project,{version:report.version,status,...extra});
 return{state,users,project,report,person,start,review};
}

test('six ordered daily-report approvals freeze assignees and recognize labor only after the CEO stage',()=>{
 const f=fixture();f.start();assert.equal(f.report.approval.stages.length,6);assert.equal(currentReportStage(f.report,f.project).userId,'lead');
 f.project.reviewChain[0].userId='manager';
 assert.equal(currentReportStage(f.report,f.project).userId,'lead');
 const before=structuredClone(f.report);assert.throws(()=>f.review('manager'),error=>error.status===403);assert.deepEqual(f.report,before);
 const chain=['lead','unit','technical','sales','finance','ceo'];
 for(const [index,id]of chain.entries()){
  f.review(id);assert.equal(f.report.approval.currentStage,index+1);assert.equal(f.report.status,index===5?'approved':'submitted');assert.equal(f.report.laborCost,index===5?1200000:0);
 }
 assert.equal(f.report.reviewedBy,'ceo');assert.equal(f.report.approval.history.length,7);assert.equal(f.report.approval.history[0].stages[0].userId,'lead');
 assert.throws(()=>f.review('ceo'),error=>error.code==='IMMUTABLE_REPORT');
});

test('one person holding two successive responsibilities must approve twice with fresh versions',()=>{
 const f=fixture();f.project.reviewChain[1].userId='lead';f.start();
 const first={version:1,status:'approved',stageIndex:0};applyReportReview(f.state,f.person('lead'),f.report,f.project,first);
 assert.equal(f.report.approval.currentStage,1);assert.equal(f.report.version,2);
 assert.throws(()=>applyReportReview(f.state,f.person('lead'),f.report,f.project,first),error=>error.code==='VERSION_CONFLICT');
 assert.throws(()=>f.review('lead','approved',{stageIndex:0}),error=>error.code==='VERSION_CONFLICT');
 f.review('lead','approved',{stageIndex:1});assert.equal(f.report.approval.currentStage,2);assert.equal(f.report.laborCost,0);
});

test('current reviewer alone gets notifications and authority, independent of the manager role',()=>{
 const f=fixture();f.start();
 const snapshot=user=>({...f.state,user});
 assert.equal(reportReviewCount(snapshot(f.person('manager'))),0);assert.equal(reportReviewCount(snapshot(f.person('lead'))),1);
 assert.equal(portalNotifications(snapshot(f.person('manager'))).filter(item=>item.kind==='report').length,0);
 assert.equal(portalNotifications(snapshot(f.person('lead'))).filter(item=>item.kind==='report').length,1);
 f.review('lead');assert.equal(reportAwaitingMe(f.report,f.person('lead'),f.project),false);assert.equal(reportAwaitingMe(f.report,f.person('unit'),f.project),true);
 assert.equal(portalNotifications(snapshot(f.person('unit'))).filter(item=>item.kind==='report').length,1);
});

test('legacy pending reports initialize a full configured chain without granting a manager shortcut',()=>{
 const f=fixture();assert.throws(()=>f.review('manager'),error=>error.code==='FORBIDDEN');assert.equal(f.report.approval,undefined);
 f.review('lead');assert.equal(f.report.approval.currentStage,1);assert.equal(f.report.approval.stages.length,6);assert.equal(f.report.status,'submitted');assert.equal(f.report.laborCost,0);assert.equal(f.report.approval.history[0].action,'initialized');
 const missing=fixture();delete missing.project.reviewChain;const before=structuredClone(missing.report);
 assert.throws(()=>missing.review('manager'),error=>error.code==='PROJECT_APPROVAL_NOT_CONFIGURED');assert.deepEqual(missing.report,before);
 missing.start();assert.equal(missing.report.approval.configurationRequired,true);assert.equal(missing.report.laborCost,0);
});

test('return and amendment preserve signed action history while restarting every stage for the new cycle',()=>{
 const f=fixture();f.start();f.review('lead');
 assert.throws(()=>f.review('unit','changes_requested'),error=>error.code==='INVALID_REPORT_APPROVAL');
 f.review('unit','changes_requested',{reviewNote:'عکس تکمیل کار را اضافه کنید'});assert.equal(f.report.status,'changes_requested');
 const before=structuredClone(f.report);f.report.description='شرح اصلاح‌شده';f.report.version++;
 restartReportApproval(f.state,f.report,f.person('manager'),{previous:before});
 assert.equal(f.report.approval.cycle,2);assert.equal(f.report.approval.currentStage,0);assert(f.report.approval.stages.every(stage=>stage.status==='pending'));
 assert.equal(f.report.approval.history.filter(event=>event.action==='approved').length,1);assert.equal(f.report.approval.history[0].snapshot.description,'شرح واقعی اجرا');assert.equal(f.report.approval.history.at(-1).snapshot.description,'شرح اصلاح‌شده');assert.equal(f.report.laborCost,0);
});

test('revoked reviewer permissions, missing versions and malformed decisions never change a pending stage',()=>{
 const f=fixture();f.start();const before=structuredClone(f.report);
 assert.throws(()=>f.review('lead','approved',{version:undefined}),error=>error.code==='VERSION_CONFLICT');
 assert.throws(()=>f.review('lead','skip-all'),error=>error.code==='INVALID_REPORT_APPROVAL');
 f.person('lead').permissions={'reports.review':false};
 assert.throws(()=>f.review('lead'),error=>error.code==='FORBIDDEN');assert.deepEqual(f.report,before);
 const forged={...f.person('unit'),id:'lead',permissions:{'reports.review':true},role:'manager'};
 assert.throws(()=>applyReportReview(f.state,forged,f.report,f.project,{version:1,status:'approved'}),error=>error.code==='FORBIDDEN');
});

test('overlap is checked at final approval and cannot leave a partially signed final step',()=>{
 const f=fixture();f.start();for(const id of ['lead','unit','technical','sales','finance'])f.review(id);
 f.state.reports.push({...f.report,id:'already-approved',status:'approved',start:'10:00',end:'12:00',laborCost:100});const before=structuredClone(f.report);
 assert.throws(()=>f.review('ceo'),error=>error.code==='TIME_OVERLAP');assert.deepEqual(f.report,before);assert.equal(f.report.laborCost,0);
});

test('history projections omit report snapshots and financial values while progress safely escapes names and notes',()=>{
 const f=fixture();f.person('lead').name='<script>lead</script>';f.start();f.review('lead','approved',{reviewNote:'<img src=x onerror=alert(1)>'});
 const safe=safeReportApproval(f.report);assert.equal(safe.history[0].snapshot,undefined);assert.equal(safe.history[0].stages,undefined);assert(!JSON.stringify(safe).includes('600000'));
 const ctx={e:value=>String(value??'').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character])),n:String,date:String};
 const html=renderReportApproval({...f.report,approval:safe},{...f.state,user:f.person('unit')},ctx);assert(html.includes('در انتظار تأیید شما'));assert(!html.includes('<script>'));assert(!html.includes('<img src=x'));
});
test('a staff member with an explicit review grant can perform only their assigned stage and revocation immediately closes it',()=>{
 const f=fixture();f.users.push({id:'stock',role:'warehouse',name:'مسئول انبار',permissions:{'reports.review':true}});f.project.reviewChain[1].userId='stock';f.start();
 assert.throws(()=>f.review('stock'),error=>error.code==='FORBIDDEN');f.review('lead');
 assert.equal(reportAwaitingMe(f.report,f.person('stock'),f.project),true);
 f.person('stock').permissions['reports.review']=false;assert.throws(()=>f.review('stock'),error=>error.code==='FORBIDDEN');
 f.person('stock').permissions['reports.review']=true;f.review('stock');assert.equal(f.report.approval.currentStage,2);assert.equal(f.report.laborCost,0);
});
test('support task notifications follow the current assignee and disappear after cancellation or completion',()=>{
 const f=fixture(),task={id:'support-work',sourceTicketId:'ticket',assigneeId:'author',title:'پیگیری پشتیبانی',status:'open',dueDate:'2026-11-01'};f.project.tasks=[task];
 const notifications=id=>portalNotifications({...f.state,user:f.person(id)}).filter(item=>item.id==='support-task:'+task.id);
 assert.equal(notifications('author').length,1);assert.equal(notifications('unit').length,0);
 task.assigneeId='unit';assert.equal(notifications('author').length,0);assert.equal(notifications('unit')[0].href,'#reports');
 task.archivedAt='2026-11-01T00:00:00Z';assert.equal(notifications('unit').length,0);
 delete task.archivedAt;task.status='done';assert.equal(notifications('unit').length,0);
});

test('historically approved reports are immutable and both runtime copies share exactly the same workflow',async()=>{
 const f=fixture();f.report.status='approved';f.report.laborCost=1200000;const before=structuredClone(f.report);
 assert.throws(()=>f.review('manager'),error=>error.code==='IMMUTABLE_REPORT');assert.deepEqual(f.report,before);
 assert.equal(await readFile('public/report-approval.mjs','utf8'),await readFile('supabase/functions/arios-api/report-approval.mjs','utf8'));
});
