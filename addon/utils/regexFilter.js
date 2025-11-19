/**
 * Regex-based content filtering utility for kid-safe content filtering
 * Allows parents to exclude content based on title/description patterns
 */

/**
 * Parse inline flags from regex pattern
 * Supports: (?i) (?-i) (?s) (?-s) (?m) (?-m)
 * @param {string} pattern - The regex pattern potentially containing inline flags
 * @returns {Object} - Object with parsed pattern and flags
 */
function parseInlineFlags(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return { pattern, flags: 'i' };
  }

  let flagSet = new Set(['i']);
  let cleanPattern = pattern;
  
  // Check for inline flags at the start of the pattern
  // Matches patterns like (?i), (?-i), (?im), (?-im), etc.
  const inlineFlagMatch = pattern.match(/^\(\?(-)?([ims]+)\)/);
  
  if (inlineFlagMatch) {
    const isNegation = inlineFlagMatch[1] === '-';
    const flagChars = inlineFlagMatch[2];
    
    if (isNegation) {
      for (const flag of flagChars) {
        flagSet.delete(flag);
      }
    } else {
      for (const flag of flagChars) {
        flagSet.add(flag);
      }
    }
    
    cleanPattern = pattern.substring(inlineFlagMatch[0].length);
  }
  
  return { pattern: cleanPattern, flags: Array.from(flagSet).join('') };
}

/**
 * Check if content should be excluded based on keywords or regex patterns
 * @param {Object} meta - The metadata object to check
 * @param {Array} keywordList - Pre-processed array of keywords (lowercase, trimmed)
 * @param {RegExp|null} compiledRegex - Pre-compiled regex pattern
 * @returns {boolean} - true if content should be excluded, false otherwise
 */
function shouldExcludeContent(meta, keywordList, compiledRegex) {
  if (!meta) {
    return false;
  }

  // Check keyword filtering first (simple, user-friendly)
  if (keywordList && keywordList.length > 0) {
    const textToCheck = [
      meta.name,
      meta.description,
      meta.originalTitle,
      ...(meta.alternativeTitles || [])
    ].filter(Boolean).join(' ').toLowerCase();

    for (const keyword of keywordList) {
      if (textToCheck.includes(keyword)) {
        return true;
      }
    }
  }

  // Check regex filtering (advanced users)
  if (compiledRegex) {
    // Check title
    if (meta.name && compiledRegex.test(meta.name)) {
      return true;
    }
    
    // Check description
    if (meta.description && compiledRegex.test(meta.description)) {
      return true;
    }
    
    // Check original title if different from name
    if (meta.originalTitle && meta.originalTitle !== meta.name && compiledRegex.test(meta.originalTitle)) {
      return true;
    }
    
    // Check alternative titles
    if (meta.alternativeTitles && Array.isArray(meta.alternativeTitles)) {
      for (const altTitle of meta.alternativeTitles) {
        if (compiledRegex.test(altTitle)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

/**
 * Filter an array of metadata objects based on keywords or regex exclusion patterns
 * @param {Array} metas - Array of metadata objects
 * @param {string} keywords - Comma-separated keywords to exclude
 * @param {string} regexPattern - Optional regex pattern for advanced users
 * @returns {Array} - Filtered array with excluded content removed
 */
function filterMetasByRegex(metas, keywords, regexPattern) {
  if (!Array.isArray(metas)) {
    return metas;
  }

  // Skip filtering if no patterns provided
  if ((!keywords || !keywords.trim()) && (!regexPattern || !regexPattern.trim())) {
    return metas;
  }

  // Pre-process keywords once (instead of in every iteration)
  const keywordList = keywords && keywords.trim() 
    ? keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k)
    : [];

  // Pre-compile regex once (instead of in every iteration)
  let compiledRegex = null;
  if (regexPattern && regexPattern.trim()) {
    try {
      const { pattern: cleanPattern, flags } = parseInlineFlags(regexPattern.trim());
      compiledRegex = new RegExp(cleanPattern, flags);
    } catch (error) {
      console.warn(`[Regex Filter] Invalid regex pattern "${regexPattern}":`, error.message);
      // Continue with null regex (won't filter by regex)
    }
  }

  const beforeCount = metas.length;
  const filteredMetas = metas.filter(meta => !shouldExcludeContent(meta, keywordList, compiledRegex));
  const afterCount = filteredMetas.length;
  
  if (beforeCount !== afterCount) {
    const patterns = [];
    if (keywordList.length > 0) patterns.push(`keywords: "${keywords}"`);
    if (compiledRegex) patterns.push(`regex: "${regexPattern}"`);
    console.log(`[Content Filter] Excluded ${beforeCount - afterCount} items matching ${patterns.join(' and ')}`);
  }
  
  return filteredMetas;
}

/**
 * Validate a regex pattern
 * @param {string} pattern - The regex pattern to validate
 * @returns {Object} - Validation result with isValid and error message
 */
function validateRegexPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') {
    return { isValid: true, error: null }; // Empty pattern is valid (no filtering)
  }

  try {
    const { pattern: cleanPattern, flags } = parseInlineFlags(pattern);
    new RegExp(cleanPattern, flags);
    return { isValid: true, error: null };
  } catch (error) {
    return { 
      isValid: false, 
      error: `Invalid regex pattern: ${error.message}` 
    };
  }
}

/**
 * Get common kid-safe exclusion patterns
 * @returns {Object} - Object with category names and their regex patterns
 */
function getCommonKidSafePatterns() {
  return {
    'Adult Content': 'naked|sex|porn|adult|xxx|erotic',
    'Violence': 'kill|murder|death|blood|violence|war|fight',
    'Drugs/Alcohol': 'drug|alcohol|drunk|high|stoned|addict',
    'Profanity': 'fuck|shit|damn|hell|bitch|ass',
    'Horror': 'horror|scary|ghost|demon|monster|zombie',
    'Crime': 'crime|theft|robbery|prison|jail|arrest'
  };
}

module.exports = {
  shouldExcludeContent,
  filterMetasByRegex,
  validateRegexPattern,
  getCommonKidSafePatterns,
  parseInlineFlags,
};
