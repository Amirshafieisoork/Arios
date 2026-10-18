import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const dist = join(root, 'dist');
const blocked = new Set(['.git', '.openai', '.data', '.aws', 'node_modules', 'secrets', 'dist', 'downloads']);

function allowed(name) {
  if (blocked.has(name) || name.startsWith('.env') || name.startsWith('.')) return false;
  return !/\.(?:db|sqlite|sqlite3|zip|tar|gz|tgz|pem|key)(?:-(?:wal|shm))?$/i.test(name);
}

function copyPublic(source, target) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (allowed(entry.name)) copyPublic(join(source, entry.name), join(target, entry.name));
    }
  } else if (info.isFile()) {
    cpSync(source, target);
  }
}

if (!existsSync(publicDir) || lstatSync(publicDir).isSymbolicLink()) {
  throw new Error('Expected a real public directory.');
}
if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) {
  throw new Error('Refusing to replace a symbolic link at dist.');
}
rmSync(dist, { recursive: true, force: true });
copyPublic(publicDir, dist);
writeFileSync(join(dist, 'preview-config.mjs'), 'export const STATIC_PREVIEW = true;\n', { mode: 0o644 });

// A source archive is optional and must be generated explicitly by package:source.
const archive = resolve(root, '..', 'deliverables', 'ARIOS_OS_source.zip');
if (existsSync(archive) && lstatSync(archive).isFile() && !lstatSync(archive).isSymbolicLink()) {
  mkdirSync(join(dist, 'downloads'), { recursive: true });
  cpSync(archive, join(dist, 'downloads', 'ARIOS_OS_source.zip'));
}
console.log(`Static demo built: ${dist}`);
console.log('The preview uses fictional browser-local data. It does not run the Node backend.');
