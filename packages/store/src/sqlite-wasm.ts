import type { SqlDatabase, SqlStatement } from './database.ts';

/**
 * What of a database from SQLite's own WebAssembly build
 * (`@sqlite.org/sqlite-wasm`, its `oo1.DB`) the port needs — what a browser
 * keeps a home in, in a worker, on the origin's private file system
 * (docs/PLAN-SHARED-CORE.md, "SQLite in the app"). Described here rather
 * than imported, so the store depends on no build of it: the place that
 * opens one hands it over.
 */
export type SqliteWasmDatabase = {
  prepare(sql: string): SqliteWasmStatement;
  exec(sql: string): unknown;
  changes(): number;
  close(): void;
};

type SqliteWasmStatement = {
  readonly parameterCount: number;
  bind(params: readonly unknown[]): unknown;
  step(): boolean;
  get(row: Record<string, unknown>): Record<string, unknown>;
  reset(alsoClearBinds?: boolean): unknown;
  finalize(): unknown;
};

/** A value as SQLite takes it: nothing is null, and a yes or no is 1 or 0, as bun:sqlite binds them. */
const bindable = (value: unknown) => (value === undefined ? null : typeof value === 'boolean' ? Number(value) : value);

/**
 * A database of SQLite's WebAssembly build as the port. Each statement is
 * prepared once and kept, as bun:sqlite keeps them, and let go on close.
 * Its transactions are savepoints, so one within another nests, as
 * bun:sqlite's do: an inner one that fails rolls back only itself, and the
 * outer decides.
 */
export function fromSqliteWasm(db: SqliteWasmDatabase): SqlDatabase {
  const prepared = new Map<string, SqliteWasmStatement>();
  let depth = 0;

  /** The statement for this text, its bindings set; reset before it is handed back. */
  const bound = (sql: string, params: readonly unknown[]): SqliteWasmStatement => {
    let statement = prepared.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      prepared.set(sql, statement);
    }
    if (statement.parameterCount > 0) statement.bind(params.map(bindable));
    return statement;
  };

  const rows = <Row>(sql: string, params: readonly unknown[], one: boolean): Row[] => {
    const statement = bound(sql, params);
    try {
      const found: Row[] = [];
      while (statement.step()) {
        found.push(statement.get({}) as Row);
        if (one) break;
      }
      return found;
    } finally {
      statement.reset(true);
    }
  };

  return {
    query<Row, Params extends readonly unknown[]>(sql: string): SqlStatement<Row, Params> {
      return {
        get: (...params) => rows<Row>(sql, params, true)[0] ?? null,
        all: (...params) => rows<Row>(sql, params, false),
        run: (...params) => {
          const statement = bound(sql, params);
          try {
            statement.step();
            return { changes: db.changes() };
          } finally {
            statement.reset(true);
          }
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
    close: () => {
      for (const statement of prepared.values()) statement.finalize();
      prepared.clear();
      db.close();
    },
  };
}
