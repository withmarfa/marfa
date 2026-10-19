import type { Child } from "hono/jsx";
import { Icon } from "../icons.js";

export interface NoticeProps {
  /** Information, or an error that has already happened. */
  tone?: "info" | "error";
  title?: string;
  children?: Child;
  action?: Child;
}

export function Notice(props: NoticeProps) {
  const tone = props.tone ?? "info";
  return (
    <div
      class={tone === "error" ? "notice error" : "notice"}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon name={tone === "error" ? "alert" : "info"} />
      <div class="grow">
        {props.title !== undefined && <div class="nt">{props.title}</div>}
        {props.children !== undefined && <div class="nd">{props.children}</div>}
      </div>
      {props.action}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: Child;
  action?: Child;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class="empty">
      <div class="et">{props.title}</div>
      {props.description !== undefined && (
        <div class="ed">{props.description}</div>
      )}
      {props.action}
    </div>
  );
}
