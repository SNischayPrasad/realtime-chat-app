import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { HAS_DATABASE } from '@/lib/config';
import { getStore } from '@/lib/store';
import ChatClient from './ChatClient';

export const dynamic = 'force-dynamic';

export default async function ChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const store = getStore();
  const [rooms, conversations] = await Promise.all([
    store.listRooms(),
    store.listConversations(user.id),
  ]);

  return (
    <ChatClient
      user={user}
      initialRooms={rooms}
      initialConversations={conversations}
      persistent={HAS_DATABASE}
    />
  );
}
