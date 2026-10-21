import { createRoute, z } from "@hono/zod-openapi";
import {
  ErrorCode,
  FOLDER_PROBLEM_CODES,
  FOLDER_STATUS_SIGN_IN_KINDS,
  MarfaError,
  isValidId,
} from "@withmarfa/shared";
import type { FolderStatus } from "@withmarfa/shared";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import {
  getTypeFilter,
  isDirectAuthority,
  standingRule,
  requireReadableRow,
} from "../middleware/auth.js";
import { readFolderStatus } from "../folder-status-read.js";
import { requestWriter, resolveWriter } from "../auth/version-writer.js";
import { VersionWriterSchema } from "./_schemas.js";
import type { Storage } from "../storage/interface.js";
import { createOpenAPIRouter, makeErrorResponseSchema } from "../openapi.js";

const readsFolderStatus = standingRule(
  "reads some type, or owner or local command",
  (c) => {
    if (!isDirectAuthority(c)) getTypeFilter(c);
  },
);

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Time = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
  )
  .openapi({ example: "2026-10-03T09:30:00.000Z" });
const Problem = z
  .strictObject({
    code: z
      .enum(FOLDER_PROBLEM_CODES)
      .describe(
        "conflict: unresolved conflict; refused: current refused write; credential_refused: rejected credential; unreadable: unreadable entry; held_file: held file; unavailable: failed sync; root_gone: unavailable root; settings_invalid: invalid settings.",
      ),
    count: Count.describe(
      "The number of current observations with this problem.",
    ),
  })
  .openapi("FolderStatusProblem", {
    description: "A safe problem code and its count.",
  });
const observations = {
  last_success_at: Time.nullable().describe(
    "When this copy last finished a fully successful sync, as reported by the client, in UTC; null if none has completed.",
  ),
  pending_uploads: Count.describe(
    "The distinct local files last observed waiting to upload.",
  ),
  pending_downloads: Count.describe(
    "The distinct items whose files the last completed pull could not write; retained when a later pull fails.",
  ),
  paused_removals: Count.describe(
    "The file removals waiting for confirmation on this copy.",
  ),
  first_sync_waiting: z
    .boolean()
    .describe("`true` if this copy's first sync is waiting for confirmation."),
  problems: z
    .array(Problem)
    .max(FOLDER_PROBLEM_CODES.length)
    .refine(
      (values) =>
        new Set(values.map((value) => value.code)).size === values.length,
    )
    .describe(
      "The current problem counts, each code once; an empty list means none were observed.",
    ),
};
const reportShape = {
  folder_store_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .describe(
      "The opaque ID of this local folder copy; it reveals no path or machine name.",
    )
    .openapi({ example: "01920000-0000-7000-8000-000000000000" }),
  sequence: Count.min(1).describe(
    "The increasing sequence for this copy under this sign-in; a retry keeps its sequence.",
  ),
  ...observations,
};
const Report = z.strictObject(reportShape).openapi("FolderStatusReport", {
  description:
    "A folder copy's last observed sync health, containing no file details.",
});
const Ack = z
  .object({
    accepted: z
      .boolean()
      .describe(
        "`true` if this report replaced the stored report; false for an equal or older sequence.",
      ),
    sequence: Count.min(1).describe(
      "The latest stored sequence for this copy and sign-in; a behind client resnapshots and sends a higher sequence.",
    ),
    received_at: Time.describe(
      "When the latest report was first accepted, in UTC; retries do not refresh it.",
    ),
  })
  .openapi("FolderStatusAck", {
    description: "The latest accepted report's sequence and receipt time.",
  });
const Copy = z
  .object({
    ...reportShape,
    received_at: Time.describe("When the server accepted this report, in UTC."),
    age_seconds: Count.describe(
      "The whole seconds since receipt, measured by the server; it does not show whether the copy is online.",
    ),
  })
  .openapi("FolderStatusCopy", {
    description: "One copy's latest report and its server-measured age.",
  });
const SignIn = VersionWriterSchema.extend({
  kind: z
    .enum(FOLDER_STATUS_SIGN_IN_KINDS)
    .describe(
      "browser: owner browser session; app: signed-in app grant; key: API key.",
    ),
}).openapi("FolderStatusSignIn", {
  description: "The existing sign-in that reported a folder copy.",
});
const Totals = z
  .object({
    saturated: z
      .boolean()
      .describe(
        "`true` if any total exceeded the safe integer bound; capped totals then mean at least that bound.",
      ),
    pending_uploads: Count.describe(
      "The sum of pending upload files across current sign-ins' copies.",
    ),
    pending_downloads: Count.describe(
      "The sum of observed pending download files across current sign-ins' copies.",
    ),
    paused_removals: Count.describe(
      "The sum of paused file removals across current sign-ins' copies.",
    ),
    first_sync_waiting: Count.describe(
      "The number of current sign-ins' copies waiting on their first sync.",
    ),
    problems: z
      .array(Problem)
      .describe(
        "The summed current problem counts across current sign-ins' copies.",
      ),
  })
  .openapi("FolderStatusTotals", {
    description:
      "The totals of the last reports from sign-ins that still stand.",
  });
const Status = z
  .object({
    folder_id: z
      .string()
      .describe("The ID of the folder.")
      .openapi({ example: "01920000-0000-7000-8000-000000000002" }),
    sign_ins: z
      .array(
        z
          .object({
            sign_in: z
              .object(SignIn.shape)
              .describe("The sign-in that owns these reports."),
            current: z
              .boolean()
              .describe(
                "`true` while the sign-in still stands; false for retained historical reports. This is no claim of current folder access, freshness, or being online.",
              ),
            copies: z
              .array(Copy)
              .describe("The latest report for each copy under this sign-in."),
          })
          .openapi("FolderStatusGroup", {
            description: "The folder-copy reports grouped under one sign-in.",
          }),
      )
      .describe(
        "Current and historical reports, grouped by sign-in; age is no claim of being online.",
      ),
    totals: z
      .object(Totals.shape)
      .describe(
        "Totals from current sign-ins alone; copies may contain overlapping files.",
      ),
  })
  .openapi("FolderStatus", {
    description: "A folder's sync reports grouped by existing sign-in.",
  });
const params = z.object({ id: z.string().describe("The ID of the folder.") });
const reportExample = {
  folder_store_id: "01920000-0000-7000-8000-000000000000",
  sequence: 1,
  last_success_at: null,
  pending_uploads: 2,
  pending_downloads: 0,
  paused_removals: 0,
  first_sync_waiting: false,
  problems: [],
};
const common = {
  400: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema([
          "invalid_id",
          "validation_error",
          "missing_required_field",
        ]),
      },
    },
    description:
      "- `invalid_id`: the folder ID is malformed.\n- `validation_error`: a field, count, time, code, or undeclared field is invalid.\n- `missing_required_field`: a required report field is missing.",
  },
  404: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["item_not_found"]),
      },
    },
    description:
      "- `item_not_found`: the folder does not exist or you cannot read it.",
  },
  403: {
    content: {
      "application/json": {
        schema: makeErrorResponseSchema(["type_not_permitted", "forbidden"]),
      },
    },
    description:
      "- `type_not_permitted`: your credential reads no type.\n- `forbidden`: a local command has no sign-in to report under.",
  },
};
const put = createRoute({
  method: "put",
  path: "/{id}/status",
  operationId: "reportFolderStatus",
  tags: ["Folders"],
  summary: "Replace a folder status",
  description:
    "Replaces your sign-in's report for one folder copy and returns the latest accepted sequence and receipt time. An equal or older sequence leaves the stored report unchanged.",
  security: [{ bearerAuth: [] }],
  middleware: readsFolderStatus,
  request: {
    params,
    body: { content: { "application/json": { schema: Report } } },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: Ack,
          example: {
            accepted: true,
            sequence: 1,
            received_at: "2026-10-03T09:30:00.000Z",
          },
        },
      },
      description:
        "Returns the latest accepted sequence and receipt time for your copy.",
    },
    ...common,
  },
});
const get = createRoute({
  method: "get",
  path: "/{id}/status",
  operationId: "getFolderStatus",
  tags: ["Folders"],
  summary: "Get a folder status",
  description:
    "Returns the latest folder-copy reports grouped by sign-in, with receipt ages and totals from sign-ins that still stand. Historical reports remain visible.",
  security: [{ bearerAuth: [] }],
  middleware: readsFolderStatus,
  request: { params },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: Status,
          example: {
            folder_id: "01920000-0000-7000-8000-000000000002",
            sign_ins: [
              {
                sign_in: {
                  kind: "key",
                  id: "01920000-0000-7000-8000-000000000001",
                  name: "Folder sync",
                },
                current: true,
                copies: [
                  {
                    ...reportExample,
                    received_at: "2026-10-03T09:30:00.000Z",
                    age_seconds: 60,
                  },
                ],
              },
            ],
            totals: {
              saturated: false,
              pending_uploads: 2,
              pending_downloads: 0,
              paused_removals: 0,
              first_sync_waiting: 0,
              problems: [],
            },
          },
        },
      },
      description:
        "Returns current and historical reports and the current totals.",
    },
    ...common,
    400: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["invalid_id", "validation_error"]),
        },
      },
      description:
        "- `invalid_id`: the folder ID is malformed.\n- `validation_error`: the query names an undeclared field, or the request asks for an unsupported conditional copy read.",
    },
    403: {
      content: {
        "application/json": {
          schema: makeErrorResponseSchema(["type_not_permitted"]),
        },
      },
      description: "- `type_not_permitted`: your credential reads no type.",
    },
  },
});

async function readableFolder(
  c: Context<AppEnv>,
  storage: Storage,
  id: string,
): Promise<void> {
  if (!isValidId(id))
    throw new MarfaError(ErrorCode.INVALID_ID, "Invalid item ID");
  const row = await storage.items.get(id);
  if (isDirectAuthority(c)) {
    if (row?.type !== "system.folder")
      throw new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Folder not found");
    return;
  }
  requireReadableRow(
    c,
    row?.type === "system.folder" ? row : null,
    () => new MarfaError(ErrorCode.ITEM_NOT_FOUND, "Folder not found"),
  );
}

export function folderStatusRoutes(storage: Storage) {
  const router = createOpenAPIRouter<AppEnv>();
  router.openapi(put, async (c) => {
    const { id } = c.req.valid("param");
    const report = c.req.valid("json");
    const result = await storage.runInTransaction(async () => {
      await readableFolder(c, storage, id);
      const signIn = await resolveWriter(storage, requestWriter(c));
      if (!signIn || signIn.kind === "local")
        throw new MarfaError(
          ErrorCode.FORBIDDEN,
          "A local command has no sign-in to report under",
        );
      return await storage.folderStatus.put(
        id,
        { ...signIn, kind: signIn.kind },
        report,
      );
    });
    return c.json(result, 200);
  });
  router.openapi(get, async (c) => {
    const { id } = c.req.valid("param");
    const result = await storage.runInTransaction(
      async (): Promise<FolderStatus> => {
        await readableFolder(c, storage, id);
        return readFolderStatus(storage, id);
      },
    );
    return c.json(result, 200);
  });
  return router;
}
