/** Android receives the signed native app; desktop/iOS retain web installation. */
export const ANDROID_APP_DOWNLOAD='/downloads/arios-android.apk';
export function installContext(scope=globalThis){
  const ua=String(scope.navigator?.userAgent||''),platform=String(scope.navigator?.platform||'');
  const ios=/iPhone|iPad|iPod/i.test(ua)||platform==='MacIntel'&&Number(scope.navigator?.maxTouchPoints)>1;
  const installed=scope.matchMedia?.('(display-mode: standalone)')?.matches===true||scope.navigator?.standalone===true;
  return {installed,ios,native:/\bAriosAndroid\/[0-9]/.test(ua),android:/Android/i.test(ua),embedded:/FBAN|FBAV|Instagram|Telegram|; wv\)/i.test(ua),firefox:/Firefox|FxiOS/i.test(ua),secure:scope.isSecureContext===true};
}
export function installationSteps(context){
  if(context.android)return [context.embedded?'این آدرس را در Chrome یا مرورگر اصلی گوشی باز کن و فایل نصب اندروید را دریافت کن.':'فایل نصب اندروید را از دکمهٔ پایین دریافت و باز کن.','اگر اندروید اجازه خواست، نصب از همین مرورگر را تأیید و «نصب» را بزن.','یک‌بار با شماره و رمز آریوس وارد شو؛ بعد قفل برنامه با اثر انگشت خود گوشی باز می‌شود.'];
  if(context.embedded)return ['این صفحه را از منوی مرورگر داخلی، در Chrome یا Safari باز کن.','در مرورگر اصلی، دوباره «نصب آریوس» را بزن.'];
  if(context.ios)return ['آریوس را در Safari باز کن و دکمهٔ اشتراک‌گذاری را بزن.','«افزودن به صفحهٔ اصلی» را انتخاب کن و «باز کردن به‌صورت برنامه» را روشن نگه دار.','«افزودن» را بزن؛ آریوس با آیکون خودش و بدون نوار مرورگر باز می‌شود.'];
  if(context.firefox)return ['برای نصب برنامه با پنجرهٔ مستقل، این آدرس را در Chrome یا Edge باز کن.','از گزینهٔ «نصب آریوس» یا علامت نصب کنار آدرس استفاده کن.'];
  return ['در Chrome یا Edge، علامت نصب کنار نوار آدرس را بزن.','یا از منوی مرورگر، «نصب این سایت به‌عنوان برنامه» را انتخاب کن.','بعد از نصب، آریوس از منوی برنامه‌های سیستم و در پنجرهٔ مستقل باز می‌شود.'];
}
export async function registerAppWorker(scope=globalThis){
  if(installContext(scope).native)return null;
  if(!scope.isSecureContext||!scope.navigator?.serviceWorker||scope.location?.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(scope.location?.hostname))return null;
  return scope.navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
}
export function mountInstaller(scope=globalThis){
  const doc=scope.document,context=installContext(scope);if(!doc?.body||!context.secure||context.native||context.installed&&!context.android||doc.querySelector('[data-arios-install]'))return null;
  const style=doc.createElement('link');style.rel='stylesheet';style.href=new URL('./install.css',import.meta.url).href;doc.head.append(style);
  const container=doc.createElement('aside');container.className='arios-install';container.dataset.ariosInstall='';container.setAttribute('aria-label','نصب برنامه آریوس');
  if(context.android)container.dataset.androidApp='';
  const button=doc.createElement('button');button.className='arios-install-button';button.type='button';button.innerHTML='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/></svg><span>'+(context.android?'دانلود اپ اندروید':'نصب آریوس')+'</span>';
  container.append(button);doc.body.append(container);let deferred=null,dialog=null,busy=false;
  const remove=()=>{dialog?.remove();dialog=null;container.remove();};
  const showGuide=()=>{
    if(dialog?.isConnected){dialog.focus();return;}
    dialog=doc.createElement('dialog');dialog.className='arios-install-dialog';dialog.setAttribute('aria-labelledby','arios-install-title');
    const title=doc.createElement('h2');title.id='arios-install-title';title.textContent=context.android?'نصب اپ اندروید آریوس':'آریوس، در فهرست برنامه‌های تو';
    const intro=doc.createElement('p');intro.textContent=context.android?'نسخهٔ اندروید به‌صورت برنامهٔ مستقل نصب می‌شود و قفل اثر انگشت گوشی دارد. برای دریافت اطلاعات حساب، اینترنت لازم است.':'بعد از نصب، آریوس با آیکون خودش و در پنجرهٔ مستقل باز می‌شود. برای کار با اطلاعات حساب، اینترنت لازم است.';
    const list=doc.createElement('ol');for(const step of installationSteps(installContext(scope))){const li=doc.createElement('li');li.textContent=step;list.append(li);}
    const actions=doc.createElement('div');actions.className='arios-install-actions';
    if(context.android){const download=doc.createElement('a');download.href=ANDROID_APP_DOWNLOAD;download.download='arios-android.apk';download.className='arios-install-primary';download.textContent='دانلود فایل نصب اندروید';actions.append(download);}
    const close=doc.createElement('button');close.type='button';close.textContent='متوجه شدم';close.className='arios-install-primary';close.addEventListener('click',()=>dialog.close());actions.append(close);
    dialog.append(title,intro,list,actions);dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});dialog.addEventListener('close',()=>button.focus());doc.body.append(dialog);dialog.showModal();
  };
  const onPrompt=event=>{event.preventDefault();if(context.android)return;deferred=event;button.querySelector('span').textContent='نصب برنامهٔ آریوس';};
  const onInstalled=()=>{deferred=null;remove();};
  scope.addEventListener('beforeinstallprompt',onPrompt);scope.addEventListener('appinstalled',onInstalled);
  button.addEventListener('click',async()=>{
    if(busy)return;if(!deferred)return showGuide();busy=true;button.disabled=true;
    const prompt=deferred;deferred=null;
    try{await prompt.prompt();const choice=await prompt.userChoice;if(choice?.outcome==='accepted')remove();}
    catch{showGuide();}
    finally{busy=false;if(button.isConnected)button.disabled=false;}
  });
  return {remove,showGuide,destroy(){scope.removeEventListener('beforeinstallprompt',onPrompt);scope.removeEventListener('appinstalled',onInstalled);remove();}};
}
if(typeof window!=='undefined'&&typeof document!=='undefined'){
  // A service-worker failure never blocks sign-in or the operational UI.
  void registerAppWorker(window).catch(()=>{});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>mountInstaller(window),{once:true});else mountInstaller(window);
}
