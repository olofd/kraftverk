import type { SqlDatabase, SqlStatement } from './database.ts';

/**
 * What of a sql.js database the port needs — SQLite compiled to WebAssembly,
 * what a browser keeps a home in. Described here rather than imported, so the
 * store depends on no build of it: the place that opens one hands it over.
 */
export type SqlJsDatabase = {
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: readonly unknown[]): unknown;
  exec(sql: string): unknown;
  getRowsModified(): number;
  close(): void;
};

type SqlJsStatement = {
  bind(params?: readonly unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): boolean;
};

/**
 * A sql.js database as the port. Its transactions are savepoints, so one
 * within another nests, as bun:sqlite's do: an inner one that fails rolls
 * back only itself, and the outer decides.
 */
export function fromSqlJs(db: SqlJsDatabase): SqlDatabase {
  let depth = 0;
  const rows = <Row>(sql: string, params: readonly unknown[], one: boolean): Row[] => {
    const statement = db.prepare(sql);
    try {
      statement.bind(params.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)));
      const found: Row[] = [];
      while (statement.step()) {
        found.push(statement.getAsObject() as Row);
        if (one) break;
      }
      return found;
    } finally {
      statement.free();
    }
  };
  return {
    query<Row, Params extends readonly unknown[]>(sql: string): SqlStatement<Row, Params> {
      return {
        get: (...params) => rows<Row>(sql, params, true)[0] ?? null,
        all: (...params) => rows<Row>(sql, params, false),
        run: (...params) => {
          db.run(sql, params.map((value) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value)));
          return { changes: db.getRowsModified() };
        },
      };
    },
    exec: (sql) => void db.exec(sql),
    transaction<T>(fn: () => T): () => T {
      return () => {
        const name = `kraftverk_${depth++}`;
        db.exec(`SAVEPOINT ${name}`);
        try {
          const result = fn();
          db.exec(`RELEASE ${name}`);
          return result;
        } catch (error) {
          db.exec(`ROLLBACK TO ${name}`);
          db.exec(`RELEASE ${name}`);
          throw error;
        } finally {
          depth -= 1;
        }
      };
    },
    close: () => db.close(),
  };
}
