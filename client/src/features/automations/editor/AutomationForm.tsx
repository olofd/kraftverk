import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import {
  checkDraft,
  createAutomation,
  describeError,
  fetchAutomationKit,
  fetchAutomations,
  updateAutomation,
  type AutomationDraftView,
  type AutomationKit,
  type AutomationView,
  type RecipeView,
  type RoleBinding,
} from '@kraftverk/api-client';
import { capabilitiesOf, isAutomationRole, meetsNeed, partsOf } from '@kraftverk/device-sdk';
import { Card, haptic, Icon, Row, RowSeparator, SegmentedControl } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { Screen } from '../../../components/Screen';
import { ASKED_AGAIN, confirmAction, withConfirmation } from '../../../lib/confirm';
import { useDevices } from '../../../state/DevicesProvider';
import type { AutomationSettings } from '../../config/entries';
import { useAutomationYaml } from '../../config/useAutomationYaml';
import { YamlEditor } from '../../config/YamlEditor';
import { useTone } from '../looks';
import { Empty, Group } from '../page/Group';
import { BlockList } from './Blocks';
import { EditorProvider, useEditor } from './context';
import { OTHERWISE, pruned, rolesOf, sameParts, THEN, type Draft } from './draft';
import { Picker } from './fields';
import { OnlyIf, Triggers } from './Triggers';

/*
  An automation being changed, or made (docs/AUTOMATIONS-UX.md): the same
  groups as its page — what it uses, when, only if, what it does, what it does
  if a step fails — each editable in its box, with what is wrong said in the
  group it is about, and Cancel and Save kept below the page.
*/

/** What the editor needs from the server: the recipes and functions it offers, and the automations a step may start. */
export function useEditorKit() {
  const [kit, setKit] = useState<AutomationKit | null>(null);
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([fetchAutomationKit(), fetchAutomations()])
      .then(([nextKit, all]) => live && (setKit(nextKit), setAutomations(all)))
      .catch((err) => live && setError(describeError(err) || 'It could not be read'));
    return () => {
      live = false;
    };
  }, []);
  return { kit, automations, error };
}

/** How it is written: block by block, or as its configuration's YAML. */
type View = 'form' | 'yaml';
const VIEWS: readonly { value: View; label: string }[] = [
  { value: 'form', label: 'Form' },
  { value: 'yaml', label: 'YAML' },
];

/** Where on the page a problem belongs, by the place the server gives it: "Trigger 1: …", "Step 2: …". */
type Place = 'uses' | 'when' | 'onlyIf' | 'does' | 'fails' | 'other';
const placeOf = (problem: string, labels: ReadonlySet<string>): Place =>
  /^Trigger \d+: /.test(problem)
    ? 'when'
    : /^Only if: /.test(problem)
      ? 'onlyIf'
      : /^(Step \d+|What it does)[,:]/.test(problem)
        ? 'does'
        : /^If a step does not succeed/.test(problem)
          ? 'fails'
          : labels.has(problem.slice(0, problem.indexOf(': ')))
            ? 'uses'
            : 'other';

/**
 * The form, as its own screen: a new one (`existing` null) or one being
 * changed. `initial` is the draft it starts from; `prefer` a device whose
 * parts are offered first.
 */
export function AutomationForm({
  existing,
  initial,
  madeFrom,
  prefer,
  back,
  view,
  onSaved,
  onCancel,
}: {
  existing: AutomationView | null;
  initial: Draft;
  madeFrom: string | null;
  prefer?: string | null;
  back: { label: string; to: string };
  /** Which it opens on: the form, or its YAML (docs/CONFIG.md). The form when not said. */
  view?: View;
  onSaved: (automation: AutomationView) => void;
  onCancel: () => void;
}) {
  const { devices, loading } = useDevices();
  const { kit, automations, error } = useEditorKit();
  const [draft, setDraft] = useState<Draft>(initial);
  const title = existing ? existing.name : 'New automation';

  // Its devices too, before it is drawn: what fills each role is named from them, in the form and in its YAML.
  if (!kit || !automations || loading) {
    return (
      <Screen back={back.label} backTo={back.to} title={title}>
        {error ? (
          <Card borderColor="$danger">
            <Text fontSize={14} color="$danger">
              {error}
            </Text>
          </Card>
        ) : (
          <Spinner color="$accent" />
        )}
      </Screen>
    );
  }
  return (
    <EditorProvider
      kit={{
        draft,
        change: (next) => setDraft((current) => next(current)),
        devices: devices.filter((device) => !device.removedAt),
        automations: automations.filter((automation) => automation.id !== existing?.id),
        functions: kit.functions,
        prefer: prefer ?? null,
      }}
    >
      <Editing existing={existing} initial={initial} madeFrom={madeFrom} back={back} title={title} view={view ?? 'form'} onSaved={onSaved} onCancel={onCancel} />
    </EditorProvider>
  );
}

function Editing({
  existing,
  initial,
  madeFrom,
  back,
  title,
  view: opensOn,
  onSaved,
  onCancel,
}: {
  existing: AutomationView | null;
  initial: Draft;
  madeFrom: string | null;
  back: { label: string; to: string };
  title: string;
  view: View;
  onSaved: (automation: AutomationView) => void;
  onCancel: () => void;
}) {
  const tone = useTone();
  const editor = useEditor();
  const { draft } = editor;
  const [check, setCheck] = useState<AutomationDraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kept = useMemo(() => pruned(draft), [draft]);
  // What the form does not edit, and its YAML does: its mode, clock, keeping it so, its place on the home page.
  const before = useMemo<AutomationSettings>(
    () => (existing ? { mode: existing.mode, timeZone: existing.timeZone, recheckMinutes: existing.recheckMinutes, homePlace: existing.homePlace } : { mode: 'observe', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, recheckMinutes: null, homePlace: null }),
    [existing]
  );
  const [settings, setSettings] = useState<AutomationSettings>(before);
  const settingsChanged = (Object.keys(before) as (keyof AutomationSettings)[]).filter((name) => settings[name] !== before[name]);

  // Written as YAML instead: the same draft, read back from the text as soon as it reads right.
  const [view, setView] = useState<View>('form');
  /** The key a whole file pasted into its YAML gives it: what it is made under, or renamed to. */
  const [key, setKey] = useState<string | null>(null);
  /** A new one's recipe, as its YAML says it. */
  const [recipe, setRecipe] = useState(madeFrom);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial) || settingsChanged.length > 0 || key !== null;
  const yaml = useAutomationYaml({
    automationKey: existing?.key ?? 'new',
    madeFrom,
    madeFromFixed: existing !== null,
    devices: editor.devices,
    automations: editor.automations,
    onRead: (read) => (editor.change(() => read.draft), setSettings(read.settings), setKey(read.key), existing ? undefined : setRecipe(read.madeFrom)),
  });
  const switchTo = (next: View) => {
    if (next === view) return;
    // Back to the form only from YAML that reads right: the form shows what it read.
    if (next === 'form' && (yaml.problems.length || yaml.reading)) {
      setProblem('Fix its YAML first: the form shows what it says once it reads right.');
      return;
    }
    setProblem(null);
    if (next === 'yaml') yaml.open(pruned(editor.draft), settings);
    setView(next);
  };
  useEffect(() => {
    if (opensOn === 'yaml') switchTo('yaml');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const yamlProblems = view === 'yaml' ? yaml.problems.length : 0;
  const yamlUnread = view === 'yaml' && (yaml.reading || !yaml.ready);

  // The server's word on the draft, as it is built: every problem, and how it reads — a moment after each change.
  const asked = useRef(0);
  useEffect(() => {
    const turn = ++asked.current;
    const timer = setTimeout(() => {
      checkDraft({ rule: kept.rule, roles: kept.roles, starts: kept.starts }, existing?.id ?? null)
        .then((answer) => turn === asked.current && setCheck(answer))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [kept, existing?.id]);

  const labels = new Set(Object.values(draft.rule.roles).map((spec) => spec.label));
  const problems = (place: Place) => (check?.problems ?? []).filter((one) => placeOf(one, labels) === place);
  const named = draft.name.trim().length > 0;
  const ready = check !== null && check.problems.length === 0 && named && yamlProblems === 0 && !yamlUnread;
  const toFix = (check?.problems.length ?? 0) + (named ? 0 : 1) + yamlProblems;

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const body = { name: draft.name.trim(), rule: kept.rule, roles: kept.roles, starts: kept.starts };
      // What its YAML changed beyond what the form edits.
      const changes = { ...Object.fromEntries(settingsChanged.map((name) => [name, settings[name]])), ...(key && key !== existing?.key ? { key } : {}) };
      const letAct = settings.mode === 'armed' && before.mode !== 'armed';
      const ask = (name: string) => (reason: string, again: boolean) =>
        confirmAction(letAct ? `Let “${name}” act on its own?` : `Change “${name}” while it acts?`, `${again ? `${ASKED_AGAIN}\n\n` : ''}${reason}\n\n${check?.sentence ?? ''}`, letAct ? 'Let it act' : 'Change it');
      const wants = (result: Awaited<ReturnType<typeof updateAutomation>>) => ('needsConfirmation' in result ? { token: result.needsConfirmation, reason: result.reason } : null);
      if (!existing) {
        const made = await createAutomation({ ...body, ...(key ? { key } : {}), madeFrom: recipe, timeZone: settings.timeZone, recheckMinutes: settings.recheckMinutes });
        // A new one only watches, off the home page: what its YAML says beyond that, set as it would be on its page.
        const { mode, homePlace } = changes as Partial<AutomationSettings>;
        if (mode === undefined && homePlace === undefined) return onSaved(made);
        const { answer } = await withConfirmation((confirmation) => updateAutomation(made.id, { ...(mode !== undefined ? { mode } : {}), ...(homePlace !== undefined ? { homePlace } : {}), confirmation }), wants, ask(made.name));
        onSaved('automation' in answer ? answer.automation : made);
        return;
      }
      // One that acts on its own asks first: what it does changes.
      const { answer, declined } = await withConfirmation((confirmation) => updateAutomation(existing.id, { ...body, ...changes, confirmation }), wants, ask(existing.name));
      if (!declined && 'automation' in answer) onSaved(answer.automation);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be saved');
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (changed && !(await confirmAction(existing ? 'Leave your changes?' : 'Leave this automation?', existing ? 'What you changed is not kept.' : 'It is not made.', 'Leave'))) return;
    onCancel();
  };

  const footer = (
    <YStack gap="$2">
      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
          {problem}
        </Text>
      ) : null}
      <XStack alignItems="center" gap="$2">
        <XStack flex={1} alignItems="center" gap="$2">
          {check === null ? (
            <Spinner size="small" color="$accent" />
          ) : (
            <Icon name={toFix ? 'alert-triangle' : 'check-circle'} size={16} color={tone(toFix ? '$warning' : '$success')} />
          )}
          <Text flex={1} fontSize={14} fontWeight="600" color={toFix ? '$warning' : '$success'} numberOfLines={1}>
            {check === null ? 'Checking…' : toFix ? `${toFix} thing${toFix === 1 ? '' : 's'} to fix` : 'Ready'}
          </Text>
        </XStack>
        <Button size="$4" backgroundColor="$card" borderWidth={1} borderColor="$borderColor" disabled={busy} onPress={() => void cancel()}>
          Cancel
        </Button>
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void save()}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Create'}
        </Button>
      </XStack>
    </YStack>
  );

  const nothingStarts = draft.rule.when.length === 0;
  return (
    <Screen back={back.label} backTo={back.to} title={title} footer={footer}>
      <Card inset>
        <SegmentedControl
          title="Write it"
          subtitle={view === 'form' ? 'Block by block, each part in its group.' : 'As configuration: the words a file says it in, checked as you type.'}
          value={view}
          options={VIEWS}
          onChange={switchTo}
        />
      </Card>
      {view === 'yaml' ? (
        <Group icon="code" title="As configuration">
          {yaml.error ? (
            <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
              {yaml.error}
            </Text>
          ) : null}
          <YamlEditor value={yaml.text} onChange={yaml.change} problems={yaml.problems} schema={yaml.schema} label={`${title}, as configuration`} minLines={14} />
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Its name, what fills each role by its key, what starts it, what it does — and how it runs on its own. Saved as the form saves it.
          </Text>
        </Group>
      ) : (
        <>
          <YStack gap="$1.5">
            <Text fontSize={13} fontWeight="600" color="$muted">
              Name
            </Text>
            <Input
              size="$5"
              fontSize={18}
              fontWeight="700"
              value={draft.name}
              placeholder="What to call it: “Morning charge”"
              aria-label="Name"
              backgroundColor="$card"
              borderColor={named ? '$borderColor' : '$warning'}
              onChangeText={(name) => editor.change((current) => ({ ...current, name }))}
              onSubmitEditing={() => void save()}
            />
          </YStack>

          <Uses problems={problems('uses')} />

          <Group icon="clock" title="When" summary={nothingStarts ? 'When started' : undefined}>
            <Problems list={problems('when')} />
            <Triggers />
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Whatever starts it on its own, you can always run it yourself.
            </Text>
          </Group>

          <Group icon="filter" title="Only if" summary={draft.rule.if ? undefined : 'Always'}>
            <Problems list={problems('onlyIf')} />
            <OnlyIf />
          </Group>

          <Group icon="list" title="Does">
            <Problems list={problems('does')} />
            <BlockList path={THEN} label="What it does" />
          </Group>

          <Group icon="corner-up-left" title="If a step fails, or you stop it">
            <Problems list={problems('fails')} />
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Each of these is tried, whatever the others do: switching back off what it switched on.
            </Text>
            <BlockList path={OTHERWISE} label="If a step does not succeed" />
          </Group>
        </>
      )}

      <Group icon="message-square" title="How it reads">
        <YStack gap="$2" role="status" aria-live="polite">
          <Problems list={view === 'yaml' ? (check?.problems ?? []) : problems('other')} />
          {check === null ? (
            <Spinner size="small" color="$accent" alignSelf="flex-start" />
          ) : check.problems.length === 0 ? (
            <XStack gap="$2" alignItems="center">
              <Icon name="check-circle" size={16} color={tone('$success')} />
              <Text fontSize={14} fontWeight="700" color="$success">
                It can run as it is
              </Text>
            </XStack>
          ) : null}
          {check?.sentence ? (
            <Text fontSize={15} color="$color" lineHeight={22}>
              {check.sentence}
            </Text>
          ) : null}
        </YStack>
        {existing ? null : (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            It starts by only watching on its own: it says what it would have done, and switches nothing on its own until you let it act. You can run it yourself at any time.
          </Text>
        )}
      </Group>
    </Screen>
  );
}

/** What is wrong with a part of it, in its group. */
function Problems({ list }: { list: readonly string[] }) {
  const tone = useTone();
  if (!list.length) return null;
  return (
    <YStack gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor="$warning">
      {list.map((problem) => (
        <XStack key={problem} gap="$2" alignItems="center">
          <Icon name="alert-triangle" size={16} color={tone('$warning')} />
          <Text flex={1} fontSize={14} color="$color" lineHeight={20}>
            {problem}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}

/**
 * What it uses: each part a step works with, and each automation one starts —
 * what fills it, changed here for every step that uses it. A recipe copied
 * starts with these still to fill.
 */
function Uses({ problems }: { problems: readonly string[] }) {
  const editor = useEditor();
  const tone = useTone();
  const { parts, automations } = rolesOf(editor.draft.rule);
  if (!parts.length && !automations.length) return null;
  const choices = (spec: (typeof parts)[number][1]) => editor.parts((description, part) => !isAutomationRole(spec) && meetsNeed(spec, capabilitiesOf(description, part)));
  // What another automation already uses for the same roles, in one tap: a stop made after its start.
  const fits = (role: string, binding: RoleBinding) => {
    const spec = editor.draft.rule.roles[role];
    return !!spec && choices(spec).some((option) => option.binding.device === binding.device && option.binding.part === binding.part);
  };
  const same = sameParts(editor.draft, editor.automations, fits).slice(0, 2);
  return (
    <Group icon="box" title="Uses" summary={`${parts.length + automations.length}`}>
      <Problems list={problems} />
      {same.map((other) => (
        <Button
          key={other.id}
          alignSelf="flex-start"
          size="$3"
          minHeight={44}
          chromeless
          color="$accent"
          icon={<Icon name="copy" size={16} color={tone('$accent')} />}
          onPress={() => (haptic(), editor.change((draft) => ({ ...draft, roles: { ...draft.roles, ...other.roles } })))}
        >
          {`Same parts as “${other.name}”`}
        </Button>
      ))}
      {parts.map(([role, spec]) => {
        if (isAutomationRole(spec)) return null;
        const options = choices(spec)
          .filter((option) => option.role === null || option.role === role)
          .map((option) => ({ key: option.key, title: option.title, subtitle: option.subtitle, value: option.binding, selected: editor.draft.roles[role]?.device === option.binding.device && editor.draft.roles[role]?.part === option.binding.part }));
        return (
          <YStack key={role} gap="$1.5">
            <Text fontSize={13} fontWeight="600" color="$muted">
              {spec.label}
            </Text>
            <Picker label={spec.label} chosen={editor.draft.roles[role] ? editor.name(role) : null} placeholder="Choose a part" options={options} onPick={(binding) => editor.change((draft) => ({ ...draft, roles: { ...draft.roles, [role]: binding } }))} />
          </YStack>
        );
      })}
      {automations.map(([role, spec]) => (
        <YStack key={role} gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$muted">
            {spec.label}
          </Text>
          <Picker
            label={spec.label}
            chosen={editor.draft.starts[role] ? editor.name(role) : null}
            placeholder="Choose an automation"
            options={editor.automations.map((automation) => ({ key: automation.id, title: automation.name, subtitle: automation.sentence, value: automation.id, selected: editor.draft.starts[role] === automation.id }))}
            onPick={(automation) => editor.change((draft) => ({ ...draft, starts: { ...draft.starts, [role]: automation } }))}
          />
        </YStack>
      ))}
    </Group>
  );
}

/**
 * Where a new one starts: from nothing, or a recipe copied — its steps then
 * the owner's to change. Started from a device, the recipes it can take part
 * in come first.
 */
export function StartFrom({ recipes, fits, onChoose, onYaml }: { recipes: readonly RecipeView[]; fits: (recipe: RecipeView) => boolean; onChoose: (recipe: RecipeView | null) => void; onYaml: () => void }) {
  const tone = useTone();
  const ordered = [...recipes].sort((a, b) => Number(fits(b)) - Number(fits(a)));
  return (
    <Group icon="plus-circle" title="Start from">
      <Card inset backgroundColor="$background">
        <Pressable onPress={() => (haptic(), onChoose(null))} label="Start from nothing">
          <Row title="Nothing" subtitle="Build it block by block: what starts it, and each step it takes." accessory={<Icon name="plus" size={18} color={tone('$accent')} />} />
        </Pressable>
        <RowSeparator />
        <Pressable onPress={() => (haptic(), onYaml())} label="Write it as YAML">
          <Row title="As YAML" subtitle="Write it in a configuration’s words — or paste one exported from here or another server." accessory={<Icon name="code" size={18} color={tone('$accent')} />} />
        </Pressable>
        {ordered.map((recipe) => (
          <YStack key={recipe.id}>
            <RowSeparator />
            <Pressable onPress={() => (haptic(), onChoose(recipe))} label={`Start from ${recipe.label}`}>
              <Row title={recipe.label} subtitle={recipe.from ? `${recipe.description} From ${recipe.from.name}.` : recipe.description} />
            </Pressable>
          </YStack>
        ))}
      </Card>
      <Empty>A recipe is a starting point: once copied, every step of it is yours to change.</Empty>
    </Group>
  );
}

/** Whether a device can fill any part a recipe needs. */
export const recipeFits = (recipe: RecipeView, device: { description: Parameters<typeof partsOf>[0]; name: string }): boolean =>
  Object.values(recipe.rule.roles).some((spec) => !isAutomationRole(spec) && partsOf(device.description, device.name).some((part) => meetsNeed(spec, capabilitiesOf(device.description, part.id))));
