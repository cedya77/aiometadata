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
