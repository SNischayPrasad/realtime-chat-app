import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Sends signed-in visitors straight to the chat, everyone else to sign-in. */
export default async function Home() {
  const user = await getCurrentUser();
  redirect(user ? '/chat' : '/login');
}
