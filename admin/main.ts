import type { SignupForm, Section, Option } from '../shared/types';
import './styles.css';

const status = document.querySelector<HTMLParagraphElement>('#status')!;
const login = document.querySelector<HTMLFormElement>('#login')!;
const editor = document.querySelector<HTMLDivElement>('#editor')!;
const content = document.querySelector<HTMLDivElement>('#content')!;
let data: SignupForm;
let dirty = false;
let busy = false;
class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, click: () => void) {
  const node = element('button', text); node.type = 'button'; node.addEventListener('click', click); return node;
}
function field(label: string, value = '', type = 'text', required = true, max = 200) {
  const node = element('label', `${label} `); const input = element('input');
  input.type = type; input.value = value; input.required = required; input.maxLength = max;
  node.append(input); return { node, input };
}
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api${path}`, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' });
  const result = await response.json();
  if (response.status === 401) { editor.hidden = true; login.hidden = false; }
  if (!response.ok) throw new ApiError(result.error || 'Request failed.', response.status);
  return result;
}
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  const focused = document.activeElement as HTMLElement | null;
  content.inert = true;
  login.inert = true;
  status.textContent = 'Saving…';
  try { await action(); status.textContent = 'Saved.'; }
  catch (error) { status.textContent = error instanceof Error ? error.message : 'Connection failed. Refresh to check whether the change saved.'; }
  finally { busy = false; content.inert = false; login.inert = false; if (focused?.isConnected) focused.focus(); }
}
function form(fields: HTMLElement[], submitText: string, save: () => Promise<void>) {
  const node = element('form'); const submit = element('button', submitText); submit.type = 'submit';
  node.append(...fields, submit);
  node.addEventListener('submit', event => { event.preventDefault(); void run(save); });
  return node;
}
function apply(result: SignupForm) { data = result; dirty = false; render(); }
function hasOtherEdits(currentForm?: HTMLFormElement): boolean {
  const others = [...content.querySelectorAll<HTMLFormElement>('form')].some(node => node !== currentForm && [...node.querySelectorAll<HTMLInputElement>('input')].some(input => input.value !== input.defaultValue));
  return (others || dirty) && !confirm('This will refresh the editor and discard other unsaved text edits or ordering. Continue?');
}
function editForm(fields: HTMLElement[], submitText: string, path: string, method: string, body: () => unknown) {
  const node = form(fields, submitText, async () => {
    if (hasOtherEdits(node)) return;
    apply(await api(path, method, body()));
  });
  for (const input of node.querySelectorAll('input')) input.defaultValue = input.value;
  return node;
}
function reorderControls(item: HTMLElement, list: HTMLElement, label: string) {
  const controls = element('div');
  const handle = button(`↕ Drag ${label}`, () => {}); handle.className = 'handle';
  handle.setAttribute('aria-label', `Drag to reorder ${label}; use the adjacent move buttons for keyboard reordering`);
  handle.addEventListener('pointerdown', event => {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    const start = event.clientY;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    let pointerY = event.clientY;
    let animation = 0;
    const preview = element('div', label); preview.className = 'drag-preview'; preview.hidden = true; document.body.append(preview);
    const place = () => {
      const siblings = [...list.children].filter(node => node !== item) as HTMLElement[];
      const target = siblings.find(node => pointerY < node.getBoundingClientRect().top + Math.min(node.getBoundingClientRect().height, 64) / 2);
      if (item.nextElementSibling !== (target || null)) {
        list.insertBefore(item, target || null);
        dirty = true; list.dataset.dirty = 'true';
        status.textContent = 'Order changed. Choose Save order to keep it.';
      }
    };
    const scroll = () => {
      if (moved) {
        const speed = pointerY < 70 ? -14 : pointerY > window.innerHeight - 70 ? 14 : 0;
        if (speed) { window.scrollBy(0, speed); place(); }
      }
      animation = requestAnimationFrame(scroll);
    };
    const move = (e: PointerEvent) => {
      pointerY = e.clientY;
      if (Math.abs(pointerY - start) < 4 && !moved) return;
      moved = true; item.classList.add('dragging');
      preview.hidden = false; preview.style.left = `${e.clientX + 12}px`; preview.style.top = `${pointerY + 12}px`;
      place();
    };
    const end = () => {
      cancelAnimationFrame(animation);
      item.classList.remove('dragging'); preview.remove();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
    animation = requestAnimationFrame(scroll);
  });
  controls.append(handle, button('Move up', () => {
    if (item.previousElementSibling) { list.insertBefore(item, item.previousElementSibling); dirty = true; list.dataset.dirty = 'true'; status.textContent = `${label} moved up. Save order to keep it.`; }
  }), button('Move down', () => {
    if (item.nextElementSibling) { list.insertBefore(item.nextElementSibling, item); dirty = true; list.dataset.dirty = 'true'; status.textContent = `${label} moved down. Save order to keep it.`; }
  }));
  return controls;
}
function orderSave(list: HTMLElement, sectionId?: string) {
  return button('Save order', () => void run(async () => {
    const otherOrder = [...content.querySelectorAll<HTMLElement>('[data-list][data-dirty]')].some(node => node !== list);
    if ((otherOrder || [...content.querySelectorAll<HTMLInputElement>('input')].some(input => input.value !== input.defaultValue)) && !confirm('Saving this order refreshes the editor and discards other unsaved edits. Continue?')) return;
    apply(await api('/admin/order', 'PUT', { sectionId, ids: [...list.children].map(item => (item as HTMLElement).dataset.item) }));
  }));
}
function optionRow(option: Option, list: HTMLElement) {
  const row = element('div'); row.className = 'option'; row.dataset.item = option.id;
  row.append(reorderControls(row, list, option.label));
  const label = field('Option label', option.label);
  row.append(editForm([label.node], 'Save option', `/admin/options/${option.id}`, 'PUT', () => ({ label: label.input.value })));
  row.append(element('p', option.claimedBy === null ? 'Available' : `Claimed by ${option.claimedBy}`));
  if (option.recipeUrl) { const link = element('a', 'Recipe'); link.href = option.recipeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; row.append(link); }
  if (option.claimedBy !== null) {
    row.append(button('Clear claim', () => {
      if (hasOtherEdits() || !confirm(`Clear ${option.claimedBy}'s claim on “${option.label}”?`)) return;
      void run(async () => apply(await api(`/admin/options/${option.id}/claim`, 'DELETE', {})));
    }));
  }
  row.append(button('Delete option', () => {
    if (hasOtherEdits() || !confirm(`Delete “${option.label}”${option.claimedBy !== null ? ` and ${option.claimedBy}'s claim` : ''}?`)) return;
    void run(async () => apply(await api(`/admin/options/${option.id}`, 'DELETE', {})));
  }));
  return row;
}
function sectionRow(section: Section, list: HTMLElement) {
  const row = element('fieldset'); row.dataset.item = section.id; row.append(element('legend', section.title));
  row.append(reorderControls(row, list, section.title));
  const title = field('Section title', section.title);
  row.append(editForm([title.node], 'Save section', `/admin/sections/${section.id}`, 'PUT', () => ({ title: title.input.value })));
  row.append(button('Delete section', () => {
    const claims = section.options.filter(option => option.claimedBy !== null).map(option => `${option.label}: ${option.claimedBy}`);
    if (hasOtherEdits() || !confirm(`Delete “${section.title}” and all ${section.options.length} options?${claims.length ? `\nClaims to delete:\n${claims.join('\n')}` : ''}`)) return;
    void run(async () => apply(await api(`/admin/sections/${section.id}`, 'DELETE', {})));
  }));
  const options = element('div'); options.dataset.list = section.id;
  section.options.forEach(option => options.append(optionRow(option, options)));
  row.append(options, orderSave(options, section.id));
  const label = field('New option');
  row.append(editForm([label.node], 'Add option', `/admin/sections/${section.id}/options`, 'POST', () => ({ label: label.input.value })));
  return row;
}
function render() {
  content.replaceChildren();
  const title = field('Page title', data.title);
  content.append(editForm([title.node], 'Save title', '/admin/title', 'PUT', () => ({ title: title.input.value })));
  const list = element('div'); list.dataset.list = 'sections';
  data.sections.forEach(section => list.append(sectionRow(section, list)));
  content.append(list, orderSave(list));
  const newTitle = field('New section title');
  content.append(editForm([newTitle.node], 'Add section', '/admin/sections', 'POST', () => ({ title: newTitle.input.value })));
}
async function load() {
  apply(await api('/form')); login.hidden = true; editor.hidden = false;
}
login.addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => { await api('/admin/login', 'POST', { password: new FormData(login).get('password') }); login.reset(); await load(); });
});
document.querySelector('#logout')!.addEventListener('click', () => void run(async () => {
  await api('/admin/logout', 'POST', {}); content.replaceChildren(); login.hidden = false; editor.hidden = true;
}));
document.querySelector('#refresh')!.addEventListener('click', () => {
  if (hasOtherEdits()) return;
  void run(load);
});
window.addEventListener('beforeunload', event => {
  if (dirty || [...content.querySelectorAll<HTMLInputElement>('input')].some(input => input.value !== input.defaultValue)) event.preventDefault();
});
void (async () => {
  try { await api('/admin/session'); await load(); status.textContent = 'Ready.'; }
  catch (error) { login.hidden = false; status.textContent = error instanceof ApiError && error.status === 401 ? '' : error instanceof Error ? error.message : 'Unable to connect.'; }
})();
