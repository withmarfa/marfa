/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * Health: how Marfa is running, and the upkeep it does on its own. The page
 * only reads. A housekeeping job's Run now is sent by the browser module
 * `client/health.ts` through `POST /housekeeping/{name}/run`.
 */
import { renderDocument } from "../pages/render.js";
import {
  Button,
  ConsolePage,
  EmptyState,
  Notice,
  PageHeader,
  Row,
  RowGroup,
  Section,
} from "../pages/parts/index.js";

export const HEALTH_HREF = "/auth/owner/health";

export type HealthTone = "warn" | "danger";

/** One thing Marfa checks when the page opens. */
export interface NowRow {
  title: string;
  description: string;
  /** What the right end says: "Working", "Slow", "Not working". */
  word: string;
  /** Set when the check found a problem. */
  tone?: HealthTone;
}

/** One housekeeping job and how its last run went. */
export interface JobRow {
  name: string;
  title: string;
  description: string;
  descriptionTone?: "danger";
  value: string;
  valueTone?: "danger";
}

export interface HealthPageParams {
  nonce: string;
  instanceName: string;
  now: readonly NowRow[];
  /** `null` when the jobs could not be read. */
  jobs: readonly JobRow[] | null;
}

export function HealthPage(props: HealthPageParams) {
  return (
    <ConsolePage
      title="Health"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "Health" }]}
      pageId="health"
    >
      <div class="stack-24" data-health>
        <PageHeader
          title="Health"
          lede="Whether things are working, and the jobs Marfa runs on its own."
        />
        <div data-notice="flash" hidden>
          <Notice>
            <span data-notice-text></span>
          </Notice>
        </div>
        <div data-notice="problem" hidden>
          <Notice tone="error">
            <span data-notice-text></span>
          </Notice>
        </div>
        <Section
          id="now"
          title="Now"
          description="Checked when you opened this page."
        >
          <RowGroup>
            {props.now.map((row) => (
              <Row
                title={row.title}
                description={row.description}
                descriptionTone={row.tone}
                dot={row.tone}
                value={row.word}
                valueTone={row.tone}
              />
            ))}
          </RowGroup>
        </Section>
        <Section
          id="housekeeping"
          title="Housekeeping"
          description="Jobs Marfa runs on its own to keep things tidy."
        >
          {props.jobs === null ? (
            <RowGroup>
              <EmptyState
                title="Couldn't read the jobs"
                description="The check failed or did not answer in time. Try again in a moment."
              />
            </RowGroup>
          ) : (
            <RowGroup>
              {props.jobs.map((job) => (
                <Row
                  title={job.title}
                  description={job.description}
                  descriptionTone={job.descriptionTone}
                  value={job.value}
                  valueTone={job.valueTone}
                  buttons={
                    <Button
                      kind="quiet"
                      hook="run-job"
                      loadingLabel="Running..."
                      data={{ job: job.name, label: job.title }}
                    >
                      Run now
                    </Button>
                  }
                />
              ))}
            </RowGroup>
          )}
        </Section>
        <Notice title="Backups happen where Marfa runs">
          Marfa doesn't check them. Back up the folder or volume that holds its
          data, wherever Marfa runs.
        </Notice>
      </div>
    </ConsolePage>
  );
}

export function renderHealthPage(params: HealthPageParams): string {
  return renderDocument(<HealthPage {...params} />);
}
