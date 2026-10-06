import { useEffect, useState, type ReactNode } from 'react';
import { Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceScreenProps } from '@kraftverk/api-client';
import { MAIN_PART, type AttributeSpec, type Value } from '@kraftverk/device-sdk';
import { AnimatedNumber, Card, formatValue, Icon, Row, RowSeparator, SectionLabel, StatTile, type IconName } from '@kraftverk/ui';

import { doingOf, levelTone, reportLine, type Doing } from './words';

/**
 * A NIU scooter at a glance: how full it is, whether it is charging and when
 * it will be full, how far it goes — and how old that is, since all of it is
 * the scooter's last report to NIU. Then its battery's health, and the rest
 * of what NIU says, folded away.
 *
 * Content only: the page frame, the name and the history below are the app's.
 * Every value is drawn through its attribute, so the words are the type's.
 */
export function ScooterDashboard({ device, reach }: DeviceScreenProps) {
  const now = useNow(30_000);
  const reading = (key: string) => device.readings.find((candidate) => candidate.key === key);
  const read = (key: string): Value => reading(key)?.value ?? null;
  const spec = (key: string) => device.description.attributes.find((attribute) => attribute.key === key);
  const shown = (key: string) => {
    const attribute = spec(key);
    return attribute ? formatValue(attribute, read(key)) : '—';
  };

  if (!device.readings.length) {
    const failed = device.health.status === 'error';
    return (
      <Card alignItems="center" paddingVertical="$8" gap="$4">
        {failed ? null : <Spinner size="large" color="$accent" />}
        <Text color={failed ? '$danger' : '$muted'} fontSize={13} textAlign="center" lineHeight={19} maxWidth={420}>
          {failed ? device.health.detail : reach.waiting}
        </Text>
      </Card>
    );
  }

  const doing = doingOf(read);
  return (
    <YStack gap="$4">
      {device.health.status === 'error' ? <Trouble detail={device.health.detail} /> : null}
      <Hero device={device} doing={doing} read={read} shown={shown} now={now} />
      <Battery shown={shown} read={read} />
      <More attributes={device.description.attributes.filter((attribute) => attribute.category === 'diagnostic' && (attribute.part ?? MAIN_PART) === MAIN_PART)} shown={shown} />
    </YStack>
  );
}

/** A clock that moves: "reported 3 minutes ago" must not stand still while the page is open. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

const TONE = { success: '$success', warning: '$warning', muted: '$muted', danger: '$danger', normal: '$accent' } as const;

function Hero({ device, doing, read, shown, now }: { device: DeviceScreenProps['device']; doing: Doing; read: (key: string) => Value; shown: (key: string) => string; now: number }) {
  const theme = useTheme();
  const soc = typeof read('soc') === 'number' ? (read('soc') as number) : null;
  const level = levelTone(soc);
  const report = reportLine(device.health.lastReadingAt, doing, now);
  const charging = read('charging') === true;
  // Said only by the models that say it (README.md): nothing, rather than a dash, where it is not.
  const alarm = read('alarmArmed');

  return (
    <Card padding="$5" gap="$4">
      <YStack gap={6}>
        <XStack alignItems="center" gap="$2">
          {charging ? <Icon name="zap" size={14} color={theme.success?.val as string} /> : null}
          <Text fontSize={13} fontWeight="700" color={TONE[doing.tone]}>
            {doing.title}
          </Text>
        </XStack>
        <XStack alignItems="baseline" gap={6} aria-label={soc === null ? 'Charge not known' : `${Math.round(soc)} % charged`}>
          {soc === null ? (
            <Text fontSize={56} lineHeight={62} fontWeight="800" color="$muted">
              —
            </Text>
          ) : (
            <AnimatedNumber value={soc} fontSize={56} fontWeight="800" color={report.stale ? '$muted' : level === 'normal' ? '$color' : TONE[level]} />
          )}
          <Text fontSize={24} fontWeight="700" color="$muted">
            %
          </Text>
        </XStack>
        {/* The battery, filled to its charge: the one picture of it that needs no reading. */}
        <YStack height={12} borderRadius={6} backgroundColor="$backgroundPress" overflow="hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={soc ?? undefined}>
          <YStack height={12} borderRadius={6} width={`${Math.max(0, Math.min(100, soc ?? 0))}%`} backgroundColor={charging ? '$success' : TONE[level]} opacity={report.stale ? 0.4 : 1} />
        </YStack>
        {doing.detail ? (
          <Text fontSize={15} fontWeight="600" color="$color" marginTop={2}>
            {doing.detail}
          </Text>
        ) : null}
      </YStack>

      <XStack gap="$3" flexWrap="wrap">
        {/* How long until full is the line above, while charging: these two are always worth a glance. */}
        <Figure label="Range" value={shown('range')} />
        <Figure label="Odometer" value={shown('odometer')} />
      </XStack>

      <YStack gap={6} borderTopWidth={1} borderTopColor="$borderColor" paddingTop="$3">
        <Line icon="clock" tone={report.stale ? 'warning' : 'muted'}>
          {report.text}
        </Line>
        {typeof alarm === 'boolean' ? <Line icon="shield">{alarm ? 'Alarm armed' : 'Alarm not armed'}</Line> : null}
      </YStack>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <YStack flex={1} minWidth={120} gap={2}>
      <Text fontSize={12} color="$muted" fontWeight="600">
        {label}
      </Text>
      <Text fontSize={20} fontWeight="700" color="$color" fontVariant={['tabular-nums']}>
        {value}
      </Text>
    </YStack>
  );
}

function Line({ icon, tone = 'muted', children }: { icon: IconName; tone?: 'muted' | 'warning'; children: ReactNode }) {
  const theme = useTheme();
  return (
    <XStack alignItems="center" gap="$2">
      <Icon name={icon} size={13} color={(tone === 'warning' ? theme.warning?.val : theme.muted?.val) as string} />
      <Text fontSize={12} color={tone === 'warning' ? '$warning' : '$muted'} lineHeight={17} flex={1}>
        {children}
      </Text>
    </XStack>
  );
}

function Trouble({ detail }: { detail: string }) {
  const theme = useTheme();
  return (
    <Card padding="$4" gap="$2" borderWidth={1} borderColor="$warning">
      <XStack alignItems="center" gap="$2">
        <Icon name="cloud-off" size={16} color={theme.warning?.val as string} />
        <Text fontSize={15} fontWeight="700" color="$color">
          NIU is not answering
        </Text>
      </XStack>
      <Text fontSize={13} color="$muted" lineHeight={19}>
        {detail}. What is shown is what it said last; it is asked again every few minutes.
      </Text>
    </Card>
  );
}

function Battery({ shown, read }: { shown: (key: string) => string; read: (key: string) => Value }) {
  const theme = useTheme();
  const health = read('battery.health');
  const temperature = read('battery.temperature');
  const cycles = read('battery.cycles');
  const icon = (name: IconName) => <Icon name={name} size={13} color={theme.muted?.val as string} />;
  if (health === null && temperature === null && cycles === null) return null;
  const worn = typeof health === 'number' && health < 70;
  const charged = typeof cycles === 'number' ? `Charged ${Math.round(cycles)} times` : null;
  return (
    <YStack gap="$2">
      <SectionLabel>Its battery</SectionLabel>
      <XStack flexWrap="wrap" gap="$3">
        <StatTile
          label="Health"
          icon={icon('heart')}
          value={shown('battery.health')}
          position={typeof health === 'number' ? health / 100 : null}
          tone={worn ? 'warning' : 'normal'}
          note={[worn ? 'Worn: it holds less than it did' : 'As NIU grades it', charged].filter(Boolean).join(' · ')}
        />
        <StatTile
          label="Temperature"
          icon={icon('thermometer')}
          value={shown('battery.temperature')}
          tone={typeof temperature === 'number' && (temperature >= 45 || temperature <= 0) ? 'warning' : 'normal'}
          note={
            typeof temperature !== 'number'
              ? null
              : temperature <= 0
                ? 'Cold: charge it indoors'
                : temperature >= 45
                  ? 'Hot: let it cool before charging'
                  : 'Fine for charging'
          }
        />
      </XStack>
    </YStack>
  );
}

/** What NIU also says — signals, the control unit — for working things out, folded away. */
function More({ attributes, shown }: { attributes: readonly AttributeSpec[]; shown: (key: string) => string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  if (!attributes.length) return null;
  return (
    <Card inset>
      <YStack
        role="button"
        tabIndex={0}
        aria-expanded={open}
        cursor="pointer"
        borderRadius="$4"
        hoverStyle={{ backgroundColor: '$backgroundHover' }}
        focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
        onPress={() => setOpen((was) => !was)}
      >
        <Row
          title="More from NIU"
          subtitle={open ? undefined : 'Signals, the control unit, its lock'}
          accessory={<Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={theme.muted?.val as string} />}
        />
      </YStack>
      {open
        ? attributes.map((attribute) => (
            <YStack key={attribute.key}>
              <RowSeparator />
              <Row
                title={attribute.label}
                accessory={
                  <Text fontSize={14} fontWeight="600" color="$muted" fontVariant={['tabular-nums']}>
                    {shown(attribute.key)}
                  </Text>
                }
              />
            </YStack>
          ))
        : null}
    </Card>
  );
}
