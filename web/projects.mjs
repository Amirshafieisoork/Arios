const photo = name => `/assets/photos/arios-${name}.webp`;
const photos = new Set(['hero', 'network', 'smart-home', 'event', 'media'].map(photo));
const statusNames = {active: 'در حال اجرا', attention: 'در حال پیگیری', completed: 'تکمیل‌شده', planned: 'در برنامه', paused: 'متوقف‌شده'};
const cleanText = (value, max = 6000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';

export function projectImage(project) {
  const supplied = cleanText(project.image || project.cover, 200);
  if (photos.has(supplied)) return supplied;
  const type = cleanText(project.type, 100).toLowerCase();
  if (/event|رویداد|همایش/.test(type)) return photo('event');
  if (/media|محتوا|رسانه/.test(type)) return photo('media');
  if (/electric|smart|برق|هوشمند/.test(type)) return photo('smart-home');
  if (/cctv|network|دوربین|نظارت|شبکه/.test(type)) return photo('network');
  return photo('hero');
}

/** The public API supplies an explicit allowlist. Ignore unrelated response fields. */
export function normalizePublicProjects(value) {
  if (!Array.isArray(value)) throw new Error('فهرست پروژه‌ها قابل دریافت نیست؛ دوباره تلاش کنید.');
  const seen = new Set();
  return value.slice(0, 100).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const id = cleanText(item.id, 120), title = cleanText(item.title || item.publicTitle, 160);
    if (!id || !title || seen.has(id)) return [];
    seen.add(id);
    const project = {id, title, summary: cleanText(item.summary || item.publicSummary), type: cleanText(item.type, 100), status: cleanText(item.status, 80)};
    project.image = projectImage(item);
    if (typeof item.progress === 'number' && Number.isFinite(item.progress)) project.progress = Math.max(0, Math.min(100, item.progress));
    return [project];
  });
}

export async function requestPublicProjects({fetcher = fetch, signal} = {}) {
  const response = await fetcher('/api/public-projects', {method: 'GET', credentials: 'omit', cache: 'no-store', signal});
  let data;
  try { data = await response.json(); }
  catch { throw new Error('پروژه‌ها دریافت نشدند؛ چند لحظه بعد دوباره تلاش کنید.'); }
  if (!response.ok) throw new Error('دریافت پروژه‌ها فعلاً ممکن نیست؛ دوباره تلاش کنید.');
  return normalizePublicProjects(data?.projects);
}

export function initPublicProjects({chat} = {}) {
  const section = document.querySelector('#projects');
  if (!section) return;
  const grid = section.querySelector('[data-public-projects]');
  const filters = section.querySelector('[data-project-filters]');
  const loading = section.querySelector('[data-project-loading]');
  const error = section.querySelector('[data-project-error]');
  const errorText = section.querySelector('[data-project-error-text]');
  const retry = section.querySelector('[data-project-retry]');
  const empty = section.querySelector('[data-project-empty]');
  let projects = [], selectedType = '', busy = false, loaded = false, lastTrigger = null;
  const dialog = document.createElement('dialog');
  dialog.id = 'public-project-dialog';
  dialog.className = 'service-dialog public-project-dialog';
  dialog.setAttribute('aria-labelledby', 'public-project-title');
  dialog.innerHTML = '<button class="dialog-close service-close" type="button" data-project-close aria-label="بستن جزئیات پروژه">×</button><div class="service-dialog-image"><img data-project-image src="/assets/photos/arios-hero.webp" alt="" width="1586" height="992"><span>ARIOS / PROJECT</span></div><div class="service-dialog-content"><p class="eyebrow" data-project-type></p><h2 id="public-project-title"></h2><div class="project-public-meta" data-project-meta></div><p class="service-introduction public-project-summary" data-project-summary></p><div class="project-detail-progress" data-project-progress></div><p class="project-detail-note">اطلاعات این صفحه برای معرفی عمومی پروژه منتشر شده‌اند؛ جزئیات اجرایی و مالی فقط در پنل اختصاصی در دسترس افراد مجاز است</p><div class="project-detail-actions"><button class="button button-primary" type="button" data-project-consult>دربارهٔ پروژه‌تان صحبت کنیم <span aria-hidden="true">←</span></button><a class="button button-quiet" href="/login/client">ورود مشتریان</a></div><p class="visual-disclosure">تصویر مفهومی حوزهٔ فعالیت</p></div>';
  document.body.append(dialog);
  let currentProject;

  function close(resetHash = true) {
    if (dialog.open) dialog.close();
    if (resetHash && location.hash.startsWith('#project/')) history.replaceState(null, '', '#projects');
    if (lastTrigger?.isConnected) lastTrigger.focus();
  }
  function show(project) {
    currentProject = project;
    const image = dialog.querySelector('[data-project-image]');
    image.src = project.image;
    image.alt = 'تصویر مفهومی حوزهٔ ' + (project.type || 'اجرای پروژه');
    dialog.querySelector('[data-project-type]').textContent = project.type || 'پروژهٔ آریوس';
    dialog.querySelector('#public-project-title').textContent = project.title;
    dialog.querySelector('[data-project-summary]').textContent = project.summary || 'برای آشنایی با مسیر اجرای پروژه‌های مشابه، با آریوس گفتگو کنید.';
    dialog.querySelector('[data-project-meta]').textContent = statusNames[project.status] || '';
    const progress = dialog.querySelector('[data-project-progress]');
    progress.replaceChildren();
    if (project.progress !== undefined) {
      const label = document.createElement('p');
      label.textContent = 'پیشرفت ثبت‌شده: ' + project.progress.toLocaleString('fa-IR') + ' درصد';
      const meter = document.createElement('progress');
      meter.value = project.progress; meter.max = 100; meter.setAttribute('aria-label', 'پیشرفت پروژه');
      progress.append(label, meter);
    }
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }
  function followHash() {
    const match = location.hash.match(/^#project\/(.+)$/);
    if (!match) { if (dialog.open) close(false); return; }
    if (!loaded) return;
    let id;
    try { id = decodeURIComponent(match[1]); } catch { return; }
    const project = projects.find(item => item.id === id);
    if (project) show(project);
    else {
      close(false);
      errorText.textContent = 'پروژهٔ موردنظر برای نمایش عمومی در دسترس نیست؛ پروژه‌های منتشرشده را از همین بخش ببینید.';
      error.hidden = false;
      section.scrollIntoView({block: 'start'});
    }
  }
  function render() {
    grid.replaceChildren();
    filters.replaceChildren();
    filters.hidden = projects.length < 2;
    const types = [...new Set(projects.map(project => project.type).filter(Boolean))];
    for (const type of ['', ...types]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = type || 'همهٔ پروژه‌ها';
      button.setAttribute('aria-pressed', String(selectedType === type));
      button.addEventListener('click', () => { selectedType = type; render(); });
      filters.append(button);
    }
    for (const project of projects.filter(item => !selectedType || item.type === selectedType)) {
      const card = document.createElement('article'); card.className = 'public-project-card';
      const link = document.createElement('a'); link.className = 'public-project-link';
      link.href = '#project/' + encodeURIComponent(project.id);
      link.setAttribute('aria-label', 'مشاهدهٔ جزئیات ' + project.title);
      const image = document.createElement('img');
      image.src = project.image; image.alt = 'تصویر مفهومی حوزهٔ ' + (project.type || 'اجرای پروژه'); image.width = 1586; image.height = 992; image.loading = 'lazy';
      const arrow = document.createElement('span'); arrow.className = 'image-arrow'; arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
      link.append(image, arrow);
      link.addEventListener('click', event => {
        event.preventDefault(); lastTrigger = link;
        history.pushState({project: project.id}, '', link.getAttribute('href'));
        show(project);
      });
      const body = document.createElement('div'); body.className = 'public-project-copy';
      const type = document.createElement('p'); type.className = 'public-project-type'; type.textContent = project.type || 'پروژهٔ آریوس';
      const title = document.createElement('h3');
      const titleLink = document.createElement('a'); titleLink.href = link.href; titleLink.textContent = project.title;
      titleLink.addEventListener('click', event => { event.preventDefault(); lastTrigger = titleLink; history.pushState({project: project.id}, '', link.getAttribute('href')); show(project); });
      title.append(titleLink);
      const description = document.createElement('p'); description.textContent = project.summary || 'برای آشنایی بیشتر، جزئیات این پروژه را ببینید.';
      const state = document.createElement('span'); state.className = 'public-project-state'; state.textContent = statusNames[project.status] || 'پروژهٔ منتشرشده';
      body.append(type, title, description, state); card.append(link, body); grid.append(card);
    }
    empty.hidden = projects.length > 0 || busy || !loaded;
  }
  async function load() {
    if (busy) return;
    busy = true; loading.hidden = false; error.hidden = true; empty.hidden = true; retry.disabled = true;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      projects = await requestPublicProjects({signal: controller.signal});
      loaded = true; selectedType = ''; render(); followHash();
    } catch {
      loaded = false; projects = []; grid.replaceChildren(); filters.hidden = true;
      errorText.textContent = 'دریافت پروژه‌ها فعلاً ممکن نیست؛ اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.';
      error.hidden = false;
    } finally {
      clearTimeout(timer); busy = false; loading.hidden = true; retry.disabled = false;
      empty.hidden = projects.length > 0 || !loaded;
    }
  }
  retry.addEventListener('click', () => void load());
  dialog.querySelector('[data-project-close]').addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
  });
  dialog.querySelector('[data-project-consult]').addEventListener('click', () => {
    const title = currentProject?.title || '';
    close(); chat?.open(title ? `برای پروژه‌ای مشابه «${title}» راهنمایی می‌خواهم` : 'برای شروع یک پروژه راهنمایی می‌خواهم');
  });
  window.addEventListener('hashchange', followHash);
  window.addEventListener('popstate', followHash);
  void load();
  return {reload: load};
}
