import { Input, Text, XStack, YStack } from 'tamagui';

import { Row, RowSeparator, ToggleRow } from './Row';
import { haptic } from './haptics';
import type { ConfigField, ConfigSchema, ConfigValues } from '@kraftverk/plugin-sdk';

/**
 * Renders any plugin's settings from its declared schema.
 *
 * This is the component that makes the extension system's promise true: a
 * plugin written next year gets a working setup form with no change here and no
 * UI code of its own. That only holds because the schema language is small and
 * closed — six field types, all of which map onto controls this app already
 * has. Adding a seventh is a decision about every plugin at once, which is
 * exactly the friction that keeps it small.
 *
 * Secrets are write-only by construction: the server never sends their values,
 * so the field shows whether one is stored and takes a replacement.
 */
export function SchemaForm({
  schema,
  values,
  secretsSet = [],
  onChange,
  disabled,
}: {
  schema: ConfigSchema;
  values: ConfigValues;
  /** Names of secret fields that already hold a value. */
  secretsSet?: string[];
  onChange: (name: string, value: string | number | boolean | undefined) => void;
  disabled?: boolean;
}) {
  const fields = Object.entries(schema.fields);

  return (
    <YStack>
      {schema.help ? (
        <Text fontSize={12} color="$muted" lineHeight={18} padding="$4" paddingBottom="$2">
          {schema.help}
        </Text>
      ) : null}

      {fields.map(([name, field], index) => (
        <YStack key={name}>
          {index > 0 ? <RowSeparator /> : null}
          <Field
            name={name}
            field={field}
            value={values[name]}
            hasSecret={secretsSet.includes(name)}
            disabled={disabled}
            onChange={onChange}
          />
        </YStack>
      ))}
    </YStack>
  );
}

function Field({
  name,
  field,
  value,
  hasSecret,
  disabled,
  onChange,
}: {
  name: string;
  field: ConfigField;
  value: string | number | boolean | undefined;
  hasSecret: boolean;
  disabled?: boolean;
  onChange: (name: string, value: string | number | boolean | undefined) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <ToggleRow
        title={field.title}
        subtitle={field.description}
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(next) => onChange(name, next)}
      />
    );
  }

  if (field.type === 'enum') {
    return (
      <YStack gap="$2" paddingHorizontal="$4" paddingVertical="$3" opacity={disabled ? 0.45 : 1}>
        <Label title={field.title} description={field.description} />
        {/*
          Wrapping chips rather than a segmented control: an enum can have two
          options or nine (Tuya has seven data centres), and a segmented control
          silently becomes unreadable somewhere in between.
        */}
        <XStack gap="$2" flexWrap="wrap">
          {field.options.map((option) => {
            const selected = option.value === String(value ?? field.default ?? '');
            return (
              <XStack
                key={option.value}
                paddingHorizontal="$3"
                paddingVertical="$2"
                borderRadius="$3"
                borderWidth={1}
                borderColor={selected ? '$accent' : '$borderColor'}
                backgroundColor={selected ? '$backgroundPress' : 'transparent'}
                cursor="pointer"
                pressStyle={{ opacity: 0.7 }}
                onPress={() => {
                  if (disabled || selected) return;
                  haptic();
                  onChange(name, option.value);
                }}
              >
                <Text fontSize={13} fontWeight={selected ? '700' : '500'} color={selected ? '$color' : '$muted'}>
                  {option.label}
                </Text>
              </XStack>
            );
          })}
        </XStack>
      </YStack>
    );
  }

  const secret = field.type === 'secret';
  const numeric = field.type === 'number';

  return (
    <YStack gap="$2" paddingHorizontal="$4" paddingVertical="$3" opacity={disabled ? 0.45 : 1}>
      <Label
        title={field.title}
        description={
          secret && hasSecret
            ? `${field.description ? `${field.description} ` : ''}Stored — leave blank to keep it.`
            : field.description
        }
      />
      <Input
        size="$3"
        backgroundColor="$backgroundPress"
        borderColor="$borderColor"
        color="$color"
        placeholderTextColor="$muted"
        disabled={disabled}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? 'numeric' : 'default'}
        placeholder={
          secret
            ? hasSecret
              ? '••••••••  (stored)'
              : 'Not set'
            : 'placeholder' in field && field.placeholder
              ? field.placeholder
              : field.type === 'host'
                ? '192.168.1.50'
                : undefined
        }
        value={value === undefined || typeof value === 'boolean' ? '' : String(value)}
        onChangeText={(text) => {
          if (!numeric) return onChange(name, text);
          if (text.trim() === '') return onChange(name, undefined);
          const parsed = Number(text);
          onChange(name, Number.isFinite(parsed) ? parsed : text);
        }}
      />
      {numeric && (field.min !== undefined || field.max !== undefined) ? (
        <Text fontSize={11} color="$muted">
          {field.min ?? '—'} to {field.max ?? '—'}
          {field.unit ? ` ${field.unit}` : ''}
        </Text>
      ) : null}
    </YStack>
  );
}

function Label({ title, description }: { title: string; description?: string }) {
  return (
    <YStack gap={2}>
      <Text fontSize={15} fontWeight="600" color="$color">
        {title}
      </Text>
      {description ? (
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {description}
        </Text>
      ) : null}
    </YStack>
  );
}

/** Whether every required field has a value, for the wizard's step tracking. */
export function isComplete(schema: ConfigSchema, values: ConfigValues, secretsSet: string[] = []): boolean {
  return Object.entries(schema.fields).every(([name, field]) => {
    if (!('required' in field) || !field.required) return true;
    if (field.type === 'secret') return secretsSet.includes(name) || Boolean(values[name]);
    const value = values[name];
    return value !== undefined && value !== '';
  });
}
