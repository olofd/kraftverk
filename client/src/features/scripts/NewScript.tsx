import { useEffect, useRef, useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import type { ConfigField, ConfigSchema } from '@kraftverk/device-sdk';
import type { ScriptCheck, ScriptShape } from '@kraftverk/automation';
import { describeError, PATHS } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { ScriptEditor } from '../../components/ScriptEditor';
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
  async ({ after }: { after: number }, { memory }: { memory: { times: number } }) => {
    memory.times += 1;
    log(\`Asked \${memory.times} times\`);
    return \`Empty for \${after / 60} min\`;
  },
);

/** How warm it feels, from the temperature and how humid it is. */
export const feelsLike = fn(
  { args: [t.number({ unit: '°C' }), t.number({ unit: '%' })], returns: t.number({ unit: '°C' }) },
  (temp: number, humidity: number) => temp - (100 - humidity) / 5,
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
 * A script, written (docs/PLAN-SCRIPTS.md): read as it is typed by the
 * home's own engine — the server's, or this browser's when it keeps its
 * own — which says what it declares, or what is wrong with it, by line.
 * Keeping a script, and running it in an automation, come next.
 */
export function NewScript() {
  const { api } = useFamily();
  const [source, setSource] = useState(STARTER);
  const [check, setCheck] = useState<ScriptCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    const ask = ++asked.current;
    const timer = setTimeout(() => {
      api.scripts
        .check(source)
        .then((read) => {
          if (ask !== asked.current) return;
          setCheck(read);
          setError(null);
        })
        .catch((err: unknown) => {
          if (ask !== asked.current) return;
          setError(describeError(err) || 'It could not be read');
        });
    }, READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [api, source]);

  return (
    <Screen back="Automations" backTo={PATHS.automations.list} title="New script" subtitle="Written in TypeScript">
      <YStack gap="$4">
        <Text fontSize={14} color="$muted" lineHeight={20}>
          A script is what an automation does, or a value it works out. What it declares is read as you write, by the same engine that will run it. Keeping scripts and running them come next.
        </Text>
        <ScriptEditor value={source} onChange={setSource} problems={check?.problems ?? []} label="The script" />
        <ErrorText>{error}</ErrorText>
        {check?.shape ? <Declared shape={check.shape} /> : null}
      </YStack>
    </Screen>
  );
}
