import {initPublicChat} from './chat.mjs';
import {services} from './services.mjs';
import {initPublicProjects} from './projects.mjs';

const toggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('#main-nav');
function closeMenu() {
  toggle?.setAttribute('aria-expanded', 'false');
  toggle?.setAttribute('aria-label', 'باز کردن منو');
  document.querySelector('.site-header')?.classList.remove('menu-open');
}
toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'بستن منو' : 'باز کردن منو');
  document.querySelector('.site-header')?.classList.toggle('menu-open', open);
});
nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && toggle?.getAttribute('aria-expanded') === 'true') { closeMenu(); toggle.focus(); } });
document.addEventListener('click', event => { if (!event.target.closest('.site-header')) closeMenu(); });
window.matchMedia('(min-width: 901px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

const chat = initPublicChat();
initPublicProjects({chat});
const serviceDialog = document.querySelector('#service-dialog');
const serviceBody = serviceDialog.querySelector('[data-service-body]');
let lastServiceTrigger = null;
function makeList(values) {
  const list = document.createElement('ul');
  for (const value of values) { const item = document.createElement('li'); item.textContent = value; list.append(item); }
  return list;
}
function closeService(resetHash = true) {
  if (serviceDialog.open) serviceDialog.close();
  if (resetHash && location.hash.startsWith('#service/')) history.replaceState(null, '', '#services');
  if (lastServiceTrigger?.isConnected) lastServiceTrigger.focus();
}
function showService(slug) {
  const service = Object.hasOwn(services, slug) ? services[slug] : null;
  if (!service) { if (serviceDialog.open) closeService(false); return; }
  serviceDialog.querySelector('[data-service-image]').src = service.image;
  serviceDialog.querySelector('[data-service-image]').alt = service.alt;
  serviceDialog.querySelector('[data-service-kicker]').textContent = service.kicker;
  serviceDialog.querySelector('#service-title').textContent = service.title;
  serviceDialog.querySelector('[data-service-intro]').textContent = service.introduction;
  serviceBody.replaceChildren();
  const offerings = document.createElement('section');
  const heading = document.createElement('h3'); heading.textContent = 'آنچه برای این مسیر در نظر می‌گیریم';
  offerings.append(heading, makeList(service.offerings));
  const preparation = document.createElement('section');
  const preparationTitle = document.createElement('h3'); preparationTitle.textContent = 'برای شروع چه اطلاعاتی نیاز است';
  preparation.append(preparationTitle, makeList(service.preparation));
  const outcome = document.createElement('p'); outcome.className = 'service-outcome'; outcome.textContent = service.outcome;
  serviceBody.append(offerings, preparation, outcome);
  const form = serviceDialog.querySelector('[data-service-form]');
  form.dataset.service = slug;
  form.reset();
  if (!serviceDialog.open) serviceDialog.showModal();
  serviceDialog.scrollTop = 0;
}
function followHash() {
  const match = location.hash.match(/^#service\/([a-z-]+)$/);
  if (match) showService(match[1]);
  else if (serviceDialog.open) closeService(false);
  if (location.hash === '#chat') chat.open();
}
document.querySelectorAll('[data-service-link]').forEach(link => link.addEventListener('click', event => {
  const slug = link.dataset.serviceLink;
  if (!Object.hasOwn(services, slug)) return;
  event.preventDefault();
  lastServiceTrigger = link;
  history.pushState({service: slug}, '', '#service/' + slug);
  closeMenu();
  showService(slug);
}));
serviceDialog.querySelector('[data-service-close]').addEventListener('click', () => closeService());
serviceDialog.addEventListener('cancel', event => { event.preventDefault(); closeService(); });
serviceDialog.addEventListener('click', event => {
  if (event.target !== serviceDialog) return;
  const box = serviceDialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeService();
});
serviceDialog.querySelector('[data-service-form]').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget, service = services[form.dataset.service];
  const location = form.elements.location.value.trim();
  const description = form.elements.description.value.trim();
  if (!description) { form.elements.description.focus(); return; }
  const message = 'برای ' + service.title + ' راهنمایی می‌خواهم.\n' + (location ? 'شهر یا محل پروژه: ' + location + '\n' : '') + 'شرح نیاز: ' + description;
  closeService();
  void chat.ask(message);
});
window.addEventListener('hashchange', followHash);
window.addEventListener('popstate', followHash);
followHash();
