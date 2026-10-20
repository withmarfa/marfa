/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import {
  MANY_TYPES,
  SHOWN_TYPES,
  type Level,
} from "../pages/access-summary.js";
import { Icon } from "../pages/icons.js";
import {
  DisclosureRow,
  Row,
  RowGroup,
  RowNote,
  SearchField,
  Select,
  Switch,
} from "../pages/parts/index.js";
import {
  LEVEL_LABELS,
  type AccessModel,
  type ChooseTypes,
  type LevelRow,
  type SwitchRow,
} from "./access-model.js";

const EDIT_NOTE = "Edit includes adding and deleting items.";

function LevelControl(props: {
  row: LevelRow;
  /** Marks the all-data control, which the script reads to show the type list. */
  all?: boolean;
  /** Text a search of the type list matches. */
  search?: string;
}) {
  const { row } = props;
  return (
    <Row
      title={row.title}
      description={row.description}
      data={
        props.search === undefined
          ? undefined
          : { "type-row": "", search: props.search }
      }
      control={
        <Select
          id={row.id}
          name={row.name ?? "scopes"}
          label={row.title}
          value={row.selected}
          options={row.options}
          data={{
            noun: row.noun,
            held: row.held,
            ...(props.all ? { all: "" } : {}),
          }}
        />
      }
    />
  );
}

/** What the "Set every type" control can set: the levels some type offers. */
function setEveryOptions(rows: readonly LevelRow[]) {
  const offers = (level: Level) =>
    rows.some((row) =>
      row.options.some((option) => option.label === LEVEL_LABELS[level]),
    );
  return [
    { value: "", label: "Choose…" },
    ...(["write", "read", "none"] as const)
      .filter(offers)
      .map((level) => ({ value: level, label: LEVEL_LABELS[level] })),
  ];
}

/**
 * The types a person may choose in place of all data. With no script every
 * type shows, and says its choice counts only when types are chosen above.
 * The script shows this only while "Choose types" is chosen, and adds, for a
 * long list, "Set every type", a search and "Show all", which start hidden
 * because they do nothing without it.
 */
function TypeList(props: { choose: ChooseTypes }) {
  const { rows } = props.choose;
  const many = rows.length > MANY_TYPES;
  return (
    <div class="type-list" data-choose-types data-total={String(rows.length)}>
      <p class="sub-note" data-no-script-note>
        These count only if you choose types above.
      </p>
      {many && (
        <>
          <Row
            title="Set every type"
            hidden
            data={{ "script-only": "" }}
            control={
              <Select
                label="Set every type"
                value=""
                options={setEveryOptions(rows)}
                data={{ "set-every": "" }}
              />
            }
          />
          <div class="row" data-script-only hidden>
            <SearchField name="" placeholder="Search types" full />
          </div>
        </>
      )}
      {rows.map((row) => (
        <LevelControl
          row={row}
          search={`${row.title} ${row.noun}`.toLowerCase()}
        />
      ))}
      {many && (
        <>
          <div class="row" data-types-none hidden>
            <span class="muted">No type matches.</span>
          </div>
          <button
            class="row more-row"
            type="button"
            data-types-more
            data-shown={String(SHOWN_TYPES)}
            hidden
          >
            <div class="grow">
              <div class="rt">Show all {String(rows.length)} types</div>
            </div>
            <span class="chev">
              <Icon name="chevron" />
            </span>
          </button>
        </>
      )}
    </div>
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
 * literal the request named, except the controls for types chosen in place of
 * all data, which are named `types`. The form posts the same way with or
 * without a script. What the app holds is never posted: the server adds it.
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
                <>
                  <LevelControl row={row} all={row.choose !== undefined} />
                  {row.choose && <TypeList choose={row.choose} />}
                </>
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
