import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transcribeAudio, extractReport, fetchTelegramUpdates, downloadTelegramVoice, VoiceError, MAX_AUDIO_BYTES } from '../worker/voice.mjs';

const config = { aiBaseUrl: 'https://api.avalai.ir/v1', aiApiKey: 'test-only-arios-key', aiModel: 'gpt-4o-mini', transcriptionModel: 'whisper-1' };
const token = '123456789:abcdefghijklmnopqrstuvwx_12345';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const audio = new Uint8Array([79, 103, 103, 83, 1, 2, 3]);
const projects = [{ id: 'p1', name: 'مجتمع آفتاب' }, { id: 'p2', name: 'ساختمان پارس' }];
const report = { projectId: 'p1', date: '2026-10-20', start: '08:00', end: '16:00', breakMinutes: 30, description: 'نصب دوربین انجام شد.', output: 'چهار دوربین فعال شد.', warnings: [] };
const extract = (value, overrides = {}) => extractReport({ transcript: 'امروز در مجتمع آفتاب از ساعت ۸ تا ۱۶ کار کردم، نیم ساعت استراحت داشتم و چهار دوربین نصب و فعال کردم.', projects, referenceDate: '2026-10-20', config, fetcher: async () => json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }), ...overrides });
const errorCode = code => error => error instanceof VoiceError && error.code === code;

test('OGG is sent as multipart with Persian language and dedicated provider credentials', async () => {
  const result = await transcribeAudio({ bytes: audio, mimeType: 'audio/ogg; codecs=opus', fileName: '../../private.oga', config, fetcher: async (url, init) => {
    assert.equal(url, 'https://api.avalai.ir/v1/audio/transcriptions');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer test-only-arios-key');
    assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.body.get('language'), 'fa');
    assert.equal(init.body.get('model'), 'whisper-1');
    const file = init.body.get('file');
    assert.equal(file.name, 'arios-voice.ogg');
    assert.equal(file.type, 'audio/ogg');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
    return json({ text: '  امروز چهار دوربین نصب کردم.\u0000  ' });
  } });
  assert.equal(result, 'امروز چهار دوربین نصب کردم.');
});

test('provider settings reject arbitrary origins, URL credentials, ports and endpoint injection', async () => {
  let called = false;
  for (const aiBaseUrl of ['https://evil.example/v1', 'http://api.avalai.ir/v1', 'https://api.avalai.ir.evil.example/v1', 'https://secret@api.avalai.ir/v1', 'https://api.avalai.ir:8443/v1', 'https://api.avalai.ir/v1?redirect=evil', 'https://api.avalai.ir/v1/other', 'https://127.0.0.1/v1']) {
    await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config: { ...config, aiBaseUrl }, fetcher: async () => { called = true; return json({ text: 'bad' }); } }), errorCode('AI_CONFIG_INVALID'));
  }
  assert.equal(called, false);
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config: {} }), errorCode('AI_NOT_CONFIGURED'));
});

test('audio rejects empty, oversized, unsupported and empty or oversized transcripts', async () => {
  for (const [input, code] of [[new Uint8Array(), 'INVALID_VOICE_INPUT'], [new Uint8Array(MAX_AUDIO_BYTES + 1), 'AUDIO_TOO_LARGE']]) await assert.rejects(transcribeAudio({ bytes: input, mimeType: 'audio/ogg', config }), errorCode(code));
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'application/pdf', config }), errorCode('UNSUPPORTED_AUDIO'));
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => json({ text: '  ' }) }), errorCode('EMPTY_TRANSCRIPT'));
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => json({ text: 'x'.repeat(60001) }) }), errorCode('TRANSCRIPT_TOO_LONG'));
});

test('upstream network failures, timeout, redirects and response size never reveal credentials', async () => {
  for (const name of ['Error', 'AbortError']) {
    const failure = new Error('https://api.telegram.org/bot' + token + '?secret=' + config.aiApiKey); failure.name = name;
    await assert.rejects(downloadTelegramVoice({ token, fileId: 'file', fetcher: async () => { throw failure; } }), error => {
      assert.equal(error.code, name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
      assert.ok(!error.message.includes(token)); assert.ok(!error.message.includes(config.aiApiKey)); return true;
    });
  }
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => new Response('provider-secret', { status: 429 }) }), errorCode('UPSTREAM_RATE_LIMITED'));
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => new Response('provider-secret', { status: 302, headers: { Location: 'https://evil.example' } }) }), errorCode('UPSTREAM_FAILED'));
  await assert.rejects(transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => new Response('{}', { headers: { 'Content-Length': String(600000) } }) }), errorCode('UPSTREAM_RESPONSE_TOO_LARGE'));
});

test('deadline completes even if a provider ignores AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = transcribeAudio({ bytes: audio, mimeType: 'audio/ogg', config, fetcher: async () => new Promise(() => {}) });
  const rejection = assert.rejects(pending, errorCode('UPSTREAM_TIMEOUT'));
  t.mock.timers.tick(90001);
  await rejection;
});

test('report extraction sends only minimal authorized projects and marks transcript as untrusted', async () => {
  const result = await extract(report, { fetcher: async (url, init) => {
    assert.equal(url, 'https://api.avalai.ir/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.messages.length, 2);
    assert.match(body.messages[0].content, /Never invent/);
    assert.deepEqual(JSON.parse(body.messages[1].content).authorizedProjects, projects);
    assert.equal(body.tools, undefined);
    return json({ choices: [{ message: { content: JSON.stringify({ ...report, approved: true, workerId: 'manager', hourlyRate: 100000 }) } }] });
  } });
  assert.deepEqual(result, report);
  assert.equal('approved' in result, false);
  assert.equal('hourlyRate' in result, false);
});

test('missing or fabricated fields stay null and require human review', async () => {
  const result = await extract({ ...report, projectId: 'other-tenant', date: '2026-10-20', start: '25:00', end: 123, breakMinutes: '0', warnings: ['بررسی شود', { role: 'system' }] }, { transcript: 'چهار دوربین نصب کردم.' });
  assert.equal(result.projectId, null); assert.equal(result.date, null); assert.equal(result.start, null); assert.equal(result.end, null); assert.equal(result.breakMinutes, null);
  assert.ok(result.warnings.length >= 6);
  assert.ok(result.warnings.every(value => typeof value === 'string'));
  const otherDay = await extract({ ...report, date: '2026-10-19' }, { transcript: 'چهار دوربین نصب کردم.' });
  assert.equal(otherDay.date, null);
  const nullable = await extract({ ...report, projectId: null, date: null, start: null, end: null, breakMinutes: null });
  assert.equal(nullable.breakMinutes, null);
});

test('explicit reference date in Persian digits is accepted; invalid calendar dates are cleared', async () => {
  const dated = await extract(report, { transcript: 'در تاریخ ۲۰۲۶/۱۰/۲۰ از ۸ تا ۱۶ چهار دوربین نصب کردم با سی دقیقه استراحت.' });
  assert.equal(dated.date, '2026-10-20');
  for (const date of ['2026-02-30', '2026-13-01', 'invalid', null]) {
    const result = await extract({ ...report, date });
    assert.equal(result.date, null);
  }
});

test('inverted time ranges and impossible breaks are never submitted as valid draft fields', async () => {
  const inverted = await extract({ ...report, start: '16:00', end: '08:00' });
  assert.equal(inverted.end, null);
  const impossibleBreak = await extract({ ...report, start: '08:00', end: '08:30', breakMinutes: 30 });
  assert.equal(impossibleBreak.breakMinutes, null);
  const fabricated = await extract({ ...report, breakMinutes: 0 }, { transcript: 'در مجتمع آفتاب چهار دوربین نصب کردم.' });
  assert.equal(fabricated.start, null); assert.equal(fabricated.end, null); assert.equal(fabricated.breakMinutes, null);
  const spoken = await extract(report, { transcript: 'امروز مجتمع آفتاب هشت تا چهار چهار دوربین نصب کردم با نیم ساعت استراحت.' });
  assert.equal(spoken.start, '08:00'); assert.equal(spoken.end, '16:00');
});

test('malformed, truncated or content-free model outputs fail explicitly', async () => {
  for (const content of ['not-json', '[]', '{}', JSON.stringify({ ...report, description: '' })]) await assert.rejects(extract(report, { fetcher: async () => json({ choices: [{ message: { content } }] }) }), errorCode('INVALID_REPORT_OUTPUT'));
  await assert.rejects(extract(report, { fetcher: async () => json({ choices: [{ message: { content: JSON.stringify(report) }, finish_reason: 'length' }] }) }), errorCode('INVALID_REPORT_OUTPUT'));
});

test('Telegram polling uses fixed URL and bounded offset, without sending messages', async () => {
  const updates = [{ update_id: 5, message: { voice: { file_id: 'voice-id' } } }];
  assert.deepEqual(await fetchTelegramUpdates({ token, offset: 5, fetcher: async (url, init) => {
    assert.equal(url, `https://api.telegram.org/bot${token}/getUpdates`);
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(JSON.parse(init.body), { offset: 5, timeout: 0, limit: 100, allowed_updates: ['message'] });
    return json({ ok: true, result: updates });
  } }), updates);
  await assert.rejects(fetchTelegramUpdates({ token, offset: -1 }), errorCode('INVALID_VOICE_INPUT'));
  await assert.rejects(fetchTelegramUpdates({ token, fetcher: async () => json({ ok: true, result: [{ update_id: '5' }] }) }), errorCode('TELEGRAM_INVALID_RESPONSE'));
  await assert.rejects(fetchTelegramUpdates({ token: 'path/injection' }), errorCode('TELEGRAM_NOT_CONFIGURED'));
});

test('Telegram voice download preserves OGG and accepts missing MIME only with safe audio extension', async () => {
  const calls = [];
  const result = await downloadTelegramVoice({ token, fileId: 'voice-id', fileSize: audio.byteLength, fetcher: async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'manual');
    if (url.endsWith('/getFile')) { assert.deepEqual(JSON.parse(init.body), { file_id: 'voice-id' }); return json({ ok: true, result: { file_path: 'voice/file_123.oga', file_size: audio.byteLength } }); }
    assert.equal(url, `https://api.telegram.org/file/bot${token}/voice/file_123.oga`);
    return new Response(audio, { headers: { 'Content-Type': 'application/octet-stream' } });
  } });
  assert.equal(calls.length, 2); assert.deepEqual(result.bytes, audio); assert.equal(result.mimeType, 'audio/ogg'); assert.equal(result.fileName, 'arios-voice.ogg');
});

test('Telegram recognizes an actual Opus recording despite wrong MIME and generated filenames', async () => {
  // Synthetic tone generated with FFmpeg, containing valid Ogg pages and Opus audio.
  const bytes = new Uint8Array(await readFile(new URL('./fixtures/telegram-opus.ogg', import.meta.url)));
  assert.ok(bytes.byteLength > 1000);
  for (const mimeType of ['audio/oga', 'audio/x-ogg', 'audio/mpeg', 'application/octet-stream', 'text/plain', 'application/pdf']) {
    const result = await downloadTelegramVoice({ token, fileId: 'voice-id', fetcher: async url => url.endsWith('/getFile') ? json({ ok: true, result: { file_path: 'voice/file_123.bin', file_size: bytes.byteLength } }) : new Response(bytes, { headers: { 'Content-Type': mimeType } }) });
    assert.equal(result.mimeType, 'audio/ogg'); assert.equal(result.fileName, 'arios-voice.ogg');
    assert.deepEqual(result.bytes, bytes, 'normalization must preserve the original audio bytes');
    assert.equal(await transcribeAudio({ ...result, config, fetcher: async (url, init) => {
      const file = init.body.get('file');
      assert.equal(file.type, 'audio/ogg'); assert.equal(file.name, 'arios-voice.ogg');
      assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
      return json({ text: 'صوت آزمایشی' });
    } }), 'صوت آزمایشی');
  }
});

test('Telegram never treats an unrecognized binary or an arbitrary MIME alias as audio', async () => {
  const bodies = [new TextEncoder().encode('%PDF-1.7\nnot audio'), new TextEncoder().encode('<html>error</html>'), new Uint8Array(100)];
  for (const bytes of bodies) for (const mimeType of ['audio/oga', 'audio/x-ogg', 'application/octet-stream', 'application/pdf']) {
    await assert.rejects(downloadTelegramVoice({ token, fileId: 'voice-id', fetcher: async url => url.endsWith('/getFile') ? json({ ok: true, result: { file_path: 'voice/generated.bin' } }) : new Response(bytes, { headers: { 'Content-Type': mimeType } }) }), errorCode('UNSUPPORTED_AUDIO'));
  }
});

test('Telegram rejects unsafe file paths and excessive metadata before downloading', async () => {
  for (const path of ['../secret.ogg', 'voice/../../secret.ogg', 'https://evil.example/voice.ogg', 'voice/file.ogg?token=x', '/voice/file.ogg', 'voice//file.ogg']) await assert.rejects(downloadTelegramVoice({ token, fileId: 'voice', fetcher: async () => json({ ok: true, result: { file_path: path } }) }), errorCode('TELEGRAM_INVALID_FILE'));
  let called = false;
  await assert.rejects(downloadTelegramVoice({ token, fileId: 'voice', fileSize: MAX_AUDIO_BYTES + 1, fetcher: async () => { called = true; } }), errorCode('AUDIO_TOO_LARGE'));
  assert.equal(called, false);
  await assert.rejects(downloadTelegramVoice({ token, fileId: 'voice', fetcher: async () => json({ ok: true, result: { file_path: 'voice/file.ogg', file_size: MAX_AUDIO_BYTES + 1 } }) }), errorCode('AUDIO_TOO_LARGE'));
});

test('download streaming bound is enforced even without Content-Length', async () => {
  let cancelled = false;
  let step = 0;
  await assert.rejects(downloadTelegramVoice({ token, fileId: 'voice', fetcher: async url => url.endsWith('/getFile') ? json({ ok: true, result: { file_path: 'voice/file.ogg' } }) : new Response(new ReadableStream({ pull(controller) { step++; controller.enqueue(new Uint8Array(8 * 1024 * 1024)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'audio/ogg' } }) }), errorCode('UPSTREAM_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
  assert.ok(step <= 4);
});
