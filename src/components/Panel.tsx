import { ReactNode } from "react";
import { Icon, IconName } from "./Icon";

interface Props {
  title: string;
  icon: IconName;
  count?: number;
  tone?: "danger" | "warn" | "prep";
  actions?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, icon, count, tone, actions, children }: Props) {
  return (
    <section className={`panel ${tone ? `tone-${tone}` : ""}`} aria-label={title}>
      <header className="panel-head">
        <Icon name={icon} />
        <h2>{title}</h2>
        {count != null && count > 0 && <span className="count">{count}</span>}
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
