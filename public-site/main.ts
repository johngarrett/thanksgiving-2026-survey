import type { SignupForm, ClaimInput } from '../shared/types';
import './styles.css';

const signup = document.querySelector<HTMLFormElement>('#signup')!;
const sections = document.querySelector<HTMLDivElement>('#sections')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const submit = document.querySelector<HTMLButtonElement>('#submit')!;
const dialog = document.querySelector<HTMLDialogElement>('#name-dialog')!;
const saveForm = document.querySelector<HTMLFormElement>('#save-form')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const name = document.querySelector<HTMLInputElement>('#guest-name')!;
const saveStatus = document.querySelector<HTMLParagraphElement>('#save-status')!;
const api = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const chosen = new Map<string, string>();
const custom = new Map<string, { label: string; recipeUrl: string }>();
let data: SignupForm | undefined;
let saving = false;
let refreshRequest = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}
function urlInput(value: string, onInput: (value: string) => void) {
  const label = element('label', 'Recipe URL (optional) ');
  const input = element('input');
  input.type = 'url'; input.maxLength = 2048; input.placeholder = 'https://'; input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  label.append(input);
  return label;
}
function recipeLink(url: string | null) {
  if (!url) return undefined;
  try { if (!['https:', 'http:'].includes(new URL(url).protocol)) return undefined; } catch { return undefined; }
  const link = element('a', 'Recipe'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}
function render(form: SignupForm) {
  document.querySelector('#title')!.textContent = form.title;
  document.title = form.title;
  sections.replaceChildren();
  const available = new Set(form.sections.flatMap(section => section.options.filter(option => option.claimedBy === null).map(option => option.id)));
  for (const id of chosen.keys()) if (!available.has(id)) chosen.delete(id);
  for (const id of custom.keys()) if (!form.sections.some(section => section.id === id)) custom.delete(id);
  for (const section of form.sections) {
    const fieldset = element('fieldset'); fieldset.append(element('legend', section.title));
    for (const option of section.options) {
      const row = element('div'); row.className = 'option';
      const label = element('label');
      const check = element('input'); check.type = 'checkbox'; check.disabled = option.claimedBy !== null; check.checked = chosen.has(option.id);
      label.append(check, document.createTextNode(` ${option.label}${option.claimedBy !== null ? ` — ${option.claimedBy}` : ''}`));
      row.append(label);
      const link = recipeLink(option.recipeUrl);
      if (link) row.append(document.createTextNode(' · '), link);
      if (option.claimedBy === null) {
        const details = element('div'); details.className = 'details'; details.hidden = !check.checked;
        details.append(urlInput(chosen.get(option.id) || '', value => chosen.set(option.id, value)));
        details.querySelector('input')!.disabled = !check.checked;
        check.addEventListener('change', () => {
          details.hidden = !check.checked;
          details.querySelector('input')!.disabled = !check.checked;
          if (check.checked) chosen.set(option.id, details.querySelector('input')!.value); else chosen.delete(option.id);
        });
        row.append(details);
      }
      fieldset.append(row);
    }
    const row = element('div'); row.className = 'option custom-choice';
    const description = element('label', 'Other (add your own) ');
    const input = element('input'); input.type = 'text'; input.maxLength = 200; input.value = custom.get(section.id)?.label || '';
    description.append(input);
    const details = element('div'); details.className = 'details'; details.hidden = !input.value.trim();
    details.append(urlInput(custom.get(section.id)?.recipeUrl || '', value => {
      const entry = custom.get(section.id); if (entry) entry.recipeUrl = value;
    }));
    const url = details.querySelector('input')!; url.disabled = details.hidden;
    input.addEventListener('input', () => {
      const populated = Boolean(input.value.trim());
      details.hidden = !populated; url.disabled = !populated;
      if (populated) custom.set(section.id, { label: input.value, recipeUrl: url.value });
      else custom.delete(section.id);
    });
    row.append(description, details); fieldset.append(row); sections.append(fieldset);
  }
  submit.disabled = saving;
}
async function refresh() {
  if (saving) return;
  const request = ++refreshRequest;
  try {
    const response = await fetch(`${api}/api/form`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error();
    const result: SignupForm = await response.json();
    if (request !== refreshRequest || saving) return;
    data = result; render(result); status.textContent = '';
  } catch { if (request === refreshRequest) status.textContent = 'Could not refresh availability. Check your connection and try again.'; }
}
signup.addEventListener('submit', event => {
  event.preventDefault();
  if (!chosen.size && !custom.size) { status.textContent = 'Choose at least one option.'; return; }
  if (!signup.reportValidity()) return;
  saveStatus.textContent = ''; dialog.showModal(); name.focus();
});
cancel.addEventListener('click', () => dialog.close());
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
saveForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || !data) return;
  const payload: ClaimInput = {
    name: name.value,
    selections: [...chosen].map(([optionId, recipeUrl]) => ({ optionId, recipeUrl })),
    custom: [...custom].map(([sectionId, entry]) => ({ sectionId, ...entry })),
  };
  saving = true; refreshRequest++; saveButton.disabled = true; cancel.disabled = true; submit.disabled = true;
  name.readOnly = true; saveStatus.textContent = 'Saving…';
  try {
    const response = await fetch(`${api}/api/claims`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (response.status === 409) {
      dialog.close(); saving = false;
      await refresh(); status.textContent = result.error; return;
    }
    if (!response.ok) { saveStatus.textContent = result.error || 'Unable to save. Try again.'; return; }
    chosen.clear(); custom.clear(); data = result; saving = false; render(result); dialog.close();
    status.textContent = 'Your selections are saved. Thank you!';
  } catch {
    saveStatus.textContent = 'Connection lost. Your save may have completed. Close this dialog and reload the page before trying again, especially for custom choices.';
  } finally {
    saving = false; saveButton.disabled = false; cancel.disabled = false; name.readOnly = false; submit.disabled = !data;
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh();
