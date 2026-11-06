import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyAction,createSeedState,publicState} from '../public/domain.mjs';
import {applySupportAction,supportTicketSnapshot,supportTicketVisible} from '../public/support-workflow.mjs';
import {renderSupportWorkspace} from '../public/support-workspace.mjs';
import {buildReminderPlans} from '../supabase/functions/arios-api/reminder-service.mjs';

const day='2026-11-02';
const fixture=()=>{
 const state=createSeedState();state.tickets=[];for(const project of state.projects)project.tasks=[];
 const ticket=applyAction(state,'customer','ticket.create',{projectId:'p1',subject:'تنظیم اتصال دوربین',description:'اتصال تصاویر روی گوشی بررسی شود.',priority:'normal'});
 return {state,id:ticket.id};
};
const ticket=(state,id)=>state.tickets.find(row=>row.id===id);
const taskFor=(state,id)=>{const row=ticket(state,id);return state.projects.find(project=>project.id===row.projectId).tasks.find(task=>task.id===row.taskId);};
const act=(state,actor,action,id,extra={})=>applyAction(state,actor,action,{id,version:ticket(state,id).version,...extra});
const approve=(state,id)=>act(state,'manager','ticket.approve',id,{note:'بررسی و تأیید شد.'});
const assign=(state,id,assigneeId='worker',extra={})=>act(state,'manager','ticket.assign',id,{assigneeId,dueDate:day,note:'فردا با مسئول پروژه هماهنگ کنید.',...extra});
function unchanged(state,run,code){const before=structuredClone(state);assert.throws(run,error=>!code||error.code===code,code);assert.deepEqual(state,before);}

test('a support request becomes exactly one persisted personal task only after approval and assignment',()=>{
 const {state,id}=fixture();assert.equal(ticket(state,id).approvalStatus,'pending');assert.equal(state.projects[0].tasks.length,0);
 unchanged(state,()=>assign(state,id),'SUPPORT_APPROVAL_REQUIRED');approve(state,id);assert.equal(state.projects[0].tasks.length,0);
 assign(state,id);const row=ticket(state,id),task=taskFor(state,id);
 assert.equal(row.approvalStatus,'approved');assert.equal(row.approvedBy,'manager');assert.equal(row.assigneeId,'worker');assert.equal(row.assignmentStatus,'assigned');
 assert.equal(task.sourceTicketId,id);assert.equal(task.assigneeId,'worker');assert.equal(task.dueDate,day);assert.equal(task.status,'open');assert(task.description.includes(row.assignmentNote));
 const own=publicState(state,'worker');assert(own.tickets.some(t=>t.id===id));assert(own.projects.find(p=>p.id==='p1').tasks.some(t=>t.id===task.id&&t.sourceTicketId===id));
 const colleague=publicState(state,'worker2');assert(!colleague.tickets.some(t=>t.id===id));assert(!colleague.projects.find(p=>p.id==='p1').tasks.some(t=>t.sourceTicketId===id),'a private support description must not leak through another member project-task list');assert(!publicState(state,'customer2').tickets.some(t=>t.id===id));
});

test('approval and assignment reject self-service, outsiders, forged fields and inactive or unrelated assignees atomically',()=>{
 const {state,id}=fixture();
 for(const actor of ['customer','worker','worker2','customer2'])unchanged(state,()=>act(state,actor,'ticket.approve',id),'FORBIDDEN');
 approve(state,id);
 for(const actor of ['customer','worker','worker2'])unchanged(state,()=>act(state,actor,'ticket.assign',id,{assigneeId:actor,dueDate:day}),'FORBIDDEN');
 for(const assigneeId of ['customer','worker3','missing'])unchanged(state,()=>assign(state,id,assigneeId),'INVALID_SUPPORT_ASSIGNEE');
 state.users.find(user=>user.id==='worker2').deletedAt=new Date().toISOString();unchanged(state,()=>assign(state,id,'worker2'),'INVALID_SUPPORT_ASSIGNEE');
 unchanged(state,()=>act(state,'manager','ticket.assign',id,{assigneeId:'worker',dueDate:'2026-02-30'}),'INVALID_SUPPORT_ACTION');
 unchanged(state,()=>act(state,'manager','ticket.assign',id,{assigneeId:'worker',dueDate:day,approvalStatus:'approved'}),'INVALID_SUPPORT_ACTION');
});

test('fresh duplicate assignments are idempotent and stale assignments cannot change the task',()=>{
 const {state,id}=fixture();approve(state,id);const version=ticket(state,id).version;assign(state,id);const taskId=taskFor(state,id).id;
 const before=structuredClone(state);assign(state,id);assert.deepEqual(state,before);assert.equal(state.projects[0].tasks.length,1);
 unchanged(state,()=>applyAction(state,'manager','ticket.assign',{id,version,assigneeId:'worker2',dueDate:day}),'VERSION_CONFLICT');assert.equal(taskFor(state,id).id,taskId);
});

test('reassignment moves the same task and removes the prior assignee from the ticket and personal-task projection',()=>{
 const {state,id}=fixture();approve(state,id);assign(state,id);const original=taskFor(state,id).id;
 assign(state,id,'worker2');assert.equal(taskFor(state,id).id,original);assert.equal(state.projects[0].tasks.length,1);
 assert.equal(ticket(state,id).assigneeId,'worker2');assert(!publicState(state,'worker').tickets.some(t=>t.id===id));
 assert(!publicState(state,'worker').projects.find(p=>p.id==='p1').tasks.some(t=>t.sourceTicketId===id&&t.assigneeId==='worker'));
 assert(publicState(state,'worker2').tickets.some(t=>t.id===id));assert.equal(ticket(state,id).assignmentHistory.at(-1).fromAssigneeId,'worker');
});

test('assigned-user status changes from either the ticket or ordinary task control synchronize both records',()=>{
 const {state,id}=fixture();approve(state,id);assign(state,id);const first=taskFor(state,id);
 unchanged(state,()=>applyAction(state,'worker2','task.update',{projectId:'p1',id:first.id,version:first.version,status:'done'}),'FORBIDDEN');
 unchanged(state,()=>applyAction(state,'worker','task.update',{projectId:'p1',id:first.id,version:first.version,status:'done',assigneeId:'worker2'}),'INVALID_SUPPORT_ACTION');
 applyAction(state,'worker','task.update',{projectId:'p1',id:first.id,version:first.version,status:'in_progress'});
 assert.equal(ticket(state,id).status,'in_progress');assert.equal(ticket(state,id).assignmentStatus,'in_progress');
 act(state,'worker','ticket.work.update',id,{status:'done'});assert.equal(taskFor(state,id).status,'done');assert.equal(ticket(state,id).status,'resolved');assert.equal(ticket(state,id).assignmentStatus,'completed');
});

test('cancellation archives the linked task and prevents stale or direct reactivation',()=>{
 const {state,id}=fixture();approve(state,id);assign(state,id);const task=structuredClone(taskFor(state,id));
 act(state,'manager','ticket.unassign',id,{note:'زمان اجرای درخواست تغییر کرد.'});
 assert.equal(ticket(state,id).assigneeId,null);assert.equal(ticket(state,id).assignmentStatus,'cancelled');assert(taskFor(state,id).archivedAt);
 assert(!publicState(state,'worker').tickets.some(row=>row.id===id));assert(!publicState(state,'worker').projects.find(p=>p.id==='p1').tasks.some(row=>row.id===task.id));
 unchanged(state,()=>applyAction(state,'worker','task.update',{projectId:'p1',id:task.id,version:task.version,status:'open'}),'SUPPORT_ASSIGNMENT_CHANGED');
 unchanged(state,()=>applyAction(state,'manager','admin.record.restore',{collection:'tasks',id:task.id,projectId:'p1',reason:'بازیابی'}),'SUPPORT_TASK_LINKED');
 assign(state,id,'worker2');assert.equal(taskFor(state,id).id,task.id);assert.equal(taskFor(state,id).archivedAt,undefined);assert.equal(taskFor(state,id).assigneeId,'worker2');
});

test('editing ticket details keeps assignment instructions and task linkage; deleting or restoring the ticket cancels the old assignment',()=>{
 const {state,id}=fixture();approve(state,id);assign(state,id);const original=taskFor(state,id).id;
 act(state,'manager','ticket.update',id,{subject:'عنوان اصلاح‌شده',description:'شرح تازهٔ بررسی'});
 assert.equal(taskFor(state,id).title,'پشتیبانی: عنوان اصلاح‌شده');assert(taskFor(state,id).description.includes('شرح تازهٔ بررسی'));assert(taskFor(state,id).description.includes(ticket(state,id).assignmentNote));
 applyAction(state,'manager','admin.record.archive',{collection:'tickets',id,version:ticket(state,id).version,reason:'تکراری'});
 assert(taskFor(state,id).archivedAt);assert.equal(ticket(state,id).assigneeId,null);
 applyAction(state,'manager','admin.record.restore',{collection:'tickets',id,version:ticket(state,id).version,reason:'اصلاح حذف'});
 assert.equal(ticket(state,id).status,'open');assert.equal(ticket(state,id).assigneeId,null);assert.equal(taskFor(state,id).id,original);assert(taskFor(state,id).archivedAt);
});

test('generic admin task or ticket edits cannot bypass the support approval and assignment workflow',()=>{
 const {state,id}=fixture();approve(state,id);assign(state,id);const task=taskFor(state,id);
 unchanged(state,()=>applyAction(state,'manager','admin.record.update',{collection:'tasks',projectId:'p1',id:task.id,version:task.version,reason:'تغییر مسیر',changes:{assigneeId:'worker2'}}));
 unchanged(state,()=>applyAction(state,'manager','admin.record.update',{collection:'tickets',id,version:ticket(state,id).version,reason:'بستن مستقیم',changes:{status:'resolved'}}),'SUPPORT_WORKFLOW_REQUIRED');
});

test('a delegated assigner sees approved scoped tickets but still cannot approve or assign another project',()=>{
 const {state,id}=fixture();const worker=state.users.find(u=>u.id==='worker2');worker.permissions={'support.assign':true};
 approve(state,id);assert(supportTicketVisible(ticket(state,id),worker,state));assert(publicState(state,'worker2').tickets.some(t=>t.id===id));
 unchanged(state,()=>act(state,'worker2','ticket.approve',id),'FORBIDDEN');
 act(state,'worker2','ticket.assign',id,{assigneeId:'worker',dueDate:day});assert.equal(taskFor(state,id).assigneeId,'worker');
 const other=applyAction(state,'customer2','ticket.create',{projectId:'p3',subject:'درخواست دیگر',description:'شرح دیگر'});approve(state,other.id);
 unchanged(state,()=>act(state,'worker2','ticket.assign',other.id,{assigneeId:'worker3',dueDate:day}),'FORBIDDEN');
});

test('canonical support permissions defeat supplied actor escalation and snapshots escape untrusted text',()=>{
 const {state,id}=fixture();const actor=state.users.find(u=>u.id==='worker');
 const before=structuredClone(state);assert.throws(()=>applySupportAction(state,{id:actor.id,role:'manager',permissions:{'support.manage':true}},'ticket.approve',{id,version:ticket(state,id).version}),error=>error.code==='FORBIDDEN');assert.deepEqual(state,before);
 const row=ticket(state,id);row.subject='<img src=x onerror=alert(1)>';row.privateSecret='NEVER_EXPOSE';row.assignmentNote='<script>bad()</script>';
 assert(!JSON.stringify(supportTicketSnapshot(row)).includes('NEVER_EXPOSE'));
 const projected=publicState(state,'manager'),e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const html=renderSupportWorkspace(projected,{e,n:String,date:String});assert(!html.includes('<img src=x'));assert(!html.includes('<script>bad()'));assert(html.includes('&lt;img'));
});

test('support workflow source stays identical in the browser model and Edge backend',async()=>{
 assert.equal(await readFile('public/support-workflow.mjs','utf8'),await readFile('supabase/functions/arios-api/support-workflow.mjs','utf8'));
});
test('support reminders include approved tomorrow work once per staff member and omit empty, cancelled or inconsistent links',()=>{
 const {state,id}=fixture();approve(state,id);assign(state,id);
 const links=[{user_id:'worker',chat_id:'1001',telegram_user_id:'1001'},{user_id:'worker2',chat_id:'1002',telegram_user_id:'1002'},{user_id:'manager',chat_id:'1003',telegram_user_id:'1003'}];
 let plans=buildReminderPlans(state,links,day);assert.equal(plans.length,1);assert.equal(plans[0].userId,'worker');assert.equal(plans[0].taskCount,1);assert(plans[0].body.includes(ticket(state,id).subject));
 const normal=structuredClone(state);
 for(const change of [s=>{ticket(s,id).approvalStatus='pending';},s=>{ticket(s,id).archivedAt='now';},s=>{ticket(s,id).status='resolved';},s=>{ticket(s,id).taskId='wrong-task';},s=>{ticket(s,id).assigneeId='worker2';},s=>{ticket(s,id).dueDate='2026-11-03';}]){const altered=structuredClone(normal);change(altered);assert.deepEqual(buildReminderPlans(altered,links,day),[]);}
 act(state,'manager','ticket.unassign',id,{note:'لغو انجام کار'});assert.deepEqual(buildReminderPlans(state,links,day),[]);
 assign(state,id,'manager');plans=buildReminderPlans(state,links,day);assert.equal(plans.length,1);assert.equal(plans[0].userId,'manager');
});
