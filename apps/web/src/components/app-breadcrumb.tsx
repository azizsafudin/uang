import { Fragment } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

type Crumb = { label: string; to?: "/" | "/goals" };

function crumbsFor(pathname: string): Crumb[] {
  if (pathname === "/") return [{ label: "Dashboard" }];
  if (pathname.startsWith("/projections")) return [{ label: "Projections" }];
  if (pathname.startsWith("/settings")) return [{ label: "Settings" }];
  if (pathname.startsWith("/goals/"))
    return [{ label: "Goals", to: "/goals" }, { label: "Goal" }];
  if (pathname.startsWith("/goals")) return [{ label: "Goals" }];
  if (pathname.startsWith("/accounts/"))
    return [{ label: "Dashboard", to: "/" }, { label: "Account" }];
  return [{ label: "uang." }];
}

export function AppBreadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const crumbs = crumbsFor(pathname);

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
