// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
require("dotenv").config();
const moviedb: any = require("./getTmdb");

async function getLanguages(config: any): Promise<Array<{ iso_639_1: string; name: string }>> {
  try {

    // /configuration/languages is what content can be in. primary_translations is only the
    // locales TMDB is translated into, and it drops every language it has no translation for.
    const languages = await moviedb.languages(config);

    return languages
      .filter((lang: any) => lang?.iso_639_1 && (lang.english_name || '').trim())
      .map((lang: any) => ({ iso_639_1: lang.iso_639_1, name: lang.english_name }));

  } catch (error: any) {
    console.error("Error fetching language list from TMDB:", error.message);
    return [{ iso_639_1: 'en', name: 'English' }];
  }
}

export { getLanguages };
module.exports = { getLanguages };
