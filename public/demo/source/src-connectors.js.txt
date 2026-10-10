import { httpRequest } from "./runtime.js";
import { sheetsRequest, sheetsOutput, sheetsMock } from './sheets.js';
export function requestFor(step, p, env) {
  if (step.kind === "http") {
    if(typeof p.url!=='string')throw Error('HTTP destination must resolve to a URL string');
    const destination=new URL(p.url);
    if(!['http:','https:'].includes(destination.protocol)||destination.username||destination.password)throw Error('Invalid HTTP destination. Use an explicit authentication binding.');
    return httpRequest(step, p);
  }
  const token = env[p.connection];
  if (!token)
    throw Error(`Configure ${p.connection} before running this action.`);
  if (step.kind.startsWith('sheets_')) return sheetsRequest(step, p, token);
  if (step.kind === 'slack_join') {
    if (typeof p.channel !== 'string' || !/^C[A-Z0-9]+$/.test(p.channel))
      throw Error('Channel joining requires a public Slack channel ID. Private channels must invite the bot.');
    return { url: 'https://slack.com/api/conversations.join', method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: p.channel }) };
  }
  if (step.kind === "airtable_find") {
    const quote = (v) => JSON.stringify(String(v));
    if (p.field && /[{}\\]/.test(p.field))
      throw Error("Search field must be a field ID or a simple name");
    const field = "{" + p.field + "}",
      value = quote(p.value);
    const formula =
      p.formula ||
      (p.exact
        ? `${field}=${value}`
        : `SEARCH(LOWER(${value}),LOWER(${field}&""))`);
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(p.base)}/${encodeURIComponent(p.table)}`,
    );
    url.searchParams.set("filterByFormula", formula);
    url.searchParams.set("maxRecords", p.multiple === "halt" ? "2" : "1");
    url.searchParams.set("returnFieldsByFieldId", "true");
    if (p.view) url.searchParams.set("view", p.view);
    return {
      url: url.toString(),
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  if (step.kind === "airtable_update") {
    if (typeof p.record !== "string" || !/^rec[A-Za-z0-9_]+$/.test(p.record))
      throw Error("Update requires a record ID");
    return {
      url: `https://api.airtable.com/v0/${encodeURIComponent(p.base)}/${encodeURIComponent(p.table)}/${encodeURIComponent(p.record)}`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: p.fields }),
    };
  }
  if (step.kind === "slack") {
    if (p.reply_broadcast && !p.thread_ts)
      throw Error("Broadcast replies require a thread timestamp");
    if (p.link_names !== undefined && ![0, 1].includes(p.link_names))
      throw Error("Slack link_names must be 0 or 1");
    if (
      typeof p.channel !== "string" ||
      !p.channel ||
      typeof p.text !== "string"
    )
      throw Error("Slack channel and text must resolve to strings.");
    if (
      p.thread_ts !== undefined &&
      (typeof p.thread_ts !== "string" ||
        !/^\d{10,16}\.\d{1,6}$/.test(p.thread_ts))
    )
      throw Error("Slack thread timestamp must resolve to a valid string.");
    for (const k of ["blocks", "attachments"])
      if (p[k] !== undefined && !Array.isArray(p[k]))
        throw Error(`Slack ${k} must resolve to an array.`);
    for (const k of ["unfurl_links", "unfurl_media", "reply_broadcast"])
      if (p[k] !== undefined && typeof p[k] !== "boolean")
        throw Error(`Slack ${k} must resolve to a boolean.`);
  }
  if (step.kind === "slack")
    return {
      url: "https://slack.com/api/chat.postMessage",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: p.channel,
        text: p.text,
        ...Object.fromEntries(
          [
            "thread_ts",
            "blocks",
            "attachments",
            "username",
            "icon_url",
            "icon_emoji",
            "unfurl_links",
            "unfurl_media",
            "reply_broadcast",
            "link_names",
          ]
            .filter((k) => p[k] !== undefined)
            .map((k) => [k, p[k]]),
        ),
        ...(p.unfurl !== undefined
          ? { unfurl_links: p.unfurl, unfurl_media: p.unfurl }
          : {}),
      }),
    };
  if (step.kind === "airtable")
    return {
      url: `https://api.airtable.com/v0/${encodeURIComponent(p.base)}/${encodeURIComponent(p.table)}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields: p.fields }] }),
    };
  throw Error("Action adapter is not implemented.");
}
function recordOutput(record) {
  return {
    ...record,
    ...Object.fromEntries(
      Object.entries(record.fields || {}).map(([k, v]) => ["fields__" + k, v]),
    ),
    _zap_search_was_found_status: true,
  };
}
export function normalizeOutput(step, response, params = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw Error("Expected an object response. Review the output adapter.");
  if (step.kind.startsWith('sheets_')) return sheetsOutput(step, response, params);
  if (step.kind === 'slack_join') {
    if (response.ok !== true) throw Error(`Slack join rejected: ${String(response.error || 'unknown_error').replace(/[^a-z_]/g, '')}`);
    if (response.channel?.id !== params.channel || response.channel?.is_member !== true)
      throw Error('Slack join response did not confirm membership in the requested channel');
    return { channel: response.channel.id, joined: true };
  }
  if (step.kind === "slack") {
    if (response.ok !== true)
      throw Error(
        `Slack rejected the request: ${String(response.error || "unknown_error").replace(/[^a-z_]/g, "")}`,
      );
    if (
      typeof response.ts !== "string" ||
      !/^\d{10,16}\.\d{1,6}$/.test(response.ts) ||
      typeof response.channel !== "string" ||
      !response.channel
    )
      throw Error(
        "Slack success response is missing a valid delivery receipt.",
      );
    return {
      ts: response.ts,
      channel: response.channel,
      message: response.message,
    };
  }
  if (step.kind === "airtable_find") {
    if (!Array.isArray(response.records))
      throw Error("Search response must contain records");
    if (params.multiple === "halt" && response.records.length > 1)
      throw Error("Search found multiple records");
    if (!response.records.length) {
      if (params.on_missing !== "continue")
        throw Error("Search found no record");
      return { _zap_search_was_found_status: false };
    }
    if (!response.records[0]?.id)
      throw Error("Search response has no record identity");
    return recordOutput(response.records[0]);
  }
  if (step.kind === "airtable_update") {
    if (!response.id) throw Error("Update response has no record receipt");
    return recordOutput(response);
  }
  if (step.kind === "airtable") {
    if (!response.records?.[0]?.id)
      throw Error("Airtable response did not include a record receipt.");
    return recordOutput(response.records[0]);
  }
  return response;
}
export function mockResponse(step, p) {
  if (step.kind.startsWith('sheets_')) return sheetsMock(step, p);
  if (step.kind === 'slack_join') return { ok: true, channel: { id: p.channel, is_member: true } };
  if (step.kind === "airtable_find") return { records: [] };
  if (step.kind === "airtable_update")
    return { id: p.record, fields: p.fields };
  if (step.kind === "slack")
    return {
      ok: true,
      ts: "1700000000.000001",
      channel: p.channel,
      message: { text: p.text },
    };
  if (step.kind === "airtable")
    return {
      records: [
        {
          id: "rec_demo_001",
          createdTime: "2026-01-01T00:00:00.000Z",
          fields: p.fields,
        },
      ],
    };
  return { id: "mock-receipt", accepted: true };
}
export function redact(value, env = {}) {
  if (Array.isArray(value)) return value.map((v) => redact(v, env));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /authorization|password|token|secret|api.?key/i.test(k)
          ? "[redacted]"
          : redact(v, env),
      ]),
    );
  if (typeof value === "string") {
    let result = value;
    for (const secret of Object.values(env))
      if (typeof secret === "string" && secret.length > 0)
        result = result.split(secret).join("[redacted]");
    try {
      const u = new URL(result);
      u.username = "";
      u.password = "";
      for (const k of [...u.searchParams.keys()])
        if (/token|key|secret|password/i.test(k))
          u.searchParams.set(k, "[redacted]");
      result = u.toString();
    } catch {}
    return result;
  }
  return value;
}
export async function send(request, hosts) {
  const u = new URL(request.url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !hosts.includes(u.hostname)
  )
    throw Error("Destination is not an approved HTTPS host.");
  // IP destinations are excluded even if mistakenly added to the allowlist.
  if (
    /^[\d.]+$/.test(u.hostname) ||
    u.hostname.includes(":") ||
    u.hostname === "localhost"
  )
    throw Error("Local and IP destinations are not allowed.");
  let response;
  try {
    response = await fetch(u, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Object.assign(
      Error(
        "No response receipt. The request may have reached the destination.",
      ),
      { uncertain: request.method !== "GET" },
    );
  }
  if (!response.ok)
    throw Object.assign(
      Error(`HTTP ${response.status}. Review the destination before retrying.`),
      { uncertain: request.method !== "GET" },
    );
  try {
    return await response.json();
  } catch {
    throw Object.assign(
      Error("The destination returned an unreadable receipt."),
      { uncertain: request.method !== "GET" },
    );
  }
}
