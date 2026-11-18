// The frame both extension pages share: the header, and the page shown when the browser does not offer the API.

import type { ReactNode } from "react";
import { COPY } from "../popup/copy.ts";
import { Icon } from "./icon.tsx";

export const PageHeader = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) => (
  <header className="page-hd">
    <img src="/icons/32.png" width={24} height={24} alt="" />
    <h1 className="grow">{title}</h1>
    {children}
  </header>
);

/** `extensions.experiments.enabled` is false, so `browser.oneClickHar` is undefined. */
export const ApiMissing = ({ title }: { readonly title: string }) => (
  <div className="page" data-view="api-missing">
    <PageHeader title={title} />
    <div className="page-body">
      <div className="callout callout-warn">
        <Icon name="alert" />
        <div className="stack-s">
          <p>
            <b>{COPY.apiMissingTitle}</b>
          </p>
          <p>{COPY.apiMissing}</p>
          <p className="meta">{COPY.apiMissingNote}</p>
        </div>
      </div>
    </div>
  </div>
);
