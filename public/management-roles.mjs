/** Manager titles are state-derived; authentication continues to use the protected manager role. */
const list=value=>Array.isArray(value)?value:[];
const activeManager=user=>user&&!user.deletedAt&&user.role==='manager';
const eligibleRoles=new Set(['manager','worker','warehouse','accountant']);
function fail(message,status=400,code='INVALID_MANAGER_TRANSFER'){const error=new Error(message);error.status=status;error.code=code;throw error;}
export function primaryManager(state){
  const managers=list(state?.users).filter(activeManager);
  if(Object.hasOwn(state||{},'primaryManagerId'))return managers.find(user=>user.id===state.primaryManagerId)||null;
  return managers.find(user=>user.id==='manager')||managers[0]||null;
}
export function managementRoleDetails(state,userOrId){
  const id=typeof userOrId==='string'?userOrId:userOrId?.id;
  const user=list(state?.users).find(person=>person.id===id);
  if(!activeManager(user))return {};
  const primary=primaryManager(state),managementRole=primary?.id===user.id?'primary':'technical';
  const jobTitle=typeof user.managementTitle==='string'&&user.managementTitle.trim().length<=80?user.managementTitle.trim():'';
  return {managementRole,managementTitle:managementRole==='primary'?'مدیر اصلی':jobTitle||'مدیر فنی'};
}
export function managementRoleSnapshot(state,userOrId){
  const id=typeof userOrId==='string'?userOrId:userOrId?.id,user=list(state?.users).find(person=>person.id===id);
  if(!activeManager(user))return undefined;
  const primary=primaryManager(state);
  return {primaryManagerId:primary?.id||null,primaryManagerName:primary?.name||'',version:Number.isSafeInteger(state.primaryManagerVersion)?state.primaryManagerVersion:0,canTransferPrimary:Boolean(primary&&primary.id===user.id),...managementRoleDetails(state,user)};
}
export function primaryTransferCompleted(state,actorId,payload){
  const last=state?.primaryManagerLastTransfer;
  return Boolean(last&&last.requestId===payload?.requestId&&last.actorId===actorId&&last.targetId===payload?.id&&last.version===state.primaryManagerVersion&&state.primaryManagerId===payload.id&&activeManager(list(state.users).find(user=>user.id===payload.id)));
}
/** Caller commits a detached state with the target protected profile in one transaction. */
export function applyPrimaryManagerTransfer(state,actorOrId,payload={}){
  const actorId=typeof actorOrId==='string'?actorOrId:actorOrId?.id;
  const actor=list(state?.users).find(user=>user.id===actorId);
  if(!activeManager(actor))fail('تعیین مدیر اصلی فقط برای مدیر مجاز است.',403,'FORBIDDEN');
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.id!=='string'||!payload.id||payload.id.length>120||typeof payload.requestId!=='string'||!/^[-a-zA-Z0-9_]{16,100}$/.test(payload.requestId))fail('درخواست تعیین مدیر اصلی معتبر نیست.');
  if(primaryTransferCompleted(state,actorId,payload))return {primaryManagerId:payload.id,previousPrimaryManagerId:actorId,version:state.primaryManagerVersion,replayed:true};
  if(Object.hasOwn(state,'primaryManagerVersion')&&(!Number.isSafeInteger(state.primaryManagerVersion)||state.primaryManagerVersion<0))fail('نسخهٔ مدیریت معتبر نیست؛ وضعیت حساب نیازمند بررسی است.',409,'PRIMARY_MANAGER_CHANGED');
  const previous=primaryManager(state),version=Number.isSafeInteger(state.primaryManagerVersion)?state.primaryManagerVersion:0;
  if(!previous||previous.id!==actorId)fail('فقط مدیر اصلی فعلی می‌تواند مدیر اصلی بعدی را تعیین کند.',403,'PRIMARY_MANAGER_REQUIRED');
  if(payload.expectedPrimaryManagerId!==previous.id||payload.expectedVersion!==version)fail('مدیر اصلی یا نسخهٔ اطلاعات تغییر کرده است؛ صفحه را تازه کنید.',409,'PRIMARY_MANAGER_CHANGED');
  if(payload.id===previous.id)fail('فرد دیگری را به‌عنوان مدیر اصلی انتخاب کنید.');
  const target=list(state.users).find(user=>user.id===payload.id);
  if(!target||target.deletedAt||!eligibleRoles.has(target.role))fail('یک همکار فعال را انتخاب کنید.',400,'INVALID_PRIMARY_MANAGER');
  if(version>=Number.MAX_SAFE_INTEGER)fail('نسخهٔ مدیریت معتبر نیست.',409,'PRIMARY_MANAGER_CHANGED');
  const at=new Date().toISOString();
  previous.managementRole='technical';
  target.role='manager';target.managementRole='primary';
  state.primaryManagerId=target.id;state.primaryManagerVersion=version+1;
  state.primaryManagerLastTransfer={requestId:payload.requestId,actorId:previous.id,targetId:target.id,version:version+1};
  state.audit||=[];
  state.audit.push({id:globalThis.crypto.randomUUID(),actorId:previous.id,action:'account.primary-manager.transfer',entityId:target.id,createdAt:at,description:`مدیر اصلی به «${target.name}» واگذار شد؛ «${previous.name}» مدیر فنی باقی ماند.`,requestId:payload.requestId});
  return {primaryManagerId:target.id,previousPrimaryManagerId:previous.id,version:version+1,replayed:false};
}
