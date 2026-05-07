require("dotenv").config();
const moviedb: any = require("./getTmdb");

async function getLanguages(config: any): Promise<Array<{ iso_639_1: string; name: string }>> {
  try {

    const [primaryTranslations, languages] = await Promise.all([
      moviedb.primaryTranslations(config),
      moviedb.languages(config),
    ]);

    const languageMap = new Map(
      languages.map((lang: any) => [lang.iso_639_1, lang.english_name])
    );

    return primaryTranslations.map((translationCode: string) => {
      const [languageCode] = translationCode.split("-");
      const englishName = languageMap.get(languageCode) || 'Unknown';

      return { iso_639_1: translationCode, name: englishName };
    }).filter((lang: { iso_639_1: string; name: string }) => lang.name !== 'Unknown');

  } catch (error: any) {
    console.error("Error fetching language list from TMDB:", error.message);
    return [{ iso_639_1: 'en-US', name: 'English' }];
  }
}

export { getLanguages };
module.exports = { getLanguages };
