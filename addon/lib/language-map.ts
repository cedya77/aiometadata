import { config } from 'dotenv';
config();
import * as moviedb from './getTmdb.js';
import getCountryISO3 from 'country-iso-2-to-3';
import languages from '@cospired/i18n-iso-languages';
import { UserConfig } from '../types/index.js';

// Type definitions
interface LanguageDetails {
  name: string;
  code3: string;
}

interface AvailableLanguage {
  iso_639_1: string;
  name: string;
}

interface LanguageData {
  availableLanguages: AvailableLanguage[];
  languageMap: Map<string, LanguageDetails>;
}

interface TmdbLanguage {
  iso_639_1: string;
  english_name: string;
}

// Cache for language data
let languageData: LanguageData | null = null;

/**
 * Fetches and caches the full language data from TMDB.
 */
async function loadLanguageData(config: UserConfig): Promise<LanguageData> {
  if (languageData) return languageData;

  try {
    const [primaryTranslations, allLanguages] = await Promise.all([
      moviedb.primaryTranslations(config),
      moviedb.languages(config),
    ]);

    // Create a fast lookup map: 'en' -> { english_name: 'English', iso_639_2: 'eng' }
    const languageMap = new Map<string, LanguageDetails>(
      (allLanguages as TmdbLanguage[]).map(lang => {
        const code3 = languages.alpha2ToAlpha3T(lang.iso_639_1) || 
                     languages.alpha2ToAlpha3B(lang.iso_639_1) || 
                     'eng';
        return [lang.iso_639_1, { 
          name: lang.english_name, 
          code3: lang.iso_639_1 === "pt" ? lang.iso_639_1 : code3 
        }];
      })
    );

    // Filter and format the list of available translations
    const availableLanguages: AvailableLanguage[] = (primaryTranslations as string[]).map((translationCode) => {
      const [langCode2] = translationCode.split("-");
      const details = languageMap.get(langCode2);
      return details ? { iso_639_1: translationCode, name: details.name } : null;
    }).filter((item): item is AvailableLanguage => item !== null);

    languageData = {
      availableLanguages,
      languageMap
    };
    return languageData;
  } catch (error) {
    console.error("Error fetching language data from TMDB:", (error as Error).message);
    // Provide a safe fallback
    return {
      availableLanguages: [{ iso_639_1: 'en-US', name: 'English' }],
      languageMap: new Map([['en', { name: 'English', code3: 'eng' }]])
    };
  }
}

/**
 * Returns the list of languages for the addon configuration page.
 */
async function getLanguageListForConfig(config: UserConfig): Promise<AvailableLanguage[]> {
  const data = await loadLanguageData(config);
  return data.availableLanguages;
}

/**
 * Converts a 2-letter based language code (e.g., 'pt-BR') to the 3-letter code for TVDB.
 * @param langCode2 The 2-letter code (e.g., 'pt').
 * @param config The user configuration object.
 * @returns The 3-letter code, defaulting to 'eng'.
 */
async function to3LetterCode(langCode2: string, config: UserConfig): Promise<string> {
  const data = await loadLanguageData(config);
  const details = data.languageMap.get(langCode2);
  return details?.code3 || 'eng'; // Default to English if not found
}

/**
 * Converts a 2-letter country code (e.g., 'US') to the 3-letter ISO 3166-1 alpha-3 code.
 * @param countryCode2 The 2-letter country code from a language tag like 'en-US'.
 * @returns The 3-letter code, defaulting to 'usa'.
 */
function to3LetterCountryCode(countryCode2: string | undefined): string {
  if (!countryCode2) {
    return 'usa';
  }
  //console.log(`Converting country code: ${countryCode2}`);
  const countryData = getCountryISO3(countryCode2.toUpperCase());
  
  return countryData ? countryData.toLowerCase() : 'usa';
}

export {
  getLanguageListForConfig,
  to3LetterCode,
  to3LetterCountryCode
};

// CommonJS compatibility
module.exports = { 
  getLanguageListForConfig, 
  to3LetterCode, 
  to3LetterCountryCode 
};
