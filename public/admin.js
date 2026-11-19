'use strict';

const loginScreen = document.querySelector('#login-screen');
const dashboardScreen = document.querySelector('#dashboard-screen');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const ticketList = document.querySelector('#ticket-list');
const detailPanel = document.querySelector('#ticket-detail-panel');
const searchInput = document.querySelector('#search-input');
const statusFilter = document.querySelector('#status-filter');
const categoryFilter = document.querySelector('#category-filter');
let selectedCode = null;
let currentTickets = [];
let searchTimer = null;

const STATUS_LABELS = { new: 'Nuevo', in_progress: 'En proceso', waiting: 'En espera', resolved: 'Resuelto' };
const CATEGORY_LABELS = { technical: 'Soporte técnico', incident: 'Incidente', request: 'Solicitud', billing: 'Administrativo', other: 'Otro' };
const PRIORITY_LABELS = { low: 'Baja', normal: 'Normal', high: 'Alta' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  if (response.status === 401 && !url.endsWith('/login') && !url.endsWith('/me')) {
    showLogin();
    throw new Error('La sesión expiró. Iniciá sesión nuevamente.');
  }
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || 'No se pudo completar la operación.');
  return result;
}

function showLogin() {
  dashboardScreen.hidden = true;
  loginScreen.hidden = false;
  selectedCode = null;
}

function showDashboard() {
  loginScreen.hidden = true;
  dashboardScreen.hidden = false;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible';
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusBadge(status) {
  return element('span', `status-badge status-${status}`, STATUS_LABELS[status] || status);
}

function priorityBadge(priority) {
  return element('span', `priority-label priority-${priority}`, `Prioridad ${PRIORITY_LABELS[priority] || priority}`);
}

function updateStats(stats) {
  document.querySelector('#stat-total').textContent = stats.total;
  document.querySelector('#stat-new').textContent = stats.new_count;
  document.querySelector('#stat-progress').textContent = stats.in_progress_count;
  document.querySelector('#stat-resolved').textContent = stats.resolved_count;
}

function renderTicketList(tickets) {
  ticketList.replaceChildren();
  if (!tickets.length) {
    const empty = element('div', 'list-empty');
    const icon = element('div', 'list-empty-icon', '—');
    const title = element('strong', '', 'No hay tickets para mostrar');
    const copy = element('p', '', 'Cuando un cliente envíe un requerimiento, aparecerá en esta bandeja.');
    empty.append(icon, title, copy);
    ticketList.append(empty);
    return;
  }

  for (const ticket of tickets) {
    const button = element('button', `ticket-row${ticket.code === selectedCode ? ' is-selected' : ''}`);
    button.type = 'button';
    button.addEventListener('click', () => openTicket(ticket.code));
    const top = element('div', 'ticket-row-top');
    top.append(element('span', 'ticket-code', ticket.code), statusBadge(ticket.status));
    const title = element('strong', 'ticket-row-title', ticket.title);
    const summary = element('p', 'ticket-row-summary', ticket.summary);
    const meta = element('div', 'ticket-row-meta');
    meta.append(element('span', '', ticket.company), element('span', 'meta-separator', '·'), element('span', '', ticket.customer_name));
    const bottom = element('div', 'ticket-row-bottom');
    bottom.append(element('span', 'ticket-type', CATEGORY_LABELS[ticket.category] || ticket.category), element('span', 'ticket-date', formatDate(ticket.created_at)));
    button.append(top, title, summary, meta, bottom);
    ticketList.append(button);
  }
}

function filtersQuery() {
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
  if (statusFilter.value !== 'all') params.set('status', statusFilter.value);
  if (categoryFilter.value !== 'all') params.set('category', categoryFilter.value);
  return params.toString();
}

async function loadTickets() {
  const query = filtersQuery();
  const result = await api(`/api/admin/tickets${query ? `?${query}` : ''}`);
  currentTickets = result.tickets;
  updateStats(result.stats);
  document.querySelector('#ticket-count').textContent = `${result.tickets.length} ${result.tickets.length === 1 ? 'solicitud' : 'solicitudes'}`;
  document.querySelector('#list-limit-note').hidden = result.tickets.length < 300;
  renderTicketList(result.tickets);
  if (selectedCode && !result.tickets.some((ticket) => ticket.code === selectedCode)) {
    selectedCode = null;
    renderEmptyDetail();
  } else if (selectedCode) {
    renderTicketList(result.tickets);
  }
}

function renderEmptyDetail() {
  detailPanel.replaceChildren();
  const empty = element('div', 'detail-empty');
  const icon = element('div', 'empty-icon');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path1.setAttribute('d', 'M5 5h14v14H5zM8 9h8M8 13h8M8 17h4'); path1.setAttribute('stroke', 'currentColor'); path1.setAttribute('stroke-width', '1.6'); path1.setAttribute('stroke-linecap', 'round'); path1.setAttribute('stroke-linejoin', 'round');
  svg.append(path1); icon.append(svg);
  empty.append(icon, element('h3', '', 'Seleccioná un ticket'), element('p', '', 'Elegí un requerimiento de la bandeja para consultar sus datos y gestionar su estado.'));
  detailPanel.append(empty);
}

function makeDetailField(label, value, className = '') {
  const wrapper = element('div', `detail-field ${className}`);
  wrapper.append(element('span', 'detail-label', label), element('div', 'detail-value', value || 'No informado'));
  return wrapper;
}

function renderActivity(activity) {
  const section = element('section', 'activity-section');
  const heading = element('div', 'activity-heading');
  heading.append(element('h3', '', 'Actividad interna'), element('span', '', `${activity.length} ${activity.length === 1 ? 'evento' : 'eventos'}`));
  section.append(heading);
  const list = element('div', 'activity-list');
  if (!activity.length) list.append(element('p', 'activity-empty', 'Todavía no hay actividad registrada.'));
  for (const item of activity) {
    const row = element('div', `activity-item activity-${item.kind}`);
    const marker = element('span', 'activity-marker');
    const content = element('div', 'activity-content');
    content.append(element('p', 'activity-message', item.message), element('time', 'activity-time', formatDate(item.created_at)));
    row.append(marker, content);
    list.append(row);
  }
  section.append(list);
  return section;
}

async function openTicket(code) {
  selectedCode = code;
  renderTicketList(currentTickets);
  detailPanel.replaceChildren(element('div', 'detail-loading', 'Cargando ticket…'));
  try {
    const result = await api(`/api/admin/tickets/${encodeURIComponent(code)}`);
    if (selectedCode !== code) return;
    renderTicketDetail(result.ticket, result.activity, result.owner, result.attachments || []);
  } catch (error) {
    detailPanel.replaceChildren(element('div', 'detail-error', error.message));
  }
}

function renderTicketDetail(ticket, activity, owner, attachments = []) {
  detailPanel.replaceChildren();
  const wrapper = element('div', 'detail-content');
  const top = element('div', 'detail-topline');
  top.append(element('span', 'ticket-code', ticket.code), statusBadge(ticket.status));
  const title = element('h2', 'detail-title', ticket.title);
  const subline = element('div', 'detail-subline');
  subline.append(element('span', '', CATEGORY_LABELS[ticket.category] || ticket.category), element('span', 'meta-separator', '·'), element('span', '', `Creado ${formatDate(ticket.created_at)}`));
  const customerCard = element('section', 'customer-card');
  customerCard.append(element('h3', '', 'Datos del contacto'));
  const contactGrid = element('div', 'contact-grid');
  contactGrid.append(makeDetailField('Nombre', ticket.customer_name), makeDetailField('Empresa', ticket.company));
  const emailField = element('div', 'detail-field');
  emailField.append(element('span', 'detail-label', 'Correo electrónico'));
  const emailLink = element('a', 'detail-value detail-link', ticket.email); emailLink.href = `mailto:${ticket.email}`; emailField.append(emailLink);
  contactGrid.append(emailField, makeDetailField('Teléfono', ticket.phone));
  customerCard.append(contactGrid);

  const bodyCard = element('section', 'request-card');
  bodyCard.append(element('h3', '', 'Detalle del requerimiento'));
  bodyCard.append(makeDetailField('Resumen', ticket.summary, 'summary-detail'));
  bodyCard.append(makeDetailField('Descripción', ticket.description, 'description-detail'));

  if (owner) {
    const accountCard = element('section', 'customer-card');
    accountCard.append(element('h3', '', 'Cuenta del portal'));
    const accountGrid = element('div', 'contact-grid');
    accountGrid.append(makeDetailField('Usuario registrado', owner.full_name), makeDetailField('Correo de acceso', owner.email));
    accountCard.append(accountGrid);
    bodyCard.append(accountCard);
  }

  const attachmentCard = element('section', 'request-card');
  attachmentCard.append(element('h3', '', `Imágenes adjuntas (${attachments.length})`));
  if (!attachments.length) attachmentCard.append(element('p', 'activity-empty', 'Este ticket no tiene imágenes adjuntas.'));
  else {
    const gallery = element('div', 'attachment-gallery');
    for (const attachment of attachments) {
      const link = element('a');
      link.href = `/api/admin/tickets/${encodeURIComponent(ticket.code)}/attachments/${attachment.id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = element('img'); img.src = link.href; img.alt = attachment.original_name || 'Imagen adjunta';
      link.append(img, element('span', '', attachment.original_name));
      gallery.append(link);
    }
    attachmentCard.append(gallery);
  }

  const management = element('section', 'management-card');
  management.append(element('h3', '', 'Gestión del ticket'));
  const managementForm = element('form', 'management-form');
  const statusWrap = element('div', 'management-field');
  statusWrap.append(element('label', '', 'Estado'));
  const statusSelect = element('select');
  statusSelect.name = 'status';
  for (const [value, label] of Object.entries(STATUS_LABELS)) {
    const option = element('option', '', label); option.value = value; statusSelect.append(option);
  }
  statusSelect.value = ticket.status;
  statusWrap.append(statusSelect);
  const priorityWrap = element('div', 'management-field');
  priorityWrap.append(element('label', '', 'Prioridad interna'));
  const prioritySelect = element('select'); prioritySelect.name = 'priority';
  for (const [value, label] of Object.entries(PRIORITY_LABELS)) {
    const option = element('option', '', label); option.value = value; prioritySelect.append(option);
  }
  prioritySelect.value = ticket.priority;
  priorityWrap.append(prioritySelect);
  const saveButton = element('button', 'save-changes-button', 'Guardar cambios'); saveButton.type = 'submit';
  managementForm.append(statusWrap, priorityWrap, saveButton);
  managementForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    saveButton.disabled = true; saveButton.textContent = 'Guardando…';
    try {
      await api(`/api/admin/tickets/${encodeURIComponent(ticket.code)}`, { method: 'PATCH', body: JSON.stringify({ status: statusSelect.value, priority: prioritySelect.value }) });
      await loadTickets();
      await openTicket(ticket.code);
    } catch (error) {
      window.alert(error.message);
      saveButton.disabled = false; saveButton.textContent = 'Guardar cambios';
    }
  });
  management.append(managementForm);

  const noteSection = element('section', 'note-section');
  noteSection.append(element('h3', '', 'Agregar nota interna'));
  const noteForm = element('form', 'note-form');
  const noteText = element('textarea', '', '');
  noteText.name = 'note'; noteText.rows = 3; noteText.maxLength = 3000; noteText.placeholder = 'Escribí una observación para el equipo. El cliente no puede ver estas notas.'; noteText.required = true;
  const noteActions = element('div', 'note-actions');
  noteActions.append(element('small', '', 'Visible solo en administración'));
  const noteButton = element('button', 'note-button', 'Guardar nota'); noteButton.type = 'submit'; noteActions.append(noteButton);
  noteForm.append(noteText, noteActions);
  noteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const note = noteText.value.trim();
    if (!note) return;
    noteButton.disabled = true; noteButton.textContent = 'Guardando…';
    try {
      await api(`/api/admin/tickets/${encodeURIComponent(ticket.code)}/notes`, { method: 'POST', body: JSON.stringify({ note }) });
      await openTicket(ticket.code);
    } catch (error) {
      window.alert(error.message);
      noteButton.disabled = false; noteButton.textContent = 'Guardar nota';
    }
  });
  noteSection.append(noteForm);

  wrapper.append(top, title, subline, customerCard, bodyCard, attachmentCard, management, noteSection, renderActivity(activity));
  detailPanel.append(wrapper);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  const password = document.querySelector('#admin-password').value;
  const button = loginForm.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    document.querySelector('#admin-password').value = '';
    showDashboard();
    await loadTickets();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* La sesión puede haber expirado. */ }
  showLogin();
});

document.querySelector('#refresh-button').addEventListener('click', async () => {
  const button = document.querySelector('#refresh-button');
  button.disabled = true;
  try { await loadTickets(); if (selectedCode) await openTicket(selectedCode); }
  catch (error) { window.alert(error.message); }
  finally { button.disabled = false; }
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadTickets().catch((error) => window.alert(error.message)), 260);
});
statusFilter.addEventListener('change', () => loadTickets().catch((error) => window.alert(error.message)));
categoryFilter.addEventListener('change', () => loadTickets().catch((error) => window.alert(error.message)));

document.querySelector('#export-button').addEventListener('click', () => {
  const query = filtersQuery();
  window.location.href = `/api/admin/export.csv${query ? `?${query}` : ''}`;
});

(async function init() {
  try {
    const result = await api('/api/admin/me');
    if (result.authenticated) {
      showDashboard();
      await loadTickets();
    } else showLogin();
  } catch {
    showLogin();
  }
})();
