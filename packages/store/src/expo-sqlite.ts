import type { SqlDatabase, SqlStatement } from './database.ts';

/**
 * What of an expo-sqlite database the port needs — a phone's SQLite, its
 * synchronous API over JSI (`openDatabaseSync`) — described here rather
 * than imported, so the store depends on no build of it: the app opens one
 * and hands it over.
 */
export type ExpoSqliteDatabase = {
  prepareSync(source: string): ExpoSqliteStatement;
  execSync(source: string): void;
  closeSync(): void;
};

type ExpoBindValue = string | number | null | boolean | Uint8Array;

type ExpoSqliteStatement = {
  executeSync<T>(params: ExpoBindValue[]): { readonly changes: number; getFirstSync(): T | null; getAllSync(): T[]; resetSync(): void };
  finalizeSync(): void;
};

/** A value as SQLite takes it: nothing is null, and a yes or no is 1 or 0, as bun:sqlite binds them. */
const bindable = (value: unknown): ExpoBindValue => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : (value as ExpoBindValue));

/**
 * An expo-sqlite database as the port. Each statement is prepared once and
 * kept, as bun:sqlite keeps them, and let go on close; its transactions are
 * savepoints, so one within another nests as bun:sqlite's do.
 */
export function fromExpoSqlite(db: ExpoSqliteDatabase): SqlDatabase {
  const prepared = new Map<string, ExpoSqliteStatement>();
  let depth = 0;

  const statement = (sql: string): ExpoSqliteStatement => {
    let found = prepared.get(sql);
    if (!found) {
      found = db.prepareSync(sql);
      prepared.set(sql, found);
    }
    return found;
  };

  /** Runs it with these values, reads what it answers, and leaves it ready for the next. */
  const run = <Row, T>(sql: string, params: readonly unknown[], read: (result: ReturnType<ExpoSqliteStatement['executeSync']>) => T): T => {
    const result = statement(sql).executeSync<Row>(params.map(bindable));
    try {
      return read(result as never);
    } finally {
      result.resetSync();
    }
  };

  return {
    query<Row, Params extends readonly unknown[]>(sql: string): SqlStatement<Row, Params> {
      return {
        get: (...params) => run<Row, Row | null>(sql, params, (result) => (result.getFirstSync() as Row | null) ?? null),
        all: (...params) => run<Row, Row[]>(sql, params, (result) => result.getAllSync() as Row[]),
        run: (...params) => run<Row, { changes: number }>(sql, params, (result) => ({ changes: result.changes })),
      };
    },
    exec: (sql) => db.execSync(sql),
    transaction<T>(fn: () => T): () => T {
      return () => {
        const name = `kraftverk_${depth++}`;
        db.execSync(`SAVEPOINT ${name}`);
        try {
          const result = fn();
          db.execSync(`RELEASE ${name}`);
          return result;
        } catch (error) {
          db.execSync(`ROLLBACK TO ${name}`);
          db.execSync(`RELEASE ${name}`);
          throw error;
        } finally {
          depth -= 1;
        }
      };
    },
    close: () => {
      for (const kept of prepared.values()) kept.finalizeSync();
      prepared.clear();
      db.closeSync();
    },
  };
}
