import { useEffect, useMemo, useRef, useState } from 'react';
import { autocompletion, closeBrackets, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { linter, lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, tooltips } from '@codemirror/view';
import { useTheme, YStack } from 'tamagui';

import { apiOver, type MessageEnd } from '@kraftverk/message-port';
import type { ScriptLanguage } from '@kraftverk/script-language';

import { ProblemList, type ScriptEditorProps, type TextProblem } from './ProblemList';
import { diagnosticsOf, editableAs, lookOf } from './YamlEditor.web';

/** How long typing rests before the language service is asked what is wrong. */
const CHECK_AFTER_MS = 300;

/** The language service, in a worker of its own beside the app (scripts/build-home-worker.mjs): one per editor, let go of with it. */
function openLanguage(): { language: ScriptLanguage; close: () => void } {
  const worker = new Worker('/script/language.js', { type: 'module', name: 'kraftverk-script-language' });
  return { language: apiOver<ScriptLanguage>(worker as unknown as MessageEnd, 'language'), close: () => worker.terminate() };
}

/**
 * A script's TypeScript, written in the browser (docs/PLAN-SCRIPTS.md
 * §11.3): CodeMirror with TypeScript's colours and the YAML editor's look,
 * and TypeScript 6's language service in a worker — checking it against the
 * SDK and this home's types (`types`) as it is typed, completing, explaining
 * on hover. Its problems — the hub's, from reading it, and the types' —
 * marked where they are and listed under it.
 */
export function ScriptEditor({ value, onChange, problems = [], label, minLines = 16, types = null }: ScriptEditorProps) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const editable = useMemo(() => new Compartment(), []);
  const looks = useMemo(() => new Compartment(), []);
  const readOnly = !onChange;
  /** What TypeScript says is wrong, as it is now: shown beside the hub's. */
  const [typeProblems, setTypeProblems] = useState<TextProblem[]>([]);
  const service = useRef<ReturnType<typeof openLanguage> | null>(null);
  const language = () => (service.current ??= openLanguage()).language;

  const colors = {
    background: theme.background?.val as string,
    card: (theme.card?.val ?? theme.background?.val) as string,
    color: theme.color?.val as string,
    muted: theme.muted?.val as string,
    border: theme.borderColor?.val as string,
    accent: theme.accent?.val as string,
    warning: theme.warning?.val as string,
    success: theme.success?.val as string,
    danger: theme.danger?.val as string,
  };
  const look = useMemo(() => lookOf(colors), [colors.background, colors.card, colors.color, colors.muted, colors.border, colors.accent, colors.warning, colors.success, colors.danger]);

  // Made once; what changes after is dispatched into it.
  useEffect(() => {
    if (!host.current) return;
    /** TypeScript's problems with the script as it is, marked where they are. */
    const checked = linter(
      async (editor): Promise<Diagnostic[]> => {
        const found = await language().problems(editor.state.doc.toString()).catch(() => []);
        setTypeProblems(found.map((each) => ({ message: each.message, line: each.line, column: each.column })));
        const length = editor.state.doc.length;
        return found.map((each) => ({ from: Math.min(each.from, length), to: Math.min(Math.max(each.to, each.from), length), severity: 'error' as const, message: each.message, source: 'TypeScript' }));
      },
      { delay: CHECK_AFTER_MS }
    );
    /** What may be written here, by TypeScript: a device's key, a capability's commands, the SDK's names. */
    const complete = async (context: CompletionContext): Promise<CompletionResult | null> => {
      const word = context.matchBefore(/[\w$-]*/);
      if (!context.explicit && (!word || word.from === word.to) && !/[.'"]$/.test(context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos))) return null;
      const found = await language().complete(context.state.doc.toString(), context.pos).catch(() => null);
      if (!found || !found.options.length) return null;
      return { from: found.from, options: found.options.map((option) => ({ label: option.label, type: option.kind === 'method' || option.kind === 'function' ? 'function' : option.kind === 'property' ? 'property' : option.kind === 'string' ? 'text' : 'variable' })), validFor: /^[\w$-]*$/ };
    };
    /** What a name is, and its words: a command's, a device's, the SDK's. */
    const hover = hoverTooltip(async (editor, at) => {
      const found = await language().hover(editor.state.doc.toString(), at).catch(() => null);
      if (!found || !found.text) return null;
      return {
        pos: found.from,
        end: found.to,
        create: () => {
          const dom = document.createElement('div');
          dom.style.whiteSpace = 'pre-wrap';
          dom.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          dom.style.fontSize = '12px';
          dom.textContent = found.text;
          return { dom };
        },
      };
    });
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          EditorState.tabSize.of(2),
          indentUnit.of('  '),
          EditorView.lineWrapping,
          javascript({ typescript: true }),
          checked,
          autocompletion({ override: [complete] }),
          hover,
          tooltips({ position: 'fixed', parent: document.body }),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          editable.of(editableAs(readOnly)),
          looks.of(look),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
      service.current?.close();
      service.current = null;
    };
  }, []);

  // The home's types: given the service as they come, and the script looked at again against them.
  useEffect(() => {
    if (types === null) return;
    void language()
      .types(types)
      .then(() => {
        const current = view.current;
        if (current) current.dispatch({ changes: { from: 0, to: 0, insert: '' } });
      })
      .catch(() => undefined);
  }, [types]);

  // A value given from outside replaces what is there.
  useEffect(() => {
    const current = view.current;
    if (current && current.state.doc.toString() !== value) current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.reconfigure(editableAs(readOnly)) });
  }, [readOnly, editable]);

  useEffect(() => {
    view.current?.dispatch({ effects: looks.reconfigure(look) });
  }, [look, looks]);

  // The hub's problems, marked where they are; the language service marks its own as the script is typed.
  useEffect(() => {
    const current = view.current;
    if (current && problems.length) current.dispatch(setDiagnostics(current.state, diagnosticsOf(current.state, problems)));
  }, [problems]);

  const shown = [...problems, ...typeProblems.filter((each) => !problems.some((one) => one.line === each.line && one.message === each.message))];
  return (
    <YStack gap="$2">
      <YStack borderWidth={1} borderColor={shown.length ? '$warning' : '$borderColor'} borderRadius="$4" overflow="hidden">
        <div ref={host} style={{ minHeight: minLines * 20 + 16, maxHeight: '70vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }} />
      </YStack>
      <ProblemList problems={shown} />
    </YStack>
  );
}
