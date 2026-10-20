import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const destination=resolve(root,'../packages/ARIOS_OS_hosted.tar');
const code=String.raw`
import pathlib, sys, tarfile
root=pathlib.Path(sys.argv[1]); destination=pathlib.Path(sys.argv[2])
entry=root/'dist/server/index.js'
if not entry.is_file(): raise SystemExit('Run npm run build first')
destination.parent.mkdir(parents=True,exist_ok=True)
with tarfile.open(destination,'w',dereference=True) as bundle:
    for name in ['.openai/hosting.json','dist/server','dist/.openai','drizzle']:
        path=root/name
        for item in sorted([path] if path.is_file() else path.rglob('*')):
            if item.is_file() and not item.is_symlink():
                bundle.add(item,arcname=item.relative_to(root).as_posix(),recursive=False)
print(destination)
`;
const result=spawnSync('python3',['-c',code,root,destination],{stdio:'inherit'});
if(result.error)throw result.error;
if(result.status)process.exit(result.status);
