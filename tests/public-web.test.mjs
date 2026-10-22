import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePublicProjects, projectImage, requestPublicProjects} from '../web/projects.mjs';
import {requestPublicAnswer} from '../web/chat.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

test('public project rendering consumes only the explicit public response fields', () => {
  const projects = normalizePublicProjects([{id: 'p1', title: 'اجرای فضای اداری', summary: 'معرفی انتخاب‌شده برای انتشار', type: 'CCTV', status: 'active', progress: 43, customerId: 'private-customer', location: 'private-address', contractAmount: 9000000, reports: ['private-report']}, {id: 'p1', title: 'duplicate'}, {id: 'private', name: 'private domain title'}, null]);
  assert.equal(projects.length, 1);
  assert.deepEqual(Object.keys(projects[0]).sort(), ['id', 'image', 'progress', 'status', 'summary', 'title', 'type']);
  assert.equal(projects[0].image, '/assets/photos/arios-network.webp');
  assert(!JSON.stringify(projects).includes('private-'));
});

test('public project covers reject remote URLs and retain the activity-specific local photo', () => {
  assert.equal(projectImage({type: 'رویداد', image: 'javascript:alert(1)'}), '/assets/photos/arios-event.webp');
  assert.equal(projectImage({type: 'electric', image: 'https://tracking.example/pixel'}), '/assets/photos/arios-smart-home.webp');
  assert.equal(projectImage({type: 'media', cover: '/assets/photos/arios-media.webp'}), '/assets/photos/arios-media.webp');
  assert.equal(projectImage({type: 'unknown'}), '/assets/photos/arios-hero.webp');
});

test('the public gallery omits credentials and supports a genuine empty published list', async () => {
  const projects = await requestPublicProjects({fetcher: async (url, options) => {
    assert.equal(url, '/api/public-projects');
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert(!options.headers);
    return json({projects: []});
  }});
  assert.deepEqual(projects, []);
  await assert.rejects(requestPublicProjects({fetcher: async () => json({error: 'private-raw-failure'}, 503)}), error => !error.message.includes('private-raw-failure'));
  await assert.rejects(requestPublicProjects({fetcher: async () => json({projects: null})}), /فهرست پروژه/);
});

test('public chat sends a bounded conversation payload without workspace credentials', async () => {
  const history = [{role: 'user', content: 'سؤال قبلی'}];
  const result = await requestPublicAnswer('برای شبکه راهنمایی می‌خواهم', history, {fetcher: async (url, options) => {
    assert.equal(url, '/api/public-assistant');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(JSON.parse(options.body), {message: 'برای شبکه راهنمایی می‌خواهم', history});
    const headers = new Headers(options.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert(!headers.has('Authorization'));
    assert(!headers.has('Cookie'));
    return json({answer: 'کاربری فضا و نقاط موردنظر را مشخص کنید', live: true, mode: 'ai'});
  }});
  assert.equal(result.live, true);
});

test('public chat accepts an explicitly labeled service guide and rejects a fabricated AI success', async () => {
  const fallback = await requestPublicAnswer('هزینه چگونه مشخص می‌شود؟', [], {fetcher: async () => json({answer: 'برآورد پس از بررسی محدودهٔ کار مشخص می‌شود', live: false, mode: 'guide', notice: 'پاسخ از راهنمای خدمات'})});
  assert.equal(fallback.mode, 'guide');
  assert.equal(fallback.live, false);
  await assert.rejects(requestPublicAnswer('سؤال', [], {fetcher: async () => json({answer: 'Unverified answer', live: false})}), /پاسخ کامل/);
  await assert.rejects(requestPublicAnswer('سؤال', [], {fetcher: async () => json({answer: '', live: true})}), /پاسخ کامل/);
  await assert.rejects(requestPublicAnswer('سؤال', [], {fetcher: async () => json({error: 'کمی بعد تلاش کنید'}, 429)}), /کمی بعد/);
});
