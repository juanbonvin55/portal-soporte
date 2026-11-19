'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'soporte.sqlite');
const ADMIN_COOKIE = 'support_admin';
const CUSTOMER_COOKIE = 'support_customer';
const ADMIN_SESSION_HOURS = 8;
const CUSTOMER_SESSION_DAYS = 7;
const MAX_JSON_BYTES = 24 * 1024;
const MAX_MULTIPART_BYTES = 14 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_FILES = 4;
const MIN_CUSTOMER_PASSWORD = 12;
let PORT = Number(process.env.PORT || 3000);

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

function ensureLocalConfiguration() {
  loadEnvFile();
  PORT = Number(process.env.PORT || 3000);
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) throw new Error('En producción configurá ADMIN_PASSWORD y SESSION_SECRET como variables de entorno.');
  } else if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    const password = randomToken(18);
    const secret = randomToken(48);
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `ADMIN_PASSWORD=${password}\nSESSION_SECRET=${secret}\nPORT=${PORT}\nNODE_ENV=development\n`, { mode: 0o600, flag: 'wx' });
      process.env.ADMIN_PASSWORD = password;
      process.env.SESSION_SECRET = secret;
      console.log('\nCONFIGURACIÓN INICIAL CREADA');
      console.log('Usuario del panel: administrador');
      console.log(`Contraseña inicial: ${password}`);
      console.log('Guardá esta contraseña. También quedó almacenada en el archivo .env local.\n');
    } else {
      throw new Error('Faltan ADMIN_PASSWORD o SESSION_SECRET en .env. Revisá ese archivo.');
    }
  }
  if (String(process.env.ADMIN_PASSWORD).length < 14) throw new Error('ADMIN_PASSWORD debe tener al menos 14 caracteres.');
  if (String(process.env.SESSION_SECRET).length < 32) throw new Error('SESSION_SECRET debe tener al menos 32 caracteres.');
}

ensureLocalConfiguration();
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT debe ser un número entre 1 y 65535.');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS customer_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    company TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES customer_users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    company TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    description TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);
  CREATE TABLE IF NOT EXISTS ticket_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_activity_ticket ON ticket_activity(ticket_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS ticket_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id, id);
`);

// Migración compatible con la base SQLite creada por la versión 1.0.0.
const ticketColumns = db.prepare('PRAGMA table_info(tickets)').all().map((column) => column.name);
if (!ticketColumns.includes('owner_user_id')) {
  db.exec('ALTER TABLE tickets ADD COLUMN owner_user_id INTEGER REFERENCES customer_users(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(owner_user_id, created_at DESC)');

const ALLOWED_CATEGORIES = new Set(['technical', 'incident', 'request', 'billing', 'other']);
const ALLOWED_STATUSES = new Set(['new', 'in_progress', 'waiting', 'resolved']);
const ALLOWED_PRIORITIES = new Set(['low', 'normal', 'high']);
const rateBuckets = new Map();

function commonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

function cookieString(name, value, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}
function clearCookie(name) { return cookieString(name, '', 0); }

function createAdminSessionCookie() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  return cookieString(ADMIN_COOKIE, `${payload}.${signature}`, ADMIN_SESSION_HOURS * 60 * 60);
}

function isAdmin(req) {
  const token = getCookie(req, ADMIN_COOKIE);
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch { return false; }
}

function customerFromRequest(req) {
  const token = getCookie(req, CUSTOMER_COOKIE);
  if (!token || token.length > 200) return null;
  const row = db.prepare(`
    SELECT u.id, u.full_name, u.company, u.email
    FROM customer_sessions s JOIN customer_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), new Date().toISOString());
  return row || null;
}

function createCustomerSession(userId) {
  const token = randomToken(32);
  const now = new Date();
  const expiry = new Date(now.getTime() + CUSTOMER_SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare('INSERT INTO customer_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, expiry.toISOString(), now.toISOString());
  return cookieString(CUSTOMER_COOKIE, token, CUSTOMER_SESSION_DAYS * 24 * 60 * 60);
}

function getClientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded && forwarded.length <= 64) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function allowRate(req, key, limit, windowMs) {
  const now = Date.now();
  const id = `${key}:${getClientIp(req)}`;
  let bucket = rateBuckets.get(id);
  if (!bucket || now - bucket.startedAt >= windowMs) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  rateBuckets.set(id, bucket);
  if (rateBuckets.size > 5000) {
    for (const [entryKey, value] of rateBuckets) if (now - value.startedAt > 60 * 60 * 1000) rateBuckets.delete(entryKey);
  }
  return bucket.count <= limit;
}

async function readRawBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('El contenido supera el tamaño permitido.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const error = new Error('Se esperaba contenido JSON.'); error.status = 415; throw error;
  }
  try {
    const parsed = JSON.parse((await readRawBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Formato incorrecto.');
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    const invalid = new Error('El contenido enviado no es válido.'); invalid.status = 400; throw invalid;
  }
}

function parseMultipart(buffer, contentType) {
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    const error = new Error('El formulario de archivos no tiene un formato válido.'); error.status = 415; throw error;
  }
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || '').trim();
  if (!boundary || boundary.length > 70 || /[^0-9A-Za-z'()+_,\-./:=? ]/.test(boundary)) {
    const error = new Error('El límite del formulario no es válido.'); error.status = 400; throw error;
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const marker = Buffer.from(`\r\n--${boundary}`);
  const crlf = Buffer.from('\r\n');
  const headerEnd = Buffer.from('\r\n\r\n');
  const fields = Object.create(null);
  const files = [];
  let cursor = 0;
  let parts = 0;
  if (!buffer.subarray(0, delimiter.length).equals(delimiter)) {
    const error = new Error('El formulario no es válido.'); error.status = 400; throw error;
  }
  cursor = delimiter.length;
  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (!buffer.subarray(cursor, cursor + 2).equals(crlf)) {
      const error = new Error('No se pudo interpretar el formulario.'); error.status = 400; throw error;
    }
    cursor += 2;
    const headersAt = buffer.indexOf(headerEnd, cursor);
    if (headersAt < 0 || headersAt - cursor > 8192) {
      const error = new Error('Los encabezados de un archivo no son válidos.'); error.status = 400; throw error;
    }
    const headerText = buffer.toString('latin1', cursor, headersAt);
    const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const fieldName = disposition.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
    const filenameMatch = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i);
    const mimeType = (headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '').trim().toLowerCase();
    if (!fieldName || fieldName.length > 80) {
      const error = new Error('El formulario contiene un campo no válido.'); error.status = 400; throw error;
    }
    const dataStart = headersAt + headerEnd.length;
    const nextPart = buffer.indexOf(marker, dataStart);
    if (nextPart < 0) {
      const error = new Error('El formulario está incompleto.'); error.status = 400; throw error;
    }
    const partData = buffer.subarray(dataStart, nextPart);
    parts += 1;
    if (parts > 30) {
      const error = new Error('El formulario tiene demasiados campos.'); error.status = 413; throw error;
    }
    if (filenameMatch) {
      const fileName = filenameMatch[1];
      if (fileName && partData.length) files.push({ fieldName, fileName, mimeType, buffer: partData });
    } else {
      if (Object.hasOwn(fields, fieldName)) {
        const error = new Error('El formulario contiene campos repetidos.'); error.status = 400; throw error;
      }
      fields[fieldName] = partData.toString('utf8');
    }
    cursor = nextPart + marker.length;
  }
  return { fields, files };
}

async function readMultipart(req) {
  const contentType = String(req.headers['content-type'] || '');
  const body = await readRawBody(req, MAX_MULTIPART_BYTES);
  return parseMultipart(body, contentType);
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\u0000/g, '').slice(0, maxLength);
}
function emailIsValid(value) { return value.length <= 180 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function createTicketCode() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `SR-${date}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function findTicket(code) { return db.prepare('SELECT * FROM tickets WHERE code = ?').get(code); }
function getTicketActivity(ticketId, includePrivate = true) {
  const sql = includePrivate
    ? 'SELECT kind, message, created_at FROM ticket_activity WHERE ticket_id = ? ORDER BY id DESC'
    : "SELECT kind, message, created_at FROM ticket_activity WHERE ticket_id = ? AND kind != 'note' ORDER BY id DESC";
  return db.prepare(sql).all(ticketId);
}
function getAttachments(ticketId) {
  return db.prepare('SELECT id, original_name, mime_type, size_bytes, created_at FROM ticket_attachments WHERE ticket_id = ? ORDER BY id').all(ticketId);
}

function getAdminTicketList(url, limit = 300) {
  const search = cleanString(url.searchParams.get('q') || '', 120);
  const status = url.searchParams.get('status') || 'all';
  const category = url.searchParams.get('category') || 'all';
  const clauses = [];
  const params = [];
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push("(t.code LIKE ? ESCAPE '\\' OR t.customer_name LIKE ? ESCAPE '\\' OR t.company LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR t.email LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')");
    params.push(term, term, term, term, term, term);
  }
  if (ALLOWED_STATUSES.has(status)) { clauses.push('t.status = ?'); params.push(status); }
  if (ALLOWED_CATEGORIES.has(category)) { clauses.push('t.category = ?'); params.push(category); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const tickets = db.prepare(`
    SELECT t.code, t.customer_name, t.company, t.email, t.category, t.title, t.summary,
      t.priority, t.status, t.created_at, t.updated_at, u.email AS account_email
    FROM tickets t LEFT JOIN customer_users u ON u.id = t.owner_user_id
    ${where} ORDER BY t.created_at DESC LIMIT ${limit}
  `).all(...params);
  const statsRow = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting_count,
      SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved_count
    FROM tickets`).get();
  return { tickets, stats: Object.fromEntries(Object.entries(statsRow).map(([key, value]) => [key, Number(value || 0)])) };
}

function csvCell(value) {
  let raw = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(raw)) raw = `'${raw}`;
  return `"${raw.replaceAll('"', '""')}"`;
}
function sendCsv(res, tickets) {
  const headings = ['Código', 'Creado', 'Estado', 'Prioridad', 'Tipo', 'Nombre', 'Empresa', 'Correo', 'Título', 'Resumen', 'Descripción'];
  const rows = tickets.map((ticket) => [ticket.code, ticket.created_at, ticket.status, ticket.priority, ticket.category, ticket.customer_name, ticket.company, ticket.email, ticket.title, ticket.summary, ticket.description].map(csvCell).join(','));
  const csv = '\uFEFF' + [headings.map(csvCell).join(','), ...rows].join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tickets-soporte.csv"', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(csv) });
  res.end(csv);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = await scryptAsync(password, salt);
  return { salt, hash: hash.toString('base64url') };
}
async function verifyPassword(password, salt, expectedHash) {
  const candidate = await scryptAsync(password, salt);
  return safeEqual(candidate, Buffer.from(expectedHash, 'base64url'));
}
function publicUser(user) { return { id: Number(user.id), name: user.full_name, company: user.company, email: user.email }; }

function safeOriginalName(name) {
  const base = path.basename(String(name).replaceAll('\\', '/'));
  return base.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '_').slice(0, 120) || 'imagen';
}
function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: 'image/png', extension: '.png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', extension: '.jpg' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: '.webp' };
  return null;
}
function saveImageAttachments(ticketId, files, userId) {
  if (!files.length) return [];
  if (files.length > MAX_IMAGE_FILES) {
    const error = new Error(`Podés adjuntar hasta ${MAX_IMAGE_FILES} imágenes por envío.`); error.status = 413; throw error;
  }
  let total = 0;
  const saved = [];
  try {
    for (const file of files) {
      if (file.fieldName !== 'images') {
        const error = new Error('Solo se permite adjuntar imágenes en el campo correspondiente.'); error.status = 422; throw error;
      }
      if (file.buffer.length > MAX_IMAGE_BYTES) {
        const error = new Error('Cada imagen puede pesar como máximo 4 MB.'); error.status = 413; throw error;
      }
      total += file.buffer.length;
      if (total > MAX_TOTAL_IMAGE_BYTES) {
        const error = new Error('El peso total de las imágenes supera el límite de 12 MB.'); error.status = 413; throw error;
      }
      const image = detectImage(file.buffer);
      if (!image || (file.mimeType && file.mimeType !== image.mime && !(image.mime === 'image/jpeg' && file.mimeType === 'image/jpg'))) {
        const error = new Error('Uno de los archivos no es una imagen PNG, JPG o WebP válida.'); error.status = 422; throw error;
      }
      const storedName = `${crypto.randomUUID()}${image.extension}`;
      const filePath = path.join(UPLOAD_DIR, storedName);
      fs.writeFileSync(filePath, file.buffer, { flag: 'wx', mode: 0o600 });
      saved.push(filePath);
      db.prepare(`INSERT INTO ticket_attachments (ticket_id, original_name, stored_name, mime_type, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(ticketId, safeOriginalName(file.fileName), storedName, image.mime, file.buffer.length, new Date().toISOString());
    }
    return saved;
  } catch (error) {
    for (const filePath of saved) { try { fs.unlinkSync(filePath); } catch { /* limpieza best-effort */ } }
    throw error;
  }
}

function serveAttachment(res, attachment) {
  const filePath = path.join(UPLOAD_DIR, attachment.stored_name);
  let content;
  try { content = fs.readFileSync(filePath); }
  catch { return json(res, 404, { error: 'No se encontró el archivo adjunto.' }); }
  res.writeHead(200, {
    'Content-Type': attachment.mime_type,
    'Content-Length': content.length,
    'Content-Disposition': `inline; filename="${attachment.mime_type === 'image/png' ? 'imagen.png' : attachment.mime_type === 'image/webp' ? 'imagen.webp' : 'imagen.jpg'}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(content);
}
function notFound(res) { return json(res, 404, { error: 'No se encontró el recurso solicitado.' }); }
function validationError(res, errors) { return json(res, 422, { error: 'Revisá los campos indicados.', fields: errors }); }

function validateRegistration(body) {
  const user = {
    name: cleanString(body.name, 120),
    company: cleanString(body.company, 120),
    email: cleanString(body.email, 180).toLowerCase(),
    password: typeof body.password === 'string' ? body.password : ''
  };
  const errors = {};
  if (user.name.length < 2) errors.name = 'Ingresá tu nombre y apellido.';
  if (user.company.length < 2) errors.company = 'Ingresá el nombre de tu empresa.';
  if (!emailIsValid(user.email)) errors.email = 'Ingresá un correo electrónico válido.';
  if (user.password.length < MIN_CUSTOMER_PASSWORD || user.password.length > 128) errors.password = `La contraseña debe tener entre ${MIN_CUSTOMER_PASSWORD} y 128 caracteres.`;
  return { user, errors };
}

async function handleAuth(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!allowRate(req, 'customer-register', 5, 60 * 60 * 1000)) return json(res, 429, { error: 'Se alcanzó el límite de registros desde esta conexión. Probá más tarde.' });
    const body = await readJson(req);
    const { user, errors } = validateRegistration(body);
    if (Object.keys(errors).length) return validationError(res, errors);
    if (db.prepare('SELECT id FROM customer_users WHERE email = ? COLLATE NOCASE').get(user.email)) return json(res, 409, { error: 'Ya existe una cuenta con ese correo electrónico.' });
    const credentials = await hashPassword(user.password);
    const now = new Date().toISOString();
    let result;
    try {
      result = db.prepare('INSERT INTO customer_users (full_name, company, email, password_salt, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(user.name, user.company, user.email, credentials.salt, credentials.hash, now, now);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Ya existe una cuenta con ese correo electrónico.' });
      throw error;
    }
    const account = db.prepare('SELECT id, full_name, company, email FROM customer_users WHERE id = ?').get(Number(result.lastInsertRowid));
    return json(res, 201, { ok: true, user: publicUser(account) }, { 'Set-Cookie': createCustomerSession(account.id) });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!allowRate(req, 'customer-login', 10, 15 * 60 * 1000)) return json(res, 429, { error: 'Demasiados intentos. Esperá unos minutos y volvé a probar.' });
    const body = await readJson(req);
    const email = cleanString(body.email, 180).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const account = db.prepare('SELECT * FROM customer_users WHERE email = ? COLLATE NOCASE').get(email);
    const valid = account && password.length <= 128 ? await verifyPassword(password, account.password_salt, account.password_hash) : false;
    if (!valid) return json(res, 401, { error: 'El correo o la contraseña no son correctos.' });
    return json(res, 200, { ok: true, user: publicUser(account) }, { 'Set-Cookie': createCustomerSession(account.id) });
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = customerFromRequest(req);
    return json(res, 200, user ? { authenticated: true, user: publicUser(user) } : { authenticated: false });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = getCookie(req, CUSTOMER_COOKIE);
    if (token) db.prepare('DELETE FROM customer_sessions WHERE token_hash = ?').run(sha256(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(CUSTOMER_COOKIE) });
  }

  const user = customerFromRequest(req);
  if (pathname === '/api/auth/profile' && req.method === 'PATCH') {
    if (!user) { req.resume(); return json(res, 401, { error: 'Iniciá sesión para continuar.' }); }
    const body = await readJson(req);
    const name = cleanString(body.name, 120);
    const company = cleanString(body.company, 120);
    const email = cleanString(body.email, 180).toLowerCase();
    const errors = {};
    if (name.length < 2) errors.name = 'Ingresá tu nombre y apellido.';
    if (company.length < 2) errors.company = 'Ingresá el nombre de tu empresa.';
    if (!emailIsValid(email)) errors.email = 'Ingresá un correo electrónico válido.';
    const duplicate = db.prepare('SELECT id FROM customer_users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, user.id);
    if (duplicate) errors.email = 'Ese correo ya está asociado a otra cuenta.';
    if (Object.keys(errors).length) return validationError(res, errors);
    db.prepare('UPDATE customer_users SET full_name = ?, company = ?, email = ?, updated_at = ? WHERE id = ?').run(name, company, email, new Date().toISOString(), user.id);
    return json(res, 200, { ok: true, user: publicUser(db.prepare('SELECT id, full_name, company, email FROM customer_users WHERE id = ?').get(user.id)) });
  }

  if (pathname === '/api/auth/password' && req.method === 'POST') {
    if (!user) { req.resume(); return json(res, 401, { error: 'Iniciá sesión para continuar.' }); }
    if (!allowRate(req, 'customer-password', 5, 60 * 60 * 1000)) return json(res, 429, { error: 'Se alcanzó el límite de cambios de contraseña. Probá más tarde.' });
    const body = await readJson(req);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    const account = db.prepare('SELECT * FROM customer_users WHERE id = ?').get(user.id);
    const valid = await verifyPassword(currentPassword, account.password_salt, account.password_hash);
    if (!valid) return json(res, 401, { error: 'La contraseña actual no es correcta.' });
    if (newPassword.length < MIN_CUSTOMER_PASSWORD || newPassword.length > 128) return json(res, 422, { error: `La nueva contraseña debe tener entre ${MIN_CUSTOMER_PASSWORD} y 128 caracteres.` });
    const credentials = await hashPassword(newPassword);
    db.prepare('UPDATE customer_users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(credentials.salt, credentials.hash, new Date().toISOString(), user.id);
    db.prepare('DELETE FROM customer_sessions WHERE user_id = ?').run(user.id);
    return json(res, 200, { ok: true }, { 'Set-Cookie': createCustomerSession(user.id) });
  }
  return null;
}

function customerTicketList(userId) {
  return db.prepare(`SELECT code, category, title, summary, priority, status, created_at, updated_at
    FROM tickets WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 200`).all(userId);
}

async function createOrUpdateCustomerTicket(req, res, user, method, code = null) {
  if (!allowRate(req, method === 'POST' ? 'customer-ticket-create' : 'customer-ticket-update', 20, 10 * 60 * 1000)) {
    return json(res, 429, { error: 'Se alcanzó el límite temporal de operaciones. Probá nuevamente más tarde.' });
  }
  const parsed = await readMultipart(req);
  const body = parsed.fields;
  if (cleanString(body.website, 200)) return json(res, 201, { ok: true, code: createTicketCode() });
  const ticket = {
    customer_name: cleanString(body.name, 120),
    company: cleanString(body.company, 120),
    email: cleanString(body.email, 180).toLowerCase(),
    phone: cleanString(body.phone, 40),
    category: cleanString(body.category, 30),
    title: cleanString(body.title, 100),
    summary: cleanString(body.summary, 180),
    description: cleanString(body.description, 5000)
  };
  const errors = {};
  if (method === 'POST') {
    if (ticket.customer_name.length < 2) errors.name = 'Ingresá tu nombre y apellido.';
    if (ticket.company.length < 2) errors.company = 'Ingresá el nombre de tu empresa.';
    if (!emailIsValid(ticket.email)) errors.email = 'Ingresá un correo electrónico válido.';
    if (!ALLOWED_CATEGORIES.has(ticket.category)) errors.category = 'Seleccioná un tipo de requerimiento.';
    if (body.privacyAccepted !== 'true') errors.privacyAccepted = 'Debés aceptar el aviso de privacidad para continuar.';
    if (ticket.title.length < 5) errors.title = 'El título debe tener al menos 5 caracteres.';
    if (ticket.summary.length < 5) errors.summary = 'El resumen debe tener al menos 5 caracteres.';
    if (ticket.description.length < 15) errors.description = 'La descripción debe tener al menos 15 caracteres.';
  } else {
    if (ticket.title.length < 5) errors.title = 'El título debe tener al menos 5 caracteres.';
    if (ticket.summary.length < 5) errors.summary = 'El resumen debe tener al menos 5 caracteres.';
    if (ticket.description.length < 15) errors.description = 'La descripción debe tener al menos 15 caracteres.';
    if (!ALLOWED_CATEGORIES.has(ticket.category)) errors.category = 'Seleccioná un tipo de requerimiento.';
  }
  if (Object.keys(errors).length) return validationError(res, errors);
  if (parsed.files.some((file) => file.fieldName !== 'images')) return json(res, 422, { error: 'Solo se permite adjuntar imágenes en el campo correspondiente.' });

  if (method === 'POST') {
    const now = new Date().toISOString();
    const ticketCode = createTicketCode();
    const createdFiles = [];
    db.exec('BEGIN');
    try {
      const result = db.prepare(`INSERT INTO tickets (code, customer_name, company, email, phone, category, title, summary, description, priority, status, created_at, updated_at, owner_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal', 'new', ?, ?, ?)`)
        .run(ticketCode, ticket.customer_name, ticket.company, ticket.email, ticket.phone || null, ticket.category, ticket.title, ticket.summary, ticket.description, now, now, user.id);
      const id = Number(result.lastInsertRowid);
      db.prepare('INSERT INTO ticket_activity (ticket_id, kind, message, created_at) VALUES (?, ?, ?, ?)').run(id, 'system', 'Ticket recibido desde el portal de clientes.', now);
      createdFiles.push(...saveImageAttachments(id, parsed.files, user.id));
      db.exec('COMMIT');
      return json(res, 201, { ok: true, code: ticketCode });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* rollback best effort */ }
      for (const filePath of createdFiles) { try { fs.unlinkSync(filePath); } catch { /* cleanup */ } }
      throw error;
    }
  }

  const existing = db.prepare('SELECT * FROM tickets WHERE code = ? AND owner_user_id = ?').get(code, user.id);
  if (!existing) return notFound(res);
  if (existing.status !== 'new') return json(res, 409, { error: 'Este ticket ya está siendo gestionado o fue resuelto. Por eso no permite modificar su contenido.' });
  const now = new Date().toISOString();
  const createdFiles = [];
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE tickets SET phone = ?, category = ?, title = ?, summary = ?, description = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`)
      .run(ticket.phone || null, ticket.category, ticket.title, ticket.summary, ticket.description, now, existing.id, user.id);
    db.prepare('INSERT INTO ticket_activity (ticket_id, kind, message, created_at) VALUES (?, ?, ?, ?)')
      .run(existing.id, 'customer_update', 'El cliente actualizó la información del ticket.', now);
    createdFiles.push(...saveImageAttachments(existing.id, parsed.files, user.id));
    db.exec('COMMIT');
    return json(res, 200, { ok: true });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* rollback best effort */ }
    for (const filePath of createdFiles) { try { fs.unlinkSync(filePath); } catch { /* cleanup */ } }
    throw error;
  }
}

async function handleCustomerApi(req, res, url) {
  const pathname = url.pathname;
  const authResult = await handleAuth(req, res, url);
  if (authResult !== null) return authResult;
  const user = customerFromRequest(req);

  if (pathname === '/api/tickets' && req.method === 'POST') {
    if (!user) { req.resume(); return json(res, 401, { error: 'Creá una cuenta o iniciá sesión para enviar un requerimiento.' }); }
    return createOrUpdateCustomerTicket(req, res, user, 'POST');
  }

  if (pathname === '/api/customer/tickets' && req.method === 'GET') {
    if (!user) { req.resume(); return json(res, 401, { error: 'Iniciá sesión para consultar tus tickets.' }); }
    return json(res, 200, { tickets: customerTicketList(user.id) });
  }

  const attachmentMatch = pathname.match(/^\/api\/customer\/tickets\/([^/]+)\/attachments\/(\d+)$/);
  if (attachmentMatch && req.method === 'GET') {
    if (!user) { req.resume(); return json(res, 401, { error: 'Iniciá sesión para continuar.' }); }
    const attachment = db.prepare(`SELECT a.* FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id
      WHERE t.code = ? AND t.owner_user_id = ? AND a.id = ?`).get(decodeURIComponent(attachmentMatch[1]), user.id, Number(attachmentMatch[2]));
    if (!attachment) return notFound(res);
    return serveAttachment(res, attachment);
  }

  const customerTicketMatch = pathname.match(/^\/api\/customer\/tickets\/([^/]+)$/);
  if (customerTicketMatch) {
    if (!user) { req.resume(); return json(res, 401, { error: 'Iniciá sesión para continuar.' }); }
    const code = decodeURIComponent(customerTicketMatch[1]);
    const ticket = db.prepare('SELECT * FROM tickets WHERE code = ? AND owner_user_id = ?').get(code, user.id);
    if (!ticket) return notFound(res);
    if (req.method === 'GET') {
      return json(res, 200, {
        ticket,
        attachments: getAttachments(ticket.id),
        activity: getTicketActivity(ticket.id, false),
        editable: ticket.status === 'new'
      });
    }
    if (req.method === 'PATCH') return createOrUpdateCustomerTicket(req, res, user, 'PATCH', code);
  }
  return null;
}

async function handleAdminApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'portal-soporte' });

  if (pathname === '/api/admin/login' && req.method === 'POST') {
    if (!allowRate(req, 'admin-login', 7, 15 * 60 * 1000)) return json(res, 429, { error: 'Demasiados intentos. Esperá unos minutos y volvé a probar.' });
    const body = await readJson(req);
    if (!safeEqual(typeof body.password === 'string' ? body.password : '', process.env.ADMIN_PASSWORD)) return json(res, 401, { error: 'La contraseña ingresada no es correcta.' });
    return json(res, 200, { ok: true }, { 'Set-Cookie': createAdminSessionCookie() });
  }
  if (pathname === '/api/admin/me' && req.method === 'GET') return json(res, isAdmin(req) ? 200 : 401, isAdmin(req) ? { authenticated: true } : { authenticated: false });
  if (pathname === '/api/admin/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(ADMIN_COOKIE) });
  if (!pathname.startsWith('/api/admin/')) return notFound(res);
  if (!isAdmin(req)) { req.resume(); return json(res, 401, { error: 'Tu sesión no está activa. Iniciá sesión nuevamente.' }); }

  if (pathname === '/api/admin/tickets' && req.method === 'GET') return json(res, 200, getAdminTicketList(url));
  if (pathname === '/api/admin/export.csv' && req.method === 'GET') {
    const result = getAdminTicketList(url, 10000);
    const codes = result.tickets.map((item) => item.code);
    const fullTickets = codes.length ? db.prepare(`SELECT * FROM tickets WHERE code IN (${codes.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...codes) : [];
    return sendCsv(res, fullTickets);
  }

  const attachmentMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/attachments\/(\d+)$/);
  if (attachmentMatch && req.method === 'GET') {
    const attachment = db.prepare(`SELECT a.* FROM ticket_attachments a JOIN tickets t ON t.id = a.ticket_id
      WHERE t.code = ? AND a.id = ?`).get(decodeURIComponent(attachmentMatch[1]), Number(attachmentMatch[2]));
    if (!attachment) return notFound(res);
    return serveAttachment(res, attachment);
  }

  const noteMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)\/notes$/);
  if (noteMatch && req.method === 'POST') {
    const ticket = findTicket(decodeURIComponent(noteMatch[1]));
    if (!ticket) return notFound(res);
    const body = await readJson(req);
    const note = cleanString(body.note, 3000);
    if (note.length < 2) return json(res, 422, { error: 'La nota debe tener al menos 2 caracteres.' });
    const now = new Date().toISOString();
    db.prepare('INSERT INTO ticket_activity (ticket_id, kind, message, created_at) VALUES (?, ?, ?, ?)').run(ticket.id, 'note', note, now);
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, ticket.id);
    return json(res, 201, { ok: true });
  }

  const detailMatch = pathname.match(/^\/api\/admin\/tickets\/([^/]+)$/);
  if (detailMatch && req.method === 'GET') {
    const ticket = findTicket(decodeURIComponent(detailMatch[1]));
    if (!ticket) return notFound(res);
    const owner = ticket.owner_user_id ? db.prepare('SELECT id, full_name, company, email FROM customer_users WHERE id = ?').get(ticket.owner_user_id) : null;
    return json(res, 200, { ticket, owner, attachments: getAttachments(ticket.id), activity: getTicketActivity(ticket.id) });
  }
  if (detailMatch && req.method === 'PATCH') {
    const ticket = findTicket(decodeURIComponent(detailMatch[1]));
    if (!ticket) return notFound(res);
    const body = await readJson(req);
    const updates = [];
    const values = [];
    const changes = [];
    if (body.status !== undefined) {
      if (!ALLOWED_STATUSES.has(body.status)) return json(res, 422, { error: 'Estado no válido.' });
      if (body.status !== ticket.status) { updates.push('status = ?'); values.push(body.status); changes.push(['status', `Estado actualizado a: ${body.status}`]); }
    }
    if (body.priority !== undefined) {
      if (!ALLOWED_PRIORITIES.has(body.priority)) return json(res, 422, { error: 'Prioridad no válida.' });
      if (body.priority !== ticket.priority) { updates.push('priority = ?'); values.push(body.priority); changes.push(['system', `Prioridad actualizada a: ${body.priority}`]); }
    }
    if (!updates.length) return json(res, 200, { ok: true, unchanged: true });
    const now = new Date().toISOString();
    updates.push('updated_at = ?'); values.push(now, ticket.id);
    db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const addActivity = db.prepare('INSERT INTO ticket_activity (ticket_id, kind, message, created_at) VALUES (?, ?, ?, ?)');
    for (const [kind, message] of changes) addActivity.run(ticket.id, kind, message, now);
    return json(res, 200, { ok: true });
  }
  return notFound(res);
}

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: 'Ruta inválida.' }); }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  if (pathname === '/privacidad' || pathname === '/privacidad/') pathname = '/privacidad.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) return notFound(res);
  let content;
  try { if (!fs.statSync(filePath).isFile()) return notFound(res); content = fs.readFileSync(filePath); }
  catch { return notFound(res); }
  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream', 'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=300', 'Content-Length': content.length });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  commonHeaders(res);
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { error: 'Solicitud inválida.' }); }
  try {
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'portal-soporte' });
    if (url.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      const customerResult = await handleCustomerApi(req, res, url);
      if (customerResult !== null) return customerResult;
      return notFound(res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Método no permitido.' });
    return serveStatic(req, res, url);
  } catch (error) {
    console.error('Error de solicitud:', error);
    if (!res.headersSent) return json(res, error.status || 500, { error: error.status ? error.message : 'Ocurrió un error interno. Revisá la consola del servidor.' });
    return res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nPortal de soporte iniciado.');
  console.log(`Portal de clientes: http://localhost:${PORT}`);
  console.log(`Panel administrativo: http://localhost:${PORT}/admin`);
  console.log(`Base de datos: ${DB_PATH}`);
  console.log('Cuentas de clientes: registro e inicio de sesión desde el portal.');
  console.log('Para detenerlo, presioná Ctrl + C.\n');
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
