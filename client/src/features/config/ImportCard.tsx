import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { Button, Input, Text, XStack, YStack } from 'tamagui';

import { changesOf, planReadiness, rebindAnswerKey, secretAnswerKey } from '@kraftverk/api-client/config';
import { applyPlan, describeError, withConfirmation, type ElsewhereView, type FamilyElsewhere, type ImportApplied, type ImportItem, type ImportPlan } from '@kraftverk/api-client';
import { checkDocument, configJsonSchema, CURRENT_VERSION, holdsSealed, readConfig, type Vocabulary } from '@kraftverk/home-file';
import { Card, haptic, Icon, RowSeparator, SectionLabel, SegmentedControl, Toggle, toggled } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Picker } from '../../components/Picker';
import { ProblemList } from '../../components/ProblemList';
import { useTone, type Tone } from '../../components/tone';
import { YamlEditor } from '../../components/YamlEditor';
import { ask } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';
import { useServers } from '../../state/ServersProvider';

type Mode = 'merge' | 'replace';

/** How each thing an import does reads, and looks. */
const ACTION: Record<ImportItem['action'], { label: string; tone: Tone }> = {
  add: { label: 'New', tone: '$success' },
  restore: { label: 'Back', tone: '$success' },
  change: { label: 'Changed', tone: '$accent' },
  same: { label: 'The same', tone: '$muted' },
  remove: { label: 'Removed', tone: '$danger' },
};

/**
 * An import (docs/CONFIG.md), in the server's two steps: a file pasted or
 * opened — checked here as it is typed, by the same code the server runs —
 * then read into a plan that says what would become of each thing and what
 * it still needs; then applied, with those answers, once you say yes to what
 * it would set acting or take away.
 */
/** Where a plan was read from, to read it again. */
type Source = { restored: true } | { text: string } | { from: FamilyElsewhere };

/** What bringing in a home kept elsewhere is called, by where it is. */
const BRING: Record<FamilyElsewhere, string> = { 'this-node': 'Move this app’s own home here', copy: 'Keep your server’s home in this app' };

export function ImportCard({
  vocabulary,
  restored,
  elsewhere,
  start,
  onApplied,
}: {
  vocabulary: Vocabulary | null;
  restored: boolean;
  /** A home this app keeps beside this one, to bring in, if there is one. */
  elsewhere: ElsewhereView;
  /** Read straight away: the home kept elsewhere a card on the home page offered. */
  start: FamilyElsewhere | null;
  onApplied: () => void;
}) {
  const { api } = useFamily();
  // The copy a restore was made from is a server's: only offered with one.
  const { server } = useServers();
  const tone = useTone();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('merge');
  const [passphrase, setPassphrase] = useState('');
  const [plan, setPlan] = useState<(ImportPlan & { source: Source }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [applied, setApplied] = useState<ImportApplied | null>(null);

  // Checked here as it is typed: what the server would say of its shape and meaning, a moment after each change.
  const [checked, setChecked] = useState<{ text: string; problems: ReturnType<typeof readConfig>['problems'] } | null>(null);
  useEffect(() => {
    if (!vocabulary || !text.trim()) return setChecked(null);
    const timer = setTimeout(() => setChecked({ text, problems: readConfig(text, (document) => checkDocument(document, vocabulary, { hasSecret: () => true, uses: 'leave' })).problems }), 250);
    return () => clearTimeout(timer);
  }, [text, vocabulary]);
  const schema = useMemo(() => (vocabulary ? configJsonSchema(vocabulary) : null), [vocabulary]);
  const localProblems = checked?.text === text ? checked.problems : [];
  const sealed = holdsSealed(text) || plan?.needs.passphrase != null;

  const read = async (source: Source) => {
    haptic();
    setBusy(true);
    setProblem(null);
    setApplied(null);
    try {
      // The copy a server's last restore was made from is the server's own to plan again; anything typed, any home's.
      const restored = () => {
        if (!server) throw new Error('Only a server keeps a copy beside its database');
        return server.restoredPlan(mode);
      };
      const next =
        'text' in source
          ? await api.configuration.plan({ text: source.text, mode, ...(passphrase ? { passphrase } : {}) })
          : 'from' in source
            ? await api.configuration.plan({ from: source.from, mode })
            : await restored();
      setPlan({ ...next, source });
    } catch (err) {
      setProblem(describeError(err) || 'It could not be read');
    } finally {
      setBusy(false);
    }
  };

  // Offered from the home page: read at once.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!start || started) return;
    setStarted(true);
    void read({ from: start });
  }, [start, started]);

  const openFile = () => {
    if (Platform.OS !== 'web') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.yaml,.yml,application/yaml,text/yaml,text/plain';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void file.text().then((content) => (setText(content), setPlan(null)));
    };
    input.click();
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Import</SectionLabel>
      <Card gap="$3">
        <Text fontSize={13} color="$muted" lineHeight={19}>
          Paste a configuration{Platform.OS === 'web' ? ', or open a file' : ''} — a whole home, or one device or automation, as its page shows it. Reading it changes nothing: it says what it would do, and what it still needs.
        </Text>
        {Platform.OS === 'web' ? (
          <Button alignSelf="flex-start" size="$3" minHeight={44} icon={<Icon name="folder" size={16} color={tone('$color')} />} onPress={openFile}>
            Open a file
          </Button>
        ) : null}
        <YamlEditor value={text} onChange={(next) => (setText(next), setPlan(null))} problems={localProblems} schema={schema} label="The configuration to import" minLines={10} />
      </Card>
      <Card inset>
        <SegmentedControl
          title="How"
          subtitle={mode === 'merge' ? 'What the file has is added or changed; everything else stays.' : 'Everything becomes what the file says: what it does not have is removed, history kept.'}
          value={mode}
          options={[
            { value: 'merge', label: 'Add and change' },
            { value: 'replace', label: 'Replace all' },
          ]}
          onChange={(next) => (setMode(next), setPlan(null))}
        />
        {sealed ? (
          <>
            <RowSeparator />
            <YStack padding="$4" gap="$1.5">
              <Text fontSize={15} fontWeight="600" color="$color">
                Passphrase
              </Text>
              <Input size="$4" value={passphrase} onChangeText={setPassphrase} secureTextEntry autoCapitalize="none" autoCorrect={false} aria-label="Passphrase" backgroundColor="$background" borderColor={plan?.needs.passphrase ? '$warning' : '$borderColor'} />
              <Text fontSize={12} color={plan?.needs.passphrase ? '$warning' : '$muted'} lineHeight={17}>
                {plan?.needs.passphrase === 'wrong' ? 'That passphrase does not open its secrets.' : 'Its secrets are sealed: the passphrase they were exported with opens them.'}
              </Text>
            </YStack>
          </>
        ) : null}
      </Card>
      <XStack gap="$2" flexWrap="wrap">
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || !text.trim()} opacity={busy || !text.trim() ? 0.5 : 1} onPress={() => void read({ text })}>
          {busy && !plan ? 'Reading…' : 'Read it'}
        </Button>
        {restored ? (
          <Button size="$4" disabled={busy} onPress={() => void read({ restored: true })}>
            Import the restored copy again
          </Button>
        ) : null}
        {elsewhere ? (
          <Button size="$4" disabled={busy} onPress={() => void read({ from: elsewhere.from })}>
            {BRING[elsewhere.from]}
          </Button>
        ) : null}
      </XStack>
      {problem ? (
        <ErrorText>
          {problem}
        </ErrorText>
      ) : null}
      {plan ? (
        <PlanView
          key={plan.id ?? 'refused'}
          plan={plan}
          onAgain={() => void read(plan.source)}
          onApplied={(done) => (setApplied(done), setPlan(null), onApplied())}
        />
      ) : null}
      {applied ? <AppliedView applied={applied} /> : null}
    </YStack>
  );
}

/**
 * What an import would do, and what it still needs: problems first — while
 * there are any, nothing can be applied — then each device, link, automation
 * and home value, each chosen or left out; the secrets and devices it asks
 * for; and Apply.
 */
function PlanView({ plan, onAgain, onApplied }: { plan: ImportPlan; onAgain: () => void; onApplied: (applied: ImportApplied) => void }) {
  const { api } = useFamily();
  const tone = useTone();
  const [devices, setDevices] = useState<ReadonlySet<string>>(() => new Set(changesOf(plan).devices));
  const [automations, setAutomations] = useState<ReadonlySet<string>>(() => new Set(changesOf(plan).automations));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [rebind, setRebind] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{ said: string; problems: string[] } | null>(null);

  const links = plan.links.filter((link) => link.action !== 'same');
  const { nothing, secretsMissing, rebindMissing, ready, everything } = planReadiness(plan, { devices, automations }, { secrets, rebind });

  const apply = async () => {
    if (!ready || busy || !plan.id) return;
    haptic();
    setBusy(true);
    setRefusal(null);
    try {
      const { answer, declined } = await withConfirmation(
        (confirmation) =>
          applyPlan(api, {
            plan: plan.id!,
            ...(everything ? {} : { include: { devices: [...devices], automations: [...automations] } }),
            secrets,
            rebind,
            ...(confirmation ? { confirmation } : {}),
          }),
        (reason) => ({ title: 'Import it?', message: `${reason}.`, yes: 'Import', tone: 'dangerous' }),
        ask
      );
      if (declined) return;
      if ('applied' in answer) onApplied(answer.applied);
      else if ('refused' in answer) setRefusal({ said: answer.refused, problems: answer.problems });
    } catch (err) {
      setRefusal({ said: describeError(err) || 'It could not be imported', problems: [] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$3">
      <SectionLabel>What it would do</SectionLabel>
      {plan.from !== null && plan.from < CURRENT_VERSION ? (
        <Text fontSize={13} color="$muted" lineHeight={19} paddingHorizontal="$1">
          Written by an older kraftverk (version {plan.from}): read as this one reads it.
        </Text>
      ) : null}
      {plan.problems.length ? (
        <Card gap="$2" borderColor="$warning">
          <Text fontSize={15} fontWeight="700" color="$warning">
            {plan.problems.length === 1 ? 'One thing to fix first' : `${plan.problems.length} things to fix first`}
          </Text>
          <ProblemList problems={plan.problems} />
        </Card>
      ) : null}

      {plan.devices.length ? <Items title="Devices" items={plan.devices} chosen={devices} onChoose={(key, on) => setDevices((set) => toggled(set, key, on))} /> : null}
      {plan.automations.length ? <Items title="Automations" items={plan.automations} chosen={automations} onChoose={(key, on) => setAutomations((set) => toggled(set, key, on))} /> : null}
      {links.length ? (
        <Card gap="$1.5">
          <Text fontSize={15} fontWeight="600" color="$color">
            Links
          </Text>
          {links.map((link) => (
            <Text key={`${link.kind}:${link.from}:${link.to}`} fontSize={13} color={link.action === 'remove' ? '$danger' : '$color'} lineHeight={19}>
              {link.action === 'remove' ? 'Removed: ' : 'New: '}
              {link.from} {link.kind} {link.to}
            </Text>
          ))}
        </Card>
      ) : null}
      {plan.family.length || plan.homes.some((home) => home.action !== 'same') || plan.zones.some((zone) => zone.action !== 'same') || plan.modes.some((mode) => mode.action !== 'same') ? (
        <Card gap="$1.5">
          <Text fontSize={15} fontWeight="600" color="$color">
            The family and its homes
          </Text>
          {plan.family.map((change) => (
            <Text key={change} fontSize={13} color="$color" lineHeight={19}>
              The family’s {change}
            </Text>
          ))}
          {plan.homes
            .filter((home) => home.action !== 'same')
            .map((home) => (
              <Text key={home.key} fontSize={13} color="$color" lineHeight={19}>
                {home.action === 'add' ? `New home: ${home.name}` : `${home.name}: ${home.changes.join(', ')}`}
              </Text>
            ))}
          {plan.modes
            .filter((mode) => mode.action !== 'same')
            .map((mode) => (
              <Text key={`mode:${mode.key}`} fontSize={13} color="$color" lineHeight={19}>
                {mode.action === 'add' ? `New mode: ${mode.name}` : `${mode.name}: ${mode.changes.join(', ')}`}
              </Text>
            ))}
          {plan.zones
            .filter((zone) => zone.action !== 'same')
            .map((zone) => (
              <Text key={`zone:${zone.key}`} fontSize={13} color="$color" lineHeight={19}>
                {zone.action === 'add' ? `New zone: ${zone.name}` : `${zone.name}: ${zone.changes.join(', ')}`}
              </Text>
            ))}
        </Card>
      ) : null}
      {plan.scripts.some((script) => script.action !== 'same') ? (
        <Card gap="$1.5">
          <Text fontSize={15} fontWeight="600" color="$color">
            Scripts
          </Text>
          {plan.scripts
            .filter((script) => script.action !== 'same')
            .map((script) => (
              <Text key={`script:${script.key}`} fontSize={13} color="$color" lineHeight={19}>
                {script.action === 'add' ? `New script: ${script.name}` : script.action === 'remove' ? `Removed: ${script.name}` : `${script.name}: ${script.changes.join(', ')}`}
              </Text>
            ))}
        </Card>
      ) : null}
      {plan.policy.length ? (
        <Card gap="$1.5">
          <Text fontSize={15} fontWeight="600" color="$color">
            A home’s values
          </Text>
          {plan.policy.map((change) => (
            <Text key={`${change.home}.${change.name}`} fontSize={13} color="$color" lineHeight={19}>
              {plan.homes.find((home) => home.key === change.home)?.name ?? change.home}, {change.label.toLowerCase()}: {change.before ?? 'its default'} → {change.after}
            </Text>
          ))}
        </Card>
      ) : null}

      {plan.needs.secrets.length ? (
        <Card gap="$3">
          <Text fontSize={15} fontWeight="600" color="$color">
            Secrets it does not carry
          </Text>
          {plan.needs.secrets.map((need) =>
            devices.has(need.device) ? (
              <YStack key={secretAnswerKey(need)} gap="$1.5">
                <Text fontSize={13} fontWeight="600" color="$muted">
                  {need.deviceName}: its {need.title}
                </Text>
                <Input
                  size="$4"
                  value={secrets[secretAnswerKey(need)] ?? ''}
                  onChangeText={(value) => setSecrets((before) => ({ ...before, [secretAnswerKey(need)]: value }))}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  aria-label={`${need.deviceName}: its ${need.title}`}
                  backgroundColor="$background"
                  borderColor={secrets[secretAnswerKey(need)] ? '$borderColor' : '$warning'}
                />
              </YStack>
            ) : null
          )}
        </Card>
      ) : null}

      {plan.needs.rebind.length ? (
        <Card gap="$3">
          <Text fontSize={15} fontWeight="600" color="$color">
            Devices you do not have
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Each names a device that is not here: choose one of yours that can do the same.
          </Text>
          {plan.needs.rebind.map((need) => {
            const key = rebindAnswerKey(need);
            if (!automations.has(need.automation)) return null;
            const chosen = need.candidates.find((candidate) => candidate.use === rebind[key]);
            return (
              <YStack key={key} gap="$1.5">
                <Text fontSize={13} fontWeight="600" color="$muted">
                  {need.label} — it names “{need.wanted}”
                </Text>
                <Picker
                  label={need.label}
                  chosen={chosen?.name ?? null}
                  placeholder={need.candidates.length ? 'Choose one of yours' : 'None of yours can do this'}
                  options={need.candidates.map((candidate) => ({ key: candidate.use, title: candidate.name, subtitle: candidate.use, value: candidate.use, selected: candidate.use === rebind[key] }))}
                  onPick={(use) => setRebind((before) => ({ ...before, [key]: use }))}
                />
              </YStack>
            );
          })}
        </Card>
      ) : null}

      {plan.needs.confirm.length ? (
        <Card gap="$2" borderColor="$warning">
          <Text fontSize={15} fontWeight="600" color="$warning">
            Asked before it is done
          </Text>
          {plan.needs.confirm.map((said) => (
            <Text key={said} fontSize={13} color="$color" lineHeight={19}>
              {said}
            </Text>
          ))}
        </Card>
      ) : null}

      {plan.notes.length ? (
        <YStack gap="$1" paddingHorizontal="$1">
          {plan.notes.map((note) => (
            <Text key={note} fontSize={13} color="$muted" lineHeight={19}>
              {note}
            </Text>
          ))}
        </YStack>
      ) : null}

      {refusal ? (
        <Card gap="$2" borderColor="$danger">
          <Text fontSize={14} fontWeight="600" color="$danger" role="alert">
            {refusal.said}
          </Text>
          {refusal.problems.map((said) => (
            <Text key={said} fontSize={13} color="$color" lineHeight={19}>
              {said}
            </Text>
          ))}
        </Card>
      ) : null}

      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        {plan.id ? (
          <Button size="$4" backgroundColor="$accent" color="$background" disabled={!ready || busy} opacity={!ready || busy ? 0.5 : 1} icon={<Icon name="upload" size={16} color={tone('$background')} />} onPress={() => void apply()}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        ) : null}
        <Button size="$4" disabled={busy} onPress={onAgain}>
          Read it again
        </Button>
        <Text flex={1} minWidth={160} fontSize={13} color="$muted" lineHeight={19}>
          {plan.id === null
            ? 'Fix it, then read it again.'
            : nothing
              ? 'It is all here already: nothing to do.'
              : plan.needs.passphrase
                ? 'Give the passphrase, then read it again.'
                : secretsMissing.length || rebindMissing.length
                  ? `It still needs ${[secretsMissing.length && `${secretsMissing.length} secret${secretsMissing.length === 1 ? '' : 's'}`, rebindMissing.length && `${rebindMissing.length} device${rebindMissing.length === 1 ? '' : 's'}`].filter(Boolean).join(' and ')}.`
                  : 'Ready to import.'}
        </Text>
      </XStack>
    </YStack>
  );
}

/** Devices, or automations, an import would touch: each with what becomes of it, and whether it is included. */
function Items({ title, items, chosen, onChoose }: { title: string; items: ImportItem[]; chosen: ReadonlySet<string>; onChoose: (key: string, on: boolean) => void }) {
  const tone = useTone();
  return (
    <Card inset>
      <XStack paddingHorizontal="$4" paddingTop="$3" paddingBottom="$1">
        <Text fontSize={15} fontWeight="600" color="$color">
          {title}
        </Text>
      </XStack>
      {items.map((item, index) => {
        const look = ACTION[item.action];
        return (
          <YStack key={item.key}>
            {index > 0 ? <RowSeparator /> : null}
            <XStack paddingHorizontal="$4" paddingVertical="$3" gap="$3" alignItems="center" opacity={item.action === 'same' ? 0.6 : 1}>
              <YStack flex={1} gap={2}>
                <XStack gap="$2" alignItems="center" flexWrap="wrap">
                  <Text fontSize={15} fontWeight="600" color="$color">
                    {item.name}
                  </Text>
                  <Text fontSize={12} fontWeight="700" color={tone(look.tone)}>
                    {look.label}
                  </Text>
                </XStack>
                <Text fontSize={12} color="$muted" fontFamily="$mono">
                  {item.key}
                </Text>
                {item.changes.map((change) => (
                  <Text key={change} fontSize={13} color="$color" lineHeight={19}>
                    {change}
                  </Text>
                ))}
              </YStack>
              {item.action === 'same' ? null : <Toggle label={`Include ${item.name}`} checked={chosen.has(item.key)} onCheckedChange={(on) => onChoose(item.key, on)} />}
            </XStack>
          </YStack>
        );
      })}
    </Card>
  );
}

/** What an import did. */
function AppliedView({ applied }: { applied: ImportApplied }) {
  const tone = useTone();
  // Each count says what it counts: "1 device brought back", "2 automations deleted".
  const count = (n: number, one: string, done: string) => (n ? `${n} ${one}${n === 1 ? '' : 's'} ${done}` : null);
  const said = [
    count(applied.devices.added.length, 'device', 'added'),
    count(applied.devices.restored.length, 'device', `brought back, with ${applied.devices.restored.length === 1 ? 'its' : 'their'} history`),
    count(applied.devices.changed.length, 'device', 'changed'),
    count(applied.devices.removed.length, 'device', 'removed, history kept'),
    count(applied.automations.added.length, 'automation', 'added'),
    count(applied.automations.changed.length, 'automation', 'changed'),
    count(applied.automations.removed.length, 'automation', 'deleted'),
    count(applied.links.added, 'link', 'added'),
    count(applied.links.removed, 'link', 'removed'),
    count(applied.homes.added.length, 'home', 'added'),
    count(applied.homes.changed.length, 'home', 'changed'),
    count(applied.zones.added.length, 'zone', 'added'),
    count(applied.zones.changed.length, 'zone', 'changed'),
    count(applied.modes.added.length, 'mode', 'added'),
    count(applied.modes.changed.length, 'mode', 'changed'),
    applied.family ? 'the family’s name or language set' : null,
    applied.policy.length ? `${applied.policy.length} of the homes’ values set` : null,
  ].filter(Boolean);
  return (
    <Card gap="$2" borderColor="$success" role="status">
      <XStack gap="$2" alignItems="center">
        <Icon name="check-circle" size={16} color={tone('$success')} />
        <Text fontSize={15} fontWeight="700" color="$success">
          Imported
        </Text>
      </XStack>
      <Text fontSize={14} color="$color" lineHeight={20}>
        {said.length ? `${said.join(', ')}.` : 'Nothing needed changing.'}
      </Text>
      {applied.notes.map((note) => (
        <Text key={note} fontSize={13} color="$warning" lineHeight={19}>
          {note}
        </Text>
      ))}
    </Card>
  );
}
