export interface AuthUser {
  id: number | string;
  name: string;
  email: string;
  username: string;
  isVerified: boolean;
  isAdmin: boolean;
  memberAllowed: boolean;
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

export interface MemberRecord {
  email: string;
  name: string;
  isVerified: boolean;
  isAdmin: boolean;
  allowed: boolean;
  numbersCount: number;
  createdAt: string;
}

export interface ApprovedUser {
  number: string;
  label?: string;
  enabled: boolean;
  addedAt?: string;
  addedBy?: string;
}

export interface BotConnectionConfig {
  botApiUrl: string;
  botAdminToken: string;
  botSyncToken: string;
  botEnabledForMembers: boolean;
  updatedAt?: string;
}

export interface PanelConnectionConfig {
  panelUrl: string;
  panelServerId: string;
  panelApiKey: string;
  updatedAt?: string;
}

export interface PanelServerSummary {
  id: string;
  uuid: string;
  name: string;
}

export interface BotHeartbeatRecord {
  lastSeenAt: number;
  connected: boolean;
  botNumber: string | null;
  botName?: string;
  version?: string;
  uptimeSeconds?: number;
  diskUsedMB?: number;
  diskBudgetMB?: number;
  queueLight?: number;
  queueHeavy?: number;
}

export interface BotCommandRecord {
  id: string;
  type: 'pair' | 'restart';
  payload: Record<string, unknown>;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  result?: Record<string, unknown> | null;
  error?: string | null;
  requestedBy?: string;
  createdAt: number;
  expiresAt: number;
}

export interface AdminOverviewPayload {
  ok: boolean;
  adminEmail: string;
  botServerLinked: boolean;
  botApiUrl: string;
  hasBotToken: boolean;
  hasBotSyncToken?: boolean;
  botEnabledForMembers: boolean;
  storageEngine: 'bot-live' | 'cloudflare-d1' | 'persistent-db';
  connectionMode?: 'heartbeat' | 'direct' | 'unconfigured';
  upstreamHost?: string | null;
  isInsecureHttp?: boolean;
  botReachable?: boolean;
  botError?: string | null;
  connected: boolean;
  botNumber: string | null;
  lastSeenAt?: number | null;
  lastSeenSecondsAgo?: number | null;
  botVersion?: string | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  panelConfigured?: boolean;
  panelUrl?: string;
  panelServerId?: string;
  hasPanelApiKey?: boolean;
  users: ApprovedUser[];
  members: MemberRecord[];
  latencyMs?: number;
}

export interface MemberOverviewPayload {
  ok: boolean;
  adminEmail: string;
  memberAllowed: boolean;
  botEnabledForMembers: boolean;
  botServerLinked: boolean;
  botReachable?: boolean;
  botError?: string | null;
  lastSeenSecondsAgo?: number | null;
  botConnected: boolean;
  botNumber: string | null;
  numbers: ApprovedUser[];
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
