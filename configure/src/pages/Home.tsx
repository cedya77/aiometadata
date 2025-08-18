import { useConfig } from "@/contexts/ConfigContext";
import { KoFiDialog } from "react-kofi";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import packageJson from "../../../package.json";


const languages = [
  { value: "ab-AB", label: "Abkhazian" },
  { value: "aa-AA", label: "Afar" },
  { value: "af-AF", label: "Afrikaans" },
  { value: "ak-AK", label: "Akan" },
  { value: "sq-AL", label: "Albanian" },
  { value: "am-AM", label: "Amharic" },
  { value: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { value: "ar-AE", label: "Arabic (UAE)" },
  { value: "an-AN", label: "Aragonese" },
  { value: "hy-HY", label: "Armenian" },
  { value: "as-AS", label: "Assamese" },
  { value: "av-AV", label: "Avaric" },
  { value: "ae-AE", label: "Avestan" },
  { value: "ay-AY", label: "Aymara" },
  { value: "az-AZ", label: "Azerbaijani" },
  { value: "bm-BM", label: "Bambara" },
  { value: "ba-BA", label: "Bashkir" },
  { value: "eu-ES", label: "Basque" },
  { value: "be-BY", label: "Belarusian" },
  { value: "bn-BD", label: "Bengali" },
  { value: "bi-BI", label: "Bislama" },
  { value: "nb-NO", label: "Bokmål" },
  { value: "bs-BS", label: "Bosnian" },
  { value: "br-BR", label: "Breton" },
  { value: "bg-BG", label: "Bulgarian" },
  { value: "my-MY", label: "Burmese" },
  { value: "cn-CN", label: "Cantonese" },
  { value: "ca-ES", label: "Catalan" },
  { value: "km-KM", label: "Central Khmer" },
  { value: "ch-GU", label: "Chamorro" },
  { value: "ce-CE", label: "Chechen" },
  { value: "ny-NY", label: "Chichewa" },
  { value: "zh-CN", label: "Chinese (China)" },
  { value: "zh-HK", label: "Chinese (Hong Kong)" },
  { value: "zh-TW", label: "Chinese (Taiwan)" },
  { value: "cu-CU", label: "Church Slavic" },
  { value: "cv-CV", label: "Chuvash" },
  { value: "kw-KW", label: "Cornish" },
  { value: "co-CO", label: "Corsican" },
  { value: "cr-CR", label: "Cree" },
  { value: "hr-HR", label: "Croatian" },
  { value: "cs-CZ", label: "Czech" },
  { value: "da-DK", label: "Danish" },
  { value: "dv-DV", label: "Divehi" },
  { value: "nl-NL", label: "Dutch" },
  { value: "dz-DZ", label: "Dzongkha" },
  { value: "en-US", label: "English (US)" },
  { value: "en-AU", label: "English (Australia)" },
  { value: "en-CA", label: "English (Canada)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "en-IE", label: "English (Ireland)" },
  { value: "en-NZ", label: "English (New Zealand)" },
  { value: "eo-EO", label: "Esperanto" },
  { value: "et-EE", label: "Estonian" },
  { value: "ee-EE", label: "Ewe" },
  { value: "fo-FO", label: "Faroese" },
  { value: "fj-FJ", label: "Fijian" },
  { value: "fi-FI", label: "Finnish" },
  { value: "fr-FR", label: "French (France)" },
  { value: "fr-CA", label: "French (Canada)" },
  { value: "ff-FF", label: "Fulah" },
  { value: "gd-GD", label: "Gaelic" },
  { value: "gl-ES", label: "Galician" },
  { value: "lg-LG", label: "Ganda" },
  { value: "ka-GE", label: "Georgian" },
  { value: "de-DE", label: "German (Germany)" },
  { value: "de-AT", label: "German (Austria)" },
  { value: "de-CH", label: "German (Switzerland)" },
  { value: "el-GR", label: "Greek" },
  { value: "gn-GN", label: "Guarani" },
  { value: "gu-GU", label: "Gujarati" },
  { value: "ht-HT", label: "Haitian" },
  { value: "ha-HA", label: "Hausa" },
  { value: "he-IL", label: "Hebrew" },
  { value: "hz-HZ", label: "Herero" },
  { value: "hi-IN", label: "Hindi" },
  { value: "ho-HO", label: "Hiri Motu" },
  { value: "hu-HU", label: "Hungarian" },
  { value: "is-IS", label: "Icelandic" },
  { value: "io-IO", label: "Ido" },
  { value: "ig-IG", label: "Igbo" },
  { value: "id-ID", label: "Indonesian" },
  { value: "ia-IA", label: "Interlingua" },
  { value: "ie-IE", label: "Interlingue" },
  { value: "iu-IU", label: "Inuktitut" },
  { value: "ik-IK", label: "Inupiaq" },
  { value: "ga-GA", label: "Irish" },
  { value: "it-IT", label: "Italian" },
  { value: "ja-JP", label: "Japanese" },
  { value: "jv-JV", label: "Javanese" },
  { value: "kl-KL", label: "Kalaallisut" },
  { value: "kn-IN", label: "Kannada" },
  { value: "kr-KR", label: "Kanuri" },
  { value: "ks-KS", label: "Kashmiri" },
  { value: "kk-KZ", label: "Kazakh" },
  { value: "ki-KI", label: "Kikuyu" },
  { value: "rw-RW", label: "Kinyarwanda" },
  { value: "ky-KY", label: "Kirghiz" },
  { value: "kv-KV", label: "Komi" },
  { value: "kg-KG", label: "Kongo" },
  { value: "ko-KR", label: "Korean" },
  { value: "kj-KJ", label: "Kuanyama" },
  { value: "ku-KU", label: "Kurdish" },
  { value: "lo-LO", label: "Lao" },
  { value: "la-LA", label: "Latin" },
  { value: "lv-LV", label: "Latvian" },
  { value: "li-LI", label: "Limburgan" },
  { value: "ln-LN", label: "Lingala" },
  { value: "lt-LT", label: "Lithuanian" },
  { value: "lu-LU", label: "Luba-Katanga" },
  { value: "lb-LB", label: "Luxembourgish" },
  { value: "mk-MK", label: "Macedonian" },
  { value: "mg-MG", label: "Malagasy" },
  { value: "ms-MY", label: "Malay (Malaysia)" },
  { value: "ms-SG", label: "Malay (Singapore)" },
  { value: "ml-IN", label: "Malayalam" },
  { value: "mt-MT", label: "Maltese" },
  { value: "gv-GV", label: "Manx" },
  { value: "mi-MI", label: "Maori" },
  { value: "mr-MR", label: "Marathi" },
  { value: "mh-MH", label: "Marshallese" },
  { value: "mo-MO", label: "Moldavian" },
  { value: "mn-MN", label: "Mongolian" },
  { value: "na-NA", label: "Nauru" },
  { value: "nv-NV", label: "Navajo" },
  { value: "nd-ND", label: "North Ndebele" },
  { value: "nr-NR", label: "South Ndebele" },
  { value: "ng-NG", label: "Ndonga" },
  { value: "ne-NE", label: "Nepali" },
  { value: "se-SE", label: "Northern Sami" },
  { value: "no-NO", label: "Norwegian" },
  { value: "nn-NN", label: "Norwegian Nynorsk" },
  { value: "oc-OC", label: "Occitan" },
  { value: "oj-OJ", label: "Ojibwa" },
  { value: "or-OR", label: "Oriya" },
  { value: "om-OM", label: "Oromo" },
  { value: "os-OS", label: "Ossetian" },
  { value: "pi-PI", label: "Pali" },
  { value: "pa-PA", label: "Panjabi" },
  { value: "fa-IR", label: "Persian" },
  { value: "pl-PL", label: "Polish" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "ps-PS", label: "Pushto" },
  { value: "qu-QU", label: "Quechua" },
  { value: "ro-RO", label: "Romanian" },
  { value: "rm-RM", label: "Romansh" },
  { value: "rn-RN", label: "Rundi" },
  { value: "ru-RU", label: "Russian" },
  { value: "sm-SM", label: "Samoan" },
  { value: "sg-SG", label: "Sango" },
  { value: "sa-SA", label: "Sanskrit" },
  { value: "sc-SC", label: "Sardinian" },
  { value: "sr-RS", label: "Serbian" },
  { value: "sh-SH", label: "Serbo-Croatian" },
  { value: "sn-SN", label: "Shona" },
  { value: "ii-II", label: "Sichuan Yi" },
  { value: "sd-SD", label: "Sindhi" },
  { value: "si-LK", label: "Sinhala" },
  { value: "sk-SK", label: "Slovak" },
  { value: "sl-SI", label: "Slovenian" },
  { value: "so-SO", label: "Somali" },
  { value: "st-ST", label: "Sotho" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "es-MX", label: "Spanish (Mexico)" },
  { value: "su-SU", label: "Sundanese" },
  { value: "sw-SW", label: "Swahili" },
  { value: "ss-SS", label: "Swati" },
  { value: "sv-SE", label: "Swedish" },
  { value: "tl-PH", label: "Tagalog" },
  { value: "ty-TY", label: "Tahitian" },
  { value: "tg-TG", label: "Tajik" },
  { value: "ta-IN", label: "Tamil" },
  { value: "tt-TT", label: "Tatar" },
  { value: "te-IN", label: "Telugu" },
  { value: "th-TH", label: "Thai" },
  { value: "bo-BO", label: "Tibetan" },
  { value: "ti-TI", label: "Tigrinya" },
  { value: "to-TO", label: "Tonga" },
  { value: "ts-TS", label: "Tsonga" },
  { value: "tn-TN", label: "Tswana" },
  { value: "tr-TR", label: "Turkish" },
  { value: "tk-TK", label: "Turkmen" },
  { value: "tw-TW", label: "Twi" },
  { value: "ug-UG", label: "Uighur" },
  { value: "uk-UA", label: "Ukrainian" },
  { value: "ur-UR", label: "Urdu" },
  { value: "uz-UZ", label: "Uzbek" },
  { value: "ve-VE", label: "Venda" },
  { value: "vi-VN", label: "Vietnamese" },
  { value: "vo-VO", label: "Volapük" },
  { value: "wa-WA", label: "Walloon" },
  { value: "cy-CY", label: "Welsh" },
  { value: "fy-FY", label: "Western Frisian" },
  { value: "wo-WO", label: "Wolof" },
  { value: "xh-XH", label: "Xhosa" },
  { value: "yi-YI", label: "Yiddish" },
  { value: "yo-YO", label: "Yoruba" },
  { value: "za-ZA", label: "Zhuang" },
  { value: "zu-ZA", label: "Zulu" }
];

interface Movie {
  imdb_id: string;
  name: string;
  description: string;
  background: string;
}

export default function Home() {
  const { language, setLanguage } = useConfig();
  const [backgroundUrl, setBackgroundUrl] = useState("");

  useEffect(() => {
    const fetchPopularMovies = async () => {
      try {
        const response = await fetch('https://cinemeta-catalogs.strem.io/top/catalog/movie/top.json');
        const data = await response.json();
        
        const moviesWithId = data.metas.filter(movie => movie.imdb_id);
        
        if (moviesWithId.length > 0) {
          const randomIndex = Math.floor(Math.random() * moviesWithId.length);
          const randomMovie = moviesWithId[randomIndex];
          
          const highQualityImageUrl = `https://images.metahub.space/background/medium/${randomMovie.imdb_id}/img`;
          setBackgroundUrl(highQualityImageUrl);
        }
      } catch (error) {
        console.error('Error fetching popular movies:', error);
        setBackgroundUrl('https://images.metahub.space/background/medium/tt0816692/img');
      }
    };

    fetchPopularMovies();
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="fixed inset-0 z-0">
        <div className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/50 to-black/80 z-10" />
        <div 
          className="absolute inset-0 blur-sm"
          style={{
            backgroundImage: `url(${backgroundUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      </div>

      <div className="relative z-20 container mx-auto px-4 py-12 min-h-screen flex flex-col items-center justify-center text-white">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="text-center space-y-8 max-w-3xl"
        >
          <img
            src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
            alt="TMDB Logo"
            className="w-64 mx-auto mb-8"
          />

          <h1 className="text-4xl sm:text-5xl font-bold mb-4">
            The Movie Database Addon
          </h1>

          <p className="text-xl sm:text-2xl text-gray-300 mb-8">
            Explore a vast catalog of movies and TV shows with metadata provided by TMDB.
            Version {packageJson.version}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <div className="w-full sm:w-64">
              <Select value={language} onValueChange={setLanguage} defaultValue="en-US">
                <SelectTrigger className="bg-white/10 border-white/20 text-white">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent className="bg-background/95 backdrop-blur-sm">
                  {languages.map((lang) => (
                    <SelectItem
                      key={lang.value}
                      value={lang.value}
                      className="cursor-pointer"
                    >
                      {lang.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <KoFiDialog
              color="#01b4e4"
              textColor="#fff"
              id="mrcanelas"
              label="Support me"
              padding={6}
              iframe={false}
              buttonRadius="6px"
              className="w-full sm:w-auto"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-left">
            <div className="bg-white/10 rounded-lg p-6 backdrop-blur-sm">
              <h3 className="text-xl font-semibold mb-2">Movies</h3>
              <p className="text-gray-300">
                Access detailed information about thousands of movies, including synopses,
                cast, ratings, and much more.
              </p>
            </div>
            <div className="bg-white/10 rounded-lg p-6 backdrop-blur-sm">
              <h3 className="text-xl font-semibold mb-2">TV Shows</h3>
              <p className="text-gray-300">
                Explore TV series, seasons, episodes, and stay up to date
                with your favorite shows.
              </p>
            </div>
          </div>


        </motion.div>
      </div>
    </div>
  );
}