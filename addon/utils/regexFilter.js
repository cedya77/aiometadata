/**
 * Regex-based content filtering utility for kid-safe content filtering
 * Allows parents to exclude content based on title/description patterns
 */

/**
 * Check if content should be excluded based on keywords or regex patterns
 * @param {Object} meta - The metadata object to check
 * @param {string} keywords - Comma-separated keywords to exclude
 * @param {string} regexPattern - Optional regex pattern for advanced users
 * @returns {boolean} - true if content should be excluded, false otherwise
 */
function shouldExcludeContent(meta, keywords, regexPattern) {
  if (!meta) {
    return false;
  }

  // Check keyword filtering first (simple, user-friendly)
  if (keywords && keywords.trim()) {
    const keywordList = keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
    if (keywordList.length > 0) {
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
  }

  // Check regex filtering (advanced users)
  if (regexPattern && regexPattern.trim()) {
    try {
      // Create regex from pattern (case-insensitive by default)
      const regex = new RegExp(regexPattern, 'i');
      
      // Check title
      if (meta.name && regex.test(meta.name)) {
        return true;
      }
      
      // Check description
      if (meta.description && regex.test(meta.description)) {
        return true;
      }
      
      // Check original title if different from name
      if (meta.originalTitle && meta.originalTitle !== meta.name && regex.test(meta.originalTitle)) {
        return true;
      }
      
      // Check alternative titles
      if (meta.alternativeTitles && Array.isArray(meta.alternativeTitles)) {
        for (const altTitle of meta.alternativeTitles) {
          if (regex.test(altTitle)) {
            return true;
          }
        }
      }
    } catch (error) {
      console.warn(`[Regex Filter] Invalid regex pattern "${regexPattern}":`, error.message);
      // Don't exclude if regex is invalid
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

  const beforeCount = metas.length;
  const filteredMetas = metas.filter(meta => !shouldExcludeContent(meta, keywords, regexPattern));
  const afterCount = filteredMetas.length;
  
  if (beforeCount !== afterCount) {
    const patterns = [];
    if (keywords && keywords.trim()) patterns.push(`keywords: "${keywords}"`);
    if (regexPattern && regexPattern.trim()) patterns.push(`regex: "${regexPattern}"`);
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
    new RegExp(pattern, 'i');
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
  getCommonKidSafePatterns
};
