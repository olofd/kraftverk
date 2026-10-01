/*
  What the YAML editor's schema support (`codemirror-json-schema`) renders
  its tooltips with, in place of its own: that one loads a code highlighter —
  shiki, with its grammars and its WebAssembly — when it is first imported,
  to colour code blocks a schema's descriptions here never have. Metro
  resolves the library's `utils/markdown` to this (`client/metro.config.js`).
  The schema's words, escaped; `code` set as code, **this** as strong.
*/

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderMarkdown(markdown: string, inline = true): string {
  const html = escape(markdown)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return inline ? html : html.split(/\n{2,}/).map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('');
}
