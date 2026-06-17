import { Fragment } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { accountsCollection, goalsCollection, instrumentsCollection } from "@/lib/collections";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Crumb = { label: string; to?: "/" | "/plan" | "/instruments" };

// The id segment of a /goals/:id detail path, else null.
function goalIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/goals\/([^/]+)/);
  return m ? m[1] : null;
}

// The id segment of an /accounts/:id detail path, else null.
function accountIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/accounts\/([^/]+)/);
  return m ? m[1] : null;
}

// The id segment of an /instruments/:id detail path, else null.
function instrumentIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/instruments\/([^/]+)/);
  return m ? m[1] : null;
}

function crumbsFor(
  pathname: string,
  goalName?: string,
  accountName?: string,
  instrumentName?: string,
): Crumb[] {
  if (pathname === "/") return [{ label: "Dashboard" }];
  if (pathname.startsWith("/plan")) return [{ label: "Plan" }];
  if (pathname.startsWith("/projections")) return [{ label: "Plan" }];
  if (pathname.startsWith("/settings")) return [{ label: "Settings" }];
  if (pathname.startsWith("/goals/"))
    return [{ label: "Plan", to: "/plan" }, { label: goalName ?? "Goal" }];
  if (pathname.startsWith("/goals")) return [{ label: "Plan" }];
  if (pathname.startsWith("/instruments/"))
    return [{ label: "Instruments", to: "/instruments" }, { label: instrumentName ?? "Instrument" }];
  if (pathname.startsWith("/instruments")) return [{ label: "Instruments" }];
  if (pathname.startsWith("/accounts/"))
    return [{ label: "Dashboard", to: "/" }, { label: accountName ?? "Account" }];
  return [{ label: "uang." }];
}

export function AppBreadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // On a goal detail page, label the last crumb with the goal's name (live, so a
  // rename updates it); falls back to "Goal" until the collection has loaded.
  const goalId = goalIdFromPath(pathname);
  const { data: goals = [] } = useLiveQuery(goalsCollection);
  const goalName = goalId ? goals.find((g) => g.id === goalId)?.name : undefined;
  // Same live-name treatment for the account-detail crumb.
  const accountId = accountIdFromPath(pathname);
  const { data: accounts = [] } = useLiveQuery(accountsCollection);
  const accountName = accountId ? accounts.find((a) => a.id === accountId)?.name : undefined;
  // Same live-name treatment for the instrument-detail crumb.
  const instrumentId = instrumentIdFromPath(pathname);
  const { data: instruments = [] } = useLiveQuery(instrumentsCollection);
  const instrumentName = instrumentId ? instruments.find((x) => x.id === instrumentId)?.name : undefined;
  const crumbs = crumbsFor(pathname, goalName, accountName, instrumentName);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={crumb.label}>
              <BreadcrumbItem>
                {last || !crumb.to ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link to={crumb.to} />}>
                    {crumb.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last ? <BreadcrumbSeparator /> : null}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
