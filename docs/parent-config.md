# Parent Config

A configuration can take its settings from another configuration on the same instance, its **parent**. Set up one configuration the way you like it, link the others to it, and every change saved to the parent reaches them on their next request. It works like the Parent Config feature in AIOStreams.

Typical uses: a kids' profile that keeps the family catalogs but tightens the age rating, or one configuration per household member, each with its own Trakt or Simkl account, that all share one catalog layout.

## Linking a parent

1. Open the configuration that should inherit (the child) and go to **Configuration → Parent Config**.
2. Enter the parent's UUID and password and select **Link Parent**. The password is checked straight away.
3. Choose a merge strategy for each section (below), then **Save** the child.

**Unlink** removes the link; the child then serves its own settings again once saved.

## Merge strategies

Each section has its own strategy:

| Strategy | Effect |
| --- | --- |
| **Inherit from Parent** (default) | The section is served from the parent. The child's own values for it are kept but not used. |
| **Override with Mine** | The section is served from the child's own settings. |
| **Extend Parent (Add Mine)** | Catalogs only: the parent's catalogs in the parent's order, followed by the child's catalogs that the parent does not have. The same applies to tags. A catalog both have is served as the parent has it. The section's other settings follow the parent. |

The sections are **General**, **API Keys**, **Meta Providers**, **Art Providers**, **Filters**, **Search** and **Catalogs**. Under each one, **Field Overrides** sets a different strategy for a single setting, for example inheriting everything in General except the addon name. A field override always wins over its section.

## What always stays the child's own

These are never taken from the parent, whatever the strategies say:

- tracker sign-ins (Trakt, Simkl, AniList, MyAnimeList, MovieLens) and watch tracking;
- addon manager accounts;
- Jellyfin users, PINs and server settings;
- recommendation settings;
- the configuration password, UUID and install URL.

If the child inherits **API Keys**, the parent's MDBList and PublicMetaDB keys are used for the child's catalogs. Set that key to **Override with Mine** if the child should use its own account.

## Good to know

- The configure page always shows the child's own settings. Sections set to Inherit are served from the parent, so what you see on, say, the Filters page is not what the child serves until Filters is set to Override.
- Only one level is followed. If the parent has a parent of its own, the child sees the parent's own settings, not its grandparent's.
- A configuration cannot be its own parent.
- If the parent is deleted, or its password is reset by an admin, the child keeps working on its own settings. A password reset reaches linked configurations within ten minutes. The child cannot be saved until the link is fixed or removed.
- Saving the child checks the parent link and validates the result: a required API key can come from the parent.
- Exported configuration files never include the link, because it holds the parent's password. Importing a file keeps the link the configuration already has.
- The parent's password is stored with the child's configuration, the same way the configuration's API keys are, so only link to a parent whose password you are allowed to share.

## API

`POST /api/config/verify-parent/:userUUID` with `{ "password": "…" }` checks a parent's UUID and password without returning its configuration. It answers `200 { "success": true, "userUUID": "…" }`, or `401` for a wrong UUID or password, and shares the rate limit of `/api/config/load`.

The link is saved as `parentConfig` in the configuration sent to `/api/config/save` and `/api/config/update/:userUUID`:

```json
{
  "parentConfig": {
    "uuid": "parent-uuid",
    "password": "parent-password",
    "mergeStrategies": {
      "filters": "override",
      "catalogs": "extend",
      "fieldOverrides": { "addonName": "override" }
    }
  }
}
```

Sections left out of `mergeStrategies` inherit. A save with a link that cannot be used fails with `400` and an error starting `Parent config:`.
