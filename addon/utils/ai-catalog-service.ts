// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { buildCatalogConfigs } from './ai-catalog-config-builder';
import { resolveEntities } from './ai-catalog-entity-resolver';
import { buildCatalogCreationPrompt, parseCatalogAIResponse } from './ai-catalog-generation';
import { normalizeCatalog, normalizeCatalogMediaTypes, stripUnknownParams, validateCatalogParams } from './ai-catalog-sanitizer';

export {
  buildCatalogCreationPrompt,
  parseCatalogAIResponse,
  normalizeCatalog,
  normalizeCatalogMediaTypes,
  stripUnknownParams,
  validateCatalogParams,
  resolveEntities,
  buildCatalogConfigs,
};

module.exports = {
  buildCatalogCreationPrompt,
  parseCatalogAIResponse,
  normalizeCatalog,
  normalizeCatalogMediaTypes,
  stripUnknownParams,
  validateCatalogParams,
  resolveEntities,
  buildCatalogConfigs,
};
