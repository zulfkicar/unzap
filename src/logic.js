import { dateIssue, formatDate } from "./dates.js";
export const conditionOperators = new Set([
  "iexact",
  "icontains",
  "igreater",
  "iless",
  "istartswith",
  "iendswith",
  "boolean",
  "iexist",
  "ireversecontains",
  "idategreater",
  "idateless",
  "idateequal",
]);
export const formatterContracts = {
  "string.split": ["inputs", "separator", "index"],
  "string.replace": ["inputs", "old", "new", "find"],
  "string.trim_space": ["inputs"],
  "string.lower_case": ["inputs"],
  "string.upper_case": ["inputs"],
  "string.capitalize": ["inputs"],
  "string.length": ["inputs"],
  "string.word_count": ["inputs"],
  "string.url_encode": ["inputs", "use_plus"],
  "string.default_value_v2": ["inputs", "default_value"],
  "string.truncate": ["inputs", "max_length", "append_ellipsis"],
  "util.choose": ["inputs", "operation", "default"],
  "util.lookup": ["inputs", "table", "fallback"],
  "util.string_to_lineitem": ["inputs", "separator"],
  "util.lineitem_to_string_v2": ["inputs", "separator"],
  "number.math": ["inputs", "operation"],
  "number.math_v2": ["inputs", "operation"],
};
export function formatterIssue(p) {
  if (String(p.transform).startsWith("date.")) return dateIssue(p);
  const allowed = formatterContracts[p.transform];
  if (!allowed) return "This formatter transform needs an implementation.";
  if (Object.keys(p).some((k) => k !== "transform" && !allowed.includes(k)))
    return "Unknown formatter options need review.";
  if (!Object.hasOwn(p, "inputs")) return "Formatter inputs are required.";
  if (
    p.transform === "string.split" &&
    p.index !== undefined &&
    !["fields", "all"].includes(String(p.index)) &&
    !/^-?\d+$/.test(String(p.index))
  )
    return "Invalid split segment index.";
  if (
    p.transform === "util.choose" &&
    !["first", "last"].includes(String(p.operation)) &&
    !/^\d+$/.test(String(p.operation))
  )
    return "Invalid item index.";
  if (
    p.transform.startsWith("number.math") &&
    !["add", "sub", "mul", "div"].includes(p.operation)
  )
    return "Unsupported arithmetic operation.";
  return null;
}
const delimiter = (v) =>
  String(v ?? ",")
    .replaceAll("[:space:]", " ")
    .replaceAll("[:tab:]", "\t")
    .replaceAll("[:newline:]", "\n")
    .replaceAll("[:return:]", "\r");
export function format(p) {
  const error = formatterIssue(p);
  if (error) throw Error(error);
  if (String(p.transform).startsWith("date.")) return formatDate(p);
  const inputs = Array.isArray(p.inputs) ? p.inputs : [p.inputs];
  if (String(p.transform).startsWith("string.") && inputs.length > 1) {
    const rows = inputs.map((input) => format({ ...p, inputs: input }));
    return Object.fromEntries(
      [...new Set(rows.flatMap((row) => Object.keys(row)))].map((key) => [
        key,
        rows.map((row) => row[key] ?? ""),
      ]),
    );
  }
  const scalar = inputs[0];
  const text = String(scalar ?? "");
  let output;
  switch (p.transform) {
    case "string.split": {
      const parts = text.split(delimiter(p.separator));
      if (p.index === "fields")
        return Object.fromEntries(parts.map((v, i) => ["output__" + i, v]));
      output =
        p.index === "all" ? parts : (parts.at(Number(p.index ?? 0)) ?? "");
      break;
    }
    case "string.replace":
      output = text
        .split(String(p.old ?? p.find ?? ""))
        .join(String(p.new ?? ""));
      break;
    case "string.trim_space":
      output = text.trim();
      break;
    case "string.lower_case":
      output = text.toLowerCase();
      break;
    case "string.upper_case":
      output = text.toUpperCase();
      break;
    case "string.capitalize":
      output = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
      break;
    case "string.length":
      output = text.length;
      break;
    case "string.word_count":
      output = text.trim() ? text.trim().split(/\s+/u).length : 0;
      break;
    case "string.url_encode":
      output = encodeURIComponent(text);
      if (p.use_plus === true || p.use_plus === "true")
        output = output.replaceAll("%20", "+");
      break;
    case "string.default_value_v2":
      output = scalar == null || scalar === "" ? p.default_value : scalar;
      break;
    case "string.truncate": {
      const n = Number(p.max_length);
      if (!Number.isInteger(n) || n < 0 || n > 100000)
        throw Error("Invalid maximum length");
      const suffix =
        p.append_ellipsis === true || p.append_ellipsis === "true" ? "..." : "";
      output =
        text.length > n
          ? text.slice(0, Math.max(0, n - suffix.length)) + suffix.slice(0, n)
          : text;
      break;
    }
    case "util.choose":
      output =
        inputs.at(
          p.operation === "last"
            ? -1
            : p.operation === "first"
              ? 0
              : Number(p.operation),
        ) ??
        p.default ??
        "";
      break;
    case "util.lookup":
      if (!p.table || typeof p.table !== "object" || Array.isArray(p.table))
        throw Error("Lookup table must be an object");
      output = Object.hasOwn(p.table, text)
        ? p.table[text]
        : (p.fallback ?? "");
      break;
    case "util.string_to_lineitem":
      output = text.split(delimiter(p.separator));
      break;
    case "util.lineitem_to_string_v2":
      output = inputs.map((v) => String(v ?? "")).join(delimiter(p.separator));
      break;
    case "number.math":
    case "number.math_v2": {
      const ns = inputs.map((v) => Number(v));
      if (
        !ns.length ||
        inputs.some((v) => v == null || String(v).trim() === "") ||
        ns.some((n) => !Number.isFinite(n))
      )
        throw Error("Arithmetic requires finite numbers");
      output = ns.reduce((a, b) =>
        p.operation === "add"
          ? a + b
          : p.operation === "sub"
            ? a - b
            : p.operation === "mul"
              ? a * b
              : a / b,
      );
      if (!Number.isFinite(output))
        throw Error("Arithmetic result is not finite");
      break;
    }
  }
  return { output };
}
