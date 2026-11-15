// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
type OAuthProvider = 'trakt' | 'simkl' | 'anilist' | 'mal';
type OAuthPageStatus = 'success' | 'error' | 'warning' | 'info';

interface OAuthPageOptions {
  provider: OAuthProvider;
  status: OAuthPageStatus;
  title: string;
  message: string;
  detail?: string;
  username?: string;
  tokenId?: string;
  retryHref?: string;
  retryLabel?: string;
}

const PROVIDERS: Record<OAuthProvider, { label: string; accent: string }> = {
  trakt: { label: 'Trakt', accent: '#ef4444' },
  simkl: { label: 'Simkl', accent: '#f97316' },
  anilist: { label: 'AniList', accent: '#38bdf8' },
  mal: { label: 'MyAnimeList', accent: '#60a5fa' },
};

const STATUS_LABELS: Record<OAuthPageStatus, string> = {
  success: 'Connected',
  error: 'Connection failed',
  warning: 'Action needed',
  info: 'In progress',
};

const STATUS_COLORS: Record<OAuthPageStatus, string> = {
  success: '#4ade80',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#60a5fa',
};

const STATUS_ICONS: Record<OAuthPageStatus, string> = {
  success: '<path d="m7.5 12.5 3 3 6-7"/><circle cx="12" cy="12" r="9"/>',
  error: '<path d="m9 9 6 6m0-6-6 6"/><circle cx="12" cy="12" r="9"/>',
  warning: '<path d="M12 8v5m0 3h.01"/><path d="M10.3 4.9 3.1 17.4A1.8 1.8 0 0 0 4.7 20h14.6a1.8 1.8 0 0 0 1.6-2.6L13.7 4.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 10v6m0-9h.01"/>',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderOAuthPage(options: OAuthPageOptions): string {
  const provider = PROVIDERS[options.provider];
  const statusColor = options.status === 'success'
    ? provider.accent
    : STATUS_COLORS[options.status];
  const hasToken = Boolean(options.tokenId);
  const title = escapeHtml(options.title);
  const message = escapeHtml(options.message);
  const detail = options.detail
    ? `<p class="detail">${escapeHtml(options.detail)}</p>`
    : '';
  const account = options.username
    ? `<p class="account">Connected as <strong>${escapeHtml(options.username)}</strong></p>`
    : '';
  const tokenPanel = hasToken
    ? `
      <section class="token-panel" aria-labelledby="token-label">
        <div class="token-heading">
          <span id="token-label">Token ID</span>
          <span class="private-label">Keep private</span>
        </div>
        <code id="tokenId" tabindex="0">${escapeHtml(options.tokenId)}</code>
      </section>
      <div class="steps">
        <span class="step"><b>1</b> Copy the token</span>
        <span class="step"><b>2</b> Return to configuration</span>
        <span class="step"><b>3</b> Paste and save</span>
      </div>
    `
    : '';
  const primaryAction = hasToken
    ? '<button class="button primary" id="copyButton" type="button" onclick="copyToken(this)">Copy token ID</button>'
    : options.retryHref
      ? `<a class="button primary" href="${escapeHtml(options.retryHref)}">${escapeHtml(options.retryLabel || 'Try again')}</a>`
      : '';
  const secondaryAction = '<button class="button secondary" type="button" onclick="closeWindow(this)">Close window</button>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="no-referrer">
  <title>${provider.label} · ${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: ${provider.accent};
      --status: ${statusColor};
      --background: #0c0d0f;
      --surface: #151619;
      --surface-raised: #1b1c20;
      --border: #2a2c32;
      --text: #f2f3f5;
      --muted: #a1a4ab;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: clamp(1rem, 4vw, 2rem);
      background:
        radial-gradient(circle at 50% 0%, rgba(96, 165, 250, .10), transparent 38rem),
        var(--background);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      width: min(100%, 34rem);
      padding: clamp(1.35rem, 5vw, 2rem);
      border: 1px solid var(--border);
      border-radius: 1.25rem;
      background: rgba(21, 22, 25, .96);
      box-shadow: 0 1.5rem 4rem rgba(0, 0, 0, .34);
      text-align: center;
      animation: enter .24s ease-out;
    }
    .brand {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: .6rem;
      color: var(--muted);
      font-size: .82rem;
      font-weight: 650;
      letter-spacing: .01em;
    }
    .brand img {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: .4rem;
      object-fit: contain;
    }
    .brand-divider { color: #555861; }
    .provider { color: var(--accent); }
    .status-icon {
      display: grid;
      place-items: center;
      width: 3.5rem;
      height: 3.5rem;
      margin: 1.5rem auto .85rem;
      border: 1px solid color-mix(in srgb, var(--status) 38%, transparent);
      border-radius: 50%;
      background: color-mix(in srgb, var(--status) 12%, transparent);
      color: var(--status);
    }
    .status-icon svg {
      width: 1.65rem;
      height: 1.65rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .eyebrow {
      margin: 0 0 .45rem;
      color: var(--status);
      font-size: .75rem;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(1.55rem, 5vw, 2rem);
      line-height: 1.15;
      letter-spacing: -.025em;
    }
    .message, .detail, .account {
      margin: .8rem auto 0;
      max-width: 29rem;
      color: var(--muted);
      font-size: .95rem;
      line-height: 1.55;
    }
    .detail { font-size: .84rem; }
    .account strong { color: var(--text); font-weight: 650; }
    .token-panel {
      margin-top: 1.35rem;
      padding: .85rem;
      border: 1px solid var(--border);
      border-radius: .85rem;
      background: #0f1012;
      text-align: left;
    }
    .token-heading {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: .55rem;
      color: var(--muted);
      font-size: .72rem;
      font-weight: 650;
      letter-spacing: .05em;
      text-transform: uppercase;
    }
    .private-label { color: #fbbf24; }
    code {
      display: block;
      color: #e5e7eb;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: .82rem;
      line-height: 1.55;
      overflow-wrap: anywhere;
      user-select: all;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: .45rem;
      margin-top: .8rem;
      color: var(--muted);
      font-size: .72rem;
      line-height: 1.35;
      text-align: left;
    }
    .step {
      padding: .55rem;
      border-radius: .65rem;
      background: var(--surface-raised);
    }
    .step b { color: var(--accent); margin-right: .2rem; }
    .actions {
      display: flex;
      gap: .65rem;
      margin-top: 1.35rem;
    }
    .button {
      min-height: 2.8rem;
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: .7rem 1rem;
      border: 1px solid transparent;
      border-radius: .75rem;
      font: inherit;
      font-size: .9rem;
      font-weight: 650;
      text-decoration: none;
      cursor: pointer;
      transition: transform .15s ease, border-color .15s ease, filter .15s ease;
    }
    .button:hover { transform: translateY(-1px); }
    .button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }
    .primary { background: var(--accent); color: #071015; }
    .primary:hover { filter: brightness(1.08); }
    .secondary { border-color: var(--border); background: var(--surface-raised); color: var(--text); }
    .secondary:hover { border-color: #454851; }
    .privacy {
      margin: 1rem 0 0;
      color: #777b84;
      font-size: .7rem;
      line-height: 1.4;
    }
    @keyframes enter {
      from { opacity: 0; transform: translateY(.4rem) scale(.99); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (max-width: 31rem) {
      .steps { grid-template-columns: 1fr; }
      .actions { flex-direction: column; }
      .card { border-radius: 1rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; }
      .button { transition: none; }
    }
  </style>
</head>
<body>
  <main class="card" aria-live="${options.status === 'info' ? 'polite' : 'assertive'}">
    <div class="brand"><img src="/logo.png" alt="AIO Metadata"><span class="brand-divider" aria-hidden="true">/</span><span class="provider">${provider.label}</span></div>
    <div class="status-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">${STATUS_ICONS[options.status]}</svg>
    </div>
    <p class="eyebrow">${STATUS_LABELS[options.status]}</p>
    <h1>${title}</h1>
    <p class="message">${message}</p>
    ${account}
    ${detail}
    ${tokenPanel}
    <div class="actions">${primaryAction}${secondaryAction}</div>
    ${hasToken ? '<p class="privacy">Treat this token ID like a password. Anyone with it may be able to use your connected account through this addon.</p>' : ''}
  </main>
  <script>
    async function copyToken(button) {
      const token = document.getElementById('tokenId')?.textContent || '';
      const originalLabel = button.textContent;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(token);
        } else {
          const field = document.createElement('textarea');
          field.value = token;
          field.style.position = 'fixed';
          field.style.opacity = '0';
          document.body.appendChild(field);
          field.select();
          document.execCommand('copy');
          field.remove();
        }
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Select and copy manually';
        document.getElementById('tokenId')?.focus();
      }
      window.setTimeout(() => { button.textContent = originalLabel; }, 2200);
    }
    function closeWindow(button) {
      window.close();
      window.setTimeout(() => { button.textContent = 'You can close this tab'; }, 150);
    }
  </script>
</body>
</html>`;
}
