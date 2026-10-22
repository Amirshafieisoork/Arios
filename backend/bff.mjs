import { loginIdentity } from '../public/identity.mjs';

const ACCESS='arios_access',REFRESH='arios_refresh';
const fail=(message,status=400,code='INVALID_INPUT')=>{const e=new Error(message);e.status=status;e.code=code;throw e;};
const json=(data,status=200,cookies=[])=>new Response(JSON.stringify(data),{status,headers:[['Content-Type','application/json; charset=utf-8'],['Cache-Control','private, no-store'],...cookies.map(c=>['Set-Cookie',c])]});
const safeSession=(portal='team')=>({user:null,demo:false,authMode:'supabase',portal,capabilities:{hosted:true,supabaseAuth:true,ai:false,voice:false,telegram:false,payments:false}});
function cookies(request){const result={};for(const item of(request.headers.get('cookie')||'').split(';')){const i=item.indexOf('=');if(i>0){const key=item.slice(0,i).trim();try{result[key]=decodeURIComponent(item.slice(i+1));}catch{}}}return result;}
function sessionCookies(session,secure=true){const attributes=`; Path=/; HttpOnly; SameSite=Lax${secure?'; Secure':''}`;return [`${ACCESS}=${encodeURIComponent(session.access_token)}; Max-Age=${Math.min(Number(session.expires_in)||3600,86400)}${attributes}`,`${REFRESH}=${encodeURIComponent(session.refresh_token)}; Max-Age=2592000${attributes}`];}
const clearCookies=secure=>sessionCookies({access_token:'',refresh_token:'',expires_in:-1},secure).map(x=>x.replace('Max-Age=2592000','Max-Age=0').replace('Max-Age=-1','Max-Age=0'));
async function boundedJSON(response,max=1048576){const reader=response.body?.getReader();if(!reader)return {};let length=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>max){await reader.cancel();fail('پاسخ سرویس بیش از حد مجاز است.',502,'UPSTREAM_RESPONSE_TOO_LARGE');}chunks.push(value);}const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail('پاسخ سرویس قابل خواندن نیست.',502,'UPSTREAM_INVALID_RESPONSE');}}
async function readBody(request){if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))fail('درخواست باید JSON باشد.',415);const data=await boundedJSON(request,65536);if(!data||typeof data!=='object'||Array.isArray(data))fail('درخواست معتبر نیست.');return data;}
function config(env){const url=env.ARIOS_SUPABASE_URL,key=env.ARIOS_SUPABASE_PUBLISHABLE_KEY;if(!url||!key)fail('اتصال آریوس هنوز آماده نیست.',503,'CONFIG_NOT_READY');const u=new URL(url);if(u.protocol!=='https:'||!u.hostname.endsWith('.supabase.co')||u.pathname!=='/')fail('تنظیم سرویس معتبر نیست.',503,'CONFIG_INVALID');return {url:u.origin,key};}
const checkOrigin=request=>{if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')fail('مبدأ درخواست مجاز نیست.',403,'ORIGIN_DENIED');};
async function publicVisitor(saved,secure,key){
 const prior=saved.arios_visitor,valid=typeof prior==='string'&&/^[a-f0-9-]{36}$/.test(prior),id=valid?prior:crypto.randomUUID();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('arios-public:'+key+':'+id)))).map(x=>x.toString(16).padStart(2,'0')).join('');
 return {clientId:digest,cookies:valid?[]:[`arios_visitor=${id}; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax${secure?'; Secure':''}`]};
}
async function authRequest(c,path,body,fetcher){let response;try{response=await fetcher(c.url+'/auth/v1/'+path,{method:'POST',headers:{apikey:c.key,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{fail('ارتباط با سرویس ورود برقرار نشد.',502,'AUTH_UNAVAILABLE');}if(response.status>=300&&response.status<400)fail('نشانی سرویس ورود تأیید نشد.',502,'AUTH_REDIRECT_BLOCKED');const data=await boundedJSON(response);if(!response.ok){if(response.status===429)fail('تعداد تلاش‌های ورود زیاد است؛ کمی بعد تلاش کنید.',429,'RATE_LIMITED');fail('شماره تماس، ایمیل یا رمز عبور درست نیست.',401,'INVALID_CREDENTIALS');}return data;}
async function edgeRequest(c,path,request,token,fetcher,body){const headers=new Headers({'Content-Type':'application/json',apikey:c.key});if(token)headers.set('Authorization','Bearer '+token);let response;try{response=await fetcher(c.url+'/functions/v1/arios-api'+path,{method:request.method,headers,...(request.method==='GET'||request.method==='HEAD'?{}:{body:JSON.stringify(body||{})}),redirect:'manual',signal:AbortSignal.timeout(200000)});}catch{fail('ارتباط با فضای کار برقرار نشد؛ دوباره تلاش کنید.',502,'BACKEND_UNAVAILABLE');}if(response.status>=300&&response.status<400)fail('نشانی فضای کار تأیید نشد.',502,'BACKEND_REDIRECT_BLOCKED');return {response,data:await boundedJSON(response,4*1024*1024)};}

export function createBff({env=process.env,fetcher=fetch}={}){return async request=>{const secure=new URL(request.url).protocol==='https:';try{const path=new URL(request.url).pathname.replace(/^\/api/,'')||'/';if(!['GET','POST'].includes(request.method))return json({error:'روش درخواست مجاز نیست.'},405);const c=config(env),saved=cookies(request);if(request.method==='POST')checkOrigin(request);
 if(path==='/login'&&request.method==='POST'){
  const body=await readBody(request);
  if(typeof body.password!=='string'||!body.password||body.password.length>128)fail('اطلاعات ورود معتبر نیست.');
  const identity=loginIdentity(body);let session;
  if(identity.phone||identity.username){
   const login=await edgeRequest(c,'/password-login',request,null,fetcher,{...identity,password:body.password});
   if(!login.response.ok)fail(login.response.status===401?'شماره تماس یا رمز عبور درست نیست.':login.data.error||'ورود انجام نشد؛ دوباره تلاش کنید.',login.response.status,login.data.code||'INVALID_CREDENTIALS');
   session=login.data;
  }else session=await authRequest(c,'token?grant_type=password',{email:identity.email,password:body.password},fetcher);
  if(typeof session.access_token!=='string'||!session.access_token||typeof session.refresh_token!=='string'||!session.refresh_token)fail('پاسخ ورود معتبر نیست.',502);
  const verified=await edgeRequest(c,'/session',new Request(request.url,{method:'GET'}),session.access_token,fetcher);
  if(!verified.response.ok||!verified.data.user||!['manager','worker','customer','warehouse','accountant'].includes(verified.data.user.role)){
   await fetcher(c.url+'/auth/v1/logout',{method:'POST',headers:{apikey:c.key,Authorization:'Bearer '+session.access_token},redirect:'manual'}).catch(()=>{});
   fail('این حساب به فضای کار آریوس دسترسی ندارد.',403,'NOT_A_MEMBER');
  }
  const portal=verified.data.user.role==='customer'?'client':'team';
  return json({...verified.data,portal},200,sessionCookies(session,secure));
 }
 if(path==='/password-reset/request'&&request.method==='POST'){const body=await readBody(request);const identity=loginIdentity(body);const r=await edgeRequest(c,path,request,null,fetcher,{identifier:Object.values(identity)[0]});return json(r.data,r.response.status);}
 if(path==='/bootstrap'&&request.method==='POST'){const body=await readBody(request);const r=await edgeRequest(c,path,request,null,fetcher,body);return json(r.data,r.response.status);}
 if(path==='/public-projects'&&request.method==='GET'){const r=await edgeRequest(c,path,request,null,fetcher);return json(r.data,r.response.status);}
 if(path==='/public-assistant'&&request.method==='POST'){const body=await readBody(request);const visitor=await publicVisitor(saved,secure,c.key);const r=await edgeRequest(c,path,request,null,fetcher,{message:body.message,history:body.history??[],clientId:visitor.clientId});return json(r.data,r.response.status,visitor.cookies);}
 if(path==='/logout'&&request.method==='POST'){if(saved[ACCESS])await fetcher(c.url+'/auth/v1/logout',{method:'POST',headers:{apikey:c.key,Authorization:'Bearer '+saved[ACCESS]},redirect:'manual',signal:AbortSignal.timeout(15000)}).catch(()=>{});return json({ok:true},200,clearCookies(secure));}
 if(path==='/health'&&request.method==='GET'){const r=await edgeRequest(c,path,request,null,fetcher);return json(r.data,r.response.status);}
 if(!saved[ACCESS]&&!saved[REFRESH])return path==='/session'&&request.method==='GET'?json(safeSession()):json({error:'برای ادامه وارد شوید.',code:'UNAUTHORIZED'},401);
 let token=saved[ACCESS],updated=[];let body;if(request.method==='POST')body=await readBody(request);let result=token?await edgeRequest(c,path,request,token,fetcher,body):null;
 if((!result||result.response.status===401)&&saved[REFRESH]){try{const session=await authRequest(c,'token?grant_type=refresh_token',{refresh_token:saved[REFRESH]},fetcher);if(typeof session.access_token!=='string'||!session.access_token||typeof session.refresh_token!=='string'||!session.refresh_token)fail('نشست معتبر نیست.',401,'INVALID_SESSION');token=session.access_token;updated=sessionCookies(session,secure);result=await edgeRequest(c,path,request,token,fetcher,body);}catch{if(path==='/session')return json(safeSession(),200,clearCookies(secure));return json({error:'نشست منقضی شده؛ دوباره وارد شوید.',code:'UNAUTHORIZED'},401,clearCookies(secure));}}
 if(!result)return json({error:'برای ادامه وارد شوید.',code:'UNAUTHORIZED'},401);if(path==='/session'&&result.response.status===401)return json(safeSession(),200,clearCookies(secure));return json(result.data,result.response.status,updated);
 }catch(error){return json({error:error.status?error.message:'درخواست انجام نشد؛ دوباره تلاش کنید.',code:error.code||'INTERNAL_ERROR'},error.status||500);}};}
