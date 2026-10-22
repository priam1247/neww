export type ConnectionMode = 'live' | 'sandbox';

export interface ApprovedUser {
  number: string;
  label?: string;
  enabled: boolean;
  addedAt?: string;
  alt?: string[];
}

export interface BotStatusPayload {
  ok: boolean;
  mode: ConnectionMode;
  upstreamConfigured: boolean;
  upstreamHost?: string | null;
  adminEmail: string;
  connected: boolean;
  botNumber: string | null;
  users: ApprovedUser[];
  latencyMs?: number;
}

export interface PairCodePayload {
  ok: boolean;
  mode: ConnectionMode;
  code: string;
  expiresInSeconds: number;
  number: string;
  issuedAt: number;
}

export interface CommandEntry {
  name: string;
  aliases: string[];
  category: 'media' | 'vault' | 'admin';
  usage: string;
  example: string;
  summary: string;
  ownerOnly?: boolean;
}

export interface MetadataSourceEntry {
  id: string;
  label: string;
  scope: string;
  keyless: boolean;
  note: string;
}
