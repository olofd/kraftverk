import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import type { AutomationSettings } from '@kraftverk/api-client/config';
import { changeAutomation, describeError, withConfirmation, type AutomationDraftView, type AutomationView } from '@kraftverk/api-client';
import { capitalise, isAutomationRole, OTHERWISE, pruned, rolesOf, sameParts, THEN, WHILE_RUNNING, type ProblemArea, type RoleBinding, type WhileRunning } from '@kraftverk/automation';
import { capabilitiesOf, configDefaults, meetsNeed } from '@kraftverk/device-sdk';
import { Card, Chips, haptic, Icon, SchemaForm, SegmentedControl } from '@kraftverk/ui';

import { ErrorText } from '../../../components/ErrorText';
import { Loading } from '../../../components/Loading';
import { Picker } from '../../../components/Picker';
import { Screen } from '../../../components/Screen';
import { useTone } from '../../../components/tone';
import { YamlEditor } from '../../../components/YamlEditor';
import { ask, confirmAction } from '../../../platform/confirm';
import { useDevices } from '../../../state/DevicesProvider';
import { useFamily } from '../../../state/FamilyProvider';
import { useAutomationYaml } from '../../config/useAutomationYaml';
import { Group } from '../page/Group';
import { BlockList } from './Blocks';
import { EditorProvider, useEditor, useEditorKit, type Draft } from './context';
import { GroupParts } from './GroupParts';
import { OnlyIf, Triggers } from './Triggers';

/*
  An automation being changed, or made (docs/AUTOMATIONS-UX.md): the same
  groups as its page — what it uses, when, only if, what it does, what it does
  if a step fails — each editable in its box, with what is wrong said in the
  group it is about, and Cancel and Save kept below the page.
*/

/** How it is written: block by block, or as its configuration's YAML. */
type View = 'form' | 'yaml';

const VIEWS: readonly { value: View; label: string }[] = [
  { value: 'form', label: 'Form' },
  { value: 'yaml', label: 'YAML' },
];

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
  onView,
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
  /** Switched between the form and its YAML: for the page's address to say which. */
  onView?: (view: View) => void;
}) {
  const { devices, loading } = useDevices();
  const { kit, automations, error } = useEditorKit();
  const [draft, setDraft] = useState<Draft>(initial);
  const title = existing ? existing.name : 'New automation';

  // Its devices too, before it is drawn: what fills each role is named from them, in the form and in its YAML.
  if (!kit || !automations || loading) {
    return (
      <Screen back={back.label} backTo={back.to} title={title}>
        <Loading error={error} />
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
      <Editing existing={existing} initial={initial} madeFrom={madeFrom} back={back} title={title} view={view ?? 'form'} onSaved={onSaved} onCancel={onCancel} onView={onView} />
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
  onView,
}: {
  existing: AutomationView | null;
  initial: Draft;
  madeFrom: string | null;
  back: { label: string; to: string };
  title: string;
  view: View;
  onSaved: (automation: AutomationView) => void;
  onCancel: () => void;
  onView?: (view: View) => void;
}) {
  const { api } = useFamily();
  const tone = useTone();
  const editor = useEditor();
  const { draft } = editor;
  const [check, setCheck] = useState<AutomationDraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kept = useMemo(() => pruned(draft), [draft]);
  // What the form does not edit, and its YAML does: its mode, clock, keeping it so, its place on the home page.
  const before = useMemo<AutomationSettings>(
    // A new one keeps its home's clock: the family's first home's, until it is for another.
    () => (existing ? { mode: existing.mode, homeId: existing.homeId, timeZone: existing.ownTimeZone, recheckMinutes: existing.recheckMinutes, homePlace: existing.homePlace } : { mode: 'watch', homeId: null, timeZone: null, recheckMinutes: null, homePlace: null }),
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
    onView?.(next);
  };
  useEffect(() => {
    if (opensOn === 'yaml') switchTo('yaml');
  }, []);
  const yamlProblems = view === 'yaml' ? yaml.problems.length : 0;
  const yamlUnread = view === 'yaml' && (yaml.reading || !yaml.ready);

  // The home's word on the draft, as it is built: every problem, and how it reads — a moment after each change.
  const asked = useRef(0);
  useEffect(() => {
    const turn = ++asked.current;
    const timer = setTimeout(() => {
      api.automations
        .draft({ rule: kept.rule, roles: kept.roles, groups: kept.groups, starts: kept.starts }, existing?.id ?? null)
        .then((answer) => turn === asked.current && setCheck(answer))
        .catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [api, kept, existing?.id]);

  const problems = (area: ProblemArea) => check?.areas[area] ?? [];
  const named = draft.name.trim().length > 0;
  const ready = check !== null && check.problems.length === 0 && named && yamlProblems === 0 && !yamlUnread;
  const toFix = (check?.problems.length ?? 0) + (named ? 0 : 1) + yamlProblems;

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const body = { name: draft.name.trim(), rule: kept.rule, roles: kept.roles, groups: kept.groups, starts: kept.starts };
      // What its YAML changed beyond what the form edits.
      const changes = { ...Object.fromEntries(settingsChanged.map((name) => [name, settings[name]])), ...(key && key !== existing?.key ? { key } : {}) };
      const letAct = settings.mode === 'act' && before.mode !== 'act';
      const question = (name: string) => (reason: string) => ({
        title: letAct ? `Let “${name}” act on its own?` : `Change “${name}” while it acts?`,
        message: `${reason}\n\n${check?.sentence ?? ''}`,
        yes: letAct ? 'Let it act' : 'Change it',
      });
      if (!existing) {
        const made = await api.automations.create({ ...body, ...(key ? { key } : {}), madeFrom: recipe, timeZone: settings.timeZone, recheckMinutes: settings.recheckMinutes });
        // A new one only watches, off the home page: what its YAML says beyond that, set as it would be on its page.
        const { mode, homePlace } = changes as Partial<AutomationSettings>;
        if (mode === undefined && homePlace === undefined) return onSaved(made);
        const { answer } = await withConfirmation((confirmation) => changeAutomation(api, made.id, { ...(mode !== undefined ? { mode } : {}), ...(homePlace !== undefined ? { homePlace } : {}), confirmation }), question(made.name), ask);
        onSaved('automation' in answer ? answer.automation : made);
        return;
      }
      // One that acts on its own asks first: what it does changes.
      const { answer, declined } = await withConfirmation((confirmation) => changeAutomation(api, existing.id, { ...body, ...changes, confirmation }), question(existing.name), ask);
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
        <ErrorText>
          {problem}
        </ErrorText>
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
  // Every trigger says what it does: the automation's own steps are only for when it is started.
  const eachSaysItsOwn = !nothingStarts && draft.rule.when.every((trigger) => trigger.then?.length);
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
            <ErrorText>
              {yaml.error}
            </ErrorText>
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

          {/* Its settings — a recipe's levels, each set once and read in its blocks as setting.low — when it has any. */}
          {Object.keys(draft.rule.params.fields).length ? (
            <Group icon="sliders" title="Settings">
              <Problems list={problems('settings')} />
              <Card>
                <SchemaForm
                  schema={draft.rule.params}
                  values={configDefaults(draft.rule.params)}
                  onChange={(name, value) =>
                    editor.change((current) => {
                      const field = current.rule.params.fields[name];
                      if (!field || value === undefined) return current;
                      return { ...current, rule: { ...current.rule, params: { ...current.rule.params, fields: { ...current.rule.params.fields, [name]: { ...field, default: value } as typeof field } } } };
                    })
                  }
                />
              </Card>
            </Group>
          ) : null}

          <Group icon="clock" title="When" summary={nothingStarts ? 'When started' : undefined}>
            <Problems list={problems('when')} />
            <Triggers />
            {/* What a trigger does while a run of it still takes its steps: only where something starts it on its own. */}
            {draft.rule.when.length ? (
              <YStack gap="$1.5">
                <Text fontSize={13} fontWeight="600" color="$muted">
                  Started again while it runs
                </Text>
                <Chips
                  label="Started again while it runs"
                  options={(Object.keys(WHILE_RUNNING) as WhileRunning[]).map((way) => ({ value: way, label: WHILE_RUNNING[way].label }))}
                  value={draft.rule.whileRunning ?? 'skip'}
                  onChange={(way) =>
                    editor.change((current) => {
                      const { whileRunning: _was, ...rule } = current.rule;
                      return { ...current, rule: way === 'skip' ? rule : { ...rule, whileRunning: way } };
                    })
                  }
                />
                <Text fontSize={13} color="$muted" lineHeight={19}>
                  {capitalise(WHILE_RUNNING[draft.rule.whileRunning ?? 'skip'].says)}.
                </Text>
              </YStack>
            ) : null}
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Whatever starts it on its own, you can always run it yourself.
            </Text>
          </Group>

          <Group icon="filter" title="Only if" summary={draft.rule.if ? undefined : 'Always'}>
            <Problems list={problems('onlyIf')} />
            <OnlyIf />
          </Group>

          <Group icon="list" title="Does" summary={eachSaysItsOwn ? 'When you start it' : undefined}>
            <Problems list={problems('does')} />
            {eachSaysItsOwn ? (
              <Text fontSize={13} color="$muted" lineHeight={19}>
                Each trigger says what it does. These steps are for when you start it yourself, or another automation does.
              </Text>
            ) : null}
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
  const { parts, groups, automations } = rolesOf(editor.draft.rule);
  if (!parts.length && !groups.length && !automations.length) return null;
  const choices = (spec: (typeof parts)[number][1]) => editor.parts((description, part) => !isAutomationRole(spec) && meetsNeed(spec, capabilitiesOf(description, part)));
  // What another automation already uses for the same roles, in one tap: a stop made after its start.
  const fits = (role: string, binding: RoleBinding) => {
    const spec = editor.draft.rule.roles[role];
    return !!spec && choices(spec).some((option) => option.binding.device === binding.device && option.binding.part === binding.part);
  };
  const same = sameParts(editor.draft, editor.automations, fits).slice(0, 2);
  return (
    <Group icon="box" title="Uses" summary={`${parts.length + groups.length + automations.length}`}>
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
      {/* Each group a "for each" goes through: its parts, switched in and out here. */}
      {groups.map(([role, spec]) => (
        <YStack key={role} gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$muted">
            {spec.label}
          </Text>
          <GroupParts role={role} label={spec.label} />
        </YStack>
      ))}
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

/** Whether a device can fill any part a recipe needs. */
