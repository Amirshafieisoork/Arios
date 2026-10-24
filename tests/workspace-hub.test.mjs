import test from 'node:test';
import assert from 'node:assert/strict';
import {customerOverview,calendarEvents,projectDocuments,persianMonth,renderWorkspaceHub,wireWorkspaceHub} from '../public/workspace-hub.mjs';
import {allowedPortalPage,portalNavigation} from '../public/access.mjs';
import {createSeedState,publicState} from '../public/domain.mjs';

const ctx = {e:value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),n:String,date:String,today:() => '2026-10-24'};
function seed() {
  const state = createSeedState();
  state.projects.find(project => project.id === 'p1').tasks = [{id:'task-public',title:'تست تحویل',status:'open',dueDate:'2026-10-25',assigneeId:'worker',version:1}];
  state.projects.find(project => project.id === 'p1').files = [
    {id:'visible-file',status:'ready',name:'نقشه نهایی.pdf',mimeType:'application/pdf',size:2048,clientVisible:true,uploadedBy:'manager',createdAt:'2026-10-24T10:00:00Z'},
    {id:'internal-file',status:'ready',name:'مدرک داخلی.pdf',mimeType:'application/pdf',size:4096,clientVisible:false,uploadedBy:'manager',createdAt:'2026-10-24T11:00:00Z'},
    {id:'pending-file',status:'uploading',name:'بارگذاری ناتمام.pdf',clientVisible:true,uploadedBy:'manager'},
  ];
  state.projects.find(project => project.id === 'p2').files = [{id:'other-project-file',status:'ready',name:'مدرک پروژه دیگر.pdf',mimeType:'application/pdf',size:1000,clientVisible:true,uploadedBy:'manager',createdAt:'2026-10-24T09:00:00Z'}];
  return state;
}

test('customer sales summary uses only linked project invoices and preserves real zero-project accounts',() => {
  const state = {user:{role:'manager'},users:[{id:'c1',role:'customer',name:'مشتری اول',phone:'+989121234567'},{id:'c2',role:'customer',name:'مشتری بدون پروژه',deletedAt:'2026-10-01'},{id:'worker',role:'worker'}],projects:[{id:'p1',customerId:'c1',name:'پروژه اول'},{id:'p2',customerId:null,name:'پروژه بدون مشتری'}],invoices:[{projectId:'p1',amount:1000,paid:400},{projectId:'p1',amount:2000,paid:2000},{projectId:'p2',amount:99999,paid:0},{projectId:'inaccessible',amount:1000000,paid:0}]};
  const customers = customerOverview(state);
  assert.equal(customers.length,2);assert.deepEqual(customers.map(({issued,paid,due}) => ({issued,paid,due})),[{issued:3000,paid:2400,due:600},{issued:0,paid:0,due:0}]);
  assert.equal(customers[1].archived,true);assert.deepEqual(customers[1].projects,[]);
  for (const role of ['worker','customer','warehouse','accountant']) assert.deepEqual(customerOverview({...state,user:{role}}),[]);
});

test('global documents and calendar inherit actual scoped API projections',() => {
  const state = seed(),customer = publicState(state,'customer'),worker = publicState(state,'worker');
  const customerFiles = projectDocuments(customer);
  assert.deepEqual(customerFiles.map(file => file.id),['visible-file']);
  assert.deepEqual(projectDocuments(publicState(state,'manager')).map(file => file.id),['internal-file','visible-file','other-project-file']);
  assert(!calendarEvents(customer).some(event => event.kind === 'task' || event.kind === 'report'));
  assert(calendarEvents(worker).some(event => event.id === 'task:task-public'));
  assert(calendarEvents(customer).every(event => event.projectId === 'p1'));
  worker.reports.push({id:'orphan-report',projectId:'not-in-snapshot',date:'2026-10-24'});
  assert(!calendarEvents(worker).some(event => event.id === 'report:orphan-report'));
  assert(!projectDocuments(worker).some(file => file.id === 'other-project-file'));
});

test('Persian month navigation crosses Nowruz and leap-year month boundaries without Gregorian drift',() => {
  const aban = persianMonth('2026-10-24');assert.equal(aban.start,'2026-10-23');assert.equal(aban.end,'2026-11-21');assert.equal(aban.days.length,30);
  const previous = persianMonth('2026-10-24',-1);assert.equal(previous.end,'2026-10-22');assert.equal(previous.days.length,30);
  const leap = persianMonth('2025-03-01');assert.equal(leap.year,1403);assert.equal(leap.month,12);assert.equal(leap.days.length,30);
  const nowruz = persianMonth('2025-03-01',1);assert.equal(nowruz.year,1404);assert.equal(nowruz.month,1);assert.equal(nowruz.start,'2025-03-21');assert.equal(nowruz.days.length,31);
  assert.equal(persianMonth('invalid'),null);assert.equal(persianMonth('2026-10-24',0.5),null);
});

test('calendar rejects impossible dates and distinguishes actual starts, deliveries, task deadlines and report dates',() => {
  const state = {user:{role:'manager'},users:[],projects:[{id:'p1',name:'پروژه',startDate:'2026-02-31',endDate:'2026-10-25',tasks:[{id:'t1',title:'وظیفه',dueDate:null,status:'open'},{id:'t2',title:'وظیفه موعددار',dueDate:'2026-10-24',status:'done'}]}],reports:[{id:'r1',projectId:'p1',date:'2026-10-23',status:'approved'}]};
  const events = calendarEvents(state);assert.deepEqual(events.map(event => event.id),['report:r1','task:t2','end:p1']);assert.equal(events[1].status,'done');assert(events[1].href.endsWith('/tasks'));
});

test('new global routes and navigation enforce roles and escape stored names in rendered views',() => {
  for (const role of ['warehouse','accountant']) for (const page of ['customers','calendar','documents']) {
    assert.equal(allowedPortalPage(page,role),false);assert.match(renderWorkspaceHub(page,{user:{role}},ctx),/در دسترس نیست/);
    wireWorkspaceHub(page,{user:{role}},ctx,{root:{querySelector(){throw Error('must not mount');}}});
    const navigation = portalNavigation(role);assert(![...navigation.main,...navigation.links].some(([id]) => id === page));
  }
  for (const role of ['manager','worker','customer']) for (const page of ['calendar','documents']) assert(allowedPortalPage(page,role));
  assert(!allowedPortalPage('customers','customer'));assert(allowedPortalPage('customers','manager'));
  const state = publicState(seed(),'manager');state.users.find(user => user.role === 'customer').name = '<script>customer</script>';
  state.projects.find(project => project.id === 'p1').files[0].name = '<img onerror=alert(1)>';
  assert(!renderWorkspaceHub('customers',state,ctx).includes('<script>'));assert(renderWorkspaceHub('customers',state,ctx).includes('&lt;script&gt;'));
  assert(!renderWorkspaceHub('documents',state,ctx).includes('<img onerror'));assert(renderWorkspaceHub('documents',state,ctx).includes('&lt;img onerror'));
  assert(renderWorkspaceHub('calendar',state,ctx).includes('aria-label="ماه قبل"'));
  assert(renderWorkspaceHub('calendar',state,ctx).includes('data-hub-day="2026-10-24"'));
});
