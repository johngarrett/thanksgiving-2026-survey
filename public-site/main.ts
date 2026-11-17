import type { SignupForm, ClaimInput } from '../shared/types';
import '../shared/ui.css';
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
const custom = new Map<string, { label: string; notes: string }>();
let data: SignupForm | undefined;
let saving = false;
let completed = false;
let refreshRequest = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}
function resizeNotes(input: HTMLTextAreaElement) {
  input.style.height = 'auto'; input.style.height = `${input.scrollHeight + 2}px`;
}
function notesInput(value: string, onInput: (value: string) => void) {
  const label = element('label');
  const input = element('textarea'); input.rows = 1; input.maxLength = 2048; input.value = value;
  input.placeholder = 'Notes'; input.setAttribute('aria-label', 'Notes');
  input.addEventListener('input', () => { resizeNotes(input); onInput(input.value); });
  label.append(input); return label;
}
function render(form: SignupForm) {
  document.querySelector('#title')!.textContent = form.title;
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
      row.classList.toggle('claimed', check.disabled);
      label.append(check, document.createTextNode(` ${option.label}`));
      row.append(label);
      if (option.claimedBy !== null) {
        const claim = element('p', '↳ Claimed by '); claim.className = 'details claim';
        claim.append(element('strong', option.claimedBy)); row.append(claim);
      }
      if (option.notes) {
        const note = element('p', `↳ ${option.notes}`); note.className = 'details notes'; row.append(note);
      }
      if (option.claimedBy === null) {
        const details = element('div'); details.className = 'details'; details.hidden = !check.checked;
        details.append(notesInput(chosen.get(option.id) || '', value => chosen.set(option.id, value)));
        details.querySelector('textarea')!.disabled = !check.checked;
        check.addEventListener('change', () => {
          details.hidden = !check.checked;
          details.querySelector('textarea')!.disabled = !check.checked;
          if (check.checked) resizeNotes(details.querySelector('textarea')!);
          if (check.checked) chosen.set(option.id, details.querySelector('textarea')!.value); else chosen.delete(option.id);
        });
        row.append(details);
      }
      fieldset.append(row);
    }
    const row = element('div'); row.className = 'option custom-choice';
    const description = element('label');
    const check = element('input'); check.type = 'checkbox'; check.checked = custom.has(section.id);
    description.append(check, document.createTextNode(' Other'));
    const input = element('input'); input.type = 'text'; input.maxLength = 200; input.value = custom.get(section.id)?.label || '';
    input.setAttribute('aria-label', 'Other description');
    input.placeholder = section.customPlaceholder;
    input.hidden = !check.checked;
    const details = element('div'); details.className = 'details'; details.hidden = !check.checked;
    details.append(notesInput(custom.get(section.id)?.notes || '', value => {
      const entry = custom.get(section.id); if (entry) entry.notes = value;
    }));
    const note = details.querySelector('textarea')!; note.disabled = details.hidden;
    const update = () => {
      input.required = check.checked; input.hidden = !check.checked;
      details.hidden = !check.checked; note.disabled = !check.checked;
      if (check.checked) resizeNotes(note);
      if (check.checked) custom.set(section.id, { label: input.value, notes: note.value });
      else custom.delete(section.id);
    };
    input.required = check.checked;
    input.addEventListener('focus', () => { check.checked = true; update(); });
    input.addEventListener('input', update);
    check.addEventListener('change', () => {
      if (!check.checked) {
        const hasText = Boolean(input.value.trim() || note.value.trim());
        input.value = ''; note.value = '';
        if (hasText) alert('Other was deselected. Its description and notes have been cleared.');
      }
      update();
      if (check.checked) input.focus();
    });
    row.append(description, input, details); fieldset.append(row); sections.append(fieldset);
  }
  submit.disabled = saving;
  for (const note of sections.querySelectorAll('textarea')) if (!note.closest('[hidden]')) resizeNotes(note);
}
async function refresh() {
  if (saving || completed) return;
  const request = ++refreshRequest;
  try {
    const response = await fetch(`${api}/api/form`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error();
    const result: SignupForm = await response.json();
    if (request !== refreshRequest || saving) return;
    data = result; render(result); status.classList.remove('selection-error'); status.textContent = '';
  } catch { if (request === refreshRequest) status.textContent = 'Could not refresh availability. Check your connection and try again.'; }
}
signup.addEventListener('invalid', event => {
  const input = event.target as HTMLInputElement | HTMLTextAreaElement;
  status.textContent = input.getAttribute('aria-label') === 'Other description' ? 'Describe your Other selection before submitting.' : input.validationMessage;
}, true);
saveForm.addEventListener('invalid', () => { saveStatus.textContent = 'Enter your name before submitting.'; }, true);
signup.addEventListener('submit', event => {
  event.preventDefault();
  status.classList.remove('selection-error');
  if (!chosen.size && !custom.size) { status.classList.add('selection-error'); status.textContent = 'Choose at least one option.'; return; }
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
    selections: [...chosen].map(([optionId, notes]) => ({ optionId, notes })),
    custom: [...custom].map(([sectionId, entry]) => ({ sectionId, ...entry })),
  };
  saving = true; refreshRequest++; saveButton.disabled = true; cancel.disabled = true; submit.disabled = true;
  name.readOnly = true; saveStatus.textContent = ''; saveButton.textContent = 'Submitting…';
  try {
    const response = await fetch(`${api}/api/claims`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (response.status === 409) {
      dialog.close(); saving = false;
      await refresh(); status.textContent = result.error; return;
    }
    if (!response.ok) { saveStatus.textContent = result.error || 'Unable to save. Try again.'; return; }
    completed = true; chosen.clear(); custom.clear(); dialog.close();
    const confirmation = element('p', 'Your selections are saved.');
    confirmation.setAttribute('role', 'status'); confirmation.tabIndex = -1;
    document.querySelector('main')!.replaceChildren(confirmation); confirmation.focus();
  } catch {
    saveStatus.textContent = 'Connection lost. Your save may have completed. Close this dialog and reload the page before trying again, especially for custom choices.';
  } finally {
    saving = false; saveButton.textContent = 'Submit'; saveButton.disabled = false; cancel.disabled = false; name.readOnly = false; submit.disabled = !data;
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh();
