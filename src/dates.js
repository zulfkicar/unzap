// Explicit ISO/Unix input contracts. Locale guessing and wall-clock DST
// ambiguity need a separate reviewed parser, not Date.parse fallbacks.
export function dateIssue(p) {
  if (!Object.hasOwn(p, "inputs")) return "Date inputs are required";
  if (String(p.to_format).includes("Do"))
    return "Ordinal date tokens need a formatter";
  if (!["date.formatting", "date.manipulate"].includes(p.transform))
    return "Unsupported date transform";
  if (
    Object.keys(p).some(
      (k) =>
        ![
          "transform",
          "inputs",
          "to_format",
          "from_format",
          "to_timezone",
          "from_timezone",
          "expression",
          "transform_help",
        ].includes(k),
    )
  )
    return "Unknown date formatter options";
  if (
    p.from_format &&
    ![
      "X",
      "x",
      "YYYY-MM-DD",
      "YYYY-MM-DDTHH:mm:ssZ",
      "YYYY-MM-DDTHH:mm:ss.SSSZ",
    ].includes(p.from_format)
  )
    return "The input date format needs a parser";
  if (
    p.from_timezone &&
    !["UTC", "Etc/UTC", "GMT"].includes(p.from_timezone) &&
    p.from_format !== "X" &&
    p.from_format !== "x"
  )
    return "Non-UTC wall-clock input needs an explicit offset";
  if (
    p.transform === "date.manipulate" &&
    !/^[+-]\d+\s*(minutes?|hours?|days?|weeks?|seconds?)$/i.test(
      String(p.expression).trim(),
    )
  )
    return "Date arithmetic requires a bounded elapsed-time expression";
  return null;
}
export function formatDate(p) {
  const error = dateIssue(p);
  if (error) throw Error(error);
  if (Array.isArray(p.inputs) && p.inputs.length > 1)
    return {
      output: p.inputs.map(
        (input) => formatDate({ ...p, inputs: input }).output,
      ),
    };
  const input = Array.isArray(p.inputs) ? p.inputs[0] : p.inputs;
  let ms;
  if (["X", "x"].includes(p.from_format))
    ms = Number(input) * (p.from_format === "X" ? 1000 : 1);
  else {
    const text = String(input ?? "");
    if (
      !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d))?$/.test(
        text,
      )
    )
      throw Error("Date input must be ISO with an offset, or a UTC date");
    const [year, month, day] = text.slice(0, 10).split("-").map(Number);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    )
      throw Error("Invalid calendar date");
    ms = Date.parse(text);
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8640000000000000)
    throw Error("Invalid date");
  if (p.transform === "date.manipulate") {
    const [, n, unit] = String(p.expression)
      .trim()
      .match(/^([+-]\d+)\s*(minutes?|hours?|days?|weeks?|seconds?)$/i);
    const factors = {
      s: 1000,
      m: 60000,
      h: 3600000,
      d: 86400000,
      w: 604800000,
    };
    ms += Number(n) * factors[unit.toLowerCase()[0]];
  }
  const d = new Date(ms),
    zone = p.to_timezone || "UTC";
  if (p.to_format === "X") return { output: Math.floor(ms / 1000) };
  if (p.to_format === "x") return { output: ms };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const zoneUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offset = Math.round((zoneUtc - Math.floor(ms / 1000) * 1000) / 60000),
    pad = (n) => String(n).padStart(2, "0");
  const z =
    (offset < 0 ? "-" : "+") +
    pad(Math.floor(Math.abs(offset) / 60)) +
    ":" +
    pad(Math.abs(offset) % 60);
  const h = Number(parts.hour) % 12 || 12,
    day = Number(parts.day),
    a = Number(parts.hour) < 12 ? "am" : "pm";
  const named = (field, length) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      [field]: length,
    }).format(d);
  const tokens = {
    YYYY: parts.year,
    YY: parts.year.slice(-2),
    MMMM: named("month", "long"),
    MMM: named("month", "short"),
    MM: parts.month,
    M: String(Number(parts.month)),
    DD: parts.day,
    D: String(day),
    dddd: named("weekday", "long"),
    ddd: named("weekday", "short"),
    HH: parts.hour,
    H: String(Number(parts.hour)),
    hh: pad(h),
    h: String(h),
    mm: parts.minute,
    m: String(Number(parts.minute)),
    ss: parts.second,
    s: String(Number(parts.second)),
    SSS: String(d.getUTCMilliseconds()).padStart(3, "0"),
    ZZ: z.replace(":", ""),
    Z: z,
    A: a.toUpperCase(),
    a,
  };
  const output = String(p.to_format || "YYYY-MM-DDTHH:mm:ssZ").replace(
    /\[[^\]]*\]|YYYY|MMMM|dddd|SSS|MMM|ddd|YY|MM|DD|HH|hh|mm|ss|ZZ|[MDHhmsZAa]/g,
    (t) => (t.startsWith("[") ? t.slice(1, -1) : tokens[t]),
  );
  return { output };
}
