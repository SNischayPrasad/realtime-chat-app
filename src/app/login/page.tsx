import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { UNCONFIGURED_IN_PRODUCTION } from '@/lib/config';
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
        <div style={{ width: '100%', maxWidth: 380 }}>
          {UNCONFIGURED_IN_PRODUCTION && <NoDatabaseNotice />}
          <AuthForm />
        </div>
      </section>
    </main>
  );
}

/**
 * Shown only when the deployment is missing its datastore. It explains the
 * failure the visitor is about to hit instead of letting them sign up and be
 * silently logged out again.
 */
function NoDatabaseNotice() {
  return (
    <div className="notice" role="status">
      <strong className="notice__title">No database attached</strong>
      <p className="notice__body">
        This deployment is running on the in-memory development store, so accounts and
        messages are not saved and you will be signed out as soon as another server
        instance handles your request. Attach Postgres to the project and redeploy;{' '}
        <code>/api/health</code> reports which store is live.
      </p>
    </div>
  );
}
