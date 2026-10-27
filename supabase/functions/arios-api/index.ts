import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { applyAction, readDossierSubmission } from './domain.mjs';
import { createRepository } from './repository.mjs';
import { handleVoice, getConfig, capabilities } from './voice-service.mjs';
import { APIError, authenticate, bootstrap, createAccount, activateAccount, transferPrimaryManager, passwordLogin, updateAccount, archiveAccount, restoreAccount, resetAccountPassword, requestPasswordReset, listPasswordResetRequests, manager, rate, safeUser } from './auth.mjs';
import { testAIConnection } from './voice-core.mjs';
import { publicAssistant, publicProjects, workspaceAssistant } from './assistant-service.mjs';
import { workspaceState } from './account-state.mjs';
import { handleReminders } from './reminder-service.mjs';
import { createPublicLead, listLeads, updateLeadStatus } from './lead-service.mjs';
import { handleProjectFiles } from './project-files.mjs';

const fail = (message: string, status = 400, code = 'INVALID_INPUT') => { throw new APIError(message, status, code); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  },
});

async function readBytes(stream: ReadableStream<Uint8Array> | null, max: number) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        fail('درخواست بیش از حد بزرگ است.', 413, 'BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function readJSON(request: Request, max = 65536) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) fail('درخواست باید JSON باشد.', 415, 'UNSUPPORTED_MEDIA');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) fail('درخواست بیش از حد بزرگ است.', 413, 'BODY_TOO_LARGE');
  const bytes = await readBytes(request.body, max);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('JSON معتبر نیست.', 400, 'INVALID_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('درخواست معتبر نیست.');
  return value;
}

function apiPath(request: Request) {
  let path = new URL(request.url).pathname;
  for (const prefix of ['/functions/v1/arios-api', '/arios-api']) {
    if (path === prefix || path.startsWith(prefix + '/')) { path = path.slice(prefix.length) || '/'; break; }
  }
  return path.startsWith('/api/') ? path : '/api' + (path.startsWith('/') ? path : '/' + path);
}

/** Explicit dependency injection keeps auth and domain checks testable without a live service. */
export function createHandler(options: any = {}) {
  const fetcher: typeof fetch = options.fetcher || fetch;
  const readEnv = (name: string) => options.env?.[name] ?? (typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined);
  let client = options.client, repo = options.repo;
  function dependencies() {
    if (!client) {
      const url = readEnv('SUPABASE_URL'), key = readEnv('SUPABASE_SERVICE_ROLE_KEY');
      if (!url || !key) fail('سرویس آریوس هنوز آماده نیست.', 503, 'SERVICE_NOT_CONFIGURED');
      client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    }
    if (!repo) repo = createRepository(client);
    return { client, repo };
  }
  return async function handle(request: Request) {
    try {
      const path = apiPath(request);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS' } });
      if (!['GET', 'POST', 'HEAD'].includes(request.method)) fail('روش درخواست مجاز نیست.', 405, 'METHOD_NOT_ALLOWED');
      const { client, repo } = dependencies();
      if (path === '/api/health' && ['GET', 'HEAD'].includes(request.method)) {
        const state = await repo.loadState();
        const response = json({ ok: true, version: '0.4.0', mode: 'supabase', initialized: Boolean(state) });
        return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }
      if (path === '/api/bootstrap' && request.method === 'POST') return json(await bootstrap(client, repo, await readJSON(request)), 201);
      if (path === '/api/public-projects' && request.method === 'GET') return json(await publicProjects({ repo }));
      if (path === '/api/public-leads' && request.method === 'POST') {
        const result = await createPublicLead({ repo, payload: await readJSON(request, 8192) });
        const { created, ...body } = result;
        return json(body, created ? 201 : 200);
      }
      if (path === '/api/public-assistant' && request.method === 'POST') return json(await publicAssistant({ repo, payload: await readJSON(request, 24576), config: await getConfig(repo), fetcher }));
      if (path === '/api/password-login' && request.method === 'POST') return json(await passwordLogin({
        client, repo, payload: await readJSON(request, 4096), authUrl: readEnv('SUPABASE_URL'),
        authKey: readEnv('SUPABASE_SERVICE_ROLE_KEY'), fetcher,
      }));
      if (path === '/api/password-reset/request' && request.method === 'POST') return json(await requestPasswordReset(repo, await readJSON(request, 4096)));
      if (path === '/api/internal/telegram-tick') {
        return await handleReminders({ repo, request, path, fetcher, readJSON, json, env: options.env || {} });
      }
      const { user, state } = await authenticate(request, client, repo);
      await rate(repo, `request:${user.id}`, 120);
      const reminders = await handleReminders({ repo, user, request, path, fetcher, readJSON, json, env: options.env || {} });
      if (reminders) return reminders;
      const projectFiles = await handleProjectFiles({ repo, supabase: client, user, request, path, readJSON, json });
      if (projectFiles) return projectFiles;
      if (path === '/api/leads' && request.method === 'GET') return json(await listLeads({ repo, user }));
      const leadStatus = path.match(/^\/api\/leads\/([^/]+)\/status$/);
      if (leadStatus && request.method === 'POST') return json(await updateLeadStatus({ repo, user, id: leadStatus[1], payload: await readJSON(request, 1024) }));
      if (path === '/api/password-reset/requests' && request.method === 'GET') return json(await listPasswordResetRequests(repo, user));
      if (path === '/api/session' && request.method === 'GET') {
        const config = await getConfig(repo);
        return json({ user: safeUser(user), demo: false, authMode: 'supabase', capabilities: { ...capabilities(config), hosted: true, supabaseAuth: true } });
      }
      if (path === '/api/state' && request.method === 'GET') return json(await workspaceState(repo, state, user.id));
      if (path === '/api/project-dossiers/read' && request.method === 'POST') {
        const payload = await readJSON(request,4096);
        return json({dossierSubmission:readDossierSubmission(state,user.id,payload.projectId,payload.id)});
      }
      if (path === '/api/actions' && request.method === 'POST') {
        const payload = await readJSON(request);
        if (typeof payload.action !== 'string' || !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) fail('عملیات معتبر نیست.');
        const result = payload.action === 'account.primary-manager.transfer'
          ? await transferPrimaryManager(client,repo,user,payload.payload)
          : payload.action === 'account.create'
          ? await createAccount(client, repo, user, payload.payload)
          : payload.action === 'account.update'
            ? await updateAccount(client, repo, user, payload.payload)
          : payload.action === 'account.activate'
            ? await activateAccount(client, repo, user, payload.payload)
          : payload.action === 'account.archive'
            ? await archiveAccount(client, repo, user, payload.payload)
          : payload.action === 'account.restore'
            ? await restoreAccount(client, repo, user, payload.payload)
          : payload.action === 'account.password.reset'
            ? await resetAccountPassword(client, repo, user, payload.payload)
          : await repo.mutateState((current: any) => applyAction(current, user.id, payload.action, payload.payload));
        return json({ result: result.result, state: await workspaceState(repo, result.state, user.id) });
      }
      if (path === '/api/assistant' && request.method === 'POST') return json(await workspaceAssistant({ repo, user, payload: await readJSON(request), config: await getConfig(repo), fetcher }));
      if (path === '/api/integrations/test' && request.method === 'POST') {
        manager(user);
        await readJSON(request, 4096);
        await rate(repo, `integration-test:${user.id}`, 3);
        return json(await testAIConnection({ config: await getConfig(repo), fetcher }));
      }
      const voice = await handleVoice({ path, request, supabase: client, repo, user, state, fetcher });
      if (voice) return voice;
      fail('مسیر پیدا نشد.', 404, 'NOT_FOUND');
    } catch (error: any) {
      const controlled = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
      return json({ error: controlled ? error.message : 'درخواست انجام نشد؛ دوباره تلاش کنید.', code: controlled ? error.code || 'REQUEST_FAILED' : 'INTERNAL_ERROR' }, controlled ? error.status : 500);
    }
  };
}

if (typeof Deno !== 'undefined') Deno.serve(createHandler());
