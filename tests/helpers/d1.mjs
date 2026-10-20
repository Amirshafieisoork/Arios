import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Minimal D1 interface backed by an independent in-memory SQLite database. */
export function createTestD1({ migrate = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (migrate) {
    const directory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(`${directory}/${name}`, 'utf8'));
  }
  const db = {
    prepare(sql) {
      const make = values => ({
        bind: (...next) => make(next),
        async first(column) { const row = sqlite.prepare(sql).get(...values); return row ? column ? row[column] : { ...row } : null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })), meta: {} }; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
      });
      return make([]);
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close: () => sqlite.close(),
    sqlite,
  };
  return db;
}
