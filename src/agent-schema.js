import { formatterContracts, conditionOperators } from "./logic.js";
const string = { type: "string" },
  object = { type: "object", additionalProperties: true },
  value = {};
const fields = (
  properties,
  required = Object.keys(properties),
  extra = false,
) => ({ type: "object", properties, required, additionalProperties: extra });
const rules = {
  type: "array",
  minItems: 1,
  items: fields(
    {
      group: { type: "integer", minimum: 0 },
      key: value,
      match: { type: "string", enum: [...conditionOperators] },
      value: value,
      action: { type: "string", enum: ["continue", "stop"] },
    },
    ["group", "key", "match", "action"],
  ),
};
const common = { connection: string, base: string, table: string };
const step = (kind, params) =>
  fields({
    id: { type: "string", pattern: "^[0-9]+$" },
    parent_id: kind === "webhook" ? { type: "null" } : string,
    kind: { type: "string", enum: [kind] },
    params,
  });
const definition = fields(
  {
    name: string,
    trigger: step("webhook", fields({ child_key: string }, [])),
    steps: {
      type: "array",
      minItems: 0,
      maxItems: 50,
      items: {
        oneOf: [
          step("transform", fields({ fields: object })),
          step("filter", fields({ filter_criteria: rules })),
          step("paths", fields({})),
          step("path", {
            oneOf: [
              fields({
                mode: { type: "string", enum: ["rules"] },
                order: { type: "integer", minimum: 0 },
                filter_criteria: rules,
              }),
              fields({
                mode: { type: "string", enum: ["always", "fallback"] },
                order: { type: "integer", minimum: 0 },
              }),
            ],
          }),
          step(
            "formatter",
            fields(
              {
                transform: {
                  type: "string",
                  enum: [
                    ...Object.keys(formatterContracts),
                    "date.formatting",
                    "date.manipulate",
                  ],
                },
                inputs: value,
                separator: string,
                index: { type: ["string", "integer"] },
                old: string,
                new: string,
                operation: string,
                default: value,
                table: object,
                fallback: value,
                default_value: value,
                max_length: { type: ["string", "integer"] },
                append_ellipsis: { type: ["string", "boolean"] },
                use_plus: { type: ["string", "boolean"] },
                from_format: { type: ["string", "null"] },
                to_format: string,
                from_timezone: string,
                to_timezone: string,
                expression: string,
              },
              ["transform", "inputs"],
            ),
          ),
          step(
            "http",
            fields(
              {
                url: string,
                method: {
                  type: "string",
                  enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
                },
                headers: object,
                data: value,
                payload_type: { type: "string", enum: ["json", "form", "raw"] },
                unflatten: { type: "boolean" },
                wrap_in_array: { type: "boolean" },
                auth: value,
              },
              ["url", "method"],
            ),
          ),
          step(
            "slack",
            fields(
              {
                connection: string,
                channel: string,
                text: string,
                thread_ts: string,
                unfurl: { type: "boolean" },
                link_names: { type: "integer", enum: [0, 1] },
                reply_broadcast: { type: "boolean" },
                username: string,
                icon_emoji: string,
                icon_url: string,
                attachments: { type: "array", items: object },
                blocks: { type: "array", items: object },
                join_channel: { type: 'boolean' },
              },
              ["connection", "channel", "text"],
            ),
          ),
          step("airtable", fields({ ...common, fields: object })),
          step(
            "airtable_update",
            fields({ ...common, record: string, fields: object }),
          ),
          ...['sheets_append', 'sheets_update'].map(kind => step(kind, fields({
            connection: string, spreadsheet: string, sheet_id: { type: ['string','integer'] },
            columns: object, value_input: { type: 'string', enum: ['RAW','USER_ENTERED'] },
            ...(kind === 'sheets_update' ? { row: { type: ['string','integer'] } } : {}),
          }))),
          step('slack_join', fields({ connection: string, channel: string })),
          step(
            "airtable_find",
            fields(
              {
                ...common,
                field: string,
                value,
                exact: { type: "boolean" },
                formula: string,
                view: string,
                on_missing: { type: "string", enum: ["continue", "hold"] },
                multiple: { type: "string", enum: ["first", "halt"] },
              },
              ["connection", "base", "table", "on_missing", "multiple"],
            ),
          ),
          {
            type: "object",
            properties: {
              id: string,
              parent_id: string,
              kind: { type: "string", enum: ["unsupported"] },
              params: object,
            },
            required: ["id", "parent_id", "kind", "params"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  ["name", "trigger", "steps"],
);
export const toolResponseSchema = {
  type: "object",
  oneOf: [
    fields(
      {
        action: { type: "string", enum: ["review_mappings"] },
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
        },
        reason: { type: "string", maxLength: 100 },
      },
      ["action", "ids"],
    ),
    fields(
      {
        action: { type: "string", enum: ["propose"] },
        definition,
        reason: { type: "string", maxLength: 100 },
      },
      ["action", "definition"],
    ),
    fields(
      {
        action: {
          type: "string",
          enum: ["inspect", "contracts", "test", "finish"],
        },
        reason: { type: "string", maxLength: 100 },
      },
      ["action"],
    ),
  ],
};
