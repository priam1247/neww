import { ApprovedUser } from './types';

interface SandboxState {
  users: ApprovedUser[];
  botConnected: boolean;
  botNumber: string;
}

declare global {
  // Persist sandbox state across Next.js hot module reloads in dev preview
  // eslint-disable-next-line no-var
  var __zafarSandboxState: SandboxState | undefined;
}

function createInitialState(): SandboxState {
  return {
    botConnected: true,
    botNumber: '265894016453',
    users: [
      {
        number: '265894016453',
        label: 'Primary Bot Owner (Malawi)',
        enabled: true,
        addedAt: '2026-10-20T09:15:00.000Z',
      },
      {
        number: '265882124748',
        label: 'Co-Admin Operator',
        enabled: true,
        addedAt: '2026-10-21T14:30:00.000Z',
      },
      {
        number: '265991408220',
        label: 'Student Representative · MZUNI',
        enabled: false,
        addedAt: '2026-10-22T07:45:00.000Z',
      },
    ],
  };
}

export function getSandboxState(): SandboxState {
  if (!globalThis.__zafarSandboxState) {
    globalThis.__zafarSandboxState = createInitialState();
  }
  return globalThis.__zafarSandboxState;
}

export function normalizePhoneNumber(input: unknown): string {
  return String(input ?? '').replace(/[^0-9]/g, '');
}

export function generateDemoPairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let partA = '';
  let partB = '';
  for (let i = 0; i < 4; i++) {
    partA += alphabet[Math.floor(Math.random() * alphabet.length)];
    partB += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${partA}-${partB}`;
}
