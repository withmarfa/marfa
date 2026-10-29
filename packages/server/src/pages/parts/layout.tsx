/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { Icon } from "../icons.js";

export interface MomentCardProps {
  title: string;
  /** Where the moment sits in a sequence: step `current` of `total`. */
  steps?: { current: number; total: number };
  /** The app that is asking, named here for its first letter. It sits beside Marfa's mark. */
  app?: string;
  /** Where the app is published, said under the title when it is known. */
  source?: string;
  lede?: Child;
  /** Announces the lede to a screen reader when the page loads. */
  ledeRole?: "status" | "alert";
  /** A line under the card. */
  foot?: Child;
  children?: Child;
}

function StepIndicator(props: { current: number; total: number }) {
  return (
    <div
      class="steps"
      role="img"
      aria-label={`Step ${String(props.current)} of ${String(props.total)}`}
    >
      {Array.from({ length: props.total }, (_, index) => (
        <span class={index < props.current ? "on" : undefined} />
      ))}
    </div>
  );
}

/**
 * A moment: one card 384 pixels wide in the middle of the page, for a screen
 * a person reaches at a turning point such as signing in, claiming, approving,
 * being signed out or meeting a problem.
 */
export function MomentCard(props: MomentCardProps) {
  return (
    <main class="center" id="main" tabindex={-1}>
      <div class="card">
        <div class="stack">
          {props.steps !== undefined && <StepIndicator {...props.steps} />}
          <div class="marks" aria-hidden="true">
            {props.app !== undefined && (
              <>
                <span class="tile">
                  {Array.from(props.app.trim())[0]?.toUpperCase() ?? "?"}
                </span>
                <span class="mark-arrow">
                  <Icon name="arrow" />
                </span>
              </>
            )}
            <span class="tile marfa">M</span>
          </div>
          <div>
            <h1 class="ctitle">{props.title}</h1>
            {props.source !== undefined && (
              <p class="small muted">From {props.source}</p>
            )}
            {props.lede !== undefined && (
              <p class="lede" role={props.ledeRole}>
                {props.lede}
              </p>
            )}
          </div>
        </div>
        {props.children}
      </div>
      {props.foot !== undefined && <p class="foot">{props.foot}</p>}
    </main>
  );
}

/** A line with a word in the middle, between two ways of doing the same thing. */
export function Divider(props: { children?: Child }) {
  return (
    <div class="or" aria-hidden="true">
      {props.children}
    </div>
  );
}

/** The console's one quiet column, 720 pixels wide. */
export function ConsoleColumn(props: { children?: Child }) {
  return (
    <main class="col" id="main" tabindex={-1}>
      {props.children}
    </main>
  );
}

export interface PageHeaderProps {
  title: string;
  lede?: Child;
  /** The page's one main action, at the top right. */
  action?: Child;
}

export function PageHeader(props: PageHeaderProps) {
  return (
    <header class="head">
      <div class="grow">
        <h1 class="title">{props.title}</h1>
        {props.lede !== undefined && <p class="lede">{props.lede}</p>}
      </div>
      {props.action !== undefined && <div class="actions">{props.action}</div>}
    </header>
  );
}

export interface SectionProps {
  /** Names the heading, so the section is a labeled region. */
  id?: string;
  title?: string;
  description?: Child;
  /** At most one control on the right: a search, a select or a button. */
  control?: Child;
  children?: Child;
}

export function Section(props: SectionProps) {
  const headingId = props.id ? `${props.id}-heading` : undefined;
  return (
    <section
      class="sec"
      id={props.id}
      aria-labelledby={props.title ? headingId : undefined}
    >
      {props.title !== undefined && (
        <div class="sec-top">
          <div class="grow">
            <h2 class="sech" id={headingId}>
              {props.title}
            </h2>
            {props.description !== undefined && (
              <p class="secd">{props.description}</p>
            )}
          </div>
          {props.control}
        </div>
      )}
      {props.children}
    </section>
  );
}
