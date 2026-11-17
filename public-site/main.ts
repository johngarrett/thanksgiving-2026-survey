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
let ownerId: string = crypto.randomUUID();
try {
  ownerId = localStorage.getItem('thanksgiving-owner-id') || ownerId;
  localStorage.setItem('thanksgiving-owner-id', ownerId);
} catch { /* Ownership lasts only for this page when storage is unavailable. */ }
let owned = new Map<string, boolean>();
const editedLabels = new Map<string, string>();
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
function rainTurkeyLegs() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rain = element('div'); rain.className = 'turkey-rain'; rain.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 300; i++) {
    const leg = element('span', '🍗');
    leg.style.left = `${Math.random() * 100}%`;
    leg.style.fontSize = `${24 + Math.random() * 32}px`;
    leg.style.animationDelay = `${Math.random() * 2}s`;
    leg.style.animationDuration = `${2 + Math.random() * 2}s`;
    rain.append(leg);
  }
  document.body.append(rain);
}
function notesInput(value: string, onInput: (value: string) => void) {
  const label = element('label');
  const input = element('textarea'); input.rows = 1; input.maxLength = 2048; input.value = value;
  input.placeholder = 'Notes'; input.setAttribute('aria-label', 'Notes');
  input.addEventListener('input', () => { resizeNotes(input); onInput(input.value); });
  label.append(input); return label;
}
async function changeOwnClaim(optionId: string, method: 'POST' | 'DELETE', body: unknown) {
  if (saving) return;
  saving = true; refreshRequest++; signup.inert = true; status.textContent = 'Saving…';
  try {
    const path = method === 'DELETE' ? `/api/claims/${encodeURIComponent(optionId)}` : '/api/claims';
    const response = await fetch(`${api}${path}`, { method, credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save. Try again.');
    chosen.delete(optionId); editedLabels.delete(optionId);
    if (method === 'DELETE') owned.delete(optionId);
    data = result; render(result); status.textContent = 'Changes saved.';
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Unable to save. Try again.'; }
  finally { saving = false; signup.inert = false; submit.disabled = !data; }
}
function render(form: SignupForm) {
  document.querySelector('#title')!.textContent = form.title;
  sections.replaceChildren();
  const available = new Set(form.sections.flatMap(section => section.options.filter(option => option.claimedBy === null || owned.has(option.id)).map(option => option.id)));
  for (const id of chosen.keys()) if (!available.has(id)) chosen.delete(id);
  for (const id of custom.keys()) if (!form.sections.some(section => section.id === id)) custom.delete(id);
  for (const section of form.sections) {
    const fieldset = element('fieldset'); fieldset.append(element('legend', section.title));
    for (const option of section.options) {
      const mine = owned.has(option.id) && option.claimedBy !== null;
      if (mine && !chosen.has(option.id)) chosen.set(option.id, option.notes || '');
      if (mine && !name.value) name.value = option.claimedBy!;
      const row = element('div'); row.className = 'option';
      const label = element('label');
      const check = element('input'); check.type = 'checkbox'; check.disabled = option.claimedBy !== null; check.checked = chosen.has(option.id);
      row.classList.toggle('claimed', check.disabled && !mine);
      row.classList.toggle('mine', mine);
      const titleText = element('span', option.label);
      label.append(check, titleText);
      row.append(label);
      if (option.claimedBy !== null) {
        const claim = element('p', '↳ Claimed by '); claim.className = 'details claim';
        claim.append(element('strong', option.claimedBy)); row.append(claim);
      }
      if (option.notes) {
        const note = element('p', `↳ ${option.notes}`); note.className = 'details notes'; row.append(note);
      }
      if (option.claimedBy === null || mine) {
        const details = element('div'); details.className = 'details'; details.hidden = mine || !check.checked;
        let title: HTMLInputElement | undefined;
        if (mine && owned.get(option.id)) {
          title = element('input'); title.type = 'text'; title.maxLength = 200; title.required = true; title.hidden = true; title.disabled = true;
          title.value = editedLabels.get(option.id) ?? option.label;
          title.setAttribute('aria-label', `Title for ${option.label}`);
          title.addEventListener('input', () => editedLabels.set(option.id, title!.value));
          label.append(title);
        }
        details.append(notesInput(chosen.get(option.id) || '', value => chosen.set(option.id, value)));
        details.querySelector('textarea')!.disabled = mine || !check.checked;
        check.addEventListener('change', () => {
          details.hidden = !check.checked;
          details.querySelector('textarea')!.disabled = !check.checked;
          if (check.checked) resizeNotes(details.querySelector('textarea')!);
          if (check.checked) chosen.set(option.id, details.querySelector('textarea')!.value); else chosen.delete(option.id);
        });
        row.append(details);
        if (mine) {
          const pencil = element('button'); pencil.type = 'button'; pencil.className = 'pencil';
          pencil.setAttribute('aria-label', `Edit ${option.label}`);
          pencil.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.5V21h3.5L18 9.5 14.5 6ZM20.7 6.8a1 1 0 0 0 0-1.4l-2.1-2.1a1 1 0 0 0-1.4 0L15.6 5 19 8.4Z"/></svg>';
          const note = details.querySelector('textarea')!;
          const noteText = row.querySelector<HTMLElement>('.notes');
          pencil.addEventListener('click', () => {
            details.hidden = false; pencil.hidden = true;
            if (noteText) noteText.hidden = true;
            if (title) { titleText.hidden = true; title.hidden = false; title.disabled = false; }
            note.disabled = false; (title || note).focus(); resizeNotes(note);
          });
          const controls = element('div'); controls.className = 'edit-actions';
          const save = element('button', 'Save'); save.type = 'button';
          save.addEventListener('click', () => {
            if (!note.reportValidity() || (title && !title.reportValidity())) return;
            void changeOwnClaim(option.id, 'POST', { ownerId, name: option.claimedBy, selections: [{ optionId: option.id, notes: note.value, ...(title ? { label: title.value } : {}) }] });
          });
          const cancel = element('button', 'Cancel'); cancel.type = 'button';
          cancel.addEventListener('click', () => {
            chosen.set(option.id, option.notes || ''); editedLabels.delete(option.id);
            note.value = option.notes || ''; note.disabled = true; details.hidden = true;
            if (title) { title.value = option.label; title.hidden = true; title.disabled = true; titleText.hidden = false; }
            if (noteText) noteText.hidden = false;
            pencil.hidden = false; pencil.focus();
          });
          const remove = element('button', 'Delete'); remove.type = 'button'; remove.className = 'delete';
          remove.addEventListener('click', () => {
            if (confirm(owned.get(option.id) ? `Delete “${option.label}” and your claim?` : `Release your claim on “${option.label}”?`)) void changeOwnClaim(option.id, 'DELETE', { ownerId });
          });
          controls.append(save, cancel, remove); details.append(controls);
          label.after(pencil);
        }
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
    const [response, ownership] = await Promise.all([
      fetch(`${api}/api/form`, { credentials: 'omit', cache: 'no-store' }),
      fetch(`${api}/api/claims/owned`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownerId }) }),
    ]);
    if (!response.ok || !ownership.ok) throw new Error();
    const result: SignupForm = await response.json();
    const ids: { optionId: string; custom: number }[] = await ownership.json();
    if (request !== refreshRequest || saving) return;
    owned = new Map(ids.map(item => [item.optionId, Boolean(item.custom)]));
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
    ownerId,
    name: name.value,
    selections: [...chosen].map(([optionId, notes]) => ({ optionId, notes, label: editedLabels.get(optionId) })),
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
    const edit = element('button', 'Edit my notes'); edit.type = 'button';
    edit.addEventListener('click', () => location.reload());
    confirmation.after(edit);
    rainTurkeyLegs();
  } catch {
    saveStatus.textContent = 'Connection lost. Your save may have completed. Close this dialog and reload the page before trying again, especially for custom choices.';
  } finally {
    saving = false; saveButton.textContent = 'Submit'; saveButton.disabled = false; cancel.disabled = false; name.readOnly = false; submit.disabled = !data;
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh();
