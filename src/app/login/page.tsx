import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import AuthForm from './AuthForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect('/chat');

  return (
    <main className="auth">
      <section className="auth__pitch">
        <div className="auth__brand">
          <span aria-hidden="true">◈</span>
          <span>Transmission</span>
        </div>

        <div>
          <h1 className="auth__headline">
            Rooms that stay <em>live</em>.
          </h1>
          <ul className="auth__facts">
            <li>
              <b>Live</b>
              <span>Messages arrive over an open event stream, not a refresh button.</span>
            </li>
            <li>
              <b>Kept</b>
              <span>Every message is written to Postgres, so history survives the tab closing.</span>
            </li>
            <li>
              <b>Shared</b>
              <span>Rooms show who is present and who is mid-sentence.</span>
            </li>
          </ul>
        </div>

        <p className="eyebrow" style={{ position: 'relative' }}>
          Sign in to join a room
        </p>
      </section>

      <section className="auth__form-pane">
        <AuthForm />
      </section>
    </main>
  );
}
