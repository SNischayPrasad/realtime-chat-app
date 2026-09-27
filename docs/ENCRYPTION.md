# End-to-end encryption

Private conversations and calls in Transmission are end-to-end encrypted. This
document says exactly what that protects, what it does not, and how it works.
If you only read one section, read [What this does not protect
against](#what-this-does-not-protect-against).

- [What is encrypted](#what-is-encrypted)
- [What this protects against](#what-this-protects-against)
- [What this does not protect against](#what-this-does-not-protect-against)
- [How it works](#how-it-works)
- [Verifying a contact](#verifying-a-contact)
- [How it was tested](#how-it-was-tested)

---

## What is encrypted

| | End-to-end encrypted? |
| --- | --- |
| Messages in private (friend-to-friend) conversations | **Yes** |
| Voice and video call media | **Yes** - WebRTC DTLS-SRTP, directly between browsers |
| Call signalling (SDP, ICE candidates, mute state) | **Yes** - sealed before it reaches the server |
| Your identity private key | **Yes** - sealed in a vault only your password opens |
| Messages in public rooms | **No** - labelled "not end-to-end encrypted" in the app |
| Private messages sent before encryption existed | **No** - shown above an "encrypted from here" divider |
| Who talks to whom, when, how often, message sizes | **No** - see metadata below |

Public rooms are not encrypted on purpose. A room anyone can join would need a
key anyone can fetch, and a key anyone can fetch is not a secret.

## What this protects against

- **A copy of the database.** Private messages are stored as AES-GCM
  ciphertext. The key that decrypts them never exists on the server.
- **The server operator reading your messages at rest.** Including the person
  who deployed this. The server never receives your password, and never holds
  a key that can open a private message.
- **Network interception**, on top of HTTPS.
- **The server tampering with stored messages.** Every message is bound to its
  room, its sender and its id. A message moved to another room, attributed to
  the other person, or replayed under a new id fails to decrypt, and the app
  says so rather than showing it.
- **The server inserting a fake message.** Once a conversation is encrypted, a
  plaintext message appearing in it is displayed as *unverified*, with no claim
  that it came from the person it names.
- **The server reordering or deleting messages**, where the gap is visible:
  each encrypted message carries a hash of the sender's previous one, and a
  broken chain is flagged on the message.
- **The server swapping someone's key** to read your conversation. Your browser
  remembers each contact's key the first time it sees it. If it ever changes,
  the conversation is blocked behind a warning until you compare safety
  numbers or explicitly accept the new key. Calls are disabled meanwhile.
- **The server seeing your IP address or intercepting a call.** Call setup
  messages carry both people's network addresses and the fingerprint that
  secures the media. They are sealed, so the server can neither read them nor
  substitute a fingerprint.

## What this does not protect against

These are real limits. They are listed first-class, not as fine print.

1. **The server delivers the app's JavaScript.** Browser-based encryption
   trusts the code the server sends. Whoever controls the deployment could ship
   a version that reads your password or your decrypted messages, and you would
   not see it happen. This is the single largest difference from apps like
   Signal, whose code is installed separately and can be independently
   verified. What *is* true: the code as published in this repository never
   sends your password or keys anywhere, and a malicious change would have to
   be deployed, not merely a database query.

2. **No forward secrecy.** Each pair of friends has one long-term key for the
   conversation. If someone records the ciphertext today and later obtains
   your identity key (for example by learning your password), they can decrypt
   the history. Signal avoids this with a ratcheting protocol; that is a larger
   project than this app, and would also require device linking.

3. **Your password protects everything.** The vault holding your identity key
   is sealed with a key derived from your password (PBKDF2-SHA256, 600,000
   iterations). Someone with a copy of the database can try to guess your
   password offline. A long, unique password matters here more than usual.

4. **There is no password reset.** If you forget your password, your encrypted
   history cannot be recovered - by you, the operator, or anyone. This is what
   "the operator cannot read your messages" costs. The database has columns
   for a printed recovery code; the feature is not built yet.

5. **Metadata is visible to the server:** who is friends with whom, who
   messages whom and when, message sizes (rounded up to 256-byte buckets),
   call times and durations, and your IP address as a web server always sees
   it.

6. **Trust on first use.** The first key your browser sees for a contact is
   trusted automatically. If the server substituted a key *before* you ever
   talked to someone, only comparing safety numbers would reveal it.

7. **Changing your password does not rotate your identity key**, and signing
   out elsewhere does not revoke a device that already unlocked your keys.
   There is no password-change or key-rotation flow yet.

8. **An XSS bug could use your keys while the page is open.** Keys are stored
   as non-extractable Web Crypto keys, so a script could not copy them out -
   but it could use them. React escapes all message content and the app sets
   `frame-ancestors 'none'`; a nonce-based script Content Security Policy
   would narrow this further and is not in place yet.

9. **Calls on some networks need a relay (TURN).** Without one configured,
   calls between people behind strict firewalls or symmetric NAT fail. They
   fail visibly, with a message saying so. A relay forwards call media but
   cannot read it.

## How it works

Everything uses the browser's built-in Web Crypto API; there is no third-party
cryptography library. The implementation is `src/lib/e2ee/crypto.ts`, and the
same file runs in Node for the tests.

### Your password never leaves the browser

```text
password ──PBKDF2-SHA256, 600k iterations──► master key
   salt = SHA-256("transmission/v1/kdf-salt|" + username)

master key ──HKDF "auth-verifier"──► auth secret   → sent to the server,
                                                     scrypt-hashed like a password
master key ──HKDF "key-wrapping"───► vault key     → never leaves the browser
```

The two outputs use different HKDF labels, so knowing the auth secret gives no
way to compute the vault key. The salt is derived from the username and the
iteration count is a constant in the code, so there are no parameters for a
malicious server to weaken.

### Identity and vault

Each account has one ECDH P-256 key pair. The public half is published. The
private half lives only inside the **vault**: an AES-GCM blob sealed with the
vault key and stored on the server, so signing in on a new browser needs only
your password. The vault also holds the keys you have seen for your contacts
and which ones you have verified, so a second device inherits those decisions
rather than blindly trusting whatever key the server sends.

In the browser, keys are kept in IndexedDB as **non-extractable** CryptoKeys:
usable by the page, never readable as bytes. Signing out deletes them.

### Conversation keys

```text
shared = ECDH(my private key, their public key)            same on both sides
epoch  = SHA-256(both user ids and both public keys)[0:4]  computed by each side
message key = HKDF(shared, "dm-message-key|" + room + "|" + epoch)
signal key  = HKDF(shared, "dm-signal-key|"  + room + "|" + epoch)
```

The epoch is computed independently by both browsers, never supplied by the
server, so the server cannot push the two sides onto different keys.

### Each message

```text
plaintext = { time, sequence, hash of sender's previous ciphertext, text, padding }
IV        = 4-byte per-sender tag ‖ 8 random bytes     (senders cannot collide)
AAD       = "msg|" + room + "|" + sender + "|" + epoch + "|" + client nonce
stored    = AES-GCM-256(plaintext) → base64url, plus IV and epoch columns
```

The authenticated data is what binds a ciphertext to its room, sender and id.
The padding rounds every message up to a 256-byte bucket.

### Calls

Media flows browser-to-browser over WebRTC and is encrypted with DTLS-SRTP by
the browser itself; it never passes through this server (or passes through a
TURN relay, if configured, still encrypted). The server relays only signalling,
and each signal is sealed with the conversation's signal key before it is sent.
Signalling is deleted the moment a call ends.

## Verifying a contact

Open a private conversation and select **End-to-end encrypted · verify**. Both
of you see a 60-digit safety number, computed in your own browsers from the two
keys actually in use - never supplied by the server. If the numbers match on
both screens, nobody is intercepting the conversation. Mark it verified; that
is remembered on every device you sign in to, and you will be warned if the key
ever changes.

## How it was tested

- **`npm run test:crypto`** - 24 tests against the real primitives. Most try to
  break them: moved, re-attributed and replayed ciphertext, a flipped byte, a
  third party's keys, a call signal served as a message, IV reuse, and that the
  auth secret the server receives cannot open the vault.
- **`npm run verify`** - 83 end-to-end checks over the HTTP API, including that
  the server stores only ciphertext, that the recipient decrypts it, that
  plaintext is refused once a conversation is encrypted, and that call
  signalling reaches the server sealed.
- **`npm run test:calls`** - two real Chrome browsers with fake cameras place a
  video call through the UI; with `DATABASE_URL` set it also proves every
  stored signal was unreadable to the server.
- **By hand** - the database was inspected directly after sending a message
  (the text appeared nowhere in it), and a contact's public key was swapped in
  the database to confirm the key-change warning appears, messaging is
  blocked and calls are disabled.
