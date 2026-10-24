import test from 'node:test';
import assert from 'node:assert/strict';
import {requestLeads,updateLeadStatus,filterLeads,renderLeads,wireLeads} from '../public/leads.mjs';
import {allowedPortalPage,portalNavigation} from '../public/access.mjs';

const lead = extra => ({id:'lead-1',name:'مینا احمدی',phone:'+989121234567',message:'مشاورهٔ شبکه',status:'new',createdAt:'2026-10-24T10:00:00Z',updatedAt:'2026-10-24T10:00:00Z',...extra});
const json = (body,status = 200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const tick = () => new Promise(resolve => setImmediate(resolve));
function node(extra = {}) { return {innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',events:{},addEventListener(event,callback){this.events[event] = callback;},setAttribute(name,value){this[name] = value;},...extra}; }
function mount() {
  const nodes = Object.fromEntries(['metrics','list','error','notice','reload','search','filter'].map(name => [`[data-leads-${name}]`,node()]));
  const buttons = [];
  nodes['[data-leads-filter]'].value = 'all';
  nodes['[data-leads-list]'].querySelectorAll = () => buttons;
  return {root:{isConnected:true,querySelector:selector => nodes[selector]},nodes,buttons};
}

test('consultation inbox and navigation are manager-only, including direct route mounting',() => {
  for (const role of ['worker','customer','warehouse','accountant']) {
    assert.equal(allowedPortalPage('leads',role),false,role);
    assert(!portalNavigation(role).main.some(([page]) => page === 'leads'));
    assert.match(renderLeads({user:{role}}),/در دسترس نیست/);
    let calls = 0;wireLeads({user:{role}},{},{root:{querySelector(){throw Error('must not mount');}},fetcher:async () => calls++});
    assert.equal(calls,0);
  }
  assert(allowedPortalPage('leads','manager'));
  assert(portalNavigation('manager').main.some(([page]) => page === 'leads'));
});

test('consultation requests use authenticated same-origin routes and confirm the returned saved status',async () => {
  const calls = [],fetcher = async (url,options) => {calls.push({url,options});return json(url.endsWith('/status') ? {lead:lead({status:'contacted'})} : {leads:[lead()]});};
  assert.deepEqual(await requestLeads({fetcher}),[lead()]);
  assert.equal(calls[0].url,'/api/leads');assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal((await updateLeadStatus('lead-1','contacted',{fetcher})).status,'contacted');
  assert.equal(calls[1].url,'/api/leads/lead-1/status');assert.equal(calls[1].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body),{status:'contacted'});
  await assert.rejects(updateLeadStatus('lead-1','contacted',{fetcher:async () => json({lead:lead({status:'new'})})}),/تأیید نشد/);
  await assert.rejects(updateLeadStatus('lead-1','unknown',{fetcher}),/معتبر نیست/);
  assert.equal(calls.length,2);
});

test('phone searches accept Persian digits and status filtering does not mutate saved records',() => {
  const rows = [lead(),lead({id:'lead-2',name:'علي',phone:'+989351234567',status:'closed'})];
  assert.deepEqual(filterLeads(rows,{query:'۹۱۲ ۱۲۳۴۵۶۷'}).map(row => row.id),['lead-1']);
  assert.deepEqual(filterLeads(rows,{query:'علی',status:'closed'}).map(row => row.id),['lead-2']);
  assert.deepEqual(filterLeads(rows,{status:'contacted'}),[]);
  assert.equal(rows[0].status,'new');
});

test('manager inbox escapes submitted content and retains the old status after a failed save',async () => {
  const {root,nodes,buttons} = mount(),button = node({dataset:{leadId:'lead-1',leadStatus:'contacted'}});buttons.push(button);
  const submitted = lead({name:'<img src=x onerror=alert(1)>',message:'<script>private input</script>'});
  let failSave = true;
  const fetcher = async (url) => url.endsWith('/status') ? failSave ? json({error:'private provider body'},503) : json({lead:{...submitted,status:'contacted'}}) : json({leads:[submitted]});
  wireLeads({user:{role:'manager'}},{},{root,fetcher});await tick();
  const list = nodes['[data-leads-list]'];
  assert(!list.innerHTML.includes('<img src=x'));assert(list.innerHTML.includes('&lt;img src=x'));
  assert(!list.innerHTML.includes('<script>'));assert(list.innerHTML.includes('tel:+989121234567'));
  assert(list.innerHTML.includes('در انتظار تماس'));
  button.events.click();await tick();
  assert(list.innerHTML.includes('در انتظار تماس'));assert(!list.innerHTML.includes('lead-status--contacted'));
  assert.equal(nodes['[data-leads-error]'].hidden,false);assert(!nodes['[data-leads-error]'].textContent.includes('provider'));
  assert.equal(button.disabled,false);
  failSave = false;button.events.click();await tick();
  assert(list.innerHTML.includes('lead-status--contacted'));assert.match(nodes['[data-leads-notice]'].textContent,/ذخیره شد/);
});

test('failed initial load offers retry, detached views stay unchanged, and demo never fetches real leads',async () => {
  const mounted = mount();let success = false;
  wireLeads({user:{role:'manager'}},{},{root:mounted.root,fetcher:async () => success ? json({leads:[]}) : json({error:'private'},500)});
  await tick();assert.equal(mounted.nodes['[data-leads-error]'].hidden,false);assert.match(mounted.nodes['[data-leads-list]'].innerHTML,/تازه‌سازی/);
  success = true;mounted.nodes['[data-leads-reload]'].events.click();await tick();
  assert.match(mounted.nodes['[data-leads-list]'].innerHTML,/هنوز درخواست مشاوره‌ای/);
  const detached = mount();let complete;
  const stop = wireLeads({user:{role:'manager'}},{},{root:detached.root,fetcher:() => new Promise(resolve => complete = resolve)});
  detached.root.isConnected = false;complete(json({leads:[lead()]}));await tick();
  assert(!detached.nodes['[data-leads-list]'].innerHTML.includes('مینا'));stop();
  const demo = mount();let calls = 0;
  wireLeads({user:{role:'manager'}},{demo:true},{root:demo.root,fetcher:async () => calls++});
  assert.equal(calls,0);assert.match(demo.nodes['[data-leads-list]'].innerHTML,/نسخهٔ نمایشی/);
});

test('malformed lead lists and unsafe telephone values cannot become callable records',async () => {
  for (const record of [lead({phone:'javascript:alert(1)'}),lead({status:'unknown'}),lead({createdAt:'invalid'})]) {
    await assert.rejects(requestLeads({fetcher:async () => json({leads:[record]})}),/کامل دریافت نشد/);
  }
  await assert.rejects(requestLeads({fetcher:async () => json({error:'private account details'},403)}),/حساب مدیر/);
});
