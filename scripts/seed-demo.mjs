/**
 * Seeds a running instance with demo accounts, a public conversation and two
 * private ones. Useful for screenshots and for trying the app out quickly.
 *
 *   node scripts/seed-demo.mjs [baseUrl]
 *
 * Default baseUrl is http://localhost:3000. Accounts are created if missing and
 * reused if they already exist, so the script is safe to run more than once.
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';

const PEOPLE = [
  { username: 'ada', displayName: 'Ada Lovelace', password: 'analytical-engine' },
  { username: 'linus', displayName: 'Linus Tan', password: 'kernel-panic-99' },
  { username: 'grace', displayName: 'Grace Okafor', password: 'nanoseconds-1906' },
];

const sessions = new Map();

async function api(username, path, init = {}) {
  const headers = { 'Content-Type': 'application/json', ...(init.headers ?? {}) };
  const cookie = sessions.get(username);
  if (cookie) headers.cookie = cookie;

  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessions.set(username, setCookie.split(';')[0]);

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status} ${text}`);
  }
  return data;
}

async function signIn(person) {
  try {
    await api(person.username, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(person),
    });
    console.log(`  registered @${person.username}`);
  } catch {
    await api(person.username, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: person.username, password: person.password }),
    });
    console.log(`  signed in  @${person.username}`);
  }
}

let nonce = 0;

async function say(username, roomId, body) {
  await api(username, `/api/rooms/${roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body, clientNonce: `seed-${Date.now()}-${nonce++}` }),
  });
  // Keep the seeded timestamps in a believable order.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function directRoom(fromUsername, toUsername) {
  const data = await api(fromUsername, '/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ username: toUsername }),
  });
  return data.conversation.room.id;
}

async function main() {
  console.log(`Seeding ${BASE}`);
  for (const person of PEOPLE) await signIn(person);

  console.log('  posting in #general');
  await say('grace', 'general', 'Morning all. Standup in ten, usual link.');
  await say('linus', 'general', 'On my way. I pushed the SSE reconnect fix late last night.');
  await say('ada', 'general', 'Saw it. The Last-Event-ID replay is exactly what we needed.');
  await say('linus', 'general', 'Yeah, no more gaps when the function hits its time budget.');
  await say('grace', 'general', 'Nice. Did the message history endpoint get the cursor param?');
  await say('ada', 'general', 'It did. GET /api/rooms/:id/messages?after=<cursor>&limit=50.');

  console.log('  seeding the private chat between @ada and @linus');
  const adaLinus = await directRoom('ada', 'linus');
  await say('ada', adaLinus, 'Before I raise it in the room — are we happy with the 50s stream budget?');
  await say('linus', adaLinus, 'Honestly yes. Vercel caps the function at 60s, so closing at 50 keeps it clean.');
  await say('ada', adaLinus, 'Good. I did not want to argue it in front of everyone if you had already tested it.');
  await say('linus', adaLinus, 'Tested it last night. The client reconnects in about a second, nobody notices.');

  console.log('  seeding an unread private chat from @grace to @ada');
  const graceAda = await directRoom('grace', 'ada');
  await say('grace', graceAda, 'Can you review my PR before I merge it?');

  console.log('\nDone. Sign in as any of:');
  for (const person of PEOPLE) {
    console.log(`  @${person.username} / ${person.password}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
