import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState } from '../public/domain.mjs';
import { createAccount, manager } from '../supabase/functions/arios-api/auth.mjs';
import { workspaceState } from '../supabase/functions/arios-api/account-state.mjs';
import { buildReminderPlans, dispatchNightlyReminders } from '../supabase/functions/arios-api/reminder-service.mjs';
import { handleProjectFiles } from '../supabase/functions/arios-api/project-files.mjs';

const tomorrow = '2026-10-27';
const archivedAt = '2026-10-26T17:00:00.000Z';

test('archived users retain profile links and historical identity without appearing login-enabled', async () => {
  const state = createSeedState();
  state.users.find(user => user.id === 'worker').deletedAt = archivedAt;
  const before = structuredClone(state);
  const snapshot = await workspaceState({ listProfileLinks: async () => [
    { domain_user_id: 'manager', role: 'manager' },
    { domain_user_id: 'worker', role: 'worker' },
  ] }, state, 'manager');
  const archived = snapshot.users.find(user => user.id === 'worker');
  assert.equal(archived.deletedAt, archivedAt);
  assert.equal(archived.loginEnabled, false);
  assert.equal(snapshot.users.find(user => user.id === 'manager').loginEnabled, true);
  assert.deepEqual(state, before);
});

test('account creation cannot attach new identities to archived projects or run as a deleted manager', async () => {
  const state = createSeedState();
  state.projects[0].archivedAt = archivedAt;
  let creates = 0;
  const client = { auth: { admin: { createUser: async () => { creates++; } } } };
  const repo = { rateLimit: async () => ({ allowed: true }), loadState: async () => ({ state, revision: 1 }) };
  const actor = state.users.find(user => user.id === 'manager');
  await assert.rejects(createAccount(client, repo, actor, {
    name: 'همکار تازه', role: 'worker', phone: '09351234567', password: 'simple6', projectIds: ['p1'],
  }), error => error.code === 'PROJECT_ARCHIVED');
  assert.equal(creates, 0, 'No external Auth account exists after failed assignment validation');
  assert.throws(() => manager({ ...actor, deletedAt: archivedAt }), error => error.status === 403);
});

test('archived projects and individual archived tasks are absent from nightly reminders and recover without losing assignments', () => {
  const state = createSeedState();
  const project = state.projects[0];
  const task = { id: 'tomorrow-task', title: 'کار فردا', assigneeId: 'worker', dueDate: tomorrow, status: 'open' };
  project.tasks = [task];
  const links = [{ user_id: 'worker', chat_id: '12345', telegram_user_id: '12345' }];
  assert.equal(buildReminderPlans(state, links, tomorrow).length, 1);
  task.archivedAt = archivedAt;
  assert.equal(buildReminderPlans(state, links, tomorrow).length, 0);
  delete task.archivedAt;
  project.archivedAt = archivedAt;
  assert.equal(buildReminderPlans(state, links, tomorrow).length, 0);
  delete project.archivedAt;
  assert.equal(buildReminderPlans(state, links, tomorrow)[0].taskCount, 1);
  assert.equal(task.assigneeId, 'worker');
});

function filesFixture() {
  const state = createSeedState(), project = state.projects[0], signed = [];
  project.files = [{
    id: 'evidence', name: 'evidence.png', mimeType: 'image/png', size: 8,
    uploadedBy: 'worker', status: 'ready', storagePath: 'projects/p1/worker/evidence.png', clientVisible: true,
  }];
  const repo = {
    loadState: async () => ({ state: structuredClone(state) }),
    rateLimit: async () => ({ allowed: true }),
    mutateState: async callback => {
      const draft=structuredClone(state),result=await callback(draft);
      for(const key of Object.keys(state))delete state[key];Object.assign(state,draft);
      return { result, state };
    },
  };
  const bucket = {
    createSignedUrl: async path => { signed.push(path); return { data: { signedUrl: 'https://private.example/' + path } }; },
    createSignedUploadUrl: async path => { signed.push(path); return { data: { signedUrl: 'https://upload.example/' + path } }; },
  };
  const handle = (id, operation = 'download', payload = {}) => handleProjectFiles({
    repo, supabase: { storage: { from: () => bucket } }, user: state.users.find(user => user.id === id),
    request: new Request('https://arios.example/api/project-files/' + operation, { method: 'POST' }),
    path: '/api/project-files/' + operation,
    readJSON: async () => ({ projectId: 'p1', id: 'evidence', fileName: 'upload.png', mimeType: 'image/png', size: 8, ...payload }),
    json: value => value,
  });
  return { state, project, repo, handle, signed };
}

test('archived project evidence remains manager-readable while members and customers lose file access and all uploads stop', async () => {
  const f = filesFixture();
  f.project.archivedAt = archivedAt;
  for (const id of ['worker', 'customer']) for (const operation of ['download', 'upload-url', 'complete']) {
    await assert.rejects(f.handle(id, operation), error => error.status === 403);
  }
  for (const operation of ['upload-url', 'complete']) {
    await assert.rejects(f.handle('manager', operation), error => error.code === 'PROJECT_ARCHIVED');
  }
  assert.equal(f.signed.length, 0);
  assert.equal((await f.handle('manager')).expiresIn, 90);
  assert.deepEqual(f.signed, ['projects/p1/worker/evidence.png']);
  delete f.project.archivedAt;
  await f.handle('worker');
  await f.handle('customer');
  assert.equal(f.signed.length, 3);
});

test('an archive committed after the initial upload read is rechecked inside the state transaction', async () => {
  const f = filesFixture();
  f.repo.mutateState = async callback => {
    f.project.archivedAt = archivedAt;
    return { result: await callback(f.state), state: f.state };
  };
  await assert.rejects(f.handle('manager', 'upload-url'), error => error.code === 'PROJECT_ARCHIVED');
  assert.equal(f.signed.length, 0);
  assert.equal(f.project.files.length, 1);
});

test('manager edits and removes documents reversibly without mutating stored evidence or frozen reports', async () => {
  const f=filesFixture();
  f.project.dossierSubmission={id:'signed-1',snapshot:{reports:[{id:'frozen-report',photoIds:['evidence']}],title:'Original document'},approval:{stages:[]}};
  const frozen=structuredClone(f.project.dossierSubmission),storedPath=f.project.files[0].storagePath;
  const renamed=await f.handle('manager','update',{changes:{name:'تحویل نهایی.png',clientVisible:false}});
  assert.equal(renamed.file.name,'تحویل نهایی.png');assert.equal(renamed.file.clientVisible,false);
  assert.equal(renamed.file.storagePath,undefined);
  assert.equal(f.state.projects[0].files[0].storagePath,storedPath);
  const archived=await f.handle('manager','archive');
  assert.equal(archived.archived,true);assert(archived.file.archivedAt);assert.equal(archived.file.archivedBy,'manager');
  assert.equal(f.state.projects[0].files[0].status,'ready');
  await assert.rejects(f.handle('manager','update',{changes:{name:'فایل.png'}}),error=>error.code==='FILE_ARCHIVED');
  const restored=await f.handle('manager','restore');assert.equal(restored.archived,false);assert.equal(restored.file.archivedAt,undefined);
  assert.deepEqual(f.state.projects[0].dossierSubmission,frozen);
  assert.deepEqual(f.state.audit.slice(-3).map(entry=>entry.action),['project.file.update','project.file.archive','project.file.restore']);
  assert.equal(f.signed.length,0);
});

test('file metadata mutations are manager-only, atomic and cannot change paths, media types or extensions', async () => {
  for(const role of ['worker','customer'])for(const operation of ['update','archive','restore']){
    const f=filesFixture(),before=structuredClone(f.state);
    await assert.rejects(f.handle(role,operation,{changes:{name:'test.png'}}),error=>error.status===403);
    assert.deepEqual(f.state,before);
  }
  for(const changes of [{storagePath:'another/path'},{mimeType:'application/pdf'},{name:'malware.pdf'},{name:'../file.png'},{name:'valid.png',clientVisible:'yes'}]){
    const f=filesFixture(),before=structuredClone(f.state);
    await assert.rejects(f.handle('manager','update',{changes}));assert.deepEqual(f.state,before);
  }
});

test('archived file download is hidden normally while exact authorized approved and frozen evidence remains readable', async () => {
  const f=filesFixture();
  f.project.files[0].archivedAt=archivedAt;
  await assert.rejects(f.handle('worker'),error=>error.status===403);
  await assert.rejects(f.handle('customer'),error=>error.status===403);
  await f.handle('manager');
  f.state.reports.push({id:'evidence-report',projectId:'p1',workerId:'worker',status:'approved',photoIds:['evidence']});
  await f.handle('worker');
  await assert.rejects(f.handle('worker2'),error=>error.status===403,'Other members cannot discover an archived private document through someone else’s report');
  f.state.users.push({id:'historical-reviewer',name:'تأییدکنندهٔ نسخه',role:'worker'});
  f.project.dossierSubmissionHistory=[{id:'history-1',snapshot:{reports:[{id:'frozen-1',photoIds:['evidence']}]},approval:{stages:[{userId:'historical-reviewer'}]}}];
  await f.handle('historical-reviewer');
  f.project.dossierSubmissionHistory[0].snapshot.reports[0].photoIds=[];
  await assert.rejects(f.handle('historical-reviewer'),error=>error.status===403);
});

test('project removal after a queued nightly reminder is claimed cancels delivery before Telegram is called', async () => {
  const at=Date.parse('2026-10-26T17:30:00.000Z'),state=createSeedState();
  state.projects[0].tasks=[{id:'next',title:'فردا',assigneeId:'worker',dueDate:tomorrow,status:'open'}];
  let claimed=false,outcome;
  const repo={
    getSetting:async()=>({enabled:true}),loadState:async()=>({state:structuredClone(state)}),
    listTelegramLinks:async()=>[{user_id:'worker',chat_id:'12345',telegram_user_id:'12345'}],
    acquireLock:async()=>true,releaseLock:async()=>{},enqueueReminders:async()=>{},
    claimReminder:async()=>{if(claimed)return null;claimed=true;state.projects[0].archivedAt=archivedAt;return{id:'queued',user_id:'worker',chat_id:'12345'};},
    finishReminder:async value=>{outcome=value;return true;},
  };
  const summary=await dispatchNightlyReminders({repo,config:{telegramBotToken:'test-only-token'},at,clock:()=>at,pause:async()=>{},fetcher:async()=>assert.fail('Archived project cannot trigger a Telegram message')});
  assert.equal(summary.cancelled,1);assert.equal(outcome.status,'cancelled');assert.equal(outcome.errorCode,'ASSIGNMENT_OR_LINK_CHANGED');
});
