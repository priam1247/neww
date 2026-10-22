import { ControlRoomApp } from '@/components/control-room-app';

export default function HomePage() {
  const defaultBotApiConfigured = Boolean(process.env.BOT_API_URL?.trim());
  const defaultAdminEmail =
    process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'troykunsauka6@gmail.com';

  return (
    <ControlRoomApp
      defaultBotApiConfigured={defaultBotApiConfigured}
      defaultAdminEmail={defaultAdminEmail}
    />
  );
}
