import { APIError, manager, rate } from './auth.mjs';
import { projectAccess, projectReadAccess, projectReviewerAccess } from './domain.mjs';

const BUCKET = 'arios-project-files';
const MAX = 10 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw new APIError(message, status, code); };
const safe = file => Object.fromEntries(['id','name','mimeType','size','uploadedBy','createdAt','clientVisible','reportId','archivedAt','archivedBy','updatedAt'].filter(key=>file[key]!==undefined).map(key=>[key,file[key]]));
function authorized(state,user,projectId,write=false) {
  const actor=state.users.find(person=>person.id===user.id&&!person.deletedAt);
  const project=state.projects.find(project=>project.id===projectId);
  if (project?.archivedAt && write && actor?.role==='manager') fail('برای بارگذاری فایل، ابتدا پروژهٔ حذف‌شده را بازیابی کنید.',409,'PROJECT_ARCHIVED');
  if (project?.archivedAt && actor?.role!=='manager') fail('به فایل‌های این پروژه دسترسی ندارید.',403,'FORBIDDEN');
  const access=write?projectAccess:projectReadAccess;
  if (!actor || actor.role!==user.role || !access(state,user.id,projectId) || (write && !['manager','worker'].includes(actor.role))) fail('به فایل‌های این پروژه دسترسی ندارید.',403,'FORBIDDEN');
  return project;
}
const list=value=>Array.isArray(value)?value:[];
function reviewerFileAccess(state,user,project,file) {
  if(projectAccess(state,user.id,project.id))return true;
  if(!projectReviewerAccess(state,user.id,project.id)||!file.mimeType.startsWith('image/')||(file.draftId&&!file.reportId))return false;
  const configured=project.projectManagerId===user.id||list(project.reviewChain).some(stage=>stage.userId===user.id);
  const reports=configured?list(state.reports).filter(report=>report.projectId===project.id):[];
  for(const submission of [project.dossierSubmission,...list(project.dossierSubmissionHistory)]) {
    if(list(submission?.approval?.stages).some(stage=>stage.userId===user.id))reports.push(...list(submission.snapshot?.reports));
  }
  return reports.some(report=>list(report.photoIds).includes(file.id));
}
/** Removing a document from active files never destroys signed/report evidence. */
function archivedEvidenceAccess(state,user,project,file) {
  if (user.role==='manager') return true;
  if (user.role==='customer') return false;
  const configured=project.projectManagerId===user.id||list(project.reviewChain).some(stage=>stage.userId===user.id);
  if (list(state.reports).some(report=>report.projectId===project.id&&report.status==='approved'&&(configured||report.workerId===user.id)&&list(report.photoIds).includes(file.id))) return true;
  for (const submission of [project.dossierSubmission,...list(project.dossierSubmissionHistory)]) {
    if (!(configured||list(submission?.approval?.stages).some(stage=>stage.userId===user.id))) continue;
    if (list(submission?.snapshot?.reports).some(report=>list(report.photoIds).includes(file.id))) return true;
  }
  return false;
}
function visible(file,user) {
  return file && file.status==='ready' && (!file.draftId || file.reportId || file.uploadedBy===user.id) && (user.role!=='customer'||file.clientVisible===true);
}
function validPath(file,projectId) {
  const path=`projects/${projectId}/${file.uploadedBy}/${file.id}.${TYPES[file.mimeType]}`;
  if (file.storagePath!==path || !TYPES[file.mimeType]) fail('فایل در دسترس نیست.',404,'NOT_FOUND');
  return path;
}
export function detectProjectFileType(bytes) {
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if([137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return 'image/png';
  const text=new TextDecoder().decode(bytes);
  if(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP')return 'image/webp';
  if(text.startsWith('%PDF-'))return 'application/pdf';
  return null;
}
export async function handleProjectFiles({repo,supabase,user,request,path,readJSON,json}) {
  const manageOperation=path.match(/^\/api\/project-files\/(update|archive|restore)$/)?.[1];
  if (!manageOperation&&!['/api/project-files/upload-url','/api/project-files/complete','/api/project-files/download'].includes(path)) return null;
  if(request.method!=='POST')fail('روش درخواست مجاز نیست.',405,'METHOD_NOT_ALLOWED');
  const payload=await readJSON(request,8192);
  const loaded=await repo.loadState();
  if(!loaded)fail('فضای کار آماده نیست.',503,'STATE_NOT_INITIALIZED');
  if(manageOperation) {
    manager(user);
    await rate(repo,`project-files-manage:${user.id}`,30);
    const saved=await repo.mutateState(state=>{
      const current=authorized(state,user,payload.projectId,true);
      const actor=state.users.find(person=>person.id===user.id);
      manager(actor);
      const target=list(current.files).find(file=>file.id===payload.id);
      if(!target||target.status!=='ready')fail('فایل آماده یافت نشد.',404,'NOT_FOUND');
      if(manageOperation==='update') {
        if(target.archivedAt)fail('برای ویرایش فایل، ابتدا آن را بازیابی کنید.',409,'FILE_ARCHIVED');
        const changes=payload.changes;
        if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.keys(changes).some(key=>!['name','clientVisible'].includes(key)))fail('اطلاعات ویرایش فایل معتبر نیست.');
        if(changes.name!==undefined) {
          const name=changes.name;
          if(typeof name!=='string'||!name.trim()||name.length>180||/[\u0000-\u001f/\\]/.test(name))fail('نام فایل معتبر نیست.');
          const extension=name.trim().split('.').at(-1)?.toLowerCase();
          if(!({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',pdf:'application/pdf'}[extension]===target.mimeType))fail('پسوند فایل را تغییر ندهید.');
          target.name=name.trim();
        }
        if(changes.clientVisible!==undefined) {
          if(typeof changes.clientVisible!=='boolean')fail('نمایش برای مشتری معتبر نیست.');
          target.clientVisible=changes.clientVisible;
        }
      } else if(manageOperation==='archive') {
        if(target.archivedAt)return safe(target);
        target.archivedAt=new Date().toISOString();target.archivedBy=actor.id;
      } else {
        if(!target.archivedAt)return safe(target);
        delete target.archivedAt;delete target.archivedBy;
      }
      target.updatedAt=new Date().toISOString();
      state.audit||=[];
      state.audit.push({id:crypto.randomUUID(),actorId:actor.id,action:`project.file.${manageOperation}`,entityId:target.id,projectId:current.id,createdAt:target.updatedAt,description:manageOperation==='archive'?'فایل با حفظ اصل سند و شواهد گزارش از فهرست فعال حذف شد.':manageOperation==='restore'?'فایل به فهرست فعال پروژه بازگردانده شد.':'نام یا نمایش فایل پروژه ویرایش شد.'});
      return safe(target);
    });
    return json({file:saved.result,archived:Boolean(saved.result.archivedAt)});
  }
  const project=authorized(loaded.state,user,payload.projectId,path!=='/api/project-files/download');
  const bucket=supabase.storage.from(BUCKET);
  if(path==='/api/project-files/upload-url') {
    await rate(repo,`project-files-upload:${user.id}`,12);
    if(typeof payload.fileName!=='string'||!payload.fileName.trim()||payload.fileName.length>180||/[\u0000-\u001f/\\]/.test(payload.fileName)||!TYPES[payload.mimeType]||!Number.isSafeInteger(payload.size)||payload.size<1||payload.size>MAX)fail('فایل JPEG، PNG، WebP یا PDF تا ۱۰ مگابایت انتخاب کنید.');
    const extension=payload.fileName.split('.').at(-1)?.toLowerCase();
    if(!({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',pdf:'application/pdf'}[extension]===payload.mimeType))fail('پسوند و نوع فایل باید یکسان باشند.');
    const id=crypto.randomUUID(),storagePath=`projects/${project.id}/${user.id}/${id}.${TYPES[payload.mimeType]}`;
    const expired=(project.files||[]).filter(file=>file.status==='removed'||file.status==='pending'&&Date.parse(file.createdAt)<Date.now()-86400000);
    if(expired.length) { const removed=await bucket.remove(expired.map(file=>validPath(file,project.id))); if(removed.error)fail('پاک‌سازی بارگذاری‌های ناتمام انجام نشد؛ دوباره تلاش کنید.',503,'UPLOAD_UNAVAILABLE'); }
    await repo.mutateState(state=>{
      const current=authorized(state,user,project.id,true);
      current.files||=[];
      current.files=current.files.filter(file=>!expired.some(old=>old.id===file.id));
      if(current.files.length>=300)fail('حداکثر ۳۰۰ فایل برای هر پروژه ثبت کنید.');
      if(payload.draftId) {
        const draft=(state.reportDrafts||[]).find(draft=>draft.id===payload.draftId&&draft.authorId===user.id&&draft.projectId===project.id&&!draft.reportId);
        if(!draft)fail('پیش‌نویس گزارش در دسترس نیست.',403,'FORBIDDEN');
        if(payload.mimeType==='application/pdf')fail('برای گزارش فقط تصویر انتخاب کنید.');
      }
      current.files.push({id,name:payload.fileName.trim(),mimeType:payload.mimeType,size:payload.size,storagePath,uploadedBy:user.id,createdAt:new Date().toISOString(),status:'pending',clientVisible:user.role==='manager'&&payload.clientVisible===true,...(payload.draftId?{draftId:payload.draftId}:{})});
    });
    const {data,error}=await bucket.createSignedUploadUrl(storagePath,{upsert:false});
    if(error||typeof data?.signedUrl!=='string'){
      await repo.mutateState(state=>{const current=authorized(state,user,project.id,true);current.files=(current.files||[]).filter(file=>file.id!==id);return {id};});
      fail('آماده‌سازی بارگذاری انجام نشد؛ دوباره تلاش کنید.',503,'UPLOAD_UNAVAILABLE');
    }
    return json({id,uploadUrl:data.signedUrl});
  }
  const file=(project.files||[]).find(file=>file.id===payload.id);
  if(!file)fail('فایل یافت نشد.',404,'NOT_FOUND');
  const storagePath=validPath(file,project.id);
  if(file.draftId&&!file.reportId&&!(loaded.state.reportDrafts||[]).some(draft=>draft.id===file.draftId&&draft.projectId===project.id&&draft.authorId===user.id&&!draft.reportId))fail('پیش‌نویس فایل در دسترس نیست.',403,'FORBIDDEN');
  if(path==='/api/project-files/download') {
    if(!visible(file,user)||!reviewerFileAccess(loaded.state,user,project,file)||(file.archivedAt&&!archivedEvidenceAccess(loaded.state,user,project,file)))fail('فایل در دسترس نیست.',403,'FORBIDDEN');
    await rate(repo,`project-files-download:${user.id}`,60);
    const {data,error}=await bucket.createSignedUrl(storagePath,90,payload.preview===true&&file.mimeType.startsWith('image/')?{}:{download:file.name});
    if(error||typeof data?.signedUrl!=='string')fail('دریافت فایل انجام نشد؛ دوباره تلاش کنید.',503,'DOWNLOAD_UNAVAILABLE');
    return json({url:data.signedUrl,expiresIn:90});
  }
  if(file.uploadedBy!==user.id)fail('تکمیل بارگذاری فقط برای بارگذار مجاز است.',403,'FORBIDDEN');
  if(file.status==='ready')return json({file:safe(file)});
  if(file.status!=='pending')fail('بارگذاری در دسترس نیست.',404,'NOT_FOUND');
  await rate(repo,`project-files-complete:${user.id}`,20);
  const {data:info,error:infoError}=await bucket.info(storagePath);
  const actualSize=Number(info?.size ?? info?.metadata?.size);
  if(infoError||!Number.isSafeInteger(actualSize)||actualSize<1||actualSize!==file.size||actualSize>MAX)fail('بارگذاری فایل کامل یا معتبر نیست؛ دوباره بارگذاری کنید.');
  const {data:blob,error:downloadError}=await bucket.download(storagePath);
  if(downloadError||!blob||blob.size!==actualSize||detectProjectFileType(new Uint8Array(await blob.slice(0,16).arrayBuffer()))!==file.mimeType) {
    await bucket.remove([storagePath]);
    fail('محتوای فایل با نوع انتخاب‌شده مطابقت ندارد.');
  }
  const saved=await repo.mutateState(state=>{
    const current=authorized(state,user,project.id,true);
    const target=(current.files||[]).find(row=>row.id===file.id&&row.uploadedBy===user.id);
    if(!target)fail('فایل در دسترس نیست.',404,'NOT_FOUND');
    if(target.draftId&&!(state.reportDrafts||[]).some(draft=>draft.id===target.draftId&&draft.authorId===user.id&&draft.projectId===project.id&&!draft.reportId))fail('پیش‌نویس در دسترس نیست.',403,'FORBIDDEN');
    target.status='ready';
    return safe(target);
  });
  return json({file:saved.result});
}
