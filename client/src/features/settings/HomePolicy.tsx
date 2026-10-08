import { useEffect, useRef, useState } from 'react';
import { Input, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import { POLICY_VALUES, type PolicyValueName, type PolicyValues } from '@kraftverk/device-sdk';
import { Card, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useFamily } from '../../state/FamilyProvider';

/**
 * The numbers this home decides that the capabilities name: a switch says
 * turning off what carries a load is confirmed first, and here is how much a
 * load is. The home's, for everything it holds — and, with a server, for what
 * this app holds for it.
 */
export function HomePolicy() {
  const { api } = useFamily();
  const [kept, setKept] = useState<PolicyValues>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const names = Object.keys(POLICY_VALUES) as PolicyValueName[];
  const inForce = (name: PolicyValueName) => kept[name] ?? POLICY_VALUES[name].default;
  const took = (now: { name: PolicyValueName; value: number | null }[]) => {
    const next = Object.fromEntries(now.filter((item) => item.value !== null).map((item) => [item.name, item.value])) as PolicyValues;
    setKept(next);
  };
  useEffect(() => {
    void api.policy
      .list()
      .then(took)
      .catch(() => undefined);
  }, [api]);
  // Enter and the blur after it both save, before either has settled: what is
  // on its way is sent once.
  const saving = useRef(new Map<PolicyValueName, string>());

  const save = async (name: PolicyValueName) => {
    const typed = values[name];
    if (typed === undefined || saving.current.get(name) === typed) return;
    const value = typed.trim() === '' ? null : Number(typed.replace(',', '.'));
    const spec = POLICY_VALUES[name];
    if (value !== null && !(Number.isFinite(value) && value >= spec.min && value <= spec.max)) {
      setProblem(`${spec.label} is from ${spec.min} to ${spec.max} ${spec.unit}`);
      return;
    }
    setProblem(null);
    const typedNoMore = () => setValues(({ [name]: _typed, ...rest }) => rest);
    saving.current.set(name, typed);
    try {
      took(await api.policy.set(name, value));
      typedNoMore();
    } catch (err) {
      setProblem(describeError(err) || 'That did not work');
    } finally {
      saving.current.delete(name);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Safety</SectionLabel>
      <Card inset>
        {names.map((name, index) => {
          const spec = POLICY_VALUES[name];
          return (
            <YStack key={name}>
              {index > 0 ? <RowSeparator /> : null}
              <Row
                title={spec.label}
                subtitle={`${spec.description} Empty puts back ${spec.default} ${spec.unit}.`}
                accessory={
                  <XStack alignItems="center" gap="$1.5">
                    <Input
                      aria-label={spec.label}
                      width={72}
                      size="$3"
                      keyboardType="decimal-pad"
                      value={values[name] ?? String(inForce(name))}
                      onChangeText={(text) => setValues((current) => ({ ...current, [name]: text }))}
                      onBlur={() => void save(name)}
                      onSubmitEditing={() => void save(name)}
                    />
                    <Text fontSize={13} color="$muted">
                      {spec.unit}
                    </Text>
                  </XStack>
                }
              />
            </YStack>
          );
        })}
      </Card>
      {problem ? (
        <ErrorText fontSize={12}>
          {problem}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
