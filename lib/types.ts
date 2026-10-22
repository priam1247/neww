export interface AuthUser {
  id: number | string;
  name: string;
  email: string;
  username: string;
  isVerified: boolean;
  isAdmin: boolean;
  createdAt?: string;
}

export interface UserQuota {
  papers_downloaded_today: number;
  papers_limit: number;
  papers_left: number;
  books_downloaded_today: number;
  books_limit: number;
  books_left: number;
}

export interface ApprovedUser {
  number: string;
  label?: string;
  enabled: boolean;
  addedAt?: string;
  addedBy?: string;
}

export interface BotStatusPayload {
  ok: boolean;
  botServerLinked: boolean;
  storageEngine: 'bot-live' | 'cloudflare-d1' | 'persistent-db';
  upstreamHost?: string | null;
  adminEmail: string;
  connected: boolean;
  botNumber: string | null;
  users: ApprovedUser[];
  latencyMs?: number;
}

export interface PairCodePayload {
  ok: boolean;
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
