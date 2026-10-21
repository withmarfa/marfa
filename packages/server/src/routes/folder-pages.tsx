/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { FolderStatus, FolderProblemCode } from "@withmarfa/shared";
import type { FolderSummary } from "../folder-inventory.js";
import { agoWords } from "../pages/key-time.js";
import {
  Button,
  ButtonPair,
  ConsolePage,
  EmptyState,
  Notice,
  PageHeader,
  Row,
  RowGroup,
  Section,
} from "../pages/parts/index.js";
import type { RegistryItem } from "../pages/registry.js";
import { renderDocument } from "../pages/render.js";

export const FOLDERS_HREF = "/auth/owner/folders";
export const folderHref = (id: string) =>
  `${FOLDERS_HREF}/${encodeURIComponent(id)}`;
export interface FolderReading {
  folder: FolderSummary;
  status: FolderStatus | null;
}
interface Base {
  nonce: string;
  instanceName: string;
  now: number;
}

const guidance: Record<
  FolderProblemCode,
  { title: string; description: string }
> = {
  conflict: {
    title: "Conflicts",
    description:
      "Marfa keeps both versions. A second file is named Name (2).md, then Name (3).md if needed. Open this copy's folder, compare the files, and keep the version you want.",
  },
  refused: {
    title: "Writes refused",
    description:
      "Open this copy's local status to see why Marfa refused the write. Correct the file or its access, then sync again. Your unsent changes stay on this copy.",
  },
  credential_refused: {
    title: "Sign-in refused",
    description:
      "Check the sign-in used by this copy and approve access again if needed, then sync again.",
  },
  unreadable: {
    title: "Unreadable files",
    description:
      "Check file permissions and that the files are available on this copy, then sync again.",
  },
  held_file: {
    title: "Files held",
    description:
      "Marfa kept files it could not safely replace or remove. Open this copy's local status, keep any changes you need, and retry.",
  },
  unavailable: {
    title: "Sync unavailable",
    description:
      "Check this copy's connection to Marfa and its local status, then sync again.",
  },
  root_gone: {
    title: "Folder missing",
    description:
      "The folder root is unavailable on this copy. Check that the folder or its drive is available at its original location before syncing again.",
  },
  settings_invalid: {
    title: "Invalid settings",
    description:
      "Check this copy's folder settings and the error in its local status. Correct the settings, then sync again.",
  },
};

export function folderReadingLabel(status: FolderStatus | null): {
  text: string;
  tone?: "warn";
} {
  if (!status) return { text: "Reports unavailable", tone: "warn" };
  const current = status.sign_ins.filter((s) => s.current);
  if (!current.length)
    return {
      text: status.sign_ins.length
        ? "Historical reports only"
        : "No reports yet",
    };
  const t = status.totals;
  if (
    t.problems.some((p) => p.count > 0) ||
    t.paused_removals ||
    t.first_sync_waiting
  )
    return { text: "Needs a look", tone: "warn" };
  if (t.pending_uploads || t.pending_downloads) return { text: "Work waiting" };
  return { text: "No problems reported" };
}

export function renderFolderList(
  props: Base & {
    rows: FolderReading[];
    next: string | null;
    continued: boolean;
    size: number;
  },
) {
  return renderDocument(
    <ConsolePage
      title="Folders"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Folders" }]}
      pageId="folders"
    >
      <div class="stack-24">
        <PageHeader
          title="Folders"
          lede="Folders kept in step with Marfa. Add a folder with the marfa command line on the machine that holds it."
        />
        <RowGroup oneLine>
          {props.rows.length ? (
            props.rows.map(({ folder, status }) => {
              const state = folderReadingLabel(status);
              const groups = status?.sign_ins ?? [];
              const copies = groups.reduce((n, g) => n + g.copies.length, 0);
              return (
                <Row
                  title={folder.title}
                  description={
                    status
                      ? `${String(copies)} reported ${copies === 1 ? "copy" : "copies"}${groups.length ? `. Sign-ins: ${groups.map((g) => g.sign_in.name).join(", ")}.` : "."}`
                      : "Sync reports could not be read. Open the folder to try again."
                  }
                  value={state.text}
                  valueTone={state.tone}
                  href={folderHref(folder.id)}
                />
              );
            })
          ) : (
            <EmptyState
              title={props.continued ? "No more folders" : "No folders"}
              description="Active folders appear here once their settings have been created in Marfa."
            />
          )}
        </RowGroup>
        <ButtonPair>
          {props.continued && (
            <Button kind="outline" href={FOLDERS_HREF}>
              First page
            </Button>
          )}
          {props.next && (
            <Button
              kind="outline"
              href={`${FOLDERS_HREF}?size=${String(props.size)}&cursor=${encodeURIComponent(props.next)}`}
            >
              Next page
            </Button>
          )}
        </ButtonPair>
      </div>
    </ConsolePage>,
  );
}

export function renderFolderDetail(
  props: Base & FolderReading & { siblings: RegistryItem[] },
) {
  const { folder, status } = props;
  const count = (n: number) =>
    `${status?.totals.saturated ? "At least " : ""}${String(n)}`;
  return renderDocument(
    <ConsolePage
      title={folder.title}
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[
        { label: "Folders", href: FOLDERS_HREF },
        { label: folder.title },
      ]}
      pageId="folders"
      items={{ folders: props.siblings }}
      currentItemHref={folderHref(folder.id)}
    >
      <div class="stack-24">
        <PageHeader
          title={folder.title}
          lede="Each copy is identified by the sign-in that reported it and its opaque copy ID. Reports do not identify a machine or tell you whether it is online."
        />
        {!status ? (
          <Notice tone="error" title="Couldn't read sync reports">
            Reload this page to try again. The folder's sync state is
            unavailable.
          </Notice>
        ) : (
          <>
            {status.sign_ins.length === 0 ? (
              <RowGroup>
                <EmptyState
                  title="No reports yet"
                  description="A copy's reports appear here after it syncs and reports to Marfa."
                />
              </RowGroup>
            ) : (
              <>
                <Section
                  id="totals"
                  title="Last reported totals"
                  description="From sign-ins that still stand. Reports may be old and copies can contain overlapping files. Current sign-in does not mean current folder access."
                >
                  <RowGroup>
                    <Row
                      title="Waiting to upload"
                      value={count(status.totals.pending_uploads)}
                    />
                    <Row
                      title="Waiting to download"
                      value={count(status.totals.pending_downloads)}
                    />
                    <Row
                      title="Paused removals"
                      value={count(status.totals.paused_removals)}
                    />
                    <Row
                      title="Copies waiting for first sync"
                      value={count(status.totals.first_sync_waiting)}
                    />
                  </RowGroup>
                </Section>
                {status.sign_ins.map((group, index) => (
                  <Section
                    id={`sign-in-${String(index)}`}
                    title={group.sign_in.name}
                    description={`${group.current ? "Current sign-in" : "Historical sign-in"}. ${group.sign_in.kind}: ${group.sign_in.id}${group.current ? "" : ". Excluded from totals."}`}
                  >
                    <div class="stack-24">
                      {group.copies.map((copy, copyIndex) => (
                        <Section
                          id={`copy-${String(index)}-${String(copyIndex)}`}
                          title={`Copy ${copy.folder_store_id}`}
                        >
                          <RowGroup>
                            <Row
                              title="Last successful sync"
                              value={
                                copy.last_success_at
                                  ? agoWords(
                                      Date.parse(copy.last_success_at),
                                      props.now,
                                    )
                                  : "None reported"
                              }
                              description={copy.last_success_at ?? undefined}
                            />
                            <Row
                              title="Report received"
                              value={agoWords(
                                Date.parse(copy.received_at),
                                props.now,
                              )}
                              description={`${copy.received_at}. ${String(copy.age_seconds)} seconds old when read.`}
                            />
                            <Row
                              title="Waiting to upload"
                              value={String(copy.pending_uploads)}
                            />
                            <Row
                              title="Waiting to download"
                              value={String(copy.pending_downloads)}
                            />
                            {copy.first_sync_waiting && (
                              <Row
                                title="First sync waiting"
                                dot="warn"
                                description="Review what this copy's first sync will do, then run marfa folders confirm with its folder path."
                              />
                            )}
                            {copy.paused_removals > 0 && (
                              <Row
                                title="Removals paused"
                                value={String(copy.paused_removals)}
                                dot="warn"
                                description="Check the planned removals in this copy. Use marfa folders confirm to allow them, or marfa folders restore to cancel them."
                              />
                            )}
                            {copy.problems
                              .filter((p) => p.count > 0)
                              .map((p) => (
                                <Row
                                  title={guidance[p.code].title}
                                  value={String(p.count)}
                                  description={guidance[p.code].description}
                                  dot="warn"
                                />
                              ))}
                          </RowGroup>
                        </Section>
                      ))}
                    </div>
                  </Section>
                ))}
              </>
            )}
          </>
        )}
        <Section
          id="on-your-machine"
          title="On the machine that holds a copy"
          description="Run marfa folders list to find its local path, then marfa folders status with that path to inspect file details. The browser never opens those files."
        />
      </div>
    </ConsolePage>,
  );
}

export function renderMissingFolder(props: Base) {
  return renderDocument(
    <ConsolePage
      title="Folders"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Folders", href: FOLDERS_HREF }, { label: "Not found" }]}
      pageId="folders"
    >
      <div class="stack-24">
        <PageHeader title="This folder isn't here" />
        <RowGroup>
          <EmptyState
            title="It may have been revoked or removed"
            action={
              <Button kind="outline" href={FOLDERS_HREF}>
                Go to Folders
              </Button>
            }
          />
        </RowGroup>
      </div>
    </ConsolePage>,
  );
}
