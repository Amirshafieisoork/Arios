import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCatalogAction,readCatalogs,catalogOptions,catalogSelect} from '../public/catalogs.mjs';
import {renderCatalogSettings} from '../public/catalog-settings.mjs';
import {renderOperations,wireOperations} from '../public/operations.mjs';
import {applyAction,createSeedState,publicState} from '../public/domain.mjs';
const manager={id:'manager',name:'مدیر آریوس',role:'manager',phone:'09121234567'};
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={e:escape,n:String,money:String,date:String,personName:String,projectName:String,badge:()=>'',icon:()=>'',authMode:'supabase',capabilities:{supabaseAuth:true},api:{isStatic:false}};
const fixture=()=>({users:[manager,{id:'worker',role:'worker',name:'همکار',department:'واحد قدیمی',skill:'تخصص قدیمی'}],projects:[{id:'p1',type:'خدمات قدیمی'}],inventory:[{id:'s1',unit:'کارتن'}],materials:[],user:manager,reports:[],tickets:[],messages:[],invoices:[],receipts:[],audit:[]});

test('catalog defaults include legacy labels without modifying source records or sharing references',()=>{
 const state=fixture(),before=structuredClone(state),first=readCatalogs(state,{includeArchived:true});
 assert(first.projectTypes.some(x=>x.label==='خدمات قدیمی'));assert(first.units.some(x=>x.label==='کارتن'));assert(first.departments.some(x=>x.label==='واحد قدیمی'));
 first.units[0].label='mutated';assert.notEqual(readCatalogs(state).units[0].label,'mutated');assert.deepEqual(state,before);
});
test('catalog archive and rename keep old records intact and prevent legacy labels reappearing',()=>{
 const state=fixture(),before=structuredClone(state.projects),entry=readCatalogs(state).projectTypes.find(x=>x.label==='خدمات قدیمی');
 applyCatalogAction(state,manager,'catalog.update',{catalog:'projectTypes',id:entry.id,label:'خدمات تازه'});
 assert(!readCatalogs(state).projectTypes.some(x=>x.label==='خدمات قدیمی'));assert(readCatalogs(state).projectTypes.some(x=>x.label==='خدمات تازه'));
 applyCatalogAction(state,manager,'catalog.archive',{catalog:'projectTypes',id:entry.id});
 assert(!readCatalogs(state).projectTypes.some(x=>x.id===entry.id));assert(readCatalogs(state,{includeArchived:true}).projectTypes.some(x=>x.id===entry.id&&x.archivedAt));
 assert.deepEqual(state.projects,before);assert.throws(()=>applyCatalogAction(state,manager,'catalog.create',{catalog:'projectTypes',label:'خدمات قدیمی'}),e=>e.code==='DUPLICATE_CATALOG_LABEL');
 applyCatalogAction(state,manager,'catalog.restore',{catalog:'projectTypes',id:entry.id});assert(readCatalogs(state).projectTypes.some(x=>x.label==='خدمات تازه'));
});
test('catalog actions reject other roles, unknown groups, duplicate Persian spellings and invalid labels atomically',()=>{
 const state=fixture();for(const role of ['worker','customer','warehouse','accountant'])assert.throws(()=>applyCatalogAction(state,{id:role,role},'catalog.create',{catalog:'units',label:'کیسه'}),e=>e.status===403);
 assert.throws(()=>applyCatalogAction(state,manager,'catalog.create',{catalog:'__proto__',label:'عنوان'}));
 applyCatalogAction(state,manager,'catalog.create',{catalog:'skills',label:'کابل کشی'});const before=structuredClone(state);
 for(const payload of [{catalog:'skills',label:'كابل كشی'},{catalog:'units',label:'x'.repeat(41)},{catalog:'units',label:'\u0000'},{catalog:'units',label:''}])assert.throws(()=>applyCatalogAction(state,manager,'catalog.create',payload));
 assert.deepEqual(state,before);
});
test('active selects omit removed labels while existing record values remain explicitly historical',()=>{
 const state=fixture(),entry=readCatalogs(state).units.find(x=>x.label==='عدد');applyCatalogAction(state,manager,'catalog.archive',{catalog:'units',id:entry.id});
 assert(!catalogOptions(state,'units').some(x=>x.value==='عدد'));
 assert.equal(catalogOptions(state,'units','عدد')[0].historical,true);
 assert(!catalogSelect(state,'units',ctx,{name:'unit',required:true}).includes('value="عدد"'));
 assert(catalogSelect(state,'units',ctx,{name:'unit',value:'عدد',required:true}).includes('value="عدد" selected'));
});
test('catalog settings escape stored labels and never offer manager controls to other roles',()=>{
 const state=fixture();applyCatalogAction(state,manager,'catalog.create',{catalog:'units',label:'<script>bad</script>'});
 const html=renderCatalogSettings(state,ctx);assert(!html.includes('<script>bad</script>'));assert(html.includes('&lt;script&gt;'));assert(html.includes('data-catalog-action="archive"'));
 const worker=renderCatalogSettings({...state,user:{role:'worker'}},ctx);assert(!worker.includes('data-catalog-action'));
});
test('catalog changes commit through audited domain actions and archived labels stay manager-only',()=>{
 const state=createSeedState(),entry=applyAction(state,'manager','catalog.create',{catalog:'units',label:'کیسه'});
 assert.equal(entry.label,'کیسه');assert.equal(state.audit.at(-1).actorId,'manager');assert.equal(state.audit.at(-1).action,'catalog.create');
 const before=structuredClone(state);assert.throws(()=>applyAction(state,'worker','catalog.archive',{catalog:'units',id:entry.id}),error=>error.status===403);assert.deepEqual(state,before);
 applyAction(state,'manager','catalog.archive',{catalog:'units',id:entry.id});
 assert(publicState(state,'manager').catalogs.units.some(row=>row.id===entry.id&&row.archivedAt));
 assert(!publicState(state,'worker').catalogs.units.some(row=>row.id===entry.id));
});
test('manager team includes protected manager editor and preserves manager role on save',()=>{
 const state=fixture(),html=renderOperations('team',state,ctx);assert(html.includes('data-person-role="manager"'));assert(html.includes('افراد و پروندهٔ همکاری'));assert(html.includes('data-edit-account="manager"'));assert(!html.includes('data-archive-account="manager"'));
 let click,modal,payload;const previous=globalThis.document;
 globalThis.document={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-edit-account]'?[{dataset:{editAccount:'manager'},addEventListener:(_event,fn)=>{click=fn;}}]:[]};
 try{wireOperations('team',state,{...ctx,modal:value=>{modal=value;},mutate:async(action,value)=>{payload={action,value};}});click();assert(modal);const roleField=modal.body.match(/<select name="role">[\s\S]*?<\/select>/)?.[0];assert(roleField.includes('value="manager" selected'));assert(!roleField.includes('value="worker"'));const data=new FormData();for(const [key,value]of Object.entries({name:manager.name,phone:manager.phone,role:'manager',username:'',department:'',skill:''}))data.set(key,value);modal.onSubmit(data);assert.equal(payload.action,'account.update');assert.equal(payload.value.role,'manager');}finally{globalThis.document=previous;}
});
