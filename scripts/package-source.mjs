import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deliverables = resolve(root, '..', 'deliverables');

// Python's standard library creates the archive; no npm dependency is required.
// Only these explicit source roots can enter the bundle. Live databases,
// credentials, build output, and generated downloads are never source roots.
const python = String.raw`
import os
import pathlib
import shutil
import sys
import tempfile
import zipfile

root = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
roots = ["public", "worker", "db", "drizzle", "drizzle.config.ts", "server.mjs", "tests", "scripts", "package.json", "package-lock.json", ".env.example", ".gitignore", "README_FA.md", "CONTRACT.md"]
blocked = {".git", ".openai", ".data", ".aws", "node_modules", "secrets", "dist", "downloads", "deliverables", "__pycache__"}
archive_suffixes = (".zip", ".tar", ".gz", ".tgz", ".7z", ".rar")
secret_suffixes = (".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm", ".sqlite3-wal", ".sqlite3-shm", ".pem", ".key", ".pyc")

def allowed(path):
    relative = path.relative_to(root)
    for name in relative.parts:
        if name in blocked:
            return False
        if name.startswith(".") and name not in (".env.example", ".gitignore"):
            return False
        if name.startswith(".env") and name != ".env.example":
            return False
    return not path.name.lower().endswith(archive_suffixes + secret_suffixes)

def files(path):
    if path.is_symlink() or not allowed(path):
        return
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from files(child)
    elif path.is_file():
        yield path

if destination.is_symlink():
    raise SystemExit("Refusing a symbolic-link deliverables directory")
destination.mkdir(parents=True, exist_ok=True)
archive = destination / "ARIOS_OS_source.zip"
if archive.is_symlink():
    raise SystemExit("Refusing a symbolic-link source archive")
fd, temporary_name = tempfile.mkstemp(prefix="arios-source-", suffix=".zip", dir=destination)
os.close(fd)
temporary = pathlib.Path(temporary_name)
try:
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        count = 0
        for name in roots:
            for path in files(root / name):
                bundle.write(path, path.relative_to(root).as_posix())
                count += 1
        if not count:
            raise RuntimeError("No source files found")
    temporary.replace(archive)
finally:
    temporary.unlink(missing_ok=True)

dist = root / "dist"
if dist.is_symlink():
    raise SystemExit("Refusing a symbolic-link dist directory")
downloads = dist / "downloads"
if downloads.is_symlink():
    raise SystemExit("Refusing a symbolic-link downloads directory")
downloads.mkdir(parents=True, exist_ok=True)
copy = downloads / archive.name
if copy.is_symlink():
    raise SystemExit("Refusing a symbolic-link download archive")
shutil.copyfile(archive, copy)
print(f"Source archive: {archive}")
print(f"Preview download: {copy}")
print(f"Source files: {count}")
`;

const result = spawnSync('python3', ['-c', python, root, deliverables], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
