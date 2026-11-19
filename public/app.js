'use strict';

const authSection = document.querySelector('#customer-auth-section');
const dashboard = document.querySelector('#customer-dashboard');
const formSection = document.querySelector('#formulario');
const loginForm = document.querySelector('#customer-login-form');
const registerForm = document.querySelector('#customer-register-form');
const loginMessage = document.querySelector('#login-message');
const registerMessage = document.querySelector('#register-message');
const customerTicketList = document.querySelector('#customer-ticket-list');
const customerTicketDetail = document.querySelector('#customer-ticket-detail');
const profileForm = document.querySelector('#profile-form');
const ticketForm = document.querySelector('#ticket-form');
const submitButton = document.querySelector('#submit-button');
const formMessage = document.querySelector('#form-message');
const formLayout = document.querySelector('#form-layout');
const successPanel = document.querySelector('#success-panel');
const ticketCode = document.querySelector('#ticket-code');
const summaryInput = document.querySelector('#summary');
const descriptionInput = document.querySelector('#description');
const imagesInput = document.querySelector('#images');
let currentUser = null;
let editingCode = null;
let selectedCustomerCode = null;
let currentTickets = [];

const STATUS_LABELS = { new: 'Nuevo', in_progress: 'En proceso', waiting: 'En espera', resolved: 'Resuelto' };
const CATEGORY_LABELS = { technical: 'Soporte técnico', incident: 'Incidente o problema', request: 'Solicitud de servicio', billing: 'Consulta administrativa', other: 'Otro' };

function showFieldError(name, message = '') {
  const error = ticketForm.querySelector(`[data-error="${name}"]`);
  const input = ticketForm.querySelector(`[name="${name}"]`);
  if (error) error.textContent = message;
  if (input && input.type !== 'checkbox') input.classList.toggle('input-invalid', Boolean(message));
}

function clearErrors() {
  document.querySelectorAll('.field-error').forEach((node) => { node.textContent = ''; });
  document.querySelectorAll('.input-invalid').forEach((node) => node.classList.remove('input-invalid'));
  formMessage.textContent = '';
  formMessage.className = 'form-message';
}

function updateCounter(input, counter, max) {
  counter.textContent = `${input.value.length} / ${max}`;
}

function setAuthTab(tab) {
  const loginSelected = tab === 'login';
  document.querySelector('#login-tab').classList.toggle('is-active', loginSelected);
  document.querySelector('#register-tab').classList.toggle('is-active', !loginSelected);
  document.querySelector('#login-tab').setAttribute('aria-selected', String(loginSelected));
  document.querySelector('#register-tab').setAttribute('aria-selected', String(!loginSelected));
  loginForm.hidden = !loginSelected;
  registerForm.hidden = loginSelected;
  loginMessage.textContent = '';
  registerMessage.textContent = '';
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || 'No se pudo completar la operación.');
  return result;
}

function showCustomerArea(user) {
  currentUser = user;
  authSection.hidden = true;
  dashboard.hidden = false;
  formSection.hidden = true;
  successPanel.hidden = true;
  document.querySelector('#customer-welcome').textContent = `Hola, ${user.name}`;
  document.querySelector('#profile-name').value = user.name;
  document.querySelector('#profile-company').value = user.company;
  document.querySelector('#profile-email').value = user.email;
  document.querySelector('#name').value = user.name;
  document.querySelector('#company').value = user.company;
  document.querySelector('#email').value = user.email;
  loadCustomerTickets();
}

function showSignedOut() {
  currentUser = null;
  selectedCustomerCode = null;
  editingCode = null;
  dashboard.hidden = true;
  formSection.hidden = true;
  authSection.hidden = false;
  setAuthTab('login');
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function makeElement(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function renderTicketList(tickets) {
  customerTicketList.replaceChildren();
  document.querySelector('#my-ticket-count').textContent = `${tickets.length} ${tickets.length === 1 ? 'ticket registrado' : 'tickets registrados'}`;
  if (!tickets.length) {
    const empty = makeElement('div', 'customer-empty');
    empty.append(makeElement('strong', '', 'Todavía no tenés tickets'), makeElement('span', '', 'Cuando envíes tu primer requerimiento, vas a poder seguirlo desde acá.'));
    customerTicketList.append(empty);
    return;
  }
  for (const ticket of tickets) {
    const button = makeElement('button', `customer-ticket-row${ticket.code === selectedCustomerCode ? ' is-selected' : ''}`);
    button.type = 'button';
    button.addEventListener('click', () => openCustomerTicket(ticket.code));
    const top = makeElement('div', 'customer-ticket-top');
    top.append(makeElement('span', 'ticket-code', ticket.code), makeElement('span', `customer-status status-${ticket.status}`, STATUS_LABELS[ticket.status] || ticket.status));
    button.append(top, makeElement('strong', 'customer-ticket-title', ticket.title), makeElement('span', 'customer-ticket-summary', ticket.summary));
    const bottom = makeElement('div', 'customer-ticket-bottom');
    bottom.append(makeElement('span', '', CATEGORY_LABELS[ticket.category] || ticket.category), makeElement('time', '', formatDate(ticket.created_at)));
    button.append(bottom);
    customerTicketList.append(button);
  }
}

async function loadCustomerTickets() {
  try {
    const result = await api('/api/customer/tickets');
    currentTickets = result.tickets || [];
    renderTicketList(currentTickets);
    if (selectedCustomerCode && currentTickets.some((ticket) => ticket.code === selectedCustomerCode)) await openCustomerTicket(selectedCustomerCode);
    else {
      selectedCustomerCode = null;
      renderEmptyCustomerDetail();
    }
  } catch (error) {
    customerTicketList.replaceChildren(makeElement('p', 'auth-error', error.message));
  }
}

function renderEmptyCustomerDetail() {
  customerTicketDetail.replaceChildren();
  const empty = makeElement('div', 'customer-empty');
  empty.append(makeElement('strong', '', 'Seleccioná un ticket'), makeElement('span', '', 'Acá vas a poder consultar su detalle y los archivos adjuntos.'));
  customerTicketDetail.append(empty);
}

function renderCustomerTicketDetail(result) {
  const { ticket, attachments, activity, editable } = result;
  customerTicketDetail.replaceChildren();
  const header = makeElement('div', 'customer-detail-head');
  const codeAndStatus = makeElement('div', 'customer-detail-kicker');
  codeAndStatus.append(makeElement('span', 'ticket-code', ticket.code), makeElement('span', `customer-status status-${ticket.status}`, STATUS_LABELS[ticket.status] || ticket.status));
  header.append(codeAndStatus, makeElement('h3', '', ticket.title), makeElement('p', '', `Creado el ${formatDate(ticket.created_at)}`));
  customerTicketDetail.append(header);
  const summary = makeElement('section', 'customer-detail-section');
  summary.append(makeElement('h4', '', 'Resumen'), makeElement('p', '', ticket.summary));
  const description = makeElement('section', 'customer-detail-section');
  description.append(makeElement('h4', '', 'Descripción detallada'), makeElement('p', 'customer-description', ticket.description));
  const contact = makeElement('section', 'customer-detail-section');
  contact.append(makeElement('h4', '', 'Datos del contacto'), makeElement('p', '', `${ticket.customer_name} · ${ticket.company}\n${ticket.email}${ticket.phone ? ` · ${ticket.phone}` : ''}`));
  const fileSection = makeElement('section', 'customer-detail-section');
  fileSection.append(makeElement('h4', '', `Imágenes adjuntas (${attachments.length})`));
  if (!attachments.length) fileSection.append(makeElement('p', 'customer-muted', 'No se adjuntaron imágenes.'));
  else {
    const gallery = makeElement('div', 'customer-image-gallery');
    for (const attachment of attachments) {
      const link = makeElement('a', 'customer-image-link');
      link.href = `/api/customer/tickets/${encodeURIComponent(ticket.code)}/attachments/${attachment.id}`;
      link.target = '_blank'; link.rel = 'noopener';
      const img = makeElement('img'); img.src = link.href; img.alt = attachment.original_name || 'Imagen adjunta';
      link.append(img, makeElement('span', '', attachment.original_name));
      gallery.append(link);
    }
    fileSection.append(gallery);
  }
  const activitySection = makeElement('section', 'customer-detail-section');
  activitySection.append(makeElement('h4', '', 'Actividad')); 
  if (!activity.length) activitySection.append(makeElement('p', 'customer-muted', 'Sin novedades registradas.'));
  else {
    const list = makeElement('div', 'customer-activity-list');
    for (const item of activity) list.append(makeElement('p', '', `${item.message} · ${formatDate(item.created_at)}`));
    activitySection.append(list);
  }
  customerTicketDetail.append(summary, description, contact, fileSection, activitySection);
  const actions = makeElement('div', 'customer-detail-actions');
  if (editable) {
    const edit = makeElement('button', 'submit-button', 'Editar este ticket');
    edit.type = 'button';
    edit.addEventListener('click', () => openTicketEditor(ticket));
    actions.append(edit, makeElement('span', 'customer-muted', 'Podés editarlo mientras esté en estado Nuevo.'));
  } else {
    actions.append(makeElement('span', 'customer-muted', 'Este ticket ya está siendo gestionado y su contenido quedó bloqueado para edición.'));
  }
  customerTicketDetail.append(actions);
}

async function openCustomerTicket(code) {
  selectedCustomerCode = code;
  renderTicketList(currentTickets);
  customerTicketDetail.replaceChildren(makeElement('p', 'list-loading', 'Cargando ticket…'));
  try {
    const result = await api(`/api/customer/tickets/${encodeURIComponent(code)}`);
    if (selectedCustomerCode === code) renderCustomerTicketDetail(result);
  } catch (error) {
    customerTicketDetail.replaceChildren(makeElement('p', 'auth-error', error.message));
  }
}

function setFormMode(isEditing) {
  document.querySelector('#section-heading-title').textContent = isEditing ? 'Editar ticket' : 'Crear un ticket';
  document.querySelector('#cancel-ticket').hidden = false;
  submitButton.querySelector('span').textContent = isEditing ? 'Guardar cambios' : 'Enviar requerimiento';
  document.querySelector('#privacyAccepted').closest('.privacy-consent').hidden = isEditing;
  document.querySelector('.form-warning').hidden = false;
  document.querySelector('#name').disabled = isEditing;
  document.querySelector('#company').disabled = isEditing;
  document.querySelector('#email').disabled = isEditing;
}

function openNewTicket() {
  editingCode = null;
  ticketForm.reset();
  document.querySelector('#name').value = currentUser.name;
  document.querySelector('#company').value = currentUser.company;
  document.querySelector('#email').value = currentUser.email;
  document.querySelector('#name').disabled = false;
  document.querySelector('#company').disabled = false;
  document.querySelector('#email').disabled = false;
  document.querySelector('#privacyAccepted').closest('.privacy-consent').hidden = false;
  document.querySelector('.form-warning').hidden = false;
  document.querySelector('#section-heading-title').textContent = 'Crear un ticket';
  submitButton.querySelector('span').textContent = 'Enviar requerimiento';
  imagesInput.disabled = false;
  document.querySelector('#upload-preview').textContent = '';
  updateCounter(summaryInput, document.querySelector('#summary-count'), 180);
  updateCounter(descriptionInput, document.querySelector('#description-count'), 5000);
  clearErrors();
  successPanel.hidden = true;
  formLayout.hidden = false;
  document.querySelector('.section-heading').hidden = false;
  dashboard.hidden = true;
  formSection.hidden = false;
  document.querySelector('#formulario').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openTicketEditor(ticket) {
  editingCode = ticket.code;
  ticketForm.reset();
  document.querySelector('#name').value = ticket.customer_name;
  document.querySelector('#company').value = ticket.company;
  document.querySelector('#email').value = ticket.email;
  document.querySelector('#phone').value = ticket.phone || '';
  document.querySelector('#category').value = ticket.category;
  document.querySelector('#title').value = ticket.title;
  summaryInput.value = ticket.summary;
  descriptionInput.value = ticket.description;
  document.querySelector('#name').disabled = true;
  document.querySelector('#company').disabled = true;
  document.querySelector('#email').disabled = true;
  document.querySelector('#privacyAccepted').closest('.privacy-consent').hidden = true;
  document.querySelector('#section-heading-title').textContent = 'Editar ticket';
  submitButton.querySelector('span').textContent = 'Guardar cambios';
  document.querySelector('#upload-preview').textContent = 'Las nuevas imágenes se agregarán a los adjuntos existentes.';
  imagesInput.disabled = false;
  updateCounter(summaryInput, document.querySelector('#summary-count'), 180);
  updateCounter(descriptionInput, document.querySelector('#description-count'), 5000);
  clearErrors();
  successPanel.hidden = true;
  formLayout.hidden = false;
  document.querySelector('.section-heading').hidden = false;
  dashboard.hidden = true;
  formSection.hidden = false;
  document.querySelector('#formulario').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function returnToDashboard() {
  editingCode = null;
  formSection.hidden = true;
  dashboard.hidden = false;
  successPanel.hidden = true;
  formLayout.hidden = false;
  document.querySelector('.section-heading').hidden = false;
  document.querySelector('#cancel-ticket').hidden = true;
  document.querySelector('#privacyAccepted').closest('.privacy-consent').hidden = false;
  document.querySelector('#name').disabled = false;
  document.querySelector('#company').disabled = false;
  document.querySelector('#email').disabled = false;
  imagesInput.disabled = false;
  dashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

summaryInput.addEventListener('input', () => updateCounter(summaryInput, document.querySelector('#summary-count'), 180));
descriptionInput.addEventListener('input', () => updateCounter(descriptionInput, document.querySelector('#description-count'), 5000));
imagesInput.addEventListener('change', () => {
  const files = [...imagesInput.files];
  const preview = document.querySelector('#upload-preview');
  preview.replaceChildren();
  if (files.length > 4) showFieldError('images', 'Podés seleccionar hasta 4 imágenes.');
  else showFieldError('images', '');
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (files.some((file) => file.size > 4 * 1024 * 1024) || total > 12 * 1024 * 1024) showFieldError('images', 'Cada imagen debe pesar hasta 4 MB y el total no puede superar 12 MB.');
  for (const file of files) preview.append(makeElement('span', 'upload-file-name', `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`));
});

document.querySelector('#login-tab').addEventListener('click', () => setAuthTab('login'));
document.querySelector('#register-tab').addEventListener('click', () => setAuthTab('register'));

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault(); loginMessage.textContent = '';
  const button = loginForm.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(loginForm).entries())) });
    loginForm.reset(); showCustomerArea(result.user);
  } catch (error) { loginMessage.textContent = error.message; }
  finally { button.disabled = false; }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault(); registerMessage.textContent = '';
  const button = registerForm.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(registerForm).entries())) });
    registerForm.reset(); showCustomerArea(result.user);
  } catch (error) { registerMessage.textContent = error.message; }
  finally { button.disabled = false; }
});

ticketForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();
  if (!ticketForm.reportValidity()) return;
  const files = [...imagesInput.files];
  if (files.length > 4 || files.some((file) => file.size > 4 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 12 * 1024 * 1024) {
    showFieldError('images', 'Revisá el límite: hasta 4 imágenes, de 4 MB cada una y 12 MB en total.');
    return;
  }
  const data = new FormData(ticketForm);
  data.set('privacyAccepted', document.querySelector('#privacyAccepted').checked ? 'true' : 'false');
  submitButton.disabled = true;
  submitButton.classList.add('is-loading');
  submitButton.querySelector('span').textContent = editingCode ? 'Guardando…' : 'Enviando…';
  try {
    const url = editingCode ? `/api/customer/tickets/${encodeURIComponent(editingCode)}` : '/api/tickets';
    const response = await fetch(url, { method: editingCode ? 'PATCH' : 'POST', credentials: 'same-origin', body: data });
    const result = await response.json();
    if (!response.ok) {
      if (result.fields) Object.entries(result.fields).forEach(([key, message]) => showFieldError(key, message));
      throw new Error(result.error || 'No se pudo guardar el requerimiento.');
    }
    if (editingCode) {
      const code = editingCode;
      await loadCustomerTickets();
      await openCustomerTicket(code);
      returnToDashboard();
    } else {
      ticketCode.textContent = result.code;
      formLayout.hidden = true;
      document.querySelector('.section-heading').hidden = true;
      successPanel.hidden = false;
      successPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      selectedCustomerCode = result.code;
      await loadCustomerTickets();
    }
  } catch (error) {
    formMessage.textContent = error.message || 'No fue posible conectar con el servidor. Verificá tu conexión e intentá nuevamente.';
    formMessage.className = 'form-message is-error';
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove('is-loading');
    submitButton.querySelector('span').textContent = editingCode ? 'Guardar cambios' : 'Enviar requerimiento';
  }
});

document.querySelector('#copy-code').addEventListener('click', async () => {
  const button = document.querySelector('#copy-code');
  try { await navigator.clipboard.writeText(ticketCode.textContent); button.classList.add('copied'); }
  catch {
    const range = document.createRange(); range.selectNodeContents(ticketCode);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
});

document.querySelector('#new-ticket').addEventListener('click', () => { openNewTicket(); });
document.querySelector('#success-back').addEventListener('click', returnToDashboard);
document.querySelector('#new-ticket-button').addEventListener('click', openNewTicket);
document.querySelector('#cancel-ticket').addEventListener('click', returnToDashboard);
document.querySelector('#customer-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* La sesión ya puede haber expirado. */ }
  showSignedOut();
});

document.querySelector('#profile-toggle').addEventListener('click', () => {
  profileForm.hidden = !profileForm.hidden;
  document.querySelector('#profile-message').textContent = '';
});
profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#profile-message'); message.textContent = '';
  try {
    const result = await api('/api/auth/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(profileForm).entries())) });
    currentUser = result.user;
    document.querySelector('#customer-welcome').textContent = `Hola, ${currentUser.name}`;
    document.querySelector('#name').value = currentUser.name;
    document.querySelector('#company').value = currentUser.company;
    document.querySelector('#email').value = currentUser.email;
    message.textContent = 'Tus datos se actualizaron.';
  } catch (error) { message.textContent = error.message; }
});

document.querySelector('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#password-message'); message.textContent = '';
  try {
    await api('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    event.currentTarget.reset(); message.textContent = 'Contraseña actualizada correctamente.';
  } catch (error) { message.textContent = error.message; }
});

(async function init() {
  try {
    const result = await api('/api/auth/me');
    if (result.authenticated) showCustomerArea(result.user);
    else showSignedOut();
  } catch { showSignedOut(); }
})();
