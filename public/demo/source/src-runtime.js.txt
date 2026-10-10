import { createHash, randomUUID } from "node:crypto";
import { format } from "./logic.js";
const own = (object, key) =>
  object != null && Object.prototype.hasOwnProperty.call(object, key);
export function webhookInput(input, params = {}) {
  if (!params.child_key) return input;
  const key = params.child_key;
  if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !own(input, key))
    throw Error('Webhook child key is missing or unsafe');
  const value = input[key];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Webhook child key must select a JSON object. Array fan-out is not implemented.');
  return value;
}
export function parseReference(expression) {
  const legacy = expression.match(/^(\d+)__(.+)$/);
  if (legacy)
    return {
      step_id: legacy[1],
      path: legacy[2].split("__"),
      flat_path: legacy[2],
    };
  if (!expression.startsWith("=gives")) return null;
  let rest = expression.slice(6).trim();
  const keys = [];
  while (rest) {
    const match = rest.match(/^\[("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\d+)\]/);
    if (!match) return null;
    const token = match[1];
    let key;
    if (token.startsWith('"')) {
      try {
        key = JSON.parse(token);
      } catch {
        return null;
      }
    } else if (token.startsWith("'")) {
      key = "";
      const raw = token.slice(1, -1);
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "\\") {
          key += raw[i];
          continue;
        }
        const next = raw[++i],
          esc = { "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t" };
        if (next === "u") {
          const code = raw.slice(i + 1, i + 5);
          if (!/^[0-9a-f]{4}$/i.test(code)) return null;
          key += String.fromCharCode(parseInt(code, 16));
          i += 4;
        } else if (Object.hasOwn(esc, next)) key += esc[next];
        else return null;
      }
    } else key = token;
    keys.push(String(key));
    rest = rest.slice(match[0].length).trim();
    if (keys.length > 20) return null;
  }
  if (keys.length < 2 || !/^\d+$/.test(keys[0])) return null;
  return {
    step_id: keys[0],
    path: keys.slice(1),
    flat_path: keys.slice(1).join("__"),
  };
}
function reference(expression, outputs) {
  const ref = parseReference(expression);
  if (!ref) throw Error("Unsupported reference expression");
  const id = ref.step_id,
    path = ref.flat_path;
  let value = outputs[id];
  if (["__proto__", "prototype", "constructor"].includes(path))
    throw Error("Prototype references are not allowed");
  if (own(value, path)) value = value[path];
  else
    for (const key of ref.path) {
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        !own(value, key)
      )
        throw Error(`Missing or unsafe mapping from step ${id}`);
      value = value[key];
    }
  if (value === undefined) throw Error(`Mapping from step ${id} is undefined`);
  return value;
}
export function resolve(value, outputs, env = {}) {
  if (value && typeof value === "object" && own(value, "$env")) {
    const secret = env[value.$env];
    if (!secret)
      throw Error(`Configure ${value.$env} before running this workflow`);
    return secret;
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, outputs, env));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, outputs, env)]),
    );
  if (typeof value !== "string") return value;
  const whole = value.match(/^\{\{([^}]+)\}\}$/);
  if (whole) return structuredClone(reference(whole[1], outputs));
  return value.replace(/\{\{([^}]+)\}\}/g, (_, ref) => {
    const v = reference(ref, outputs);
    if (v && typeof v === "object")
      throw Error("Object interpolation requires an explicit mapping");
    return String(v);
  });
}
export function resolveConditions(criteria, outputs, env = {}) {
  return criteria.map((c) => {
    let key;
    try {
      key = resolve(c.key, outputs, env);
    } catch (error) {
      if (
        c.match !== "iexist" ||
        !/Missing or unsafe mapping|is undefined/.test(error.message) ||
        /constructor|__proto__|prototype/.test(String(c.key))
      )
        throw error;
      key = undefined;
    }
    return { ...c, key, value: resolve(c.value, outputs, env) };
  });
}
export function filter(criteria) {
  const groups = new Map();
  for (const c of criteria) {
    if (c.match !== "iexist" && c.key && typeof c.key === "object")
      throw Error("Array/object filter rules need a verified adapter");
    const value = String(c.key ?? "").toLowerCase(),
      target = String(c.value ?? "").toLowerCase();
    let passed;
    switch (c.match) {
      case "iexist":
        passed = c.key !== undefined && c.key !== null && c.key !== "";
        break;
      case "ireversecontains":
        passed = target.includes(value);
        break;
      case "idategreater":
      case "idateless":
      case "idateequal": {
        const a = Date.parse(String(c.key)),
          b = Date.parse(String(c.value));
        if (!Number.isFinite(a) || !Number.isFinite(b))
          throw Error("Date filter has invalid dates");
        passed =
          c.match === "idategreater"
            ? a > b
            : c.match === "idateless"
              ? a < b
              : a === b;
        break;
      }
      case "iexact":
        passed = value === target;
        break;
      case "icontains":
        passed = value.includes(target);
        break;
      case "istartswith":
        passed = value.startsWith(target);
        break;
      case "iendswith":
        passed = value.endsWith(target);
        break;
      case "igreater":
      case "iless":
        if (
          value.trim() === "" ||
          target.trim() === "" ||
          !Number.isFinite(Number(value)) ||
          !Number.isFinite(Number(target))
        )
          throw Error("Numeric filter has non-numeric data");
        passed =
          c.match === "igreater"
            ? Number(value) > Number(target)
            : Number(value) < Number(target);
        break;
      case "boolean":
        if (
          !["true", "false"].includes(value) ||
          !["true", "false"].includes(target)
        )
          throw Error("Boolean filter has non-boolean data");
        passed = value === target;
        break;
      default:
        throw Error("Unverified filter operator");
    }
    const rows = groups.get(c.group) || [];
    rows.push(c.action === "stop" ? !passed : passed);
    groups.set(c.group, rows);
  }
  return [...groups.values()].some((rows) => rows.every(Boolean));
}
export function unflatten(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const result = Object.create(null);
  for (const [k, v] of Object.entries(data)) {
    const parts = k.split("__");
    let target = result;
    if (
      parts.some(
        (p) => !p || ["__proto__", "constructor", "prototype"].includes(p),
      )
    )
      throw Error("Unsafe nested payload key");
    for (const part of parts.slice(0, -1)) {
      if (
        Object.hasOwn(target, part) &&
        (!target[part] ||
          typeof target[part] !== "object" ||
          Array.isArray(target[part]))
      )
        throw Error("Conflicting nested payload keys");
      target[part] ||= Object.create(null);
      target = target[part];
    }
    const last = parts.at(-1);
    if (Object.hasOwn(target, last))
      throw Error("Conflicting nested payload keys");
    target[last] = v;
  }
  return result;
}
export function httpRequest(step, params) {
  const method = String(params.method || step.action).toUpperCase(),
    headers = { ...(params.headers || {}) };
  let body;
  const rawData = params.data === undefined ? {} : params.data;
  const data =
    params.unflatten === true || params.unflatten === "yes"
      ? unflatten(rawData)
      : rawData;
  let destination = params.url;
  if (params.auth) {
    if (typeof params.auth !== "string" || !params.auth.includes("|"))
      throw Error("Basic auth requires username|password");
    if (Object.keys(headers).some((k) => k.toLowerCase() === "authorization"))
      throw Error("Conflicting authentication headers");
    const index = params.auth.indexOf("|");
    headers.Authorization =
      "Basic " +
      Buffer.from(
        params.auth.slice(0, index) + ":" + params.auth.slice(index + 1),
      ).toString("base64");
  }
  if (method === "GET" && Object.keys(data).length) {
    const url = new URL(destination);
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object")
        throw Error("Nested query values need a verified adapter");
      url.searchParams.set(k, String(v ?? ""));
    }
    destination = url.toString();
  }
  if (method !== "GET") {
    if (params.data === undefined && step.action === "custom")
      return { url: params.url, method, headers };
    if (params.payload_type === "raw")
      body =
        typeof params.data === "string" ? params.data : JSON.stringify(data);
    else if (params.payload_type === "form") {
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw Error("Form payload must be an object.");
      const entries = Object.entries(data);
      if (entries.some(([, v]) => v && typeof v === "object"))
        throw Error("Nested form values require a verified adapter");
      headers["Content-Type"] ||= "application/x-www-form-urlencoded";
      body = new URLSearchParams(
        entries.map(([k, v]) => [k, String(v)]),
      ).toString();
    } else {
      headers["Content-Type"] ||= "application/json";
      body = JSON.stringify(
        params.wrap_in_array === "yes" || params.wrap_in_array === true
          ? [data]
          : data,
      );
    }
  }
  return {
    url: destination,
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}
export function createContext({ env = {}, transport, journal } = {}) {
  const trace = [],
    requests = [];
  const id = randomUUID();
  return {
    env,
    trace,
    requests,
    resolve: (v, out) => resolve(v, out, env),
    conditions: (v, out) => resolveConditions(v, out, env),
    format,
    webhook: webhookInput,
    filter,
    skip(stepId, kind) {
      trace.push({ step_id: stepId, kind, status: "skipped" });
      journal?.start(stepId, kind);
      journal?.finish(stepId, "skipped", null);
    },
    async action(step, params) {
      if (step.kind === "http") return this.http(step, params);
      throw Error("Use the durable runner for SaaS adapters");
    },
    async step(stepId, kind, operation) {
      // Tab names can change between a held run and its resume. Resolve the
      // numeric identity afresh before each write attempt, retaining its journal.
      const saved = kind === 'sheets_resolve' ? null : journal?.read(stepId);
      if (saved?.status === "succeeded") {
        trace.push({ step_id: stepId, kind, status: "reused" });
        return saved.output;
      }
      if (saved?.status === "uncertain")
        throw Error(
          `Step ${stepId} may have applied an external write. Reconcile it before resuming.`,
        );
      const entry = { step_id: stepId, kind, status: "running" };
      trace.push(entry);
      journal?.start(stepId, kind);
      try {
        const output = await operation();
        entry.status = "succeeded";
        journal?.finish(stepId, "succeeded", output);
        return output;
      } catch (error) {
        entry.status = "held";
        entry.error = error.message;
        journal?.finish(
          stepId,
          error.uncertain ? "uncertain" : "held",
          null,
          error.message,
        );
        throw error;
      }
    },
    async http(step, params) {
      const request = httpRequest(step, params);
      requests.push({
        ...request,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([k, v]) => [
            k,
            /authorization|token|key|secret/i.test(k) ? "[redacted]" : v,
          ]),
        ),
      });
      if (!transport)
        throw Error("An explicit mock or live transport is required");
      const output = await transport(request, step);
      if (!output || typeof output !== "object" || Array.isArray(output))
        throw Error("HTTP output needs an explicit response adapter");
      return output;
    },
    result(status, outputs, error = null) {
      return {
        id,
        status,
        outputs,
        trace,
        requests,
        error,
        finished_at: new Date().toISOString(),
      };
    },
  };
}
export const mockTransport = async () => ({
  id: "mock-receipt",
  accepted: true,
});
export function liveTransport(env = {}) {
  const allowed = new Set(
    String(env.ALLOWED_HOSTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return async (request) => {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || !allowed.has(url.hostname))
      throw Error("Destination is not an explicitly allowed HTTPS host");
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw Error(
        `HTTP ${response.status}; inspect before retrying a potentially applied write`,
      );
    return response.json();
  };
}
