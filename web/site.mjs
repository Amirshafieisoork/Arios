const toggle=document.querySelector('.menu-toggle');
const nav=document.querySelector('#main-nav');
function closeMenu(){toggle?.setAttribute('aria-expanded','false');toggle?.setAttribute('aria-label','باز کردن منو');document.querySelector('.site-header')?.classList.remove('menu-open');}
toggle?.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'بستن منو':'باز کردن منو');document.querySelector('.site-header')?.classList.toggle('menu-open',open);});
nav?.querySelectorAll('a').forEach(link=>link.addEventListener('click',closeMenu));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&toggle?.getAttribute('aria-expanded')==='true'){closeMenu();toggle.focus();}});
document.addEventListener('click',event=>{if(!event.target.closest('.site-header'))closeMenu();});
window.matchMedia('(min-width: 901px)').addEventListener('change',event=>{if(event.matches)closeMenu();});
