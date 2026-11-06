import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSeedState,applyAction,publicState,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
import {SERVICE_TYPES,normalizeCodingText,normalizePartyCode,parseProjectCode,nextDossierNumber,nextProjectNumber,readCustomerDossiers} from '../public/project-coding.mjs';

const person=(state,id)=>state.users.find(row=>row.id===id);
function fixture(){const state=createSeedState();person(state,'customer').customerCode='10151';person(state,'customer2').customerCode='10020';return state;}
function payload(overrides={}){return {codingVersion:1,name:'پروژه اول زیرساخت',customerId:'customer',createDossier:true,dossierTitle:'گروه مانا مستر',serviceCode:'110',location:'تهران',memberIds:['worker'],budget:100,contractAmount:200,startDate:'2026-11-07',endDate:'2026-12-07',projectManagerId:'manager',reviewChain:PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'manager'})),...overrides};}
function unchanged(state,callback,code){const before=structuredClone(state);assert.throws(callback,error=>!code||error.code===code);assert.deepEqual(state,before);}

test('official party ranges and all sixteen service codes follow the supplied scheme',()=>{
 assert.deepEqual(SERVICE_TYPES.map(row=>row.code),['110','111','112','113','114','115','120','121','122','123','130','131','132','140','141','142']);
 for(const [kind,first,last]of [['supplier','1000','9999'],['customer','10000','99999'],['personnel','100000','999999']]){
  assert.equal(normalizePartyCode(first,kind),first);assert.equal(normalizePartyCode(last,kind),last);
  assert.throws(()=>normalizePartyCode(String(Number(first)-1),kind));assert.throws(()=>normalizePartyCode(String(Number(last)+1),kind));assert.throws(()=>normalizePartyCode('0'+first,kind));
 }
 assert.equal(normalizePartyCode(' ۱۰۱۵۱ ','customer'),'10151');assert.equal(normalizePartyCode('١٠٠٠٠٠','personnel'),'100000');assert.equal(normalizePartyCode('','customer',{optional:true}),'');
});

test('Persian and Arabic digits, tatweel and dash variants normalize to one canonical code',()=>{
 for(const value of ['۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۱','١٠١٥١ – ٠١ – ١١٠ – ٠٠١','\u200f10151\u200e-01-110-001'])assert.equal(normalizeCodingText(value),'10151-01-110-001');
 assert.deepEqual(parseProjectCode('۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۱'),{projectCode:'10151-01-110-001',customerCode:'10151',dossierCode:'10151-01',dossierNumber:'01',serviceCode:'110',projectNumber:'001'});
 for(const value of ['AR-1405-001','10151-00-110-001','10151-01-110-000','10151-01-999-001','00151-01-110-001'])assert.equal(parseProjectCode(value),null);
});

test('the first project creates a customer dossier and derives all authoritative code fields',()=>{
 const state=fixture(),project=applyAction(state,'manager','project.create',payload());
 assert.equal(project.projectCode,'10151-01-110-001');assert.equal(project.dossierCode,'10151-01');assert.equal(project.customerCode,'10151');assert.equal(project.dossierNumber,'01');assert.equal(project.projectNumber,'001');assert.equal(project.type,'زیرساخت');assert.equal(project.codingVersion,1);
 assert.equal(state.customerDossiers.length,1);assert.equal(state.customerDossiers[0].title,'گروه مانا مستر');assert.equal(project.dossierId,state.customerDossiers[0].id);
 const second=applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:project.dossierId,dossierTitle:undefined,name:'پروژه دوم'}));
 assert.equal(second.projectCode,'10151-01-110-002');assert.equal(state.customerDossiers.length,1);
 const third=applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:project.dossierId,dossierTitle:undefined,serviceCode:'111'}));
 assert.equal(third.projectCode,'10151-01-111-001');assert.equal(third.type,'برق ساختمان');
 const other=applyAction(state,'manager','project.create',payload({dossierTitle:'شعبه دوم'}));assert.equal(other.projectCode,'10151-02-110-001');
});

test('inline assignment of an unnumbered customer is atomic and requires people management',()=>{
 const state=fixture();delete person(state,'customer').customerCode;
 unchanged(state,()=>applyAction(state,'manager','project.create',payload()),'CUSTOMER_CODE_REQUIRED');
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({customerCode:'10151',endDate:'2026-01-01'})));
 assert.equal(person(state,'customer').customerCode,undefined);assert.equal(state.customerDossiers,undefined);
 person(state,'worker').permissions={'projects.create':true};
 const delegated=payload({budget:undefined,contractAmount:undefined,customerCode:'10151'});
 unchanged(state,()=>applyAction(state,'worker','project.create',delegated),'FORBIDDEN');
 const created=applyAction(state,'manager','project.create',payload({customerCode:'۱۰۱۵۱'}));
 assert.equal(created.projectCode,'10151-01-110-001');assert.equal(person(state,'customer').customerCode,'10151');
});

test('customer codes are unique even across archived people and historical dossiers',()=>{
 const state=fixture();person(state,'customer2').deletedAt='2026-11-07';delete person(state,'customer').customerCode;
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({customerCode:'10020'})),'DUPLICATE_CUSTOMER_CODE');
 state.customerDossiers=[{id:'historical',customerId:'retired-customer',customerCode:'10151',number:'01',code:'10151-01',title:'قدیمی',archivedAt:'2026-11-07'}];
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({customerCode:'10151'})),'DUPLICATE_CUSTOMER_CODE');
});

test('coded projects reject mismatched client-supplied fields, wrong customers and invalid services atomically',()=>{
 for(const overrides of [{projectCode:'10151-01-110-002'},{dossierCode:'10151-02'},{customerCode:'10020'},{serviceCode:'999'},{customerId:'worker'},{dossierNumber:'00'},{dossierNumber:0},{dossierNumber:'100'},{projectNumber:'000'},{projectNumber:'1000'},{codingVersion:2}]){
  const state=fixture();unchanged(state,()=>applyAction(state,'manager','project.create',payload(overrides)));
 }
 const state=fixture(),project=applyAction(state,'manager','project.create',payload());
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({customerId:'customer2',createDossier:false,dossierId:project.dossierId,dossierTitle:undefined})),'CUSTOMER_DOSSIER_MISMATCH');
});

test('project codes remain reserved after archiving and counters are per dossier and service',()=>{
 const state=fixture(),first=applyAction(state,'manager','project.create',payload());
 state.projects.find(row=>row.id===first.id).archivedAt='2026-11-07';
 const common={createDossier:false,dossierId:first.dossierId,dossierTitle:undefined};
 assert.equal(applyAction(state,'manager','project.create',payload(common)).projectCode,'10151-01-110-002');
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({...common,projectNumber:'001'})),'DUPLICATE_PROJECT_CODE');
 assert.equal(applyAction(state,'manager','project.create',payload({...common,projectNumber:'۰۱۰'})).projectCode,'10151-01-110-010');
 assert.equal(nextProjectNumber(state,'10151-01','110'),'011');assert.equal(nextProjectNumber(state,'10151-01','111'),'001');
});

test('a sparse dossier number still allows 99 total dossiers and archived numbers are never reused',()=>{
 const state=fixture();applyAction(state,'manager','customer-dossier.create',{customerId:'customer',dossierTitle:'پرونده ۹۹',dossierNumber:'99'});
 assert.equal(nextDossierNumber(state,'customer'),'01');
 const first=applyAction(state,'manager','customer-dossier.create',{customerId:'customer',dossierTitle:'پرونده اول'});assert.equal(first.number,'01');
 applyAction(state,'manager','customer-dossier.archive',{id:first.id});assert.equal(nextDossierNumber(state,'customer'),'02');
 unchanged(state,()=>applyAction(state,'manager','customer-dossier.create',{customerId:'customer',dossierTitle:'تکراری',dossierNumber:'01'}),'DUPLICATE_DOSSIER_CODE');
});

test('dossier 99 and project 999 are exact upper bounds without widening their formats',()=>{
 const state=fixture();state.customerDossiers=Array.from({length:99},(_,index)=>{const number=String(index+1).padStart(2,'0');return{id:'case'+number,customerId:'customer',customerCode:'10151',number,code:'10151-'+number,title:'پرونده '+number};});
 unchanged(state,()=>applyAction(state,'manager','project.create',payload()),'CUSTOMER_DOSSIER_LIMIT');
 const last=applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:'case01',dossierTitle:undefined,projectNumber:'999'}));assert.equal(last.projectCode,'10151-01-110-999');
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:'case01',dossierTitle:undefined})),'PROJECT_NUMBER_LIMIT');
 assert.equal(applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:'case01',dossierTitle:undefined,serviceCode:'111'})).projectCode,'10151-01-111-001');
});

test('delegated staff can create numbered projects with zero hidden prices and cannot rewrite customer codes',()=>{
 const state=fixture();person(state,'worker').permissions={'projects.create':true};
 const result=applyAction(state,'worker','project.create',payload({budget:undefined,contractAmount:undefined,memberIds:[]}));
 assert.equal(result.projectCode,'10151-01-110-001');assert.equal(result.budget,undefined);assert.equal(result.contractAmount,undefined);assert.equal(state.projects.find(row=>row.id===result.id).budget,0);
 assert(publicState(state,'worker').projects.some(row=>row.id===result.id));
 unchanged(state,()=>applyAction(state,'worker','project.create',payload({budget:undefined,contractAmount:undefined,customerCode:'10152'})),'CUSTOMER_CODE_MISMATCH');
 unchanged(state,()=>applyAction(state,'worker2','project.create',payload()),'FORBIDDEN');
});

test('issued coded identity cannot change through direct updates or the generic management editor',()=>{
 const state=fixture(),created=applyAction(state,'manager','project.create',payload());
 for(const changes of [{projectCode:'10151-01-110-002'},{customerId:'customer2'},{customerId:null},{customerCode:'10152'},{dossierCode:'10151-02'},{dossierNumber:'02'},{dossierId:'other'},{serviceCode:'111'},{projectNumber:'002'},{codingVersion:0},{type:'دیگر'},{dossierTitle:'عنوان ناسازگار'}]){
  unchanged(state,()=>applyAction(state,'manager','project.update',{id:created.id,...changes}),'PROJECT_CODING_IMMUTABLE');
 }
 unchanged(state,()=>applyAction(state,'manager','admin.record.update',{collection:'projects',id:created.id,changes:{customerId:'customer2'},reason:'اصلاح'}),'PROJECT_CODING_IMMUTABLE');
 const edited=applyAction(state,'manager','project.update',{id:created.id,name:'نام اصلاح‌شده',budget:300,projectCode:'۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۱'});
 assert.equal(edited.name,'نام اصلاح‌شده');assert.equal(edited.budget,300);assert.equal(edited.projectCode,'10151-01-110-001');
});

test('legacy project identifiers stay unchanged and new canonical-looking codes cannot bypass allocation',()=>{
 const state=fixture(),legacy=state.projects[0];legacy.projectCode='AR-OLD';
 const edited=applyAction(state,'manager','project.update',{id:legacy.id,name:'نام قدیمی اصلاح‌شده'});assert.equal(edited.projectCode,'AR-OLD');assert.equal(edited.codingVersion,undefined);
 unchanged(state,()=>applyAction(state,'manager','project.update',{id:legacy.id,projectCode:'۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۱'}),'STRUCTURED_CODING_REQUIRED');
 const input=payload({codingVersion:undefined,projectCode:'۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۱',type:'زیرساخت'});
 unchanged(state,()=>applyAction(state,'manager','project.create',input),'STRUCTURED_CODING_REQUIRED');
 const plain=applyAction(state,'manager','project.create',{...input,projectCode:'AR-LEGACY'});assert.equal(plain.projectCode,'AR-LEGACY');
});

test('canonical legacy dossiers are discovered without rewriting historical records and their codes reserve sequences',()=>{
 const state=fixture();Object.assign(state.projects[0],{projectCode:'۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۳',dossierCode:'10151-01',dossierTitle:'گروه مانا مستر'});
 const before=structuredClone(state),rows=readCustomerDossiers(state);assert.equal(rows.length,1);assert.equal(rows[0].number,'01');assert.deepEqual(state,before);
 const project=applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:rows[0].id,dossierTitle:undefined}));
 assert.equal(project.projectCode,'10151-01-110-004');assert.equal(state.projects[0].projectCode,'۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۳');assert.equal(state.customerDossiers.length,1);
});

test('customer dossier rename propagates to current project identities, while active cases cannot be archived',()=>{
 const state=fixture(),created=applyAction(state,'manager','project.create',payload());
 const renamed=applyAction(state,'manager','customer-dossier.update',{id:created.dossierId,title:'گروه مانا مستر شمال'});assert.equal(renamed.title,'گروه مانا مستر شمال');assert.equal(state.projects.find(row=>row.id===created.id).dossierTitle,renamed.title);
 unchanged(state,()=>applyAction(state,'manager','customer-dossier.archive',{id:created.dossierId}),'CUSTOMER_DOSSIER_IN_USE');
 state.projects.find(row=>row.id===created.id).archivedAt='2026-11-07';applyAction(state,'manager','customer-dossier.archive',{id:created.dossierId});
 unchanged(state,()=>applyAction(state,'manager','project.create',payload({createDossier:false,dossierId:created.dossierId,dossierTitle:undefined})),'CUSTOMER_DOSSIER_ARCHIVED');
 applyAction(state,'manager','customer-dossier.restore',{id:created.dossierId});assert.equal(nextDossierNumber(state,'customer'),'02');
});

test('ordinary staff and customers cannot edit dossiers and projected cases never expose unrelated projects or extra data',()=>{
 const state=fixture(),first=applyAction(state,'manager','project.create',payload()),second=applyAction(state,'manager','project.create',payload({customerId:'customer2',memberIds:[],dossierTitle:'پرونده خصوصی'}));
 state.customerDossiers[1].privateSecret='DO_NOT_EXPOSE';
 for(const actor of ['worker','customer'])unchanged(state,()=>applyAction(state,actor,'customer-dossier.update',{id:first.dossierId,title:'تغییر غیرمجاز'}),'FORBIDDEN');
 const worker=publicState(state,'worker'),customer=publicState(state,'customer');
 assert(worker.customerDossiers.some(row=>row.id===first.dossierId));assert(!worker.customerDossiers.some(row=>row.id===second.dossierId));assert(!customer.customerDossiers.some(row=>row.id===second.dossierId));assert(!JSON.stringify(publicState(state,'manager')).includes('DO_NOT_EXPOSE'));
 person(state,'worker').permissions={'projects.edit':true};
 unchanged(state,()=>applyAction(state,'worker','customer-dossier.update',{id:second.dossierId,title:'تغییر غیرمجاز'}),'FORBIDDEN');
});

test('account edits cannot orphan a coded customer, change its party code, or move its identity to another group',()=>{
 const state=fixture(),created=applyAction(state,'manager','project.create',payload());
 for(const changes of [{role:'worker'},{customerCode:'10152'},{customerCode:''},{replaceProjectIds:true,projectIds:[]}])unchanged(state,()=>applyAction(state,'manager','account.update',{id:'customer',...changes}));
 const result=applyAction(state,'manager','account.update',{id:'customer',name:'مهندس احمدی',customerCode:'۱۰۱۵۱',replaceProjectIds:true,projectIds:[created.id]});assert.equal(result.customerCode,'10151');assert.equal(person(state,'customer').name,'مهندس احمدی');
 state.projects.find(row=>row.id===created.id).archivedAt='2026-11-07';
 applyAction(state,'manager','account.update',{id:'customer',name:'احمدی',replaceProjectIds:true,projectIds:[]});assert.equal(state.projects.find(row=>row.id===created.id).customerId,'customer');
});

test('historical full codes allow bootstrapping the same missing customer code without renumbering projects',()=>{
 const state=fixture();delete person(state,'customer').customerCode;state.projects[0].projectCode='10151-01-110-001';
 unchanged(state,()=>applyAction(state,'manager','account.update',{id:'customer',customerCode:'10152'}),'CUSTOMER_CODE_IN_USE');
 applyAction(state,'manager','account.update',{id:'customer',customerCode:'10151'});assert.equal(person(state,'customer').customerCode,'10151');assert.equal(state.projects[0].projectCode,'10151-01-110-001');
});

test('re-evaluating a stale state mutation after a competing allocation issues the next unique number',()=>{
 const state=fixture(),first=applyAction(state,'manager','project.create',payload());
 const input=payload({createDossier:false,dossierId:first.dossierId,dossierTitle:undefined}),stale=structuredClone(state);
 const staleResult=applyAction(stale,'manager','project.create',input);assert.equal(staleResult.projectCode,'10151-01-110-002');
 const winner=applyAction(state,'manager','project.create',input),retried=applyAction(state,'manager','project.create',input);
 assert.equal(winner.projectCode,'10151-01-110-002');assert.equal(retried.projectCode,'10151-01-110-003');assert.equal(new Set(state.projects.map(row=>row.projectCode).filter(Boolean)).size,3);
});

test('Edge and browser numbering, permissions and domain sources are identical',async()=>{
 for(const file of ['project-coding.mjs','domain.mjs','permissions.mjs'])assert.equal(await readFile(new URL('../public/'+file,import.meta.url),'utf8'),await readFile(new URL('../supabase/functions/arios-api/'+file,import.meta.url),'utf8'),file);
});
