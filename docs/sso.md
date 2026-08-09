# Sign-in with an identity provider

Signing in with an OpenID Connect provider lets people reach their configurations with an account they already have, instead of a UUID and a password. It is entirely optional: with it switched off, nothing about the addon changes.

Once someone has saved a configuration to their account, opening it asks for nothing. The list of their saved configurations is on the sign-in dialog and in the dashboard.

## Before you start

- **Redis is required.** Sessions live there, not in the database.
- **The addon needs a stable public hostname over HTTPS.** The redirect URI is derived from the request, so an instance reached under two names will hand the provider two different URIs, and the provider will reject whichever it does not know.

## Register the addon with your provider

Create a confidential client with:

| | |
|---|---|
| Redirect URI | `https://<your-host>/api/auth/oidc/callback` |
| Grant type | authorization code |
| PKCE | S256 (always sent) |
| Scopes | `openid profile email groups` |

`groups` is requested because the permission mapping reads it. A provider that does not know that scope generally ignores it; one that rejects unknown scopes needs it defined, or `OIDC_GROUPS_CLAIM` pointed at a claim it does issue.

The exact redirect URI your instance will send is shown at `GET /api/auth/status`, which is the quickest way to settle a mismatch.

## Settings

All of these are in the dashboard under **Server**, or as environment variables. The client secret and the trusted proxy count are environment-only.

| Setting | Default | What it does |
|---|---|---|
| `OIDC_ENABLED` | `false` | Turns sign-in on. Does nothing until an issuer, client id and secret are set. |
| `OIDC_ISSUER` | — | Your provider's root URL. Discovery is read from `/.well-known/openid-configuration` beneath it. |
| `OIDC_CLIENT_ID` | — | Client id the provider issued. |
| `OIDC_CLIENT_SECRET` | — | Client secret. Environment only. |
| `OIDC_GROUPS_CLAIM` | `groups` | Which claim the permission mapping reads. |
| `OIDC_USERNAME_CLAIM` | — | Which claim names the account. Empty tries `preferred_username`, then `name`, then the email address. |
| `OIDC_GROUP_PERMISSIONS` | — | Maps groups to permissions. See below. |
| `OIDC_DEFAULT_PERMISSIONS` | — | What an identity matching nothing gets. Empty refuses the sign-in. |
| `OIDC_ALLOW_INSECURE_ISSUER` | `false` | Permits an `http` issuer. The secret and tokens then travel in the clear. |
| `OIDC_RATE_LIMIT_PER_WINDOW` | `20` | Sign-in attempts allowed per address per window. |
| `OIDC_RATE_LIMIT_WINDOW` | `300` | Length of that window, in seconds. |
| `TRUST_PROXY_HOPS` | `1` | How many reverse proxies sit in front of the addon. Environment only. |
| `SESSION_TTL_SECONDS` | `86400` | How long a sign-in lasts. |
| `AUTH_REQUIRE_SIGNIN` | `false` | Asks for a sign-in before the configuration and dashboard pages render, rather than only when saving. See below. |

Sign-in is rate limited per client address, and the address is only as trustworthy as the count in `TRUST_PROXY_HOPS`. It reads that many entries back from the end of `X-Forwarded-For`, because a client can add entries at the front but cannot remove the ones your own proxies append. The default of `1` matches the usual single reverse proxy; raise it if more sit in front. Set it to `0` when the addon is reachable directly, which reads the address from the socket and ignores the header.

Getting it wrong costs one of two things. Too low behind a proxy and every visitor shares one bucket, so a single abuser can exhaust the limit for everyone. Too high, or anything above `0` on a directly reachable instance, and the address can be forged, which defeats the limit but grants nothing on its own.

## Requiring sign-in

By default anyone reaching the configuration page sees it, and is only asked to sign in when they save. `AUTH_REQUIRE_SIGNIN=true` moves that gate to the page itself. The configuration and dashboard pages redirect to your provider before they render, and the API behind them answers `401` until a session exists, apart from the few endpoints the sign-in flow itself needs.

Addon routes are deliberately untouched. Manifests, catalogs, meta, streams and artwork are still served to anyone holding the URL, because clients carry no session and would stop working the moment the setting went on. This gates who can configure the instance, not who can use it.

Two things keep it from locking you out:

- It is ignored while no identity provider is configured, so turning it on before setting one up does nothing.
- A request carrying a valid `ADMIN_KEY` header passes regardless.

## Permissions

Two permissions exist:

- **`admin`** — reaches the dashboard. It is a superset: holding it grants everything else, so a group mapped to `admin` alone needs nothing added.
- **`createConfig`** — may create new configurations.

`createConfig` is only consulted on an instance that sets `ADDON_PASSWORD`, and only for someone signed in. Without an addon password anyone may create a configuration, so the permission would decide nothing; and a visitor who is not signed in cannot hold a permission at all, so they are left to the addon password as before.

Editing an existing configuration needs no permission. Knowing the configuration's own password, or having it saved to your account, is already the gate.

`OIDC_GROUP_PERMISSIONS` maps groups to them, as `group=permission|permission`, comma separated:

```env
OIDC_GROUP_PERMISSIONS=admins=admin|createConfig,users=createConfig
```

An identity matching no group falls to `OIDC_DEFAULT_PERMISSIONS`. **Leave that empty unless you mean it** — empty refuses the sign-in, which is what keeps an unmatched identity out. An entry the addon cannot parse also refuses the sign-in rather than guessing.

Setting `OIDC_DEFAULT_PERMISSIONS=admin` makes every identity your provider will authenticate an administrator here. That is reasonable when the provider itself decides who may reach the instance, as with a private Authelia or Keycloak. It is not reasonable with a provider that will authenticate anybody, such as Google.

Nothing requires the claim to be group membership. Point `OIDC_GROUPS_CLAIM` at `email` and the mapping becomes an allowlist of addresses, which is how providers without groups are handled:

```env
OIDC_GROUPS_CLAIM=email
OIDC_GROUP_PERMISSIONS=you@example.com=admin|createConfig
```

Editing `OIDC_GROUP_PERMISSIONS` or `OIDC_DEFAULT_PERMISSIONS` takes effect immediately, including for people already signed in: permissions are resolved from the identity's groups on every request, not frozen at sign-in. An edit that leaves someone matching nothing signs them out.

Group membership changes *at the provider* still take effect at the next sign-in, because the addon only learns someone's groups when they sign in. `SESSION_TTL_SECONDS` bounds that delay.

If the mapping is left unreadable, people already signed in keep the permissions they last resolved and an error is logged, so a typo cannot sign out an entire instance. New sign-ins are still refused.

Because a mapping edit applies at once, one that would remove your own admin permission — or switch the provider off entirely — asks you to confirm before it saves.

## Managing accounts

Once a provider is configured, the dashboard's **Users** tab is renamed **Accounts** and gains a panel listing everyone who has signed in: the permissions each one currently holds, the groups their provider presented, how many sessions they have open, and which configurations they have saved.

Permissions shown there are resolved live from the group mapping, so they are what the account has right now rather than what it had at sign-in. An account that has not signed in since this was added shows *unknown until next sign-in*, because the addon only learns someone's groups when they arrive.

Three actions, and the difference between them matters:

- **Revoke** ends every session the account holds. It does not stop them signing in again, which they can do immediately.
- **Block** refuses their next sign-in and revokes their sessions on the way. This is the one that ends someone's access. It survives until you unblock them, and you cannot block your own account.
- **Delete** forgets the account and unlinks its configurations. The configurations themselves survive and stay reachable by UUID and password, so deleting never destroys anyone's catalogs — but it does not stop a sign-in either, and the next one creates the account afresh.

Editing the group mapping remains the way to change what someone *may do*; blocking is the way to stop them being here at all.

## When a sign-in is refused

The Accounts panel also lists recent refused sign-ins with the reason and, where the exchange got far enough to know, the groups the provider actually sent and the claim they came from.

This is the quickest way to fix the most common misconfiguration. If `OIDC_GROUPS_CLAIM` names a claim your provider does not issue, every sign-in is refused and there is otherwise nothing to see — the entry will show the claim carrying *nothing*, and the fix is to name the claim your provider really sends. If instead the groups are listed but the sign-in is still refused, they matched no entry in `OIDC_GROUP_PERMISSIONS`.

How many entries are kept and for how long is set by `AUTH_SIGNIN_FAILURE_LOG_MAX` and `AUTH_SIGNIN_FAILURE_LOG_TTL`.

## Worked example: Authelia

In `configuration.yml`:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: aiometadata
        client_name: AIOMetadata
        client_secret: '$pbkdf2-sha512$...'   # hashed, from `authelia crypto hash generate pbkdf2`
        public: false
        authorization_policy: two_factor
        redirect_uris:
          - https://aiometadata.example.com/api/auth/oidc/callback
        scopes: [openid, profile, email, groups]
        grant_types: [authorization_code]
        response_types: [code]
        token_endpoint_auth_method: client_secret_basic
```

and on the addon:

```env
OIDC_ENABLED=true
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=aiometadata
OIDC_CLIENT_SECRET=<the plaintext secret, not the hash>
OIDC_GROUP_PERMISSIONS=admins=admin|createConfig,users=createConfig
```

Two things worth knowing about Authelia specifically:

- The secret in `configuration.yml` is a **hash**; the addon needs the **plaintext**.
- If your file ends with a `...` document-end marker, anything appended after it is outside the document and silently ignored — and `authelia validate-config` still reports success. Put the client block above that marker.

## What a user sees

Signing in is a button on the configure page and on the dashboard login. It does not, by itself, open anything: an account and a configuration are separate things until they are linked.

Linking happens through **Save this to your account**, which asks for the configuration's password once. That is the only time it is asked. From then on, opening that configuration — by picking it from the list, or by visiting its URL while signed in — needs nothing.

A password prompt reappearing on a configuration you thought was linked almost always means it was never saved to the account, only opened with its password.

## Troubleshooting

**"Sign-in failed" straight after the provider redirects back.** Usually the client authentication method. The addon reads `token_endpoint_auth_methods_supported` from discovery and uses `client_secret_post` only when the provider advertises it and not `client_secret_basic`; otherwise it sends HTTP Basic. A client registered as the other one fails at the token exchange. Align the registration with what discovery advertises.

**Redirected back but still asked for a password.** The configuration is not linked to the account yet. Use *Save this to your account* once.

**A group change at the provider had no effect.** The addon learns someone's groups when they sign in, so a membership change at the provider needs a new sign-in. Changing `OIDC_GROUP_PERMISSIONS` here, by contrast, applies at once. Revoke the account's sessions from the Accounts panel to force the re-sign-in.

**Sign-in refused for someone who should be allowed.** They matched no entry in `OIDC_GROUP_PERMISSIONS` and `OIDC_DEFAULT_PERMISSIONS` is empty. The refused sign-in in the Accounts panel shows what the provider actually put in the claim named by `OIDC_GROUPS_CLAIM`; a provider that omits the `groups` scope sends no groups at all.
