'use strict';
/**
 * Ending one session at a time — Settings → Active sessions.
 *
 * A session id IS the credential that keeps a browser signed in, so the
 * listing must never hand one out: each session is named by a short hash of
 * its id, and the id is looked back up from that hash when a session is to be
 * ended. Both halves are pinned here, because getting either wrong is quiet —
 * a leaked id looks like an ordinary identifier, and an over-permissive kill
 * endpoint looks like a working feature until someone uses it on an account
 * that is not theirs.
 *
 * The database is never written to: `db.get` is stood in for, so running this
 * against a real panel cannot leave a test user behind. Each test is given its
 * own accounts, because the session store is shared for the whole file and
 * counts would otherwise depend on what ran before.
 *
 * Run with: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const session = require('express-session');

const db = require('../lib/db');
const settings = require('../lib/settings');

/* Fresh accounts per test, so one test's browsers are never counted by
 * another's assertions. */
const users = {};
let seq = 0;
function account(role = 'user') {
  const id = `u${++seq}`;
  users[id] = { id, username: `${role === 'admin' ? 'admin' : 'user'}${id.slice(1)}`, role };
  return id;
}

let realGet;
let srv;
let base;

function app() {
  const a = express();
  a.use(express.json());
  a.use(session({ name: 't', secret: 'test-secret', resave: false, saveUninitialized: false }));
  /* Stand in for the login: requireAuth only looks at req.session.userId. */
  a.use((req, _res, next) => {
    if (req.query.as) {
      req.session.userId = req.query.as;
      req.session.createdAt = Date.now() - 60_000;
    }
    next();
  });
  a.use('/settings', settings.router);
  a.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return a;
}

/* Sign a browser in and return the cookie that identifies it. */
async function signIn(userId) {
  const r = await fetch(`${base}/settings?as=${userId}`, { redirect: 'manual' });
  return r.headers.get('set-cookie') || '';
}

async function call(cookie, m, p, body) {
  const r = await fetch(base + p, {
    method: m,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined
  });
  return { s: r.status, b: await r.json().catch(() => ({})) };
}

const sessionsOf = async (cookie, user) =>
  ((await call(cookie, 'GET', '/settings/sessions')).b.sessions || []).filter((x) => x.user === user);

before(async () => {
  realGet = db.get;
  db.get = (table, id) => (table === 'users' ? users[id] || null : realGet(table, id));
  await new Promise((r) => { srv = app().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  db.get = realGet;
  if (srv) srv.close();
});

test('a user sees their own sessions, and never a session id', async () => {
  const me = account();
  const stranger = account();
  const aliceA = await signIn(me);
  await signIn(me);                       /* a second browser of theirs */
  await signIn(stranger);                 /* somebody else entirely */

  const { s, b } = await call(aliceA, 'GET', '/settings/sessions');
  assert.equal(s, 200);
  const mine = (b.sessions || []).filter((x) => x.user === users[me].username);
  assert.equal(mine.length, 2, 'only the two that are theirs');
  assert.equal((b.sessions || []).length, 2, 'and nobody else\'s');

  for (const x of mine) {
    assert.match(x.token, /^[0-9a-f]{16}$/, 'named by a hash, not an id');
    assert.equal(x.sid, undefined, 'no raw session id is handed out');
    assert.equal(x.role, 'user');
  }
  assert.equal(mine.filter((x) => x.current).length, 1, 'the one in use is marked');
});

test('a session in use cannot be ended from its own row', async () => {
  const me = account();
  const aliceA = await signIn(me);
  const mine = await sessionsOf(aliceA, users[me].username);
  const r = await call(aliceA, 'POST', '/settings/sessions/kill', { token: mine[0].token });
  assert.equal(r.s, 400);
  assert.match(r.b.error, /session you are using/);
});

test('a token that is not a token is refused before anything is looked up', async () => {
  const me = account();
  const aliceA = await signIn(me);
  for (const token of ['', 'not-a-token', '../../etc/passwd', 'ABCDEF0123456789', 'a'.repeat(15)]) {
    const r = await call(aliceA, 'POST', '/settings/sessions/kill', { token });
    assert.equal(r.s, 400, `refused ${JSON.stringify(token)}`);
  }
});

test('one user cannot end another account\'s session', async () => {
  const me = account();
  const other = account();
  const mine = await signIn(me);
  const theirs = await signIn(other);

  const theirList = await sessionsOf(theirs, users[other].username);
  assert.equal(theirList.length, 1);

  const r = await call(mine, 'POST', '/settings/sessions/kill', { token: theirList[0].token });
  assert.equal(r.s, 403, 'the id may be known, the permission is not');
  assert.match(r.b.error, /another user/);

  const still = await sessionsOf(theirs, users[other].username);
  assert.equal(still.length, 1, 'and they are still signed in');
});

test('a user ends one of their own sessions, and it stays ended', async () => {
  const me = account();
  const name = users[me].username;
  const mine = await signIn(me);
  await signIn(me);
  const before = await sessionsOf(mine, name);
  assert.equal(before.length, 2);
  const other = before.find((x) => !x.current);
  assert.ok(other, 'there is another to end');

  const kill = await call(mine, 'POST', '/settings/sessions/kill', { token: other.token });
  assert.equal(kill.s, 200);
  assert.equal(kill.b.killed, 1);
  assert.equal(kill.b.user, name, 'the row says whose it was');

  const left = await sessionsOf(mine, name);
  assert.equal(left.length, 1);
  assert.ok(left[0].current, 'only the one in use remains');

  /* Ending it again is not an error the operator has to decode. */
  const twice = await call(mine, 'POST', '/settings/sessions/kill', { token: other.token });
  assert.equal(twice.s, 404);
  assert.match(twice.b.error, /already gone/);
});

test('an administrator can end anyone\'s session', async () => {
  const me = account();
  const other = account();
  const admin = account('admin');
  const mine = await signIn(me);
  await signIn(me);
  const theirs = await signIn(other);
  const rootS = await signIn(admin);

  const all = await call(rootS, 'GET', '/settings/sessions');
  const visible = (all.b.sessions || []);
  assert.ok(visible.some((x) => x.user === users[me].username),
    'an administrator sees the other accounts\' logins, which is how a stolen one is found');
  assert.ok(visible.some((x) => x.user === users[admin].username), 'and their own');

  const target = visible.find((x) => x.user === users[me].username && !x.current);
  assert.ok(target, 'the administrator can see it');

  const r = await call(rootS, 'POST', '/settings/sessions/kill', { token: target.token });
  assert.equal(r.s, 200);
  assert.equal(r.b.user, users[me].username);

  const after = await sessionsOf(mine, users[me].username);
  assert.equal(after.length, 1, 'their other browser is signed out');
  assert.equal((await sessionsOf(theirs, users[other].username)).length, 1,
    'and an unrelated account is untouched');
});

test('kill-others ends the other browsers and keeps this one', async () => {
  const me = account();
  const other = account();
  const name = users[me].username;
  const mine = await signIn(me);
  await signIn(me);
  await signIn(me);
  const theirs = await signIn(other);         /* not theirs, so not touched */

  const before = await sessionsOf(mine, name);
  assert.equal(before.length, 3);

  const r = await call(mine, 'POST', '/settings/sessions/kill-others');
  assert.equal(r.s, 200);
  assert.equal(r.b.killed, 2);

  const left = await sessionsOf(mine, name);
  assert.equal(left.length, 1);
  assert.ok(left[0].current, 'the one still signed in is this one');
  assert.equal((await sessionsOf(theirs, users[other].username)).length, 1,
    'another account keeps its sessions');
});
