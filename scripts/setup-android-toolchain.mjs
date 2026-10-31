#!/usr/bin/env node
/** Download pinned official Android tools and the Eclipse Java compiler.
 * Uses curl with the execution environment's existing proxy and CA settings.
 */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(process.argv[2]||process.env.ARIOS_ANDROID_TOOLCHAIN_ROOT||'/workspace/work/android-toolchain');
const artifacts=[
  {file:'platform-35_r02.zip',url:'https://dl.google.com/android/repository/platform-35_r02.zip',sha256:'0988cacad01b38a18a47bac14a0695f246bc76c1b06c0eeb8eb0dc825ab0c8e0',directory:'platforms/android-35'},
  {file:'build-tools_r35.0.1_linux.zip',url:'https://dl.google.com/android/repository/build-tools_r35.0.1_linux.zip',sha256:'5993499f3229a021b89f87088c57242aeefaa62316bf3d69da7de40bfd5350f1',directory:'build-tools/35.0.1'},
  {file:'ecj-3.39.0.jar',url:'https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.39.0/ecj-3.39.0.jar',sha256:'01f5a92ac19bb2b3bf85e295a68f2c73c264369109158b566ce9b490af982948'},
];
async function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'inherit',env:process.env});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(command+' failed: '+code)));});}
async function digest(path){return createHash('sha256').update(await readFile(path)).digest('hex');}
try{
  await mkdir(join(root,'downloads'),{recursive:true});await mkdir(join(root,'sdk'),{recursive:true});
  for(const item of artifacts){
    const path=join(root,'downloads',item.file);let good=false;try{good=await digest(path)===item.sha256;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!good){await run('curl',['--fail','--silent','--show-error','--location','--retry','2','--max-time','240',item.url,'--output',path]);if(await digest(path)!==item.sha256)throw Error('Checksum mismatch: '+item.file);}
    if(item.directory)await run('python3',['-c',`import pathlib,zipfile,sys,shutil
archive=pathlib.Path(sys.argv[1]);dest=pathlib.Path(sys.argv[2])
if dest.exists():sys.exit(0)
dest.parent.mkdir(parents=True,exist_ok=True)
temporary=dest.parent/(dest.name+'.extracting')
if temporary.exists():raise RuntimeError('Previous extraction needs review: '+str(temporary))
temporary.mkdir()
with zipfile.ZipFile(archive) as z:
 for i in z.infolist():
  p=pathlib.PurePosixPath(i.filename)
  if p.is_absolute() or '..' in p.parts:raise RuntimeError('Unsafe archive entry')
 z.extractall(temporary)
 for i in z.infolist():
  mode=(i.external_attr>>16)&0o777
  if mode:(temporary/i.filename).chmod(mode)
entries=list(temporary.iterdir())
if len(entries)!=1 or not entries[0].is_dir():raise RuntimeError('Unexpected SDK archive layout')
entries[0].rename(dest);temporary.rmdir()
`,path,join(root,'sdk',item.directory)]);
  }
  await writeFile(join(root,'pinned-toolchain.json'),JSON.stringify({platform:'35_r02',buildTools:'35.0.1',compiler:'ECJ3.39.0',artifacts},null,2)+'\n');
  console.log('Verified Android toolchain ready at '+root+'. Java21 runtime, Python3 and curl are required.');
}catch(error){console.error(error.message);process.exitCode=1;}
