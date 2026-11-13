// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestAuth {
  authenticated: boolean;
}

const store = new AsyncLocalStorage<RequestAuth>();

function runWithRequestAuth<T>(authenticated: boolean, fn: () => T): T {
  return store.run({ authenticated }, fn);
}

function inRequest(): boolean {
  return store.getStore() !== undefined;
}

function requestIsAuthenticated(): boolean {
  return store.getStore()?.authenticated === true;
}

export { runWithRequestAuth, inRequest, requestIsAuthenticated };
module.exports = { runWithRequestAuth, inRequest, requestIsAuthenticated };
