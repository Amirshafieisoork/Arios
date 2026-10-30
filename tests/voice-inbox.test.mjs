import test from 'node:test';import assert from 'node:assert/strict';
import {voiceInboxRows,voiceInboxGroups,renderVoiceInbox} from '../public/voice-inbox.mjs';
import {workspaceNextActions,renderWorkspaceNextActions} from '../public/workspace-hub.mjs';
const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const drafts=[{id:'old',status:'ready',userId:'w1',source:'telegram',createdAt:'2026-10-28T12:00:00Z',transcript:'كابل طبقه ۲',fields:{projectId:'p1'}},{id:'new',status:'failed',userId:'w2',source:'upload',createdAt:'2026-10-29T12:00:00Z',fields:{projectId:'p2'}},{id:'working',status:'processing',userId:'w1',fields:{projectId:'p1'}},{id:'saved',status:'submitted',userId:'w2',fields:{projectId:'p2'}}];
const ctx={e,n:String,date:String,icon:()=>'',personName:id=>id==='w1'?'علی':'مریم',projectName:id=>id==='p1'?'آفتاب':'سرو'};
const state={user:{id:'manager',role:'manager'},users:[{id:'w1',name:'علی'},{id:'w2',name:'مریم'}],projects:[{id:'p1',name:'آفتاب'},{id:'p2',name:'سرو'}]};
const memory={filter:'all',query:'',processingIds:new Set(),data:{drafts,integration:{aiConfigured:true}},canRetry:false};
test('voice inbox combines project, person, normalized Persian search and workflow stage without changing source drafts',()=>{
 const before=structuredClone(drafts);assert.deepEqual(voiceInboxRows(drafts,{filter:'attention'},ctx).map(d=>d.id),['new','old']);
 assert.deepEqual(voiceInboxRows(drafts,{query:'کابل طبقه 2',projectId:'p1',userId:'w1'},ctx).map(d=>d.id),['old']);
 assert.deepEqual(voiceInboxRows(drafts,{filter:'processing-group',query:'علی'},ctx).map(d=>d.id),['working']);
 assert.deepEqual(voiceInboxRows(drafts,{userId:'w1',projectId:'p2'},ctx),[]);assert.deepEqual(drafts,before);
});
test('voice workflow places required actions before conversion and submitted history',()=>{
 const groups=voiceInboxGroups(voiceInboxRows(drafts));assert.deepEqual(groups.map(g=>g.id),['attention','processing','submitted']);assert.deepEqual(groups.map(g=>g.rows.length),[2,1,1]);assert(!groups[2].detail.includes('تأییدشده'));
});
test('voice cards expose one clear next action per state, escaped transcript and no provider playback URL',()=>{
 const rows=structuredClone(drafts);rows[0].transcript='<img src=x onerror=bad()>';rows[0].audio={available:true};
 const html=renderVoiceInbox(state,ctx,{...memory,data:{...memory.data,drafts:rows}});
 assert.match(html,/data-voice-review="old"/);assert.match(html,/data-voice-retry="new"/);assert.match(html,/پیگیری گزارش ثبت‌شده/);assert.match(html,/data-voice-audio="old"/);assert.match(html,/&lt;img/);assert(!html.includes('<img src=x'));assert(!html.includes('storage/v1'));assert(!html.includes('data-voice-review="working"'));
 const worker=renderVoiceInbox({...state,user:{id:'w1',role:'worker'}},ctx,memory);assert(!worker.includes('data-voice-inbox-person'));assert(!worker.includes('data-voice-retry-all'));
});
test('inbox empty and filtered states tell the user how to continue',()=>{
 const empty=renderVoiceInbox(state,ctx,{...memory,data:{drafts:[]}});assert.match(empty,/data-voice-compose/);assert.match(empty,/هنوز ویسی دریافت نشده/);
 const filtered=renderVoiceInbox(state,ctx,{...memory,query:'nothingmatches'});assert.match(filtered,/موردی با این فیلتر پیدا نشد/);assert(!filtered.includes('data-voice-compose'));
});
test('dashboard next actions count only scoped employee tasks and reports, with role-appropriate destinations',()=>{
 const worker={user:{id:'w1',role:'worker'},projects:[{id:'p1',memberIds:['w1','w2'],tasks:[{assigneeId:'w1',dueDate:'2026-10-29',status:'open'},{assigneeId:'w2',dueDate:'2026-10-29',status:'open'},{assigneeId:'w1',dueDate:'2026-10-28',status:'done'}]}],reports:[{workerId:'w1',status:'changes_requested'},{workerId:'w2',status:'changes_requested'}]};
 const actions=workspaceNextActions(worker,{today:'2026-10-29'});assert.equal(actions[0].count,1);assert.equal(actions[2].count,1);assert(!actions.some(a=>a.href==='#team'||a.href==='#finance'));
 assert.deepEqual(workspaceNextActions({...worker,user:{id:'customer',role:'customer'}}),[]);assert.equal(renderWorkspaceNextActions({...worker,user:{role:'warehouse'}},ctx),'');assert.match(renderWorkspaceNextActions(worker,ctx),/از کجا شروع کنم/);
});
