import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { HAS_DATABASE } from '@/lib/config';
import { getSocial } from '@/lib/social';
import { getStore } from '@/lib/store';
import ChatClient from './ChatClient';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const store = getStore();
  const [rooms, conversations, blockers] = await Promise.all([
    store.listRooms(),
    store.listConversations(user.id),
    getSocial().listBlockersOf(user.id),
  ]);

  return (
    <ChatClient
      user={user}
      initialRooms={rooms}
      // Same rule as GET /api/conversations: someone who blocked you vanishes.
      initialConversations={conversations.filter((entry) => !blockers.has(entry.counterpart.id))}
      persistent={HAS_DATABASE}
    />
  );
}
