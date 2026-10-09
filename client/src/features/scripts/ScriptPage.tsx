import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import type { ConfigField, ConfigSchema } from '@kraftverk/device-sdk';
import type { ScriptCheck, ScriptShape } from '@kraftverk/automation';
import { describeError, PATHS, type ScriptView } from '@kraftverk/api-client';
import { Card, haptic, Icon } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Loading } from '../../components/Loading';
import { Screen } from '../../components/Screen';
import { ScriptEditor } from '../../components/ScriptEditor';
import { useTone } from '../../components/tone';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';

/** What a new script starts as: one step and one function, each declared as the SDK has them now. */
const STARTER = `import { step, fn, t, log } from 'kraftverk';

/** Says how long a room has been empty, and remembers how often it was asked. */
export const tidyUp = step(
  {
    inputs: { after: t.duration({ title: 'Empty for at least', min: 60 }) },
    answer: t.text(),
    memory: { times: t.count() },
  },
  async ({ after }, { memory }) => {
    memory.times += 1;
    log(\`Asked \${memory.times} times\`);
    return \`Empty for \${after / 60} min\`;
  },
);

/** How warm it feels, from the temperature and how humid it is. */
export const feelsLike = fn(
  { args: [t.number({ unit: '°C' }), t.number({ unit: '%' })], returns: t.number({ unit: '°C' }) },
  (temp, humidity) => temp - (100 - humidity) / 5,
);
`;

/** How long typing rests before the script is read again. */
const READ_AFTER_MS = 300;

/** A name as a person says it: "tidyUp" is "Tidy up". */
const wordsOf = (name: string): string => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A field in words: its title, and what it holds. */
const fieldWords = (field: ConfigField): string => {
  const kind =
    field.type === 'number'
      ? [field.unit === 's' ? 'seconds' : field.unit, field.integer ? 'whole' : null, field.min !== undefined ? `from ${field.min}` : null, field.max !== undefined ? `to ${field.max}` : null].filter(Boolean).join(', ') || 'a number'
      : field.type === 'boolean'
        ? 'yes or no'
        : field.type === 'enum'
          ? field.options.map((option) => option.label).join(' · ')
          : field.type === 'timestamp'
            ? 'a date and time'
            : 'text';
  return `${field.title} — ${kind}`;
};

const fieldsOf = (schema: ConfigSchema): ConfigField[] => Object.values(schema.fields);

function Fields({ label, fields }: { label: string; fields: readonly ConfigField[] }) {
  if (!fields.length) return null;
  return (
    <YStack gap={2}>
      <Text fontSize={13} color="$muted">
        {label}
      </Text>
      {fields.map((field, at) => (
        <Text key={at} fontSize={14} color="$color">
          {fieldWords(field)}
        </Text>
      ))}
    </YStack>
  );
}

/** What a script declares, as a person reads it: its steps and its functions, each with what it takes and gives. */
function Declared({ shape }: { shape: ScriptShape }) {
  const steps = Object.entries(shape.steps);
  const functions = Object.entries(shape.functions);
  return (
    <YStack gap="$3" role="region" aria-label="What it declares">
      <Text role="heading" aria-level={2} fontSize={18} fontWeight="700" color="$color">
        What it declares
      </Text>
      {steps.map(([name, step]) => (
        <Card key={`step:${name}`} gap="$2" aria-label={`Step ${wordsOf(name)}`}>
          <XStack gap="$2" alignItems="baseline">
            <Text fontSize={12} color="$muted" textTransform="uppercase">
              Step
            </Text>
            <Text fontSize={16} fontWeight="600" color="$color">
              {wordsOf(name)}
            </Text>
          </XStack>
          <Fields label="It takes" fields={fieldsOf(step.inputs)} />
          <Fields label="It answers" fields={step.answer ? [step.answer] : []} />
          <Fields label="It remembers" fields={fieldsOf(step.memory)} />
        </Card>
      ))}
      {functions.map(([name, fn]) => (
        <Card key={`fn:${name}`} gap="$2" aria-label={`Function ${wordsOf(name)}`}>
          <XStack gap="$2" alignItems="baseline">
            <Text fontSize={12} color="$muted" textTransform="uppercase">
              Function
            </Text>
            <Text fontSize={16} fontWeight="600" color="$color">
              {wordsOf(name)}
            </Text>
          </XStack>
          <Fields label="It takes, in order" fields={fn.args} />
          <Fields label="It gives" fields={[fn.returns]} />
        </Card>
      ))}
    </YStack>
  );
}

/**
 * A source, read again by the home's engine each time typing rests: what it
 * declares, or its problems. What was read last stays shown while the next
 * reading is made, so the page keeps its height and place as it is typed in;
 * `current` says whether it was read from the source as it is now.
 */
function useRead(source: string): { check: ScriptCheck | null; current: boolean; error: string | null } {
  const { api } = useFamily();
  const [read, setRead] = useState<{ source: string; check: ScriptCheck } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      api.scripts
        .check(source)
        .then((check) => {
          if (ask !== asked.current) return;
          setRead({ source, check });
          setError(null);
        })
        .catch((err: unknown) => {
          if (ask !== asked.current) return;
          setError(describeError(err) || 'It could not be read');
        });
    }, READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [api, source]);
  return { check: read?.check ?? null, current: read?.source === source, error };
}

/** The script itself: its name, its source, what it declares, and keeping it. */
function ScriptForm({ script }: { script: ScriptView | null }) {
  const { api } = useFamily();
  const tone = useTone();
  const [name, setName] = useState(script?.name ?? '');
  const [source, setSource] = useState(script?.source ?? STARTER);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { check, current, error } = useRead(source);
  // The home's types, for the editor's checking and completion: asked once, as the page opens.
  const [types, setTypes] = useState<string | null>(null);
  useEffect(() => {
    api.scripts
      .types()
      .then(setTypes)
      .catch(() => setTypes(null));
  }, [api]);

  const changed = script === null || name.trim() !== script.name || source !== script.source;
  const problems = check?.problems.length ?? 0;
  const ready = Boolean(name.trim()) && current && problems === 0 && changed;

  const save = async () => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      if (script) {
        await api.scripts.update(script.id, { name: name.trim(), source });
        router.replace(PATHS.automations.list);
      } else {
        const made = await api.scripts.create({ name: name.trim(), source });
        router.replace(PATHS.scripts.one(made.id));
      }
    } catch (err) {
      setProblem(describeError(err) || 'It could not be kept');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!script) return;
    if (!(await confirmAction(`Remove "${script.name}"?`, 'Its source is gone with it: export it first to keep a copy.', 'Remove', 'careful'))) return;
    setBusy(true);
    try {
      await api.scripts.remove(script.id);
      router.replace(PATHS.automations.list);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be removed');
      setBusy(false);
    }
  };

  const footer = (
    <YStack gap="$2">
      {problem ? <ErrorText>{problem}</ErrorText> : null}
      <XStack alignItems="center" gap="$2">
        <XStack flex={1} alignItems="center" gap="$2">
          {!current ? <Spinner size="small" color="$accent" /> : <Icon name={problems ? 'alert-triangle' : name.trim() ? 'check-circle' : 'edit-3'} size={16} color={tone(problems ? '$warning' : name.trim() ? '$success' : '$muted')} />}
          <Text flex={1} fontSize={14} fontWeight="600" color={!current || (!problems && !name.trim()) ? '$muted' : problems ? '$warning' : '$success'} numberOfLines={1}>
            {!current ? 'Reading…' : problems ? `${problems} thing${problems === 1 ? '' : 's'} to fix` : !name.trim() ? 'Give it a name to keep it' : 'Ready'}
          </Text>
        </XStack>
        {script ? (
          <Button size="$4" chromeless color="$danger" disabled={busy} onPress={() => void remove()}>
            Remove
          </Button>
        ) : null}
        <Button size="$4" backgroundColor="$accent" color="$background" disabled={busy || !ready} opacity={busy || !ready ? 0.5 : 1} onPress={() => void save()}>
          {busy ? 'Keeping…' : script ? 'Save changes' : 'Keep it'}
        </Button>
      </XStack>
    </YStack>
  );

  return (
    <Screen back="Automations" backTo={PATHS.automations.list} title={script ? script.name : 'New script'} subtitle={script ? `${script.key} · written in TypeScript` : 'Written in TypeScript'} footer={footer}>
      <YStack gap="$4">
        <Text fontSize={14} color="$muted" lineHeight={20}>
          A script is what an automation does, or a value it works out. What it declares is read as you write, by the same engine that runs it. Once it is kept, an automation runs its steps and uses its functions.
        </Text>
        <YStack gap="$1.5">
          <Text fontSize={13} color="$muted">
            Its name
          </Text>
          <Input aria-label="Its name" placeholder="Tidy up" size="$4" maxLength={60} value={name} onChangeText={setName} />
        </YStack>
        <ScriptEditor value={source} onChange={setSource} problems={check?.problems ?? []} label="The script" types={types} />
        <ErrorText>{error}</ErrorText>
        {check?.shape ? <Declared shape={check.shape} /> : null}
      </YStack>
    </Screen>
  );
}

/**
 * A script (docs/PLAN-SCRIPTS.md): a new one, or one the family keeps —
 * read as it is typed by the home's own engine, the server's or this
 * browser's, which says what it declares or what is wrong with it, by
 * line; kept when it reads without a problem.
 */
export function ScriptPage({ id }: { id: string | null }) {
  const { api } = useFamily();
  const [script, setScript] = useState<ScriptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    api.scripts
      .get(id)
      .then((found) => (setScript(found), setError(null)))
      .catch((err: unknown) => setError(describeError(err) || 'It could not be read'));
  }, [api, id]);

  if (id && !script)
    return (
      <Screen back="Automations" backTo={PATHS.automations.list} title="Script">
        <Loading error={error} />
      </Screen>
    );
  return <ScriptForm key={script?.id ?? 'new'} script={script} />;
}
