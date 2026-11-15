import { isOwnPage } from "@/lib/ownPage";
import { useEffect } from "react";

const MANIFEST = "/dashboard-app.webmanifest";
const MAIN_PROFILE = "main";

function pointManifest(href: string): void {
  const link = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]') ?? document.head.appendChild(Object.assign(document.createElement("link"), { rel: "manifest" }));
  link.href = href;
}

/** While a Jellyfin tab is open, the home screen app opens on its configuration and user, even when reached without a page load. */
export function useDashboardApp(userUUID: string, profile: string | null): void {
  useEffect(() => {
    if (isOwnPage()) return undefined;
    const query = new URLSearchParams({ config: userUUID });
    if (profile !== null) query.set("profile", profile || MAIN_PROFILE);
    pointManifest(`${MANIFEST}?${query}`);
    return () => pointManifest(MANIFEST);
  }, [userUUID, profile]);
}
