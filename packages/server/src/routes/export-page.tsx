/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The Export and restore page of the owner console, drawn from what
 * `export-routes.ts` reads. Export is a plain form to `GET /export`, so the
 * browser downloads the archive itself; restore is sent by the browser module
 * `client/export.ts` to `POST /restore`, the door every other caller uses.
 */
import {
  Button,
  ConsolePage,
  FormFoot,
  Notice,
  PageHeader,
  Row,
  RowGroup,
  Section,
  Select,
  Switch,
  type SelectGroup,
  type SelectOption,
} from "../pages/parts/index.js";
import { renderDocument } from "../pages/render.js";

export interface ExportPageParams {
  nonce: string;
  instanceName: string;
  types: readonly (SelectOption | SelectGroup)[];
  /** The files in the instance, in words: "12 files, 3.4 MB". */
  files: string;
  /** Milliseconds until the sign-in stops counting as recent, or undefined. */
  signInLeft?: number;
}

export function ExportPage(props: ExportPageParams) {
  return (
    <ConsolePage
      title="Export and restore"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Export and restore" }]}
      pageId="export"
    >
      <div class="stack-24">
        <PageHeader
          title="Export and restore"
          lede="Take a copy of your data, or bring one back."
        />
        <form class="stack-24" method="get" action="/export" data-export-form>
          <input type="hidden" name="format" value="archive" />
          <Section
            id="export"
            title="Export"
            description="An archive of your items, links, types and files. It leaves out keys, apps, webhooks, settings, activity and the trash."
          >
            <RowGroup>
              <Row
                title="What to export"
                for="export-type"
                control={
                  <Select
                    id="export-type"
                    name="type"
                    label="What to export"
                    value=""
                    options={props.types}
                  />
                }
              />
              <Row
                title="Include files"
                description={props.files}
                for="export-files"
                control={
                  <Switch id="export-files" label="Include files" checked />
                }
              />
            </RowGroup>
          </Section>
          <FormFoot note="Downloads to this browser as a .tar.gz file.">
            <Button kind="primary" type="submit">
              Export
            </Button>
          </FormFoot>
        </form>
        <div
          class="stack-24"
          data-restore
          data-confirm-left={
            props.signInLeft === undefined
              ? undefined
              : String(Math.max(0, Math.round(props.signInLeft)))
          }
          data-confirm-why="Restoring adds to your data."
        >
          <Section
            id="restore"
            title="Restore"
            description="Adds what isn't here and never replaces anything."
          >
            <RowGroup>
              <Row
                title="Export file"
                value="No file chosen"
                valueAuto
                data={{ restore: "file" }}
                buttons={
                  <>
                    <input
                      type="file"
                      accept=".gz,.tgz,application/gzip"
                      hidden
                      data-restore-input
                      aria-label="Export file"
                    />
                    <Button kind="quiet" hook="restore-choose">
                      Choose file...
                    </Button>
                  </>
                }
              />
            </RowGroup>
          </Section>
          <div data-notice="restored" hidden>
            <Notice title="Restore finished">
              <span data-notice-text></span>
            </Notice>
          </div>
          <div data-notice="restore-problem" hidden>
            <Notice tone="error" title="Nothing was restored">
              <span data-notice-text></span>
            </Notice>
          </div>
          <div data-notice="restore-unknown" hidden>
            <Notice tone="error" title="Restore didn't finish">
              <span data-notice-text></span>
            </Notice>
          </div>
          <FormFoot note={<span data-restore-reason>Choose a file first</span>}>
            <Button
              kind="primary"
              ariaDisabled
              loadingLabel="Restoring..."
              hook="restore-send"
            >
              Restore
            </Button>
          </FormFoot>
        </div>
      </div>
    </ConsolePage>
  );
}

export const renderExportPage = (params: ExportPageParams): string =>
  renderDocument(<ExportPage {...params} />);
