// Sheets writes resolve the exported numeric tab ID before addressing A1 ranges.
// Sparse updates use one range per mapped cell so unmapped cells stay untouched.
export function columnIndex(column) {
  if (!/^[A-Z]{1,3}$/.test(column)) throw Error('Invalid Sheets column');
  let n = 0;
  for (const c of column) n = n * 26 + c.charCodeAt(0) - 64;
  if (n > 1000) throw Error('Sheets mappings are limited to 1000 columns');
  return n - 1;
}
export function sheetsIssue(kind, p) {
  const keys = ['spreadsheet', 'sheet_id', 'connection', 'columns', 'value_input'];
  if (kind === 'sheets_update') keys.push('row');
  if (kind === 'sheets_resolve') keys.splice(3);
  if (Object.keys(p).some(k => !keys.includes(k))) return 'Unknown Sheets parameters need review';
  if (!p.spreadsheet || !p.connection || p.sheet_id === undefined) return 'Set spreadsheet, numeric sheet_id and connection';
  const dynamic = v => typeof v === 'string' && v.includes('{{');
  if (!dynamic(p.sheet_id) && (!/^\d+$/.test(String(p.sheet_id)) || !Number.isSafeInteger(Number(p.sheet_id)))) return 'Sheets sheet_id must be a nonnegative integer';
  if (kind === 'sheets_resolve') return null;
  if (!['RAW', 'USER_ENTERED'].includes(p.value_input)) return 'Choose RAW or USER_ENTERED';
  if (!p.columns || typeof p.columns !== 'object' || Array.isArray(p.columns) || !Object.keys(p.columns).length) return 'Map at least one Sheets column';
  try { Object.keys(p.columns).forEach(columnIndex); } catch (e) { return e.message; }
  if (kind === 'sheets_update' && !dynamic(p.row) && (!/^[1-9]\d*$/.test(String(p.row)) || !Number.isSafeInteger(Number(p.row)))) return 'Sheet updates require a positive row number';
  return null;
}
export function sheetsProposal(n, p) {
  if (!/^GoogleSheetsV2(?:CLI)?API(?:@|$)/.test(String(n.selected_api)) || !['add_row','update_row'].includes(n.action) || n.parent_id == null) return null;
  if (Object.keys(p).some(k => !['spreadsheet','worksheet','row','drive','timezone'].includes(k) && !/^COL\$[A-Z]{1,3}$/.test(k))) return null;
  if (p.drive || ![undefined, false, 'false', 'no', ''].includes(p.timezone)) return null;
  if (n.action === 'add_row' && p.row !== undefined) return null;
  const kind = n.action === 'add_row' ? 'sheets_append' : 'sheets_update';
  const params = { spreadsheet: p.spreadsheet, sheet_id: p.worksheet,
    connection: `GOOGLE_SHEETS_STEP_${n.id}_TOKEN`,
    columns: Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith('COL$')).map(([k,v]) => [k.slice(4),v])),
    value_input: 'USER_ENTERED', ...(kind === 'sheets_update' ? { row: p.row } : {}) };
  if (sheetsIssue(kind, params)) return null;
  return { kind, params, review_required: true, review_notes: 'Verify spreadsheet/tab identity and USER_ENTERED cell interpretation against a sandbox. Provide a fresh Google access token with Sheets scope. Numeric tab IDs are resolved through metadata. Header-name mappings, Drive selection and timezone conversion need separate adapters.' };
}
const titleRange = title => "'" + title.replaceAll("'", "''") + "'";
const cells = columns => Object.entries(columns).sort(([a],[b]) => columnIndex(a) - columnIndex(b));
const scalar = value => {
  if (value === null) return null;
  if (!['string','number','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw Error('Sheets cells require finite scalar values. Map arrays or objects explicitly.');
  return value;
};
export function sheetsRequest(step, p, token) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(p.spreadsheet)}`;
  if (typeof p.spreadsheet !== 'string' || !/^[\w-]+$/.test(p.spreadsheet)) throw Error('Invalid spreadsheet identity');
  if (!/^\d+$/.test(String(p.sheet_id)) || !Number.isSafeInteger(Number(p.sheet_id))) throw Error('Invalid numeric tab identity');
  const headers = { Authorization: `Bearer ${token}` };
  if (step.kind === 'sheets_resolve') return { url: base + '?fields=sheets.properties(sheetId,title)', method: 'GET', headers };
  if (typeof p.sheet_title !== 'string' || !p.sheet_title) throw Error('Resolve the numeric tab ID before writing');
  if (!['RAW','USER_ENTERED'].includes(p.value_input)) throw Error('Invalid cell interpretation mode');
  const entries = cells(p.columns), values = Array(columnIndex(entries.at(-1)[0]) + 1).fill(null);
  for (const [column,value] of entries) values[columnIndex(column)] = scalar(value);
  headers['Content-Type'] = 'application/json';
  if (step.kind === 'sheets_append') {
    const range = `${titleRange(p.sheet_title)}!A:${entries.at(-1)[0]}`;
    const query = new URLSearchParams({ valueInputOption: p.value_input, insertDataOption: 'INSERT_ROWS', includeValuesInResponse: 'true', responseValueRenderOption: 'FORMATTED_VALUE' });
    return { url: base + '/values/' + encodeURIComponent(range) + ':append?' + query, method: 'POST', headers,
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [values] }) };
  }
  if (!/^[1-9]\d*$/.test(String(p.row)) || !Number.isSafeInteger(Number(p.row))) throw Error('Invalid update row');
  return { url: base + '/values:batchUpdate', method: 'POST', headers,
    body: JSON.stringify({ valueInputOption: p.value_input, includeValuesInResponse: true, responseValueRenderOption: 'FORMATTED_VALUE',
      data: entries.map(([column,value]) => ({ range: `${titleRange(p.sheet_title)}!${column}${p.row}`, majorDimension: 'ROWS', values: [[scalar(value)]] })) }) };
}
export function sheetsOutput(step, r, p) {
  if (step.kind === 'sheets_resolve') {
    if (!Array.isArray(r.sheets)) throw Error('Sheets metadata response has no sheets');
    const found = r.sheets.filter(s => s.properties?.sheetId === Number(p.sheet_id));
    if (found.length !== 1 || typeof found[0].properties.title !== 'string' || !found[0].properties.title) throw Error('Exported tab ID was not found uniquely in spreadsheet metadata');
    return { title: found[0].properties.title, sheet_id: Number(p.sheet_id) };
  }
  if (r.spreadsheetId !== p.spreadsheet) throw Error('Sheets receipt belongs to another spreadsheet');
  const entries = cells(p.columns), output = {};
  let row;
  if (step.kind === 'sheets_append') {
    const u = r.updates, match = u?.updatedRange?.match(/^(.+)!A([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/);
    if (!match || (match[1] !== titleRange(p.sheet_title) && match[1] !== p.sheet_title) ||
        match[2] !== (match[4] || match[2]) || (match[3] || 'A') !== entries.at(-1)[0] ||
        u.updatedRows !== 1 || !Array.isArray(u.updatedData?.values?.[0])) throw Error('Sheets append response has no matching one-row receipt');
    row = Number(match[2]);
    for (const [column] of entries) output['COL$' + column] = u.updatedData.values[0][columnIndex(column)] ?? '';
  } else {
    row = Number(p.row);
    if (!Array.isArray(r.responses) || r.responses.length !== entries.length) throw Error('Sheets update response has missing cell receipts');
    entries.forEach(([column],i) => {
      const u = r.responses[i], expected = `${titleRange(p.sheet_title)}!${column}${row}`;
      if ((u.updatedRange !== expected && u.updatedRange !== `${p.sheet_title}!${column}${row}`) || u.updatedRows !== 1 || !Array.isArray(u.updatedData?.values?.[0])) throw Error('Sheets cell receipt does not match the requested cell');
      output['COL$' + column] = u.updatedData.values[0][0] ?? '';
    });
  }
  return { id: String(row), row, ...output };
}
export function sheetsMock(step, p) {
  if (step.kind === 'sheets_resolve') return { sheets: [{ properties: { sheetId: Number(p.sheet_id), title: 'Demo sheet' } }] };
  const entries = cells(p.columns);
  const receipt = (range,values) => ({ updatedRange: range, updatedRows: 1, updatedData: { range, majorDimension: 'ROWS', values: [values] } });
  if (step.kind === 'sheets_append') {
    const values = Array(columnIndex(entries.at(-1)[0])+1).fill('');
    for (const [column,value] of entries) values[columnIndex(column)] = value ?? '';
    return { spreadsheetId: p.spreadsheet, updates: receipt(`${titleRange(p.sheet_title)}!A2:${entries.at(-1)[0]}2`,values) };
  }
  return { spreadsheetId: p.spreadsheet, responses: entries.map(([column,value]) => receipt(`${titleRange(p.sheet_title)}!${column}${p.row}`,[value ?? ''])) };
}
