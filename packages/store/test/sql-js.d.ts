// sql.js, as these tests open it: the package ships no types of its own.
declare module 'sql.js' {
  import type { SqlJsDatabase } from '../src/sql-js.ts';

  const initSqlJs: () => Promise<{ Database: new () => SqlJsDatabase }>;
  export default initSqlJs;
}
