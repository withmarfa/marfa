/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import {
  Disclosure,
  Row,
  RowGroup,
  Section,
  Select,
  Switch,
} from "../pages/parts/index.js";
import type { AccessModel, LevelRow, SwitchRow } from "./access-model.js";

const DATA_NOTE = "One choice for each type of data it asked for.";
const EDIT_NOTE = "Edit includes adding and deleting items.";

function LevelControl(props: { row: LevelRow }) {
  const { row } = props;
  return (
    <Row
      title={row.title}
      description={row.description}
      badge={row.isNew ? "New" : undefined}
      control={
        <Select
          id={row.id}
          name="scopes"
          label={row.title}
          value={row.selected}
          options={row.options}
        />
      }
    />
  );
}

function SwitchControl(props: { row: SwitchRow }) {
  const { row } = props;
  return (
    <Row
      title={row.title}
      description={row.description}
      descriptionTone={row.destructive ? "danger" : undefined}
      badge={row.isNew ? "New" : undefined}
      for={row.id}
      control={
        <Switch
          id={row.id}
          name="scopes"
          value={row.literal}
          checked={row.checked}
        />
      }
    />
  );
}

function Controls(props: { rows: readonly (LevelRow | SwitchRow)[] }) {
  return (
    <RowGroup>
      {props.rows.map((row) =>
        row.kind === "level" ? (
          <LevelControl row={row} />
        ) : (
          <SwitchControl row={row} />
        ),
      )}
    </RowGroup>
  );
}

export interface AccessChoicesProps {
  model: AccessModel;
}

/**
 * The part of an approval screen where a person chooses: what the app
 * already holds, then one control for each thing it asks for. Every control
 * is a field named `scopes` whose value is a scope literal the request
 * named, so the form posts the same way with or without a script.
 */
export function AccessChoices(props: AccessChoicesProps) {
  const { model } = props;
  return (
    <>
      {model.mechanisms.map((literal) => (
        <input type="hidden" name="scopes" value={literal} />
      ))}
      {model.held.length > 0 && (
        <RowGroup>
          <Disclosure
            title="Already allowed"
            description="Approving never lowers this. To end its access, use Connected apps."
          >
            {model.held.map((row) => (
              <Row title={row.title} value={row.value} />
            ))}
          </Disclosure>
        </RowGroup>
      )}
      {model.data.length > 0 && (
        <Section
          id="access-data"
          title="Your data"
          description={
            model.offersEdit ? `${DATA_NOTE} ${EDIT_NOTE}` : DATA_NOTE
          }
        >
          <Controls rows={model.data} />
        </Section>
      )}
      {model.profile.length > 0 && (
        <Section id="access-profile" title="Your profile">
          <Controls rows={model.profile} />
        </Section>
      )}
      {model.powers.map((section) => (
        <Section
          id={`access-${section.id}`}
          title={section.title}
          description={`${section.description} Each is off until you turn it on.`}
        >
          <Controls rows={section.rows} />
        </Section>
      ))}
    </>
  );
}
