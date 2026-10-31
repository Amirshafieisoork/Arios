#!/usr/bin/env node
/** Build the native Android app without Gradle or third-party Android libraries.
 * Signing keys and their password files must remain outside the source checkout.
 */
import {mkdir,readFile,writeFile,readdir,stat,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const fail=message=>{throw new Error(message);};
const envPath=(name,fallback)=>resolve(process.env[name]||fallback);
const sdk=envPath('ARIOS_ANDROID_SDK_ROOT',process.env.ANDROID_HOME||'/workspace/work/android-toolchain/sdk');
const ecj=envPath('ARIOS_ANDROID_ECJ_JAR','/workspace/work/android-toolchain/downloads/ecj-3.39.0.jar');
const java=process.env.ARIOS_ANDROID_JAVA||'java';
const keytool=process.env.ARIOS_ANDROID_KEYTOOL||'keytool';
const tools=join(sdk,'build-tools','35.0.1'),platform=join(sdk,'platforms','android-35','android.jar');
const source=join(root,'android-app','src','main');
const output=envPath('ARIOS_ANDROID_OUTPUT',join(root,'dist-android'));
const work=join(output,'.build');
const withinRepo=path=>path===root||path.startsWith(root+'/');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(path){const result=[];for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(path,item.name);if(item.isSymbolicLink())fail('Symbolic links are not accepted in Android build inputs.');if(item.isDirectory())result.push(...await files(p));else if(item.isFile())result.push(p);}return result;}
async function sourceDigest(paths){const hash=createHash('sha256');for(const path of paths){hash.update(relative(source,path)+'\0');hash.update(await readFile(path));}return hash.digest('hex');}
async function run(command,args,{capture=false}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:root,env:process.env,stdio:['ignore',capture?'pipe':'inherit',capture?'pipe':'inherit']});let stdout='',stderr='';
    if(capture){child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});}
    child.on('error',reject);child.on('close',code=>code===0?resolve(stdout):reject(new Error(`${command} failed (${code}).${capture?' '+stderr.slice(0,1200):''}`)));
  });
}
async function initSigning(path){
  const privateDir=resolve(path);if(withinRepo(privateDir))fail('Signing material must be outside the source checkout.');
  await mkdir(privateDir,{recursive:true,mode:0o700});const pass=join(privateDir,'keystore-password.txt'),keystore=join(privateDir,'arios-release.p12');
  try{await stat(keystore);fail('A release keystore already exists; it must never be replaced for updates.');}catch(error){if(error.code!=='ENOENT')throw error;}
  await writeFile(pass,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx'});
  await run(keytool,['-genkeypair','-keystore',keystore,'-storetype','PKCS12','-storepass:file',pass,'-keypass:file',pass,'-alias','arios-release','-keyalg','RSA','-keysize','3072','-sigalg','SHA256withRSA','-validity','10000','-dname','CN=ARIOS Android, OU=Mobile, O=ARIOS Group, C=IR']);
  console.log('Created private Android signing files. Preserve this directory independently for all future updates.');
}

async function build(){
  const keystore=process.env.ARIOS_ANDROID_KEYSTORE&&resolve(process.env.ARIOS_ANDROID_KEYSTORE),pass=process.env.ARIOS_ANDROID_KEYSTORE_PASS_FILE&&resolve(process.env.ARIOS_ANDROID_KEYSTORE_PASS_FILE),alias=process.env.ARIOS_ANDROID_KEY_ALIAS||'arios-release';
  if(!keystore||!pass)fail('Set ARIOS_ANDROID_KEYSTORE and ARIOS_ANDROID_KEYSTORE_PASS_FILE to private file paths.');
  if(withinRepo(keystore)||withinRepo(pass))fail('Release signing files must be outside the source checkout.');
  const lambdaStubs=join(tools,'core-lambda-stubs.jar');
  for(const path of [keystore,pass,platform,lambdaStubs,ecj,join(tools,'aapt2'),join(tools,'lib/d8.jar'),join(tools,'lib/apksigner.jar'),join(source,'AndroidManifest.xml')])await stat(path);
  const compiler=await readFile(ecj);if(digest(compiler)!=='01f5a92ac19bb2b3bf85e295a68f2c73c264369109158b566ce9b490af982948')fail('Unexpected ECJ compiler checksum.');
  if(output===root||output===source||output==='/'||output===dirname(root))fail('Unsafe Android output directory.');
  await mkdir(output,{recursive:true});await rm(work,{recursive:true,force:true});await mkdir(work,{recursive:true});for(const folder of ['generated','classes','dex'])await mkdir(join(work,folder));
  const inputs=await files(source),sourceHash=await sourceDigest(inputs);
  await run(join(tools,'aapt2'),['compile','--dir',join(source,'res'),'-o',join(work,'resources.zip')]);
  const assetArgs=[];try{if((await stat(join(source,'assets'))).isDirectory())assetArgs.push('-A',join(source,'assets'));}catch(error){if(error.code!=='ENOENT')throw error;}
  await run(join(tools,'aapt2'),['link','--manifest',join(source,'AndroidManifest.xml'),'-I',platform,'--java',join(work,'generated'),'--min-sdk-version','28','--target-sdk-version','35','--auto-add-overlay',...assetArgs,'-o',join(work,'resources.ap_'),join(work,'resources.zip')]);
  const javaFiles=[...inputs.filter(path=>path.endsWith('.java')),...await files(join(work,'generated'))];if(!javaFiles.length)fail('Native Android source files are missing.');
  // The Android platform jar excludes the compile-time invokedynamic stubs.
  // The official build-tools jar supplies those symbols; D8 desugars lambdas
  // into Android-compatible classes and the stubs are never packaged.
  await run(java,['-jar',ecj,'-1.8','-encoding','UTF-8','-bootclasspath',platform+':'+lambdaStubs,'-d',join(work,'classes'),...javaFiles]);
  await run('python3',['-c',`import pathlib,zipfile,sys
p=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(p/'classes.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
 for f in sorted((p/'classes').rglob('*.class')):
  i=zipfile.ZipInfo(str(f.relative_to(p/'classes')),(1980,1,1,0,0,0));i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,f.read_bytes())
`,work]);
  await run(java,['-cp',join(tools,'lib/d8.jar'),'com.android.tools.r8.D8','--release','--min-api','28','--lib',platform,'--output',join(work,'dex'),join(work,'classes.zip')]);
  await run('python3',['-c',`import pathlib,zipfile,sys
p=pathlib.Path(sys.argv[1]);entries={}
with zipfile.ZipFile(p/'resources.ap_') as z:
 for i in z.infolist(): entries[i.filename]=(z.read(i),i.compress_type)
for f in sorted((p/'dex').glob('*.dex')):entries[f.name]=(f.read_bytes(),zipfile.ZIP_DEFLATED)
with zipfile.ZipFile(p/'unsigned.apk','w') as z:
 for name,(data,compression) in sorted(entries.items()):
  i=zipfile.ZipInfo(name,(1980,1,1,0,0,0));i.compress_type=compression;z.writestr(i,data)
`,work]);
  await run(join(tools,'zipalign'),['-f','-p','4',join(work,'unsigned.apk'),join(work,'aligned.apk')]);
  const apk=join(work,'signed.apk');
  // PKCS12 uses the same store/key password. Supplying the same one-line file
  // twice makes apksigner consume a second line and fail at EOF.
  await run(java,['-jar',join(tools,'lib/apksigner.jar'),'sign','--ks',keystore,'--ks-key-alias',alias,'--ks-pass','file:'+pass,'--min-sdk-version','28','--v1-signing-enabled','false','--v2-signing-enabled','true','--v3-signing-enabled','true','--v4-signing-enabled','false','--out',apk,join(work,'aligned.apk')]);
  // Include API24 in signature-only verification to exercise v2 as well as v3.
  // The actual app remains restricted to minSdk28, checked in its manifest.
  const signature=await run(java,['-jar',join(tools,'lib/apksigner.jar'),'verify','--min-sdk-version','24','--verbose','--print-certs',apk],{capture:true});
  await run(join(tools,'zipalign'),['-c','-p','4',apk]);
  const badging=await run(join(tools,'aapt2'),['dump','badging',apk],{capture:true});
  if(!badging.includes("package: name='ir.arioshub.app'")||!badging.includes("minSdkVersion:'28'")||!badging.includes("targetSdkVersion:'35'"))fail('Unexpected Android package metadata.');
  if(!signature.includes('Verified using v2 scheme (APK Signature Scheme v2): true')||!signature.includes('Verified using v3 scheme (APK Signature Scheme v3): true'))fail('APK signature verification failed.');
  if(sourceHash!==await sourceDigest(await files(source)))fail('Android source changed during the build; rebuild the final source tree.');
  const apkBytes=await readFile(apk),sha256=digest(apkBytes),metadata={applicationId:'ir.arioshub.app',versionCode:Number(badging.match(/versionCode='(\d+)'/)?.[1]),versionName:badging.match(/versionName='([^']+)'/)?.[1],minSdk:28,targetSdk:35,bytes:apkBytes.byteLength,sha256,sourceTreeSha256:sourceHash,signerCertificateSha256:signature.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1],signatureSchemes:['v2','v3'],toolchain:{platform:'35_r02',buildTools:'35.0.1',compiler:'ECJ3.39.0'},format:'arios-android-release/v1'};
  // Only expose a release file after verification and stable-source checks.
  await writeFile(join(output,'arios-android.apk'),apkBytes);
  await writeFile(join(output,'arios-android.apk.sha256'),sha256+'  arios-android.apk\n');await writeFile(join(output,'arios-android-release.json'),JSON.stringify(metadata,null,2)+'\n');await writeFile(join(output,'apk-verification.txt'),signature+'\n'+badging);
  console.log(JSON.stringify(metadata,null,2));
}
try{const args=process.argv.slice(2);if(args[0]==='--init-signing'&&args.length===2)await initSigning(args[1]);else if(args.length===0)await build();else fail('Usage: node scripts/build-android.mjs [--init-signing PRIVATE_DIRECTORY]');}catch(error){console.error(error.message);process.exitCode=1;}
