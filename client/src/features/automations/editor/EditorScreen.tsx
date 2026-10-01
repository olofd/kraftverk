import { router } from 'expo-router';
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
} from '@kraftverk/api-client';
import { capabilitiesOf, isAutomationRole, meetsNeed, partName, partsOf } from '@kraftverk/device-sdk';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { Screen } from '../../../components/Screen';
import { ASKED_AGAIN, confirmAction, withConfirmation } from '../../../lib/confirm';
import { useDevices } from '../../../state/DevicesProvider';
import { useTone } from '../looks';
import { BlockList } from './Blocks';
import { EditorProvider, useEditor } from './context';
import { EMPTY, fromRecipe, OTHERWISE, pruned, rolesOf, THEN, type Draft } from './draft';
import { Picker } from './fields';
import { OnlyIf, Triggers } from './Triggers';

/**
 * Building an automation from blocks, or changing one
 * (docs/AUTOMATION-EDITOR.md): what starts it on its own, what it must meet,
 * the steps it takes — nested, reordered, each a part's command or setting,
 * a pause, a wait, a check, a choice, a watch, or another automation
 * started — and what it does if a step does not succeed. A new one starts
 * from nothing, or from a recipe copied. The server checks the draft as it
 * is built, and says how it reads.
 */
/** `from`: the device a new one was started from — where back, and Cancel, return to. */
export function EditorScreen({ id, from }: { id: string | null; from?: { id: string; name: string } | null }) {
  const creating = id === null;
  const { devices } = useDevices();
  const [kit, setKit] = useState<AutomationKit | null>(null);
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [madeFrom, setMadeFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetchAutomationKit(), fetchAutomations()])
      .then(([nextKit, all]) => {
        if (!live) return;
        setKit(nextKit);
        setAutomations(all);
        if (!creating) {
          const existing = all.find((automation) => automation.id === id);
          if (!existing) return setError('There is no such automation');
          setDraft({ name: existing.name, rule: existing.rule, roles: existing.roles, starts: existing.starts });
        }
      })
      .catch((err) => live && setError(describeError(err) || 'It could not be read'));
    return () => {
      live = false;
    };
  }, [creating, id]);

  const existing = automations?.find((automation) => automation.id === id) ?? null;
  // Back, and Cancel: to the automation being changed, the device a new one was started from, or the list.
  const back = existing ? { label: existing.name, to: `/automation/${existing.id}` } : from ? { label: from.name, to: `/device/${from.id}` } : { label: 'Automations', to: '/automations' };
  const title = creating ? 'New automation' : existing ? `Change “${existing.name}”` : 'Automation';

  return (
    <Screen back={back.label} backTo={back.to} title={title} subtitle="What starts it, what it must meet, and the steps it takes">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}
      {!kit || !automations ? (
        error ? null : <Spinner color="$accent" />
      ) : !draft ? (
        creating ? (
          <StartFrom recipes={kit.recipes} onChoose={(recipe) => (setMadeFrom(recipe?.id ?? null), setDraft(recipe ? fromRecipe(recipe) : EMPTY))} />
        ) : null
      ) : (
        <EditorProvider
          kit={{
            draft,
            change: (next) => setDraft((current) => (current ? next(current) : current)),
            devices: devices.filter((device) => !device.removedAt),
            automations: automations.filter((automation) => automation.id !== id),
            functions: kit.functions,
          }}
        >
          <Editing existing={existing} madeFrom={madeFrom} cancelTo={back.to} />
        </EditorProvider>
      )}
    </Screen>
  );
}

/** Where a new one starts: from nothing, or a recipe copied — its steps then the owner's to change. */
function StartFrom({ recipes, onChoose }: { recipes: readonly RecipeView[]; onChoose: (recipe: RecipeView | null) => void }) {
  const tone = useTone();
  return (
    <YStack gap="$2">
      <SectionLabel>Start from</SectionLabel>
      <Card inset>
        <Pressable onPress={() => (haptic(), onChoose(null))} label="Start from nothing">
          <Row title="Nothing" subtitle="Build it block by block: what starts it, and each step it takes." accessory={<Icon name="plus" size={16} color={tone('$accent')} />} />
        </Pressable>
        {recipes.map((recipe) => (
          <YStack key={recipe.id}>
            <RowSeparator />
            <Pressable onPress={() => (haptic(), onChoose(recipe))} label={`Start from ${recipe.label}`}>
              <Row title={recipe.label} subtitle={recipe.from ? `${recipe.description} From ${recipe.from.name}.` : recipe.description} />
            </Pressable>
          </YStack>
        ))}
      </Card>
      <Text fontSize={12} color="$muted" lineHeight={18}>
        A recipe is a starting point: once copied, every step of it is yours to change.
      </Text>
    </YStack>
  );
}

/** The draft being built: every section, the live check, and saving. */
function Editing({ existing, madeFrom, cancelTo }: { existing: AutomationView | null; madeFrom: string | null; cancelTo: string }) {
  const tone = useTone();
  const editor = useEditor();
  const { draft } = editor;
  const [check, setCheck] = useState<AutomationDraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const kept = useMemo(() => pruned(draft), [draft]);

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

  const ready = check !== null && check.problems.length === 0 && draft.name.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const body = { name: draft.name.trim(), rule: kept.rule, roles: kept.roles, starts: kept.starts };
      if (!existing) {
        const made = await createAutomation({ ...body, madeFrom, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        // Made: its own page, in place of the editor.
        router.replace(`/automation/${made.id}`);
        return;
      } else {
        // One that acts on its own asks first: what it does changes.
        const { answer, declined } = await withConfirmation(
          (confirmation) => updateAutomation(existing.id, { ...body, confirmation }),
          (result) => ('needsConfirmation' in result ? { token: result.needsConfirmation, reason: result.reason } : null),
          (reason, again) => confirmAction(`Change “${existing.name}” while it acts?`, `${again ? `${ASKED_AGAIN}\n\n` : ''}${reason}\n\n${check?.sentence ?? ''}`, 'Change it')
        );
        if (declined || !('automation' in answer)) return;
      }
      router.replace(`/automation/${existing.id}`);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$4">
      <YStack gap="$2">
        <SectionLabel>Name</SectionLabel>
        <Input size="$4" value={draft.name} placeholder="What to call it: “Morning charge”" aria-label="Name" backgroundColor="$card" borderColor="$borderColor" onChangeText={(name) => editor.change((current) => ({ ...current, name }))} onSubmitEditing={() => (ready && !busy ? void save() : undefined)} />
      </YStack>

      <Parts />

      <YStack gap="$2">
        <SectionLabel>When it runs on its own</SectionLabel>
        <Triggers />
        <XStack gap="$2" alignItems="center">
          <Icon name="play" size={12} color={tone('$muted')} />
          <Text fontSize={12} color="$muted">
            Whatever starts it on its own, you can always start it yourself.
          </Text>
        </XStack>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Only if</SectionLabel>
        <OnlyIf />
      </YStack>

      <YStack gap="$2">
        <SectionLabel>What it does</SectionLabel>
        <BlockList path={THEN} label="What it does" />
      </YStack>

      <YStack gap="$2">
        <SectionLabel>If a step does not succeed, or you stop it</SectionLabel>
        <Text fontSize={12} color="$muted" lineHeight={17}>
          Each of these is tried, whatever the others do: switching back off what it switched on.
        </Text>
        <BlockList path={OTHERWISE} label="If a step does not succeed" />
      </YStack>

      <Check check={check} />

      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={19} role="alert">
          {problem}
        </Text>
      ) : null}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$4" chromeless color="$muted" disabled={busy} onPress={() => router.replace(cancelTo)}>
          Cancel
        </Button>
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void save()}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Create'}
        </Button>
      </XStack>
      {existing ? null : (
        <Text fontSize={12} color="$muted" lineHeight={18}>
          It starts by only watching on its own: it says what it would have done, and switches nothing on its own until you let it act. You can start it yourself at
          any time.
        </Text>
      )}
    </YStack>
  );
}

/**
 * The parts it uses, and the automations it starts: each role, and what fills
 * it — changed here for every block that uses it. A recipe copied starts with
 * its roles still to fill.
 */
function Parts() {
  const editor = useEditor();
  const { parts, automations } = rolesOf(editor.draft.rule);
  if (!parts.length && !automations.length) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>What it uses</SectionLabel>
      {parts.map(([role, spec]) => {
        if (isAutomationRole(spec)) return null;
        const options = editor.devices.flatMap((device) =>
          partsOf(device.description, device.name)
            .filter((part) => meetsNeed(spec, capabilitiesOf(device.description, part.id)))
            .map((part) => ({ key: `${device.id}:${part.id}`, title: partName(device.name, part.id, part.label), subtitle: device.meta.name, value: { device: device.id, part: part.id }, selected: editor.draft.roles[role]?.device === device.id && editor.draft.roles[role]?.part === part.id }))
        );
        return (
          <YStack key={role} gap="$1">
            <Text fontSize={13} fontWeight="700" color="$color">
              {spec.label}
            </Text>
            <Picker label={spec.label} chosen={editor.draft.roles[role] ? editor.name(role) : null} placeholder="Choose a part" options={options} onPick={(binding) => editor.change((draft) => ({ ...draft, roles: { ...draft.roles, [role]: binding } }))} />
          </YStack>
        );
      })}
      {automations.map(([role, spec]) => (
        <YStack key={role} gap="$1">
          <Text fontSize={13} fontWeight="700" color="$color">
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
    </YStack>
  );
}

/** What the server says of the draft: what is wrong — or that nothing is — and how it reads. */
function Check({ check }: { check: AutomationDraftView | null }) {
  const tone = useTone();
  if (!check) return <Spinner size="small" color="$accent" alignSelf="flex-start" />;
  return (
    <YStack gap="$2" padding="$3" borderRadius="$4" borderWidth={1} borderColor={check.problems.length ? '$warning' : '$success'} role="status" aria-live="polite">
      {check.problems.length ? (
        check.problems.map((problem) => (
          <XStack key={problem} gap="$2" alignItems="flex-start">
            <Icon name="alert-triangle" size={14} color={tone('$warning')} style={{ marginTop: 2 }} />
            <Text flex={1} fontSize={13} color="$color" lineHeight={19}>
              {problem}
            </Text>
          </XStack>
        ))
      ) : (
        <XStack gap="$2" alignItems="center">
          <Icon name="check-circle" size={14} color={tone('$success')} />
          <Text fontSize={13} fontWeight="700" color="$success">
            It can run as it is
          </Text>
        </XStack>
      )}
      {check.sentence ? (
        <Text fontSize={14} color="$muted" lineHeight={21}>
          {check.sentence}
        </Text>
      ) : null}
    </YStack>
  );
}

