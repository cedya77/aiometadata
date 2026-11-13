// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const getCountryISO3 = require("country-iso-2-to-3");

/**
 * Comprehensive TVDB Content Rating Mapping
 * Maps MPAA-style ageRating (G, PG, PG-13, R, NC-17) to TVDB content rating IDs by country and content type
 * Based on actual TVDB /content/ratings endpoint data
 */
const TVDB_CONTENT_RATINGS = {
  // Argentina (arg)
  arg: {
    episode: {
      'G': 1, // ATP - Suitable for all audiences
      'PG': 2, // +13 - Suitable for ages 13 and up
      'PG-13': 3, // +16 - Suitable for ages 16 and up
      'R': 4, // +18 - Suitable for ages 18 and up
      'NC-17': 4 // +18 (highest available)
    },
    movie: {
      'G': 251, // ATP - Suitable for all ages
      'PG': 252, // SAM13 - Suitable for ages 13 and over
      'PG-13': 253, // SAM16 - Suitable for ages 16 and over
      'R': 254, // SAM18 - Suitable for ages 18 and over
      'NC-17': 255 // C - Suitable for ages 18 and over, licensed venues only
    }
  },
  
  // Armenia (arm)
  arm: {
    episode: {
      'G': 5, // 0+ - Suitable for all ages
      'PG': 8, // 7+ - Suitable for ages 7 and up
      'PG-13': 11, // 12+ - Suitable for ages 12 and up
      'R': 13, // 15+ - Suitable for ages 15 and up
      'NC-17': 15 // 18+ - Suitable only for adults ages 18 and up
    }
    // No movie ratings for Armenia
  },
  
  // Australia (aus)
  aus: {
    episode: {
      'G': 18, // G - Suitable for all ages, but not necessarily intended for children
      'PG': 19, // PG - Parental guidance recommended for young viewers
      'PG-13': 20, // M - Recommended for ages 15 years or over
      'R': 21, // MA15+ - Not suitable for people under 15
      'NC-17': 21 // MA15+ (highest available)
    },
    movie: {
      'G': 256, // G - Suitable for all audiences
      'PG': 257, // PG - Parental guidance recommended for viewers under 15
      'PG-13': 258, // M - Recommended for mature audiences
      'R': 259, // MA15+ - Not suitable for viewers under 15
      'NC-17': 260 // R18+ - Restricted to viewers 18 years and over
    }
  },
  
  // Brazil (bra)
  bra: {
    episode: {
      'G': 23, // L - Suitable for all audiences
      'PG': 24, // 10 - Suitable for viewers over the age of 10
      'PG-13': 25, // 12 - Suitable for viewers over the age of 12
      'R': 27, // 16 - Suitable for viewers over the age of 16
      'NC-17': 28 // 18 - Suitable for viewers over the age of 18
    },
    movie: {
      'G': 277, // L - Suitable for all ages
      'PG': 278, // 10 - Not recommended for minors under 10
      'PG-13': 279, // 12 - Not recommended for minors under 12
      'R': 281, // 16 - Not recommended for minors under 16
      'NC-17': 282 // 18 - Not recommended for minors under 18
    }
  },
  
  // Cambodia (khm)
  khm: {
    episode: {
      'G': 30, // G - Suitable for general audiences
      'PG': 30, // G (no PG equivalent)
      'PG-13': 30, // G (no PG-13 equivalent)
      'R': 32, // R18 - Allowed for viewers 18 and over
      'NC-17': 32 // R18
    }
    // No movie ratings for Cambodia
  },
  
  // Canada (can)
  can: {
    episode: {
      'G': 37, // G - Suitable for general audiences
      'PG': 38, // PG - Parental guidance suggested
      'PG-13': 39, // 14+ - Programming intended for viewers ages 14 and older
      'R': 40, // 18+ - Programming intended for viewers ages 18 and older
      'NC-17': 40 // 18+ (highest available)
    },
    movie: {
      'G': 288, // G - Suitable for all ages
      'PG': 289, // PG - Parental guidance advised
      'PG-13': 290, // 14A - Parental guidance advised for viewers 14 or younger
      'R': 291, // 18A - Parental guidance advised for viewers 18 or younger
      'NC-17': 292 // R - Restricted to viewers 18 years and over
    }
  },
  
  // Chile (chl)
  chl: {
    episode: {
      'G': 41, // I - Suitable for all children
      'PG': 44, // I12 - Recommended for children and teens ages 12 or older
      'PG-13': 45, // F - Suitable for a general audience of all ages
      'R': 46, // R - Parental guidance suggested for children under 12
      'NC-17': 47 // A - Suitable for adult audiences only (ages 18 or older)
    },
    movie: {
      'G': 295, // TE - Suitable for all ages
      'PG': 296, // TE+7 - Not suitable for children younger than 7 years
      'PG-13': 297, // 14 - Recommended for viewers over 14 years old
      'R': 298, // R - Recommended for viewers over 18 years old
      'NC-17': 298 // R (highest available)
    }
  },
  
  // Colombia (col)
  col: {
    episode: {
      'G': 50, // 3 - Familiar
      'PG': 50, // 3 (no PG equivalent)
      'PG-13': 50, // 3 (no PG-13 equivalent)
      'R': 51, // 4 - Suitable for adult audiences
      'NC-17': 51 // 4 (highest available)
    },
    movie: {
      'G': 299, // TODOS - Suitable for all audiences
      'PG': 300, // 7 - Suitable for viewers over 7
      'PG-13': 301, // 12 - Suitable for viewers over 12
      'R': 302, // 15 - Restricted to viewers over 15
      'NC-17': 303 // 18 - Restricted to viewers over 18
    }
  },
  
  // Croatia (hrv)
  hrv: {
    episode: {
      'G': null, // No G equivalent
      'PG': 52, // 12 - Suitable for children of 12 years of age or older
      'PG-13': 53, // 15 - Suitable for teens of 15 years of age or older
      'R': 54, // 18 - Suitable for adults of 18 years of age or older
      'NC-17': 54 // 18 (highest available)
    }
    // No movie ratings for Croatia
  },
  
  // Denmark (dnk)
  dnk: {
    episode: {
      'G': 55, // A - Suitable for all ages
      'PG': 56, // 7 - Allowed for children over 7 years
      'PG-13': 56, // 7 (no PG-13 equivalent)
      'R': 56, // 7 (no R equivalent)
      'NC-17': 56 // 7 (highest available)
    },
    movie: {
      'G': 306, // A - Suitable for a general audience
      'PG': 307, // 7 - Not recommended for children under 7
      'PG-13': 308, // 11 - Recommended for ages 11 and up
      'R': 309, // 15 - Recommended for ages 15 and up
      'NC-17': 309 // 15 (highest available)
    }
  },
  
  // Ecuador (ecu)
  ecu: {
    episode: {
      'G': 59, // A - Suitable for all age groups
      'PG': 60, // B - Suitable for all age groups, 12 & under needs adult supervision
      'PG-13': 60, // B (no PG-13 equivalent)
      'R': 61, // C - Suitable only for adults
      'NC-17': 61 // C (highest available)
    }
    // No movie ratings for Ecuador
  },
  
  // El Salvador (slv)
  slv: {
    episode: {
      'G': 62, // 0+ - Suitable for all age groups
      'PG': 63, // 12+ - Suitable for ages 12 and up
      'PG-13': 64, // 15+ - Suitable for ages 15 and up
      'R': 65, // 18+ - Suitable for ages 18 and up
      'NC-17': 65 // 18+ (highest available)
    }
    // No movie ratings for El Salvador
  },
  
  // Finland (fin)
  fin: {
    episode: {
      'G': 67, // ST - All ages
      'PG': 68, // 7 - 7 and older
      'PG-13': 69, // 12 - 12 and older
      'R': 70, // 16 - 16 and older
      'NC-17': 71 // 18 - Adult
    },
    movie: {
      'G': 318, // ST - For all ages
      'PG': 319, // K-7 - Not for children under 7
      'PG-13': 320, // K-12 - Not for children under 12
      'R': 321, // K-16 - Not for children under 16
      'NC-17': 322 // K-18 - Only for adults
    }
  },
  
  // France (fra)
  fra: {
    episode: {
      'G': 72, // TP - Suitable for all audiences
      'PG': 73, // -10 - Not recommended for children under 10
      'PG-13': 74, // -12 - Not recommended for children under 12
      'R': 75, // -16 - Not recommended for persons under 16
      'NC-17': 75 // -16 (highest available)
    },
    movie: {
      'G': 323, // TP - Suitable for all audiences
      'PG': 324, // -12 - Prohibiting for minors under 12
      'PG-13': 325, // -16 - Prohibiting for minors under 16
      'R': 325, // -16 (no R equivalent)
      'NC-17': 325 // -16 (highest available)
    }
  },
  
  // Germany (deu)
  deu: {
    episode: {
      'G': null, // No G equivalent
      'PG': null, // No PG equivalent
      'PG-13': 77, // 16+ - Restricted to ages 16 and older
      'R': 78, // 18+ - Restricted to ages 18 and older
      'NC-17': 78 // 18+ (highest available)
    },
    movie: {
      'G': 328, // 0+ - Suitable for all ages
      'PG': 329, // 6+ - Restricted to ages 6 and older
      'PG-13': 330, // 12+ - Restricted to ages 12 and older, ages 6-11 with adult accompaniment
      'R': 331, // 16+ - Restricted to ages 16 and older
      'NC-17': 332 // 18+ - Restricted to ages 18 and older
    }
  },
  
  // Greece (grc)
  grc: {
    episode: {
      'G': 79, // K - Suitable for all ages
      'PG': 80, // 8 - Suitable for ages 8 and up
      'PG-13': 81, // 12 - Suitable for ages 12 and up
      'R': 82, // 16 - Suitable for ages 16 and up
      'NC-17': 83 // 18 - Suitable for ages 18 and up
    },
    movie: {
      'G': 334, // K - Suitable for all ages
      'PG': 335, // 12 - Suitable for minors over12
      'PG-13': 336, // 16 - Suitable for minors over16
      'R': 337, // 18 - Not suitable for minors
      'NC-17': 337 // 18 (highest available)
    }
  },
  
  // Hong Kong (hkg)
  hkg: {
    episode: {
      'G': 84, // I - General audiences
      'PG': 84, // I (no PG equivalent)
      'PG-13': 84, // I (no PG-13 equivalent)
      'R': 86, // III - Recommended for adult viewers above the age of 18
      'NC-17': 86 // III (highest available)
    },
    movie: {
      'G': 338, // I - Suitable for all ages
      'PG': 339, // IIA - Not suitable for children
      'PG-13': 340, // IIB - Not suitable for young persons and children
      'R': 341, // III - Restricted to ages 18 or above
      'NC-17': 341 // III (highest available)
    }
  },
  
  // Hungary (hun)
  hun: {
    episode: {
      'G': 87, // KN - Program can be viewed by any age
      'PG': 89, // 6 - Not recommended for children below the age of 6
      'PG-13': 90, // 12 - Not recommended for children below the age of 12
      'R': 91, // 16 - Not recommended for teens and children below the age of 16
      'NC-17': 92 // 18 - Recommended for adult viewers only (ages 18 and up)
    },
    movie: {
      'G': 342, // KN - Unrestricted or exempt
      'PG': 343, // 6 - Not recommended for viewers under 6
      'PG-13': 344, // 12 - Not recommended for viewers under 12
      'R': 345, // 16 - Not recommended for viewers under 16
      'NC-17': 346 // 18 - Not recommended for viewers under 18
    }
  },
  
  // Iceland (isl)
  isl: {
    episode: {
      'G': 93, // L - Suitable for all ages
      'PG': 94, // 7 - Suitable for ages 7 and older
      'PG-13': 96, // 12 - Suitable for ages 12 and older
      'R': 98, // 16 - Suitable for ages 16 and older
      'NC-17': 99 // 18 - Suitable for ages 18 and older
    },
    movie: {
      'G': 348, // G - General audiences
      'PG': 349, // PG - Parental guideance
      'PG-13': 351, // PG-13 - Not recommended for viewers under 13
      'R': 353, // R - Restricted to ages 18 or above
      'NC-17': 353 // R (highest available)
    }
  },
  
  // India (ind)
  ind: {
    episode: {
      'G': 100, // U - Unrestricted public exhibition
      'PG': 101, // UA13+ - Parental guidance recommended for those under 13 years of age
      'PG-13': 101, // UA13+ (no PG-13 equivalent)
      'R': 102, // A - Restricted to adults 18 years of age and older only
      'NC-17': 102 // A (highest available)
    },
    movie: {
      'G': 354, // U - Unrestricted, suitable for all ages
      'PG': 355, // UA13+ - Parental guidance recommended for viewers under 13
      'PG-13': 355, // UA13+ (no PG-13 equivalent)
      'R': 356, // A - Restricted to adults age 18 and over
      'NC-17': 356 // A (highest available)
    }
  },
  
  // Indonesia (idn)
  idn: {
    episode: {
      'G': 104, // SU - Suitable for general audiences over the age of 2 years
      'PG': 107, // 13 - Suitable for teens ages 13 - 17
      'PG-13': 107, // 13 (no PG-13 equivalent)
      'R': 111, // 17 - Suitable for viewers 17 and older
      'NC-17': 111 // 17 (highest available)
    },
    movie: {
      'G': 358, // SU - Suitable for all ages
      'PG': 359, // 13 - Suitable for ages 13 and above
      'PG-13': 359, // 13 (no PG-13 equivalent)
      'R': 360, // 17 - Suitable for ages 17 and above
      'NC-17': 361 // 21 - Suitable for ages 21 and above
    }
  },
  
  // Ireland (irl)
  irl: {
    episode: {
      'G': 112, // G - Suitable for all audiences
      'PG': 113, // PG - Suitable for children under 12 with parental guidance
      'PG-13': 115, // 15 - Suitable for persons aged 15 and over
      'R': 116, // 18 - Suitable for persons aged 18 and over
      'NC-17': 116 // 18 (highest available)
    },
    movie: {
      'G': 362, // G - Suitable for children 4 and up
      'PG': 363, // PG - Parental guidance recommended for children under 12
      'PG-13': 364, // 12 - Restricted to ages 12 and over, unless accompanied by an adult
      'R': 365, // 15 - Restricted to ages 15 and over, unless accompanied by an adult
      'NC-17': 367 // 18 - Restricted to adult viewers ages 18 and over
    }
  },
  
  // Israel (isr)
  isr: {
    episode: {
      'G': 117, // 0+ - Suitable for a general audience of all ages
      'PG': 118, // 12+ - Suitable for persons aged 12 and over
      'PG-13': 119, // 15+ - Suitable for persons aged 15 and over
      'R': 120, // 18+ - Suitable only for adults
      'NC-17': 120 // 18+ (highest available)
    }
    // No movie ratings for Israel
  },
  
  // Italy (ita)
  ita: {
    episode: {
      'G': 125, // T - Suitable for all ages
      'PG': 126, // 6+ - Not suitable for children under 6
      'PG-13': 128, // 14+ - Not suitable for children under 14
      'R': 129, // 18+ - Not suitable for children under 18
      'NC-17': 129 // 18+ (highest available)
    },
    movie: {
      'G': 368, // T - All ages admitted
      'PG': 368, // T (no PG equivalent)
      'PG-13': 369, // 14+ - No admittance for children under 14
      'R': 370, // 18+ - No admittance for children under 18
      'NC-17': 370 // 18+ (highest available)
    }
  },
  
  // Lithuania (ltu)
  ltu: {
    episode: {
      'G': 130, // V - Suitable for a general audience
      'PG': 131, // N-7 - Suitable for children of 7 years of age or older
      'PG-13': 132, // N-14 - Suitable for teens of 14 years of age or older
      'R': 133, // S - Suitable for adults of 18 years of age or older
      'NC-17': 133 // S (highest available)
    }
    // No movie ratings for Lithuania
  },
  
  // Malaysia (mys)
  mys: {
    episode: {
      'G': 134, // U - Suitable for all ages
      'PG': 135, // P13 - Parental supervision recommended for viewers under 13 years of age
      'PG-13': 135, // P13 (no PG-13 equivalent)
      'R': 136, // 18 - Recommended for viewers 18 and above
      'NC-17': 136 // 18 (highest available)
    },
    movie: {
      'G': 391, // U - Suitable for all ages
      'PG': 392, // PG-13 - Parental guidance required for audiences under the age of 13
      'PG-13': 392, // PG-13 (no PG-13 equivalent)
      'R': 393, // 18 - Restricted to adult viewers ages 18 and over
      'NC-17': 393 // 18 (highest available)
    }
  },
  
  // Mexico (mex)
  mex: {
    episode: {
      'G': 137, // AA - Appropriate for all ages, mostly for children
      'PG': 138, // A - Appropriate for all ages, with some profanity, sexual references, violence or crude humor
      'PG-13': 139, // B - Designed for ages 12 and older
      'R': 140, // B-15 - Designed for ages 15 and older
      'NC-17': 141 // C - Designed for adults ages 18 or older
    },
    movie: {
      'G': 407, // AA - Suitable for children under 7 years old
      'PG': 408, // A - Suitable for all ages
      'PG-13': 409, // B - Suitable for ages 12 and over
      'R': 410, // B-15 - Not recommended for children under 15
      'NC-17': 411 // C - Restricted to adult viewers ages 18 and older
    }
  },
  
  // Morocco (mar)
  mar: {
    episode: {
      'G': 143, // TP - Suitable for all audiences
      'PG': 144, // -10 - Not recommended for under 10
      'PG-13': 145, // -12 - Not recommended for under 12
      'R': 146, // -16 - Not recommended for under 16
      'NC-17': 146 // -16 (highest available)
    }
    // No movie ratings for Morocco
  },
  
  // Netherlands (nld)
  nld: {
    episode: {
      'G': 147, // AL - Suitable for all ages
      'PG': 148, // 6 - Parental guidance suggested for children under 6
      'PG-13': 150, // 12 - Parental guidance suggested for children under 12
      'R': 151, // 16 - Parental guidance suggested for children and teens under 16
      'NC-17': 151 // 16 (highest available)
    },
    movie: {
      'G': 413, // AL - Suitable for all ages
      'PG': 414, // 6 - Not recommended for children under 6
      'PG-13': 416, // 12 - Not recommended for children under 12
      'R': 418, // 16 - Restricted to ages 16 and older
      'NC-17': 419 // 18 - Restricted to ages 18 and older
    }
  },
  
  // New Zealand (nzl)
  nzl: {
    episode: {
      'G': 152, // G - Approved for General viewing
      'PG': 153, // PG - Parental Guidance recommended for young viewers
      'PG-13': 154, // M - Suitable for Mature audiences 16 years and over
      'R': 155, // 16 - People under 16 years should not view
      'NC-17': 156 // 18 - People under 18 years should not view
    },
    movie: {
      'G': 420, // G - Suitable for all ages
      'PG': 421, // PG - Parental guidance recommended for younger viewers
      'PG-13': 422, // M - Suitable for mature audiences 16 years and over
      'R': 423, // R13 - Restricted to persons 13 years and over
      'NC-17': 428 // R18 - Restricted to persons 18 years and over
    }
  },
  
  // Norway (nor)
  nor: {
    episode: {
      'G': 157, // 0+ - Suitable for all ages
      'PG': 158, // 5+ - Suitable for ages 5 and up
      'PG-13': 160, // 12+ - Suitable for ages 12 and up
      'R': 161, // 15+ - Suitable for ages 15 and up
      'NC-17': 162 // 18+ - Suitable for ages 18 and up
    },
    movie: {
      'G': 438, // A - Suitable for all ages
      'PG': 439, // 6 - Suitable for ages 6 and above
      'PG-13': 441, // 12 - Restricted to ages 12 and older, ages 9-12 with adult accompaniment
      'R': 442, // 15 - Restricted to ages 15 and older, ages 12-14 with adult accompaniment
      'NC-17': 443 // 18 - Restricted to ages 18 and over
    }
  },
  
  // Peru (per)
  per: {
    episode: {
      'G': 163, // 0+ - Suitable for all audiences
      'PG': 163, // 0+ (no PG equivalent)
      'PG-13': 163, // 0+ (no PG-13 equivalent)
      'R': 165, // 18+ - Suitable for only for adults
      'NC-17': 165 // 18+ (highest available)
    }
    // No movie ratings for Peru
  },
  
  // Philippines (phl)
  phl: {
    episode: {
      'G': 166, // G - Suitable for all audiences
      'PG': 167, // PG - Unsuitable for children without the guidance of a parent
      'PG-13': 168, // SPG - Strong and vigilant parental supervision recommended
      'R': 168, // SPG (no R equivalent)
      'NC-17': 168 // SPG (highest available)
    },
    movie: {
      'G': 444, // G - Suitable for all ages
      'PG': 445, // PG - Restricted to ages 13 and over unless accompanied by an adult
      'PG-13': 446, // R-13 - Restricted to ages 13 and over
      'R': 447, // R-16 - Restricted to ages 16 and over
      'NC-17': 448 // R-18 - Restricted to ages 18 and over
    }
  },
  
  // Poland (pol)
  pol: {
    episode: {
      'G': 169, // G - No age limit
      'PG': 170, // 7 - For minors from age 7
      'PG-13': 171, // 12 - For minors from age 12
      'R': 172, // 16 - For minors from age 16
      'NC-17': 173 // 18 - Permitted from age of 18 only
    },
    movie: {
      'G': 450, // G - Suitable for all ages
      'PG': 450, // G (no PG equivalent)
      'PG-13': 452, // 12 - Suitable for ages 12 and above
      'R': 453, // 16 - Suitable for ages 16 and above
      'NC-17': 454 // 18 - Suitable for ages 18 and above
    }
  },
  
  // Portugal (prt)
  prt: {
    episode: {
      'G': 174, // T - Suitable for all ages
      'PG': 174, // T (no PG equivalent)
      'PG-13': 176, // M12 - Suitable for viewers aged 12 and older
      'R': 177, // M16 - Suitable for viewers aged 16 and older
      'NC-17': 177 // M16 (highest available)
    },
    movie: {
      'G': 455, // T - Suitable for all ages
      'PG': 456, // M3 - Suitable for viewers aged 3 and older
      'PG-13': 458, // M12 - Suitable for viewers aged 12 and older
      'R': 460, // M16 - Suitable for viewers aged 16 and older
      'NC-17': 461 // M18 - Suitable for viewers aged 18 and older
    }
  },
  
  // Romania (rou)
  rou: {
    episode: {
      'G': 178, // GA - Programs can be viewed by any age
      'PG': 179, // PA - Recommended for children with parental guidance
      'PG-13': 180, // 12 - Not recommended for children below the age of 12
      'R': 181, // 15 - Not recommended for teens and children below the age of 15
      'NC-17': 182 // 18 - Recommended for adult viewers only (ages 18 and up)
    },
    movie: {
      'G': 463, // AG - Suitable for all ages
      'PG': 464, // AP-12 - Parental guidance recommended for children under 12
      'PG-13': 465, // N-15 - Not recommended for children under 15
      'R': 466, // IM-18 - Restricted to ages 18 and over
      'NC-17': 467 // 18+ - Restricted to ages 18 and over, adult content
    }
  },
  
  // Russia (rus)
  rus: {
    episode: {
      'G': 184, // 0+ - Suitable for all ages
      'PG': 185, // 6+ - Intended for viewers between the ages of 6-12
      'PG-13': 186, // 12+ - Intended for viewers over the age of 12
      'R': 187, // 16+ - Intended for viewers over the age of 16
      'NC-17': 188 // 18+ - Unsuitable for children, intended for adult viewers
    },
    movie: {
      'G': 469, // 0+ - Suitable for all ages
      'PG': 470, // 6+ - Unsuitable for children under 6
      'PG-13': 471, // 12+ - Unsuitable for children under 12
      'R': 472, // 16+ - Unsuitable for children under 16
      'NC-17': 473 // 18+ - Prohibited for children under 18
    }
  },
  
  // Singapore (sgp)
  sgp: {
    episode: {
      'G': 189, // G - Suitable for all ages
      'PG': 190, // PG - Suitable for children 7 and up
      'PG-13': 191, // PG13 - Suitable for teens 13 and up
      'R': 192, // NC16 - Suitable for teens 16 and up
      'NC-17': 193 // M18 - Not suitable for viewers under 18
    },
    movie: {
      'G': 481, // G - Suitable for all ages
      'PG': 482, // PG - Parental guidance recommended
      'PG-13': 483, // PG-13 - Parental guidance recommended for children under 13
      'R': 484, // NC16 - Suitable for persons aged 16 and above
      'NC-17': 485 // M18 - Suitable for persons aged 18 and above
    }
  },
  
  // Slovakia (svk)
  svk: {
    episode: {
      'G': null, // No G equivalent
      'PG': 194, // 7 - Suitable for children over 7 years
      'PG-13': 195, // 12 - Suitable for children over 12 years
      'R': 196, // 15 - Suitable for teens over 15 years
      'NC-17': 197 // 18 - Exclusively for adults
    }
    // No movie ratings for Slovakia
  },
  
  // Slovenia (svn)
  svn: {
    episode: {
      'G': null, // No G equivalent
      'PG': 198, // VS - Parental guidance suggested for children under 12
      'PG-13': 199, // 12 - Suitable for children over 12 years
      'R': 200, // 15 - Suitable for children over 15 years
      'NC-17': 201 // 18 - Suitable for persons over 18 years
    }
    // No movie ratings for Slovenia
  },
  
  // South Africa (zaf)
  zaf: {
    episode: {
      'G': 202, // A - Suitable for family viewing
      'PG': 203, // PG - Parental guidance suggested for children under 6
      'PG-13': 204, // 13 - Unsuitable for children under 13
      'R': 205, // 16 - Unsuitable for children and teens under 16
      'NC-17': 206 // 18 - Unsuitable for children and teens under 18
    },
    movie: {
      'G': 487, // A - Suitable for all ages
      'PG': 488, // PG - Parental guidance recommended
      'PG-13': 489, // 7-9PG - Restricted to ages 10 and older, ages 7-9 with adult accompaniment
      'R': 490, // 10-12PG - Restricted to ages 13 and older, ages 10-12 with adult accompaniment
      'NC-17': 490 // 10-12PG (highest available)
    }
  },
  
  // South Korea (kor)
  kor: {
    episode: {
      'G': 208, // ALL - Appropriate for all ages
      'PG': 209, // 7 - Unsuitable for children under 7
      'PG-13': 210, // 12 - Unsuitable for children under 12
      'R': 211, // 15 - Unsuitable for children and teens under 15
      'NC-17': 212 // 19 - Restricted to ages 19 and over
    },
    movie: {
      'G': 496, // ALL - Appropriate for all ages
      'PG': 497, // 12 - Restricted to ages 12 and over, unless accompanied by an adult
      'PG-13': 498, // 15 - Restricted to ages 15 and over, unless accompanied by an adult
      'R': 499, // 18 - Restricted to ages 18 and over
      'NC-17': 500 // Restricted Screening - Restricted to ages 19 and over, adult content
    }
  },
  
  // Spain (esp)
  esp: {
    episode: {
      'G': 214, // IA - Especially recommended for children
      'PG': 215, // A - Suitable for general viewing
      'PG-13': 216, // 7 - Not recommended for viewers under the age of 7
      'R': 218, // 12 - Not recommended for viewers under the age of 12
      'NC-17': 220 // 16 - Not recommended for viewers under the age of 16
    },
    movie: {
      'G': 501, // A-TP - For all the public
      'PG': 502, // 7 - Not recommended for audiences under 7
      'PG-13': 503, // 12 - Not recommended for audiences under 12
      'R': 504, // 16 - Not recommended for audiences under 16
      'NC-17': 505 // 18 - Not recommended for audiences under 18
    }
  },
  
  // Taiwan (twn)
  twn: {
    episode: {
      'G': 222, // G - Suitable for watching by general audiences
      'PG': 223, // P - Not suitable for viewing by children under the age of 6
      'PG-13': 224, // PG-12 - Not suitable for viewing by children under the age of 12
      'R': 225, // PG-15 - Not suitable for viewing by people under the age of 15
      'NC-17': 226 // R - Not suitable for viewing by people under the age of 18
    },
    movie: {
      'G': 511, // ALL - Suitable for all ages
      'PG': 512, // 6 - Restricted to ages 6 and older, ages 6-11 require adult accompaniment
      'PG-13': 513, // 12 - Restricted to ages 12 and older
      'R': 514, // 15 - Restricted to ages 15 and older
      'NC-17': 515 // 18 - Restricted to ages 18 and older
    }
  },
  
  // Thailand (tha)
  tha: {
    episode: {
      'G': 229, // ALL - Suitable for general audiences
      'PG': 228, // 5+ - Suitable for viewers aged 5 years and over
      'PG-13': 230, // 13+ - Suitable for viewers aged 13 years and over
      'R': 231, // 18+ - Suitable for viewers aged 18 years and over
      'NC-17': 232 // 20+ - Suitable for viewers aged 20 years and over
    },
    movie: {
      'G': 517, // ALL - Suitable for all ages
      'PG': 517, // ALL (no PG equivalent)
      'PG-13': 518, // 13+ - Suitable for viewers aged 13 years and over
      'R': 520, // 18+ - Suitable for viewers aged 18 years and over
      'NC-17': 521 // 20+ - Suitable for viewers aged 20 years and over
    }
  },
  
  // Turkey (tur)
  tur: {
    episode: {
      'G': 234, // G - General audience, suitable for all ages
      'PG': 235, // 7+ - Suitable for ages 7 and over
      'PG-13': 236, // 13+ - Suitable for ages 13 and over
      'R': 237, // 18+ - Suitable for ages 18 and over
      'NC-17': 237 // 18+ (highest available)
    },
    movie: {
      'G': 523, // ALL - Suitable for all ages
      'PG': 524, // 6+ - Suitable for viewers aged 6 and over
      'PG-13': 526, // 13+ - Suitable for viewers aged 13 and over
      'R': 528, // 16+ - Suitable for viewers aged 16 and over
      'NC-17': 530 // 18+ - Suitable for viewers aged 18 and over
    }
  },
  
  // Ukraine (ukr)
  ukr: {
    episode: {
      'G': 238, // 0+ - Suitable for all ages
      'PG': 239, // 12+ - Suitable for persons ages 12 years and over
      'PG-13': 240, // 16+ - Suitable for persons ages 16 years and over
      'R': 241, // 18+ - Suitable for persons ages 18 years and over
      'NC-17': 241 // 18+ (highest available)
    }
    // No movie ratings for Ukraine
  },
  
  // United States (usa)
  usa: {
    episode: {
      'G': 244, // TV-G - Suitable for all ages
      'PG': 245, // TV-PG - Parental guidance recommended for younger children
      'PG-13': 246, // TV-14 - Not suitable for children under 14
      'R': 247, // TV-MA - Not suitable for children and teens under 17
      'NC-17': 247 // TV-MA (highest available)
    },
    movie: {
      'G': 543, // G - Suitable for all ages
      'PG': 544, // PG - Parental guidance recommended
      'PG-13': 545, // PG-13 - Suitable for viewers aged 13 and over, unless accompanied by an adult
      'R': 546, // R - Restricted to ages 17 and over, unless accompanied by an adult
      'NC-17': 547 // NC-17 - Restricted to ages 17 and over only
    }
  },
  
  // Venezuela (ven)
  ven: {
    episode: {
      'G': 248, // 0+ - Suitable for all ages
      'PG': 248, // 0+ (no PG equivalent)
      'PG-13': 248, // 0+ (no PG-13 equivalent)
      'R': 250, // 18+ - Suitable only for adults
      'NC-17': 250 // 18+ (highest available)
    }
    // No movie ratings for Venezuela
  }
};

/**
 * Get TVDB content rating ID based on user's ageRating preference, country, and content type
 * @param {string} ageRating - User's age rating preference (None, G, PG, PG-13, R, NC-17)
 * @param {string} language - Language setting (e.g., 'en-US', 'pt-BR')
 * @param {string} contentType - Content type ('episode' or 'movie')
 * @returns {number|null} TVDB content rating ID or null if no filtering
 */
function getTVDBContentRatingId(ageRating, country, contentType = 'episode') {
  if (!ageRating || ageRating === 'None') {
    return null; // No filtering
  }
  
  // Get country ratings (convert to lowercase for matching)
  const countryRatings = TVDB_CONTENT_RATINGS[country.toLowerCase()];
  if (!countryRatings) {
    console.warn(`[TVDB Content Rating] No ratings found for country: ${country}`);
    return null;
  }
  
  // Get content type ratings
  const contentRatings = countryRatings[contentType];
  if (!contentRatings) {
    console.warn(`[TVDB Content Rating] No ${contentType} ratings found for country: ${country}`);
    return null;
  }
  
  const ratingId = contentRatings[ageRating];
  if (ratingId === undefined) {
    console.warn(`[TVDB Content Rating] No rating mapping found for ageRating: ${ageRating} in country: ${country} for ${contentType}`);
    return null;
  }
  
  if (ratingId === null) {
    console.log(`[TVDB Content Rating] No equivalent rating for ${ageRating} in ${country} for ${contentType}`);
    return null;
  }
  
  console.log(`[TVDB Content Rating] Using rating ID ${ratingId} for ${ageRating} in ${country} (${contentType})`);
  return ratingId;
}

module.exports = {
  getTVDBContentRatingId
};
