import { Button, Paragraph, Text, YStack } from 'tamagui';
import axios from 'axios';
import { useEffect, useState } from 'react';

const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3333/api';

export default function HomeScreen() {
  const [station, setStation] = useState({ name: 'Aferiy Powerstation', level: 0, state: 'idle' });
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    async function fetchStatus() {
      try {
        const result = await axios.get(`${apiBase}/status`);
        setStation(result.data);
        setStatus('Connected');
      } catch (error) {
        setStatus('Offline');
      }
    }
    fetchStatus();
  }, []);

  return (
    <YStack padding="$4" space="$4" flex={1}>
      <Text fontSize={24} fontWeight="700">Aferiy Powerstation</Text>
      <Text color="$gray10">{status}</Text>

      <YStack padding="$4" borderRadius={16} backgroundColor="$backgroundStrong" space="$3">
        <Text fontSize={18} fontWeight="700">Station</Text>
        <Paragraph>{station.name}</Paragraph>
        <Paragraph>Charge level: {station.level}%</Paragraph>
        <Paragraph>Status: {station.state}</Paragraph>
      </YStack>

      <Button onPress={() => alert('Charging command coming soon')} bordered>
        Start charging
      </Button>
    </YStack>
  );
}
