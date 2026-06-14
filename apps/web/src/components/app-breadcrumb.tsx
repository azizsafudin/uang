import { Fragment } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useLiveQuery } from "@tanstack/react-db";
import { goalsCollection } from "@/lib/collections";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Crumb = { label: string; to?: "/" | "/goals" };

// The id segment of a /goals/:id detail path, else null.
function goalIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/goals\/([^/]+)/);
  return m ? m[1] : null;
}

function crumbsFor(pathname: string, goalName?: string): Crumb[] {
  if (pathname === "/") return [{ label: "Dashboard" }];
  if (pathname.startsWith("/projections")) return [{ label: "Projections" }];
  if (pathname.startsWith("/settings")) return [{ label: "Settings" }];
  if (pathname.startsWith("/goals/"))
    return [{ label: "Goals", to: "/goals" }, { label: goalName ?? "Goal" }];
  if (pathname.startsWith("/goals")) return [{ label: "Goals" }];
  if (pathname.startsWith("/accounts/"))
    return [{ label: "Dashboard", to: "/" }, { label: "Account" }];
  return [{ label: "uang." }];
}

export function AppBreadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // On a goal detail page, label the last crumb with the goal's name (live, so a
  // rename updates it); falls back to "Goal" until the collection has loaded.
  const goalId = goalIdFromPath(pathname);
  const { data: goals = [] } = useLiveQuery(goalsCollection);
  const goalName = goalId ? goals.find((g) => g.id === goalId)?.name : undefined;
  const crumbs = crumbsFor(pathname, goalName);

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
