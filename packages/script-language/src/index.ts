import { createSystem, createVirtualTypeScriptEnvironment, type VirtualTypeScriptEnvironment } from '@typescript/vfs';
import ts from 'typescript';

/*
  The script editor's language service (docs/PLAN-SCRIPTS.md §11.2):
  TypeScript 6's — the last compiler with a JavaScript API — over files
  kept in memory: the script being written, the types it is written against
  (`@kraftverk/script`'s `typesOf`: the SDK and the home), and the
  language's own declarations, ES2022 and no DOM, as a script has none. It
  says what is wrong as it is typed, completes, and explains on hover.

  Where the editor is, never the hub: a browser's worker (the app's
  `public/script/language.js`), served there over a message port. Nothing is
  fetched from anywhere: the library declarations are given it.
*/

/** What is wrong, where — by offset into the script — as the editor marks it. */
export type LanguageProblem = { from: number; to: number; message: string; line: number; column: number };
/** One completion, as the editor lists it. */
export type LanguageCompletion = { label: string; kind: string; detail: string | null };
/** What the editor asks, each with the script as it is now. */
export interface ScriptLanguage {
  /** The types it is written against: the home's `kraftverk.d.ts`, as the hub makes it. */
  types(declarations: string): Promise<void>;
  /** Everything wrong with it: its syntax, then its types. */
  problems(source: string): Promise<LanguageProblem[]>;
  /** What may be written at an offset, and where what it replaces begins. */
  complete(source: string, at: number): Promise<{ from: number; options: LanguageCompletion[] } | null>;
  /** What the name at an offset is, and its words. */
  hover(source: string, at: number): Promise<{ from: number; to: number; text: string } | null>;
}

const SCRIPT = '/script.ts';
const TYPES = '/kraftverk.d.ts';

/** What a script is checked as: strict, ES2022, a module of its own, nothing emitted. */
const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts'],
  types: [],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: false,
  isolatedModules: true,
};

/** A word's start: where a completion of it begins. */
const wordStart = (source: string, at: number): number => {
  let from = at;
  while (from > 0 && /[A-Za-z0-9_$-]/.test(source.charAt(from - 1))) from--;
  return from;
};

/**
 * The language service, given the language's own declarations by file name
 * (`lib.es2022.d.ts` and every one it references): what the app's build
 * copies beside the worker, and a test reads from TypeScript's package.
 */
export function createScriptLanguage(libraries: Readonly<Record<string, string>>): ScriptLanguage {
  const files = new Map<string, string>(Object.entries(libraries).map(([name, text]) => [`/${name}`, text]));
  files.set(TYPES, "declare module 'kraftverk' {}\n");
  files.set(SCRIPT, '\n');
  // The compiler is this package's TypeScript 6: @typescript/vfs names its own TypeScript's types, not the one it is given.
  const env: VirtualTypeScriptEnvironment = createVirtualTypeScriptEnvironment(createSystem(files), [TYPES, SCRIPT], ts as never, OPTIONS as never);
  /** The script as it is now — empty, a line: TypeScript keeps no empty file. */
  const now = (source: string) => env.updateFile(SCRIPT, source.length ? source : '\n');
  const lineOf = (offset: number) => env.getSourceFile(SCRIPT)?.getLineAndCharacterOfPosition(offset) ?? { line: 0, character: 0 };

  return {
    async types(declarations) {
      env.updateFile(TYPES, declarations.length ? declarations : '\n');
    },

    async problems(source) {
      now(source);
      const found = [...env.languageService.getSyntacticDiagnostics(SCRIPT), ...env.languageService.getSemanticDiagnostics(SCRIPT)];
      return found.map((diagnostic) => {
        const from = diagnostic.start ?? 0;
        const at = lineOf(from);
        return { from, to: from + (diagnostic.length ?? 0), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '), line: at.line + 1, column: at.character + 1 };
      });
    },

    async complete(source, at) {
      now(source);
      const info = env.languageService.getCompletionsAtPosition(SCRIPT, at, { includeCompletionsForModuleExports: false, includeCompletionsWithInsertText: true });
      if (!info) return null;
      const from = info.optionalReplacementSpan?.start ?? wordStart(source, at);
      return { from, options: info.entries.slice(0, 200).map((entry: ts.CompletionEntry) => ({ label: entry.name, kind: entry.kind, detail: entry.kindModifiers || null })) };
    },

    async hover(source, at) {
      now(source);
      const info = env.languageService.getQuickInfoAtPosition(SCRIPT, at);
      if (!info) return null;
      const text = [ts.displayPartsToString(info.displayParts), ts.displayPartsToString(info.documentation)].filter(Boolean).join('\n\n');
      return { from: info.textSpan.start, to: info.textSpan.start + info.textSpan.length, text };
    },
  };
}
