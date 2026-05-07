import { uuid, parseDuration } from './utils.js';

/**
 * Parse a CSV string into slot objects.
 * Expected columns: Name, Title, Duration, Notes (header optional)
 * @param {string} text
 * @returns {Array<{id,name,title,durationSec,operatorNotes}>}
 */
export function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('Empty CSV');

  const HEADER_PATTERNS = ['name', 'title', 'duration', 'notes'];
  const firstRow = lines[0].split(',').map(c => c.trim().toLowerCase());
  const isHeader = HEADER_PATTERNS.some(p => firstRow.includes(p));

  const dataLines = isHeader ? lines.slice(1) : lines;

  return dataLines
    .filter(l => l.trim())
    .map(line => parseCSVLine(line));
}

function parseCSVLine(line) {
  const cols = splitCSVRow(line);
  const name = (cols[0] || '').trim();
  const title = (cols[1] || '').trim();
  const durationRaw = (cols[2] || '').trim();
  const operatorNotes = (cols[3] || '').trim();

  if (!name) throw new Error(`Row missing name: ${line}`);

  const durationSec = parseDuration(durationRaw);
  if (isNaN(durationSec) || durationSec <= 0) {
    throw new Error(`Invalid duration "${durationRaw}" for "${name}"`);
  }

  return { id: uuid(), name, title, durationSec, operatorNotes };
}

function splitCSVRow(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

/**
 * Parse a JSON array of slot objects.
 * @param {string} text
 * @returns {Array<{id,name,title,durationSec,operatorNotes}>}
 */
export function parseJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON'); }

  if (!Array.isArray(data)) throw new Error('JSON must be an array of speaker objects');

  return data.map((item, i) => {
    const name = String(item.name || '').trim();
    if (!name) throw new Error(`Item ${i} missing "name"`);

    let durationSec;
    if (typeof item.durationSec === 'number') {
      durationSec = item.durationSec;
    } else if (item.duration) {
      durationSec = parseDuration(String(item.duration));
    } else {
      throw new Error(`Item ${i} (${name}) missing duration`);
    }

    if (isNaN(durationSec) || durationSec <= 0) {
      throw new Error(`Item ${i} (${name}) has invalid duration`);
    }

    return {
      id: uuid(),
      name,
      title: String(item.title || '').trim(),
      durationSec,
      operatorNotes: String(item.operatorNotes || item.notes || '').trim(),
    };
  });
}

/**
 * Auto-detect format and parse
 * @param {string} text
 * @returns {Array}
 */
export function parseSchedule(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseJSON(trimmed);
  }
  return parseCSV(trimmed);
}

/**
 * Create a blank slot with defaults
 * @param {Partial<object>} overrides
 * @returns {object}
 */
export function createSlot(overrides = {}) {
  return {
    id: uuid(),
    name: '',
    title: '',
    durationSec: 600,
    operatorNotes: '',
    ...overrides,
  };
}
