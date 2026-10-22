import test from 'node:test';
import assert from 'node:assert/strict';
import { createBff } from '../backend/bff.mjs';

const APP = 'https://arios.example.com';
const SUPABASE = 'https://qategfabulrkvdckzmqp.supabase.co';
const ENV = { ARIOS_SUPABASE_URL: SUPABASE, ARIOS_SUPABASE_PUBLISHABLE_KEY: 'test-publishable' };
const PASSWORD = 'test-password-for-account';
const TOKENS = { access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const memberSession = (role = 'worker') => ({ user: { id: 'member-one', name: 'عضو آریوس', email: 'member@example.com', role }, authMode: 'supabase', demo: false, capabilities: { hosted: true, supabaseAuth: true } });

function fixture({ env = ENV, upstream } = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, SUPABASE, 'The BFF must call only its configured Supabase project.');
    assert(['/auth/v1/token', '/auth/v1/logout'].includes(parsed.pathname) || parsed.pathname.startsWith('/functions/v1/arios-api/'), 'Unexpected upstream route');
    assert.equal(options.redirect, 'manual');
    const headers = new Headers(options.headers);
    assert.equal(headers.get('apikey'), ENV.ARIOS_SUPABASE_PUBLISHABLE_KEY);
    assert.equal(headers.has('Cookie'), false);
    assert.equal(headers.has('Origin'), false);
    const call = { url: String(url), path: parsed.pathname + parsed.search, method: options.method, headers, body: options.body === undefined ? undefined : JSON.parse(options.body) };
    calls.push(call);
    if (!upstream) assert.fail('Anonymous or invalid requests must not call an upstream service.');
    return upstream(call, calls);
  };
  const handle = createBff({ env, fetcher });
  const call = async (path, { method = 'GET', body, cookie, origin, app = APP, extraHeaders = {} } = {}) => {
    const headers = new Headers(extraHeaders);
    if (cookie) headers.set('Cookie', cookie);
    if (method === 'POST') {
      headers.set('Content-Type', 'application/json');
      if (origin !== null) headers.set('Origin', origin ?? app);
    }
    const response = await handle(new Request(app + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, data: await response.json(), cookies: response.headers.getSetCookie(), headers: response.headers };
  };
  return { call, calls };
}

test('anonymous session is a safe Supabase login state and never calls internal services', async () => {
  const f = fixture();
  const session = await f.call('/api/session');
  assert.equal(session.status, 200);
  assert.equal(session.data.user, null);
  assert.equal(session.data.authMode, 'supabase');
  assert.equal(session.data.demo, false);
  assert.equal(session.data.capabilities.supabaseAuth, true);
  assert.equal(session.data.capabilities.ai, false);
  assert.equal('access_token' in session.data, false);
  assert.equal('users' in session.data, false);
  assert.deepEqual(session.cookies, []);
  assert.equal(session.headers.get('Cache-Control'), 'private, no-store');
  for (const path of ['/api/state', '/api/voice', '/api/telegram/sync']) {
    const denied = await f.call(path, path.endsWith('/sync') ? { method: 'POST', body: {} } : {});
    assert.equal(denied.status, 401, path);
    assert.equal(denied.data.code, 'UNAUTHORIZED');
    assert.deepEqual(denied.cookies, []);
  }
  assert.equal(f.calls.length, 0);
});

test('same-origin POST protection rejects missing, foreign and cross-site origins before any side effect', async () => {
  const f = fixture();
  for (const scenario of [
    { origin: null },
    { origin: 'https://foreign.example.com' },
    { origin: APP, extraHeaders: { 'Sec-Fetch-Site': 'cross-site' } },
  ]) {
    for (const path of ['/api/login', '/api/logout', '/api/actions', '/api/bootstrap', '/api/password-reset/request']) {
      const denied = await f.call(path, { method: 'POST', body: { email: 'member@example.com', password: PASSWORD }, cookie: 'arios_access=test-existing-access', ...scenario });
      assert.equal(denied.status, 403, path);
      assert.equal(denied.data.code, 'ORIGIN_DENIED');
      assert.deepEqual(denied.cookies, []);
    }
  }
  assert.equal(f.calls.length, 0);
});

test('password login verifies Edge membership before issuing secure HttpOnly session cookies', async () => {
  const f = fixture({ upstream: call => {
    if (call.path === '/auth/v1/token?grant_type=password') {
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.body, { email: 'member@example.com', password: PASSWORD });
      return json({ ...TOKENS, expires_in: 172800 });
    }
    assert.equal(call.path, '/functions/v1/arios-api/session');
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.get('Authorization'), 'Bearer ' + TOKENS.access_token);
    return json(memberSession('worker'));
  } });
  const login = await f.call('/api/login', { method: 'POST', body: { email: ' member@example.com ', password: PASSWORD, portal: 'team' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, 'worker');
  assert.equal(login.data.portal, 'team');
  assert.deepEqual(f.calls.map(call => call.path), ['/auth/v1/token?grant_type=password', '/functions/v1/arios-api/session']);
  assert.equal(login.cookies.length, 2);
  for (const cookie of login.cookies) {
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert(!cookie.includes('Domain='));
  }
  assert.match(login.cookies.find(cookie => cookie.startsWith('arios_access=')), /Max-Age=86400/);
  assert.match(login.cookies.find(cookie => cookie.startsWith('arios_refresh=')), /Max-Age=2592000/);
  assert(!JSON.stringify(login.data).includes(TOKENS.access_token));
  assert(!JSON.stringify(login.data).includes(TOKENS.refresh_token));
  assert(!JSON.stringify(login.data).includes(PASSWORD));
});

test('unverified workspace membership never creates browser session cookies', async t => {
  for (const scenario of [{ status: 403, data: { error: 'not a member' } }, { status: 200, data: { user: null } }]) {
    await t.test('membership response ' + scenario.status, async () => {
      const f = fixture({ upstream: call => {
        if (call.path === '/auth/v1/token?grant_type=password') return json(TOKENS);
        if (call.path === '/functions/v1/arios-api/session') return json(scenario.data, scenario.status);
        assert.equal(call.path, '/auth/v1/logout');
        assert.equal(call.headers.get('Authorization'), 'Bearer ' + TOKENS.access_token);
        return new Response(null, { status: 204 });
      } });
      const login = await f.call('/api/login', { method: 'POST', body: { email: 'member@example.com', password: PASSWORD, portal: 'team' } });
      assert.equal(login.status, 403);
      assert.equal(login.data.code, 'NOT_A_MEMBER');
      assert.deepEqual(login.cookies, []);
      assert(!JSON.stringify(login.data).includes(TOKENS.access_token));
      assert(f.calls.some(call => call.path === '/auth/v1/logout'));
    });
  }
});

test('verified account role chooses its portal even when the other login page was used', async t => {
  for (const scenario of [
    { role: 'manager', portal: 'team', status: 200 },
    { role: 'worker', portal: 'team', status: 200 },
    { role: 'warehouse', portal: 'team', status: 200 },
    { role: 'accountant', portal: 'team', status: 200 },
    { role: 'customer', portal: 'client', status: 200 },
    { role: 'customer', portal: 'team', status: 200 },
    { role: 'worker', portal: 'client', status: 200 },
    { role: 'manager', portal: 'client', status: 200 },
  ]) {
    await t.test(scenario.role + ' -> ' + scenario.portal, async () => {
      const f = fixture({ upstream: call => {
        if (call.path === '/auth/v1/token?grant_type=password') return json(TOKENS);
        assert.equal(call.path, '/functions/v1/arios-api/session');
        return json(memberSession(scenario.role));
      } });
      const login = await f.call('/api/login', { method: 'POST', body: { email: 'member@example.com', password: PASSWORD, portal: scenario.portal } });
      assert.equal(login.status, scenario.status);
      if (scenario.status === 403) {
        assert.equal(login.data.code, 'WRONG_PORTAL');
        assert.deepEqual(login.cookies, []);
      } else {
        assert.equal(login.data.portal, scenario.role === 'customer' ? 'client' : 'team');
        assert.equal(login.data.user.role, scenario.role, 'The selected page cannot change authorization.');
        assert.equal(login.cookies.length, 2);
      }
    });
  }
});

test('Supabase password failure is sanitized and never reaches Edge membership or cookie creation', async () => {
  const f = fixture({ upstream: call => {
    assert.equal(call.path, '/auth/v1/token?grant_type=password');
    return json({ error_description: 'raw upstream detail with ' + PASSWORD }, 400);
  } });
  const denied = await f.call('/api/login', { method: 'POST', body: { email: 'member@example.com', password: PASSWORD } });
  assert.equal(denied.status, 401);
  assert.equal(denied.data.code, 'INVALID_CREDENTIALS');
  assert.deepEqual(denied.cookies, []);
  assert(!JSON.stringify(denied.data).includes(PASSWORD));
  assert.equal(f.calls.length, 1);
});

test('expired access token refreshes once, verifies the retried request and renews both cookies', async () => {
  const state = { user: { id: 'member-one', role: 'worker' }, projects: [{ id: 'project-one' }] };
  const f = fixture({ upstream: call => {
    if (call.path === '/auth/v1/token?grant_type=refresh_token') {
      assert.deepEqual(call.body, { refresh_token: 'test-old-refresh' });
      return json({ access_token: 'test-renewed-access', refresh_token: 'test-renewed-refresh', expires_in: 1800 });
    }
    assert.equal(call.path, '/functions/v1/arios-api/state');
    assert.equal(call.method, 'GET');
    if (call.headers.get('Authorization') === 'Bearer test-old-access') return json({ error: 'expired' }, 401);
    assert.equal(call.headers.get('Authorization'), 'Bearer test-renewed-access');
    return json(state);
  } });
  const refreshed = await f.call('/api/state', { cookie: 'arios_access=test-old-access; arios_refresh=test-old-refresh' });
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshed.data, state);
  assert.deepEqual(f.calls.map(call => call.path), ['/functions/v1/arios-api/state', '/auth/v1/token?grant_type=refresh_token', '/functions/v1/arios-api/state']);
  assert.equal(refreshed.cookies.length, 2);
  assert.match(refreshed.cookies[0], /^arios_access=test-renewed-access; Max-Age=1800/);
  assert.match(refreshed.cookies[1], /^arios_refresh=test-renewed-refresh;/);
  assert(refreshed.cookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Lax')));
  assert(!JSON.stringify(refreshed.data).includes('test-renewed-refresh'));
});

test('failed refresh clears stale sessions and returns a safe anonymous session or unauthorized response', async t => {
  for (const path of ['/api/session', '/api/state']) {
    await t.test(path, async () => {
      const f = fixture({ upstream: call => {
        if (call.path === '/auth/v1/token?grant_type=refresh_token') return json({ error: 'refresh revoked: test-old-refresh' }, 400);
        assert.equal(call.headers.get('Authorization'), 'Bearer test-old-access');
        return json({ error: 'expired' }, 401);
      } });
      const result = await f.call(path, { cookie: 'arios_access=test-old-access; arios_refresh=test-old-refresh' });
      assert.equal(result.status, path === '/api/session' ? 200 : 401);
      if (path === '/api/session') assert.equal(result.data.user, null);
      else assert.equal(result.data.code, 'UNAUTHORIZED');
      assert.equal(result.cookies.length, 2);
      assert(result.cookies.every(cookie => cookie.includes('Max-Age=0') && cookie.includes('HttpOnly')));
      assert(!JSON.stringify(result.data).includes('test-old-refresh'));
    });
  }
});

test('logout clears both local cookies even when remote revocation is unavailable', async () => {
  const f = fixture({ upstream: call => {
    assert.equal(call.path, '/auth/v1/logout');
    assert.equal(call.headers.get('Authorization'), 'Bearer test-existing-access');
    throw new Error('upstream network failure with internal details');
  } });
  const loggedOut = await f.call('/api/logout', { method: 'POST', body: {}, cookie: 'arios_access=test-existing-access; arios_refresh=test-existing-refresh' });
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(loggedOut.data, { ok: true });
  assert.equal(loggedOut.cookies.length, 2);
  assert(loggedOut.cookies.every(cookie => /arios_(?:access|refresh)=;/.test(cookie) && cookie.includes('Max-Age=0') && cookie.includes('Secure')));
});

test('local HTTP development cookies stay HttpOnly and SameSite without an unusable Secure attribute', async () => {
  const f = fixture({ upstream: call => call.path === '/auth/v1/token?grant_type=password' ? json(TOKENS) : json(memberSession('manager')) });
  const local = await f.call('/api/login', { method: 'POST', app: 'http://localhost:3000', body: { email: 'member@example.com', password: PASSWORD, portal: 'team' } });
  assert.equal(local.status, 200);
  assert.equal(local.cookies.length, 2);
  assert(local.cookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && !cookie.includes('Secure')));
});

test('public health reports setup and backend failures without tokens or secret configuration', async t => {
  await t.test('missing configuration', async () => {
    const f = fixture({ env: {} });
    const health = await f.call('/api/health');
    assert.equal(health.status, 503);
    assert.equal(health.data.code, 'CONFIG_NOT_READY');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(health.cookies, []);
  });
  await t.test('backend setup not ready', async () => {
    const f = fixture({ upstream: call => {
      assert.equal(call.path, '/functions/v1/arios-api/health');
      assert.equal(call.headers.has('Authorization'), false);
      return json({ ok: false, ready: false, code: 'SETUP_REQUIRED' }, 503);
    } });
    const health = await f.call('/api/health');
    assert.equal(health.status, 503);
    assert.equal(health.data.ready, false);
    assert.equal(health.data.code, 'SETUP_REQUIRED');
    assert.deepEqual(health.cookies, []);
  });
  await t.test('backend connection failure', async () => {
    const f = fixture({ upstream: () => { throw new Error('raw network exception with test-publishable'); } });
    const health = await f.call('/api/health');
    assert.equal(health.status, 502);
    assert.equal(health.data.code, 'BACKEND_UNAVAILABLE');
    assert(!JSON.stringify(health.data).includes('test-publishable'));
    assert(!JSON.stringify(health.data).includes('raw network'));
    assert.deepEqual(health.cookies, []);
  });
});


test('phone login normalizes Persian digits and keeps the Auth identity mapping server-side', async () => {
  const f = fixture({ upstream: call => {
    if(call.path === '/functions/v1/arios-api/password-login') {
      assert.deepEqual(call.body, {phone:'+989123456789',password:PASSWORD});
      assert.equal(call.headers.has('Authorization'),false);
      return json(TOKENS);
    }
    assert.equal(call.path,'/functions/v1/arios-api/session');
    return json({...memberSession('worker'),user:{id:'member-one',name:'همکار',phone:'+989123456789',role:'worker'}});
  }});
  const result=await f.call('/api/login',{method:'POST',body:{identifier:'۰۹۱۲ ۳۴۵ ۶۷۸۹',password:PASSWORD,portal:'client'}});
  assert.equal(result.status,200);assert.equal(result.data.portal,'team');assert.equal(result.data.user.phone,'+989123456789');
  assert.equal(result.cookies.length,2);
  assert(!JSON.stringify(result.data).includes(TOKENS.access_token));
  assert.equal(f.calls.some(call=>call.path.startsWith('/auth/v1/token')),false);
});

test('internal phone aliases and malformed numbers cannot bypass phone identity resolution',async()=>{
  const f=fixture();
  for(const identifier of ['phone.989123456789@phone.arios.invalid','123','+98badphone']) {
    const result=await f.call('/api/login',{method:'POST',body:{identifier,password:PASSWORD}});
    assert.equal(result.status,400);assert.equal(result.cookies.length,0);
  }
  assert.equal(f.calls.length,0);
});

test('published project gallery is an anonymous GET with no workspace cookies forwarded',async()=>{
  const f=fixture({upstream:call=>{
    assert.equal(call.path,'/functions/v1/arios-api/public-projects');assert.equal(call.method,'GET');
    assert.equal(call.headers.has('Authorization'),false);return json({projects:[]});
  }});
  const result=await f.call('/api/public-projects');assert.equal(result.status,200);assert.deepEqual(result.data,{projects:[]});
});

test('public recovery forwards only the normalized identifier without session credentials or Auth tokens', async () => {
  const acknowledgement = { ok: true, message: 'برای بازیابی با مدیر هماهنگ کنید' };
  const f = fixture({ upstream: call => {
    assert.equal(call.path, '/functions/v1/arios-api/password-reset/request');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.has('Authorization'), false);
    assert.deepEqual(call.body, { identifier: '+989123456789' });
    return json(acknowledgement);
  } });
  const result = await f.call('/api/password-reset/request', { method: 'POST', body: { identifier: '۰۹۱۲۳۴۵۶۷۸۹', password: 'must-not-forward' }, cookie: 'arios_access=existing-session; arios_refresh=existing-refresh' });
  assert.equal(result.status, 200); assert.deepEqual(result.data, acknowledgement);
  assert.deepEqual(result.cookies, []);
});
