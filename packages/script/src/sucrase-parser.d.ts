// sucrase's own parser, as signature.ts reads a script's exports with it: the
// same tokens that compile.ts strips, typed by sucrase's own declarations.
declare module 'sucrase/dist/esm/parser/index.js' {
  export const parse: typeof import('sucrase/dist/types/parser/index').parse;
}
declare module 'sucrase/dist/esm/parser/tokenizer/types.js' {
  export const TokenType: typeof import('sucrase/dist/types/parser/tokenizer/types').TokenType;
  export type TokenType = import('sucrase/dist/types/parser/tokenizer/types').TokenType;
}
declare module 'sucrase/dist/esm/parser/tokenizer/keywords.js' {
  export const ContextualKeyword: typeof import('sucrase/dist/types/parser/tokenizer/keywords').ContextualKeyword;
  export type ContextualKeyword = import('sucrase/dist/types/parser/tokenizer/keywords').ContextualKeyword;
}
