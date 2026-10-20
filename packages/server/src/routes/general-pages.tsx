/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * General: this Marfa's name and how long it keeps things. The page is one
 * form behind the save bar. The browser module `client/general.ts` sends only
 * the settings that changed through `PATCH /config`, which takes effect at
 * once.
 */
import { renderDocument } from "../pages/render.js";
import {
  ConsolePage,
  Notice,
  PageHeader,
  Row,
  RowGroup,
  RowInput,
  SaveBar,
  Section,
  Select,
  type SelectOption,
} from "../pages/parts/index.js";

export const GENERAL_HREF = "/auth/owner/general";

/** A setting that is a length of time, shown as a choice. */
export interface KeepingRow {
  /** The setting's name in `GET /config`, which is also the control's name. */
  field: string;
  title: string;
  description: string;
  /** The number the control starts at, as text. */
  value: string;
  options: readonly SelectOption[];
}

export interface RuleRow {
  title: string;
  value: string;
}

export interface GeneralPageParams {
  nonce: string;
  instanceName: string;
  keeping: readonly KeepingRow[];
  rules: readonly RuleRow[];
  about: { address: string; version: string };
}

export function GeneralPage(props: GeneralPageParams) {
  return (
    <ConsolePage
      title="General"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "General" }]}
      pageId="general"
    >
      <div class="stack-24">
        <form
          id="general-form"
          class="stack-24"
          method="post"
          action="/auth/owner/general"
          novalidate
          data-general-form
        >
          <PageHeader
            title="General"
            lede="This Marfa's name, and how long it keeps things."
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
          <RowGroup>
            <Row
              title="Name"
              description="Shown on these pages and to apps you approve"
              for="general-name"
              control={
                <RowInput
                  id="general-name"
                  name="name"
                  value={props.instanceName}
                  maxlength={200}
                />
              }
            />
          </RowGroup>
          <Section
            id="keeping"
            title="Keeping things"
            description="Changes take effect as soon as you save them."
          >
            <RowGroup>
              {props.keeping.map((row) => (
                <Row
                  title={row.title}
                  description={row.description}
                  for={`general-${row.field}`}
                  control={
                    <Select
                      id={`general-${row.field}`}
                      name={row.field}
                      value={row.value}
                      options={row.options}
                    />
                  }
                />
              ))}
            </RowGroup>
          </Section>
        </form>
        <Section
          id="rules"
          title="Write rules"
          description="Checks on what apps and keys may write, type by type. Set them through the API."
        >
          <RowGroup>
            {props.rules.map((rule) => (
              <Row title={rule.title} value={rule.value} valueAuto />
            ))}
          </RowGroup>
        </Section>
        <Section
          id="about"
          title="About"
          description="This Marfa, and where it runs."
        >
          <RowGroup>
            <Row title="Address" value={props.about.address} valueAuto />
            <Row title="Version" value={props.about.version} valueAuto />
          </RowGroup>
        </Section>
      </div>
      <SaveBar form="general-form" />
    </ConsolePage>
  );
}

export function renderGeneralPage(params: GeneralPageParams): string {
  return renderDocument(<GeneralPage {...params} />);
}
