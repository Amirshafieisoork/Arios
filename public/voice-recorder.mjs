// Recording stays in memory until the member explicitly sends it to the private voice inbox.
export const MAX_RECORDED_BYTES=20*1024*1024;
export const MAX_RECORDING_SECONDS=10*60;
const formats=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'];
export function recordingSupport(scope=globalThis){return scope.isSecureContext!==false&&typeof scope.navigator?.mediaDevices?.getUserMedia==='function'&&typeof scope.MediaRecorder==='function';}
export function recordingError(error){
 if(['NotAllowedError','PermissionDeniedError','SecurityError'].includes(error?.name))return 'اجازهٔ میکروفن داده نشد. در تنظیمات گوشی یا مرورگر اجازهٔ میکروفن آریوس را روشن کنید، یا فایل صوتی انتخاب کنید.';
 if(['NotFoundError','DevicesNotFoundError'].includes(error?.name))return 'میکروفن پیدا نشد؛ می‌توانید فایل صوتی انتخاب کنید.';
 if(['NotReadableError','TrackStartError'].includes(error?.name))return 'میکروفن در برنامهٔ دیگری مشغول است؛ آن برنامه را ببندید و دوباره تلاش کنید.';
 return error?.code==='EMPTY_RECORDING'?'صدایی ضبط نشد؛ دوباره ضبط کنید.':error?.code==='RECORDING_TOO_LARGE'?'حجم ویس از ۲۰ مگابایت بیشتر شد؛ ویس کوتاه‌تری ضبط کنید.':'ضبط صدا شروع نشد؛ دوباره تلاش کنید یا فایل صوتی انتخاب کنید.';
}
const extension=type=>/webm/i.test(type)?'webm':/mp4|m4a/i.test(type)?'m4a':/ogg|opus/i.test(type)?'ogg':/wav/i.test(type)?'wav':'webm';
/** Dependency injection exercises permission races and track cleanup without a real microphone. */
export function createAudioCapture({scope=globalThis,onChange=()=>{},maxSeconds=MAX_RECORDING_SECONDS,maxBytes=MAX_RECORDED_BYTES}={}){
 let disposed=false,phase='idle',stream=null,recorder=null,timer=null,chunks=[],bytes=0,seconds=0,file=null,error='',sequence=0,discard=false;
 const timerSet=scope.setInterval?.bind(scope)||setInterval,timerClear=scope.clearInterval?.bind(scope)||clearInterval;
 const notify=()=>onChange({phase,seconds,file,error});
 const release=()=>{if(timer!==null){timerClear(timer);timer=null;}for(const track of stream?.getTracks?.()||[])track.stop();stream=null;};
 const stop=()=>{if(phase!=='recording')return;phase='stopping';if(timer!==null){timerClear(timer);timer=null;}notify();try{recorder.stop();release();}catch(cause){release();phase='error';error=recordingError(cause);notify();}};
 const cancel=()=>{
  sequence++;discard=true;file=null;chunks=[];bytes=0;error='';seconds=0;
  if(recorder&&recorder.state!=='inactive')try{recorder.stop();}catch{}
  release();recorder=null;phase='idle';if(!disposed)notify();
 };
 return {
  get busy(){return ['requesting','recording','stopping'].includes(phase);},
  snapshot:()=>({phase,seconds,file,error}),
  async start(){
   if(disposed||['requesting','recording','stopping'].includes(phase))return;
   if(!recordingSupport(scope)){phase='error';error='این مرورگر ضبط مستقیم را پشتیبانی نمی‌کند؛ از ضبط‌صدای گوشی یا انتخاب فایل صوتی استفاده کنید.';notify();return;}
   const attempt=++sequence;phase='requesting';file=null;error='';seconds=0;chunks=[];bytes=0;discard=false;notify();
   let acquired;
   try{
    acquired=await scope.navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    if(disposed||attempt!==sequence){for(const track of acquired.getTracks())track.stop();return;}
    stream=acquired;
    const mime=formats.find(type=>scope.MediaRecorder.isTypeSupported?.(type));
    recorder=new scope.MediaRecorder(stream,mime?{mimeType:mime,audioBitsPerSecond:64000}:{audioBitsPerSecond:64000});
    const active=recorder;
    active.ondataavailable=event=>{
     if(disposed||attempt!==sequence||discard||!event.data?.size)return;
     bytes+=event.data.size;
     if(bytes>maxBytes){discard=true;chunks=[];error=recordingError({code:'RECORDING_TOO_LARGE'});stop();return;}
     chunks.push(event.data);
    };
    active.onerror=event=>{if(disposed||attempt!==sequence)return;discard=true;error=recordingError(event.error);release();phase='error';try{if(active.state!=='inactive')active.stop();}catch{}notify();};
    active.onstop=()=>{
     release();if(disposed||attempt!==sequence)return;
     recorder=null;
     if(discard){phase=error?'error':'idle';notify();return;}
     const mimeType=active.mimeType||chunks.find(part=>part.type)?.type||mime||'audio/webm';
     const blob=new scope.Blob(chunks,{type:mimeType});chunks=[];
     if(!blob.size){phase='error';error=recordingError({code:'EMPTY_RECORDING'});notify();return;}
     file=new scope.File([blob],`ARIOS-voice-${new Date().toISOString().replace(/[:.]/g,'-')}.${extension(mimeType)}`,{type:mimeType});
     phase='ready';notify();
    };
    active.start(1000);phase='recording';notify();
    timer=timerSet(()=>{if(phase!=='recording')return;seconds++;notify();if(seconds>=maxSeconds)stop();},1000);
   }catch(cause){
    if(!stream)for(const track of acquired?.getTracks?.()||[])track.stop();release();
    if(disposed||attempt!==sequence)return;
    phase='error';error=recordingError(cause);notify();
   }
  },
  stop,cancel,
  dispose(){disposed=true;cancel();},
 };
}
export function renderVoiceRecorder({disabled=false}={}){
 return `<section class="voice-recorder" data-voice-recorder aria-label="ضبط مستقیم ویس"><div class="voice-recorder-heading"><div><h3>همین‌جا ویس ضبط کنید</h3><p>ضبط و ارسال مستقیم در آریوس؛ بدون نیاز به تلگرام.</p></div><time data-record-timer dir="ltr">00:00</time></div><div class="actions"><button type="button" class="button primary" data-record-start ${disabled?'disabled':''}>شروع ضبط</button><button type="button" class="button danger" data-record-stop hidden>پایان ضبط</button><button type="button" class="button primary" data-record-send hidden>ارسال ویس به صندوق</button><button type="button" class="button secondary" data-record-discard hidden>حذف ضبط</button></div><audio data-record-preview controls preload="metadata" hidden aria-label="شنیدن ویس ضبط‌شده پیش از ارسال"></audio><p class="voice-recorder-status" data-record-status role="status" aria-live="polite">پس از ضبط، ویس را بشنوید و ارسال کنید. حداکثر ۱۰ دقیقه یا ۲۰ مگابایت.</p><div class="voice-recorder-fallback"><button type="button" class="text-link" data-record-phone ${disabled?'disabled':''}>استفاده از ضبط‌صدای گوشی یا فایل صوتی</button><input type="file" data-record-phone-input accept="audio/*,.ogg,.opus,.mp3,.m4a,.wav,.webm" capture="microphone" hidden><a class="text-link" data-record-app-update href="/downloads/arios-android.apk" download hidden>اگر اجازهٔ میکروفن در برنامه نیست، نسخهٔ جدید آریوس را نصب کنید</a><small>پیش از خروج از این صفحه، ویس را ارسال کنید.</small></div></section>`;
}
export function wireVoiceRecorder(root,{scope=globalThis,file:initialFile=null,onFile=()=>{},upload,onSaved=()=>{},disabled=false}={}){
 const block=root?.querySelector?.('[data-voice-recorder]');if(!block)return {busy:false,dispose(){}};
 const get=key=>block.querySelector(`[data-record-${key}]`),start=get('start'),stop=get('stop'),send=get('send'),discard=get('discard'),player=get('preview'),status=get('status'),timer=get('timer'),phone=get('phone'),phoneInput=get('phone-input');
 let disposed=false,sending=false,file=initialFile,url='',seconds=0,phase=file?'ready':'idle';
 const handlers=[];
 const listen=(element,event,fn)=>{element?.addEventListener(event,fn);handlers.push(()=>element?.removeEventListener(event,fn));};
 const clearPreview=()=>{player?.pause?.();player?.removeAttribute('src');if(url)scope.URL.revokeObjectURL(url);url='';};
 const preview=()=>{clearPreview();if(file){url=scope.URL.createObjectURL(file);player.src=url;}};
 const render=(error='')=>{
  if(disposed)return;
  const busy=['requesting','recording','stopping'].includes(phase);
  block.dataset.recordingBusy=String(busy||sending||Boolean(file));
  start.hidden=busy||Boolean(file);start.disabled=disabled||sending;
  stop.hidden=phase!=='recording';stop.disabled=sending;
  send.hidden=!file;send.disabled=sending||busy||disabled;
  send.textContent=sending?'در حال ارسال…':'ارسال ویس به صندوق';
  discard.hidden=!busy&&!file;discard.disabled=sending;
  phone.disabled=disabled||busy||sending;
  player.hidden=!file;timer.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  status.textContent=error|| (sending?'در حال ذخیرهٔ خصوصی ویس؛ این صفحه را باز نگه دارید.':phase==='requesting'?'اجازهٔ دسترسی به میکروفن را تأیید کنید.':phase==='recording'?'در حال ضبط… پس از پایان صحبت «پایان ضبط» را بزنید.':phase==='stopping'?'در حال آماده‌کردن ویس…':file?'ویس آماده است؛ می‌توانید آن را بشنوید، ارسال یا حذف کنید.':'پس از ضبط، ویس را بشنوید و ارسال کنید. حداکثر ۱۰ دقیقه یا ۲۰ مگابایت.');
  status.dataset.error=String(Boolean(error));
  const update=get('app-update');if(update)update.hidden=!(error&&/AriosAndroid\//.test(scope.navigator?.userAgent||''));
 };
 const capture=createAudioCapture({scope,onChange:s=>{phase=s.phase;seconds=s.seconds;if(s.file){file=s.file;onFile(file);preview();}render(s.error);}});
 listen(start,'click',()=>{if(!disabled&&!sending){file=null;onFile(null);clearPreview();void capture.start();}});
 listen(stop,'click',()=>capture.stop());
 listen(discard,'click',()=>{if(sending)return;capture.cancel();file=null;onFile(null);clearPreview();phase='idle';render();});
 listen(phone,'click',()=>{if(!disabled&&!sending&&!capture.busy)phoneInput.click();});
 listen(phoneInput,'change',()=>{
  const chosen=phoneInput.files?.[0];if(!chosen)return;
  if(!chosen.size||chosen.size>MAX_RECORDED_BYTES){render('یک فایل صوتی غیرخالی تا ۲۰ مگابایت انتخاب کنید.');phoneInput.value='';return;}
  if(!chosen.type.startsWith('audio/')&&!/\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(chosen.name)){render('یک فایل صوتی معتبر انتخاب کنید.');phoneInput.value='';return;}
  capture.cancel();file=chosen;onFile(file);seconds=0;phase='ready';preview();render();phoneInput.value='';
 });
 listen(send,'click',async()=>{
  if(disabled||disposed||sending||capture.busy||!file)return;
  sending=true;render();
  try{
   const result=await upload(file);
   if(disposed)return;
   file=null;onFile(null);clearPreview();phase='idle';sending=false;render();await onSaved(result);
  }catch(error){if(!disposed){sending=false;render(error?.message||'ارسال ویس کامل نشد؛ ویس حفظ شده است و می‌توانید دوباره ارسال کنید.');}}
 });
 const stopForBackground=()=>{capture.stop();player?.pause?.();};
 listen(scope,'arios-native-background',stopForBackground);
 listen(scope,'pagehide',stopForBackground);
 listen(scope.document,'visibilitychange',()=>{if(scope.document.hidden)stopForBackground();});
 if(file)preview();render();
 return {get busy(){return capture.busy||sending||Boolean(file);},dispose(){disposed=true;capture.dispose();clearPreview();for(const cleanup of handlers)cleanup();block.dataset.recordingBusy='false';}};
}
