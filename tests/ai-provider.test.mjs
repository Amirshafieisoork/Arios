import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio, requestAIJSON, testAIConnection, VoiceError, logAIFailure } from '../worker/voice.mjs';

const config = { aiBaseUrl: 'https://api.openai.com/v1', aiApiKey: 'test-only-dedicated-key', aiModel: 'configured-model', transcriptionModel: 'configured-transcriber' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const messages = [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: 'Test request.' }];
const audio = new Uint8Array([79, 103, 103, 83, 0]);

test('an unknown structured error cannot become a billing error by quoting quota instructions', async () => {
  for (const identity of [{ code: 'invalid_request_error' }, { type: 'invalid_request_error' }]) {
    await assert.rejects(requestAIJSON({ config, messages, fetcher: async () => json({ error: { ...identity, message: 'Invalid request. Documentation includes insufficient quota and payment required examples.' } }, 429) }), error => error.code === 'UPSTREAM_RATE_LIMITED' && error.providerCode === undefined);
  }
});

test('provider failures expose actionable fixed codes without credentials or raw upstream details', async t => {
  for (const [status, error, expected] of [
    [401, { message: 'bad key ' + config.aiApiKey }, 'AI_AUTH_FAILED'],
    [403, { message: 'account restricted' }, 'AI_AUTH_FAILED'],
    [403, { code: 'unsupported_country_region_territory', message: config.aiApiKey }, 'AI_REGION_UNSUPPORTED'],
    [429, { code: 'insufficient_quota', message: 'billing details ' + config.aiApiKey }, 'AI_QUOTA_EXCEEDED'],
    [429, { code: 'rate_limit_exceeded' }, 'UPSTREAM_RATE_LIMITED'],
    [402, { message: 'payment required' }, 'AI_QUOTA_EXCEEDED'],
    [404, { code: 'model_not_found' }, 'AI_MODEL_UNAVAILABLE'],
    [400, { message: 'Unable to decode audio file ' + config.aiApiKey }, 'AI_AUDIO_UNSUPPORTED'],
  ]) await t.test(String(status) + '-' + expected, async () => {
    let calls = 0;
    await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async (url, init) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions'); assert.equal(init.redirect, 'manual');
      return json({ error }, status);
    } }), value => {
      assert(value instanceof VoiceError); assert.equal(value.code, expected); assert.equal(value.providerStatus, status);
      assert(!value.message.includes(config.aiApiKey)); assert(!value.message.includes('billing details')); assert(!value.message.includes('Unable to decode'));
      return true;
    });
    assert.equal(calls, 1);
  });
});

test('chat retries only parameters explicitly rejected by the same configured model', async () => {
  const calls = [];
  const value = await requestAIJSON({ config, messages, maxTokens: 500, fetcher: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions'); assert.equal(init.redirect, 'manual');
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(body.model, config.aiModel);
    if (calls.length === 1) return json({ error: { message: "Unsupported parameter: 'max_tokens'; use max_completion_tokens" } }, 400);
    if (calls.length === 2) return json({ error: { message: "Unsupported value: 'temperature' is not supported" } }, 400);
    if (calls.length === 3) return json({ error: { message: "response_format json_object is not supported" } }, 400);
    return json({ choices: [{ message: { content: '```json\n{"answer":"پاسخ معتبر","needsHumanSupport":false}\n```' }, finish_reason: 'stop' }] });
  } });
  assert.equal(value.answer, 'پاسخ معتبر'); assert.equal(calls.length, 4);
  assert.equal(calls[1].max_tokens, undefined); assert.equal(calls[1].max_completion_tokens, 500);
  assert.equal(calls[2].temperature, undefined); assert.equal(calls[3].response_format, undefined);
  assert.deepEqual(calls[3].messages, messages);
});

test('authentication and model failures never retry or switch providers', async () => {
  let calls = 0;
  await assert.rejects(requestAIJSON({ config, messages, fetcher: async url => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/chat/completions'); return json({ error: { message: 'invalid API key' } }, 401);
  } }), error => error.code === 'AI_AUTH_FAILED');
  assert.equal(calls, 1);
});

test('transcription removes only explicitly unsupported optional fields and preserves the original audio', async () => {
  const calls = [];
  const transcript = await transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async (url, init) => {
    calls.push(init.body);
    assert.deepEqual(new Uint8Array(await init.body.get('file').arrayBuffer()), audio);
    if (calls.length === 1) return json({ error: { message: 'Unsupported parameter response_format' } }, 400);
    return json({ text: 'آزمایش تبدیل صوت' });
  } });
  assert.equal(transcript, 'آزمایش تبدیل صوت'); assert.equal(calls.length, 2);
  assert.equal(calls[0].get('response_format'), 'json'); assert.equal(calls[1].get('response_format'), null);
  assert.equal(calls[1].get('language'), 'fa');
});

test('manager connection diagnostic distinguishes chat success from transcription failure without using user audio', async () => {
  const calls = [];
  const result = await testAIConnection({ config, fetcher: async (url, init) => {
    calls.push(url);
    if (url.endsWith('/chat/completions')) return json({ choices: [{ message: { content: '{"ok":true}' } }] });
    const file = init.body.get('file'); assert.equal(file.name, 'arios-connection-test.wav'); assert.equal(file.type, 'audio/wav');
    const data = new Uint8Array(await file.arrayBuffer()); assert.equal(data.length, 32044); assert.equal(new TextDecoder().decode(data.subarray(0, 4)), 'RIFF');
    return json({ error: { code: 'insufficient_quota', message: config.aiApiKey } }, 429);
  } });
  assert.equal(result.ok, false); assert.equal(result.provider, 'OpenAI'); assert.equal(result.chat.ok, true);
  assert.equal(result.transcription.code, 'AI_QUOTA_EXCEEDED'); assert.equal(result.transcription.providerStatus, 429);
  assert(!JSON.stringify(result).includes(config.aiApiKey)); assert.equal(calls.length, 2);
});

test('operational diagnostics log only fixed classifications and never messages, credentials or caller-supplied codes', () => {
  const original = console.warn, logs = [];
  console.warn = value => logs.push(JSON.parse(value));
  try {
    logAIFailure({ code: 'AI_QUOTA_EXCEEDED', providerStatus: 429, message: config.aiApiKey, transcript: 'private user audio' }, 'transcription');
    logAIFailure({ code: 'PRIVATE_API_KEY_SECRET', providerStatus: 999, message: 'raw provider message' }, 'private-caller-stage');
  } finally { console.warn = original; }
  assert.deepEqual(logs, [
    { event: 'arios_ai_failure', stage: 'transcription', code: 'AI_QUOTA_EXCEEDED', providerStatus: 429 },
    { event: 'arios_ai_failure', stage: 'ai', code: 'UPSTREAM_UNAVAILABLE' },
  ]);
});

async function providerError(status, error) {
  let failure;
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => json({ error }, status) }), value => {
    assert(value instanceof VoiceError);
    failure = value;
    return true;
  });
  return failure;
}

test('structured rate-limit codes override incidental billing language and a conflicting quota type', async () => {
  const failure = await providerError(429, {
    code: 'rate_limit_exceeded', type: 'insufficient_quota',
    message: 'Rate limit reached. Review your credit balance. ' + config.aiApiKey,
  });
  assert.equal(failure.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(failure.providerCode, 'rate_limit_exceeded');
  assert.equal(failure.providerStatus, 429);
  assert(!JSON.stringify(failure).includes(config.aiApiKey));
});

test('server failures and incidental billing text are never presented as exhausted account quota', async () => {
  for (const [status, error] of [
    [500, { code: 'server_error', message: 'Service unavailable. Check your credit balance.' }],
    [500, { code: 'insufficient_quota', message: 'Internal service error' }],
    [503, { message: 'Upstream unavailable; contact support about credit balance.' }],
    [400, { code: 'invalid_request_error', message: 'Invalid request containing the words credit balance.' }],
    [429, { message: 'Temporarily busy; see credit balance and usage settings.' }],
  ]) {
    const failure = await providerError(status, error);
    assert.notEqual(failure.code, 'AI_QUOTA_EXCEEDED', 'status ' + status + ' must not imply unavailable quota from incidental words');
    if (status === 429) assert.equal(failure.code, 'UPSTREAM_RATE_LIMITED');
  }
});

test('known billing codes retain their precise safe reason with separate actionable messages', async () => {
  const known = [
    'insufficient_quota', 'credit_balance_exhausted', 'organization_usage_limit_exceeded',
    'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
    'billing_hard_limit_reached', 'billing_not_active',
  ];
  const messages = [];
  for (const providerCode of known) {
    const failure = await providerError(429, { code: providerCode, type: 'insufficient_quota', message: 'Raw billing account details ' + config.aiApiKey });
    assert.equal(failure.code, 'AI_QUOTA_EXCEEDED');
    assert.equal(failure.providerCode, providerCode);
    assert.equal(failure.providerStatus, 429);
    assert.equal(typeof failure.message, 'string');
    assert(failure.message.length > 20);
    assert(!JSON.stringify(failure).includes(config.aiApiKey));
    assert(!failure.message.includes('Raw billing account details'));
    messages.push(failure.message);
    if (providerCode === 'insufficient_quota') {
      assert.match(failure.message, /سهمیه|فعال|پروژه/);
      assert.doesNotMatch(failure.message, /تمام شده|تمام‌شده|مصرف کرده|مصرف شده|مصرف‌شده/);
    }
  }
  assert.equal(new Set(messages).size, known.length, 'specific provider reasons should not collapse into a single credit message');
});

test('billing classification is restricted to billing-capable statuses and uses a known type only as fallback', async () => {
  for (const status of [400, 402, 429]) {
    const failure = await providerError(status, { code: 'unknown_vendor_code', type: 'insufficient_quota', message: config.aiApiKey });
    assert.equal(failure.code, 'AI_QUOTA_EXCEEDED');
    assert.equal(failure.providerCode, 'insufficient_quota');
    assert(!JSON.stringify(failure).includes('unknown_vendor_code'));
  }
  const authentication = await providerError(401, { code: 'insufficient_quota', type: 'insufficient_quota' });
  assert.equal(authentication.code, 'AI_AUTH_FAILED');
  const payment = await providerError(402, { code: 'unknown_vendor_code', message: 'Payment required ' + config.aiApiKey });
  assert.equal(payment.code, 'AI_QUOTA_EXCEEDED');
  assert.equal(payment.providerCode, undefined);
  assert(!JSON.stringify(payment).includes(config.aiApiKey));
});

test('unknown provider code and type values cannot escape through errors, diagnostics or operational logs', async () => {
  const secret = config.aiApiKey + '-private-provider-field';
  const failure = await providerError(429, { code: secret, type: secret, message: secret });
  assert.equal(failure.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(failure.providerCode, undefined);
  assert(!JSON.stringify(failure).includes(secret));
  const diagnostic = await testAIConnection({ config, fetcher: async () => json({ error: { code: secret, type: secret, message: secret } }, 429) });
  for (const stage of [diagnostic.chat, diagnostic.transcription]) {
    assert.equal(stage.providerCode, undefined);
    assert.equal(stage.providerStatus, 429);
  }
  assert(!JSON.stringify(diagnostic).includes(secret));
  const original = console.warn, logs = [];
  console.warn = value => logs.push(JSON.parse(value));
  try {
    logAIFailure({ code: 'AI_QUOTA_EXCEEDED', providerStatus: 429, providerCode: 'project_spend_limit_exceeded', message: secret }, 'chat');
    logAIFailure({ code: 'UPSTREAM_RATE_LIMITED', providerStatus: 429, providerCode: secret, message: secret }, 'transcription');
  } finally { console.warn = original; }
  assert.equal(logs[0].providerCode, 'project_spend_limit_exceeded');
  assert.equal(logs[1].providerCode, undefined);
  assert(!JSON.stringify(logs).includes(secret));
});

test('manager diagnostics expose a safe provider reason independently for chat and transcription', async () => {
  const diagnostic = await testAIConnection({ config, fetcher: async url => json({ error: {
    code: url.endsWith('/chat/completions') ? 'project_spend_limit_exceeded' : 'billing_not_active',
    type: 'insufficient_quota', message: 'Private account details ' + config.aiApiKey,
  } }, 429) });
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.chat.providerCode, 'project_spend_limit_exceeded');
  assert.equal(diagnostic.transcription.providerCode, 'billing_not_active');
  for (const stage of [diagnostic.chat, diagnostic.transcription]) {
    assert.equal(stage.providerStatus, 429);
    assert.equal(stage.code, 'AI_QUOTA_EXCEEDED');
    assert.equal(stage.ok, false);
  }
  assert.notEqual(diagnostic.chat.message, diagnostic.transcription.message);
  assert(!JSON.stringify(diagnostic).includes(config.aiApiKey));
});
