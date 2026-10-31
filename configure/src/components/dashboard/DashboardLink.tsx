import { createContext, useCallback, useContext, type AnchorHTMLAttributes, type ReactNode } from "react";
import { dashboardUrl, navigateDashboard, useDashboardRoute, type DashboardPage, type DashboardRoute } from "@/lib/dashboardRoute";

const RouteContext = createContext<DashboardRoute | null>(null);

export function DashboardLinks({ children }: { children: ReactNode }) {
  const route = useDashboardRoute();
  return <RouteContext.Provider value={route}>{children}</RouteContext.Provider>;
}

export const titlePage = (key: string, kind: "movie" | "series"): DashboardPage => ({ kind: "title", ref: { id: key, type: kind } });

export const personPage = (id: string, name: string, photo: string | null = null): DashboardPage => ({ kind: "person", person: { id, name, role: null, type: "", photo } });

function targetOf(route: DashboardRoute, page: DashboardPage): DashboardRoute {
  return { tab: route.tab, config: route.config, profile: route.profile, section: route.section, page };
}

export function useDashboardOpen(): ((page: DashboardPage) => void) | null {
  const route = useContext(RouteContext);
  const open = useCallback((page: DashboardPage) => {
    if (route?.config) navigateDashboard(targetOf(route, page));
  }, [route]);
  return route?.config ? open : null;
}

export function DashboardLink({ page, name, children, onClick, ...rest }: { page: DashboardPage; name?: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const route = useContext(RouteContext);
  if (!route?.config) return <span className={rest.className}>{children}</span>;
  const target = targetOf(route, page);
  return (
    <a
      {...rest}
      href={dashboardUrl(target, name)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateDashboard(target);
      }}
    >
      {children}
    </a>
  );
}
