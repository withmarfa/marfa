/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import {
  DisclosureRow,
  Row,
  RowGroup,
  RowNote,
  Select,
  Switch,
} from "../pages/parts/index.js";
import type { AccessModel, LevelRow, SwitchRow } from "./access-model.js";

const EDIT_NOTE = "Edit includes adding and deleting items.";

function LevelControl(props: { row: LevelRow }) {
  const { row } = props;
  return (
    <Row
      title={row.title}
      description={row.description}
      control={
        <Select
          id={row.id}
          name="scopes"
          label={row.title}
          value={row.selected}
          options={row.options}
          data={{ noun: row.noun, held: row.held }}
        />
      }
    />
  );
}

function SwitchControl(props: { row: SwitchRow; badge?: string }) {
  const { row } = props;
  return (
    <Row
      title={row.title}
      description={row.description}
      descriptionTone={row.destructive ? "danger" : undefined}
      badge={props.badge}
      for={row.id}
      control={
        <Switch
          id={row.id}
          name="scopes"
          value={row.literal}
          checked={row.checked}
          data={{ phrase: row.title }}
        />
      }
    />
  );
}

/** Whether the page offers anything to turn on or off. */
export function offersChoice(model: AccessModel): boolean {
  return model.data.length + model.profile.length + model.powers.length > 0;
}

export interface AccessChoicesProps {
  model: AccessModel;
}

/**
 * The part of an approval screen where a person decides: what the app already
 * holds, then one row to open for each kind of thing it asks for. Each row
 * says in a line what the choice beneath it gives, and opens in place with no
 * script. Every control is a field named `scopes` whose value is a scope
 * literal the request named, so the form posts the same way with or without a
 * script. What the app holds is never posted: the server adds it.
 */
export function AccessChoices(props: AccessChoicesProps) {
  const { model } = props;
  const isNew = model.returning ? "New" : undefined;
  return (
    <>
      {model.mechanisms.map((literal) => (
        <input type="hidden" name="scopes" value={literal} />
      ))}
      {model.held.length > 0 && (
        <RowGroup>
          <DisclosureRow
            title="Already allowed"
            description={model.summaries.held}
          >
            {model.held.map((row) => (
              <Row title={row.title} value={row.value} />
            ))}
            <RowNote>
              Approving never lowers this. To end its access, use Connected
              apps.
            </RowNote>
          </DisclosureRow>
        </RowGroup>
      )}
      {offersChoice(model) && (
        <RowGroup>
          {model.data.length > 0 && (
            <DisclosureRow
              title="Your data"
              badge={isNew}
              description={model.summaries.data}
              live
              data={{
                "access-group": "data",
                "access-empty": model.summaries.empty.data,
              }}
            >
              {model.data.map((row) => (
                <LevelControl row={row} />
              ))}
              {model.offersEdit && <RowNote>{EDIT_NOTE}</RowNote>}
            </DisclosureRow>
          )}
          {model.profile.length > 0 && (
            <DisclosureRow
              title="Your profile"
              badge={isNew}
              description={model.summaries.profile}
              live
              data={{
                "access-group": "profile",
                "access-empty": model.summaries.empty.profile,
              }}
            >
              {model.profile.map((row) =>
                row.kind === "level" ? (
                  <LevelControl row={row} />
                ) : (
                  <SwitchControl row={row} />
                ),
              )}
            </DisclosureRow>
          )}
          {model.powers.length > 0 && (
            <DisclosureRow
              title="More control over Marfa"
              badge={isNew}
              description={model.summaries.powers}
              live
              data={{ "access-group": "powers" }}
            >
              {model.powers.map((row) => (
                <SwitchControl row={row} badge={isNew} />
              ))}
            </DisclosureRow>
          )}
        </RowGroup>
      )}
    </>
  );
}
