# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.0.0-beta.24.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.0...v1.0.0-beta.24.1.0) (2025-09-28)


### Features

* add custom ttl for mdblist ([2ddba0a](https://github.com/cedya77/aiometadata/commit/2ddba0aef733e8290cd398065036f7a2e5720835))
* add SOCKS5 proxy support for MDBList API ([182b8e3](https://github.com/cedya77/aiometadata/commit/182b8e3d3dfa1236ce02c2e56581122ca300f3a3))
* **meta:** add fallback to imdbId for tvdb movies (useful for anime movies) ([cd2a698](https://github.com/cedya77/aiometadata/commit/cd2a698710d1f20768edffad85a8f2afed3b6c81))
* **meta:** add option to use imdb id with mal catalogs, enabling calendar functions and the like ([a6ed329](https://github.com/cedya77/aiometadata/commit/a6ed329abce0b769babaefafe76aab2afcc56e36))
* **tmdb catalog:** revamp popular catalog ([cec252a](https://github.com/cedya77/aiometadata/commit/cec252a8d4c458e4a9e1b732a79c1d17133d1b54))

## [1.0.0-beta.24.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.3.0...v1.0.0-beta.24.0) (2025-09-24)


### Features

* Add allowEpisodeMarking UI toggle and dashboard button ([69bd4a7](https://github.com/cedya77/aiometadata/commit/69bd4a7a2e4c6bc326e20c8688eef90b87e9f079))
* Add MDBList catalog sorting functionality with cache invalidation ([77a99a9](https://github.com/cedya77/aiometadata/commit/77a99a98a95958fc6eb53d2a71ed70f50802e413))
* add ratings object from mdblist when key is provided ([307d1df](https://github.com/cedya77/aiometadata/commit/307d1df46b2c7c749d015871257baf88e3ace89d))
* Add wiki mappings system with performance tracking ([272ff4a](https://github.com/cedya77/aiometadata/commit/272ff4a3e45a00ad141a4a66202b03ee9bc30050))
* **catalogs:** add option to modifiy catalog names ([17a5d0e](https://github.com/cedya77/aiometadata/commit/17a5d0e01d5c650ce3a745beab0a0e5b2f126a74))
* **catalogs:** get genres from ST lists ([164ab37](https://github.com/cedya77/aiometadata/commit/164ab379b77d338a30b59cadc49a839728a3a082))
* **http:** follow redirects in httpClient; fix nameToImdb await; safe certification write in trending and adapt to cinemeta api changes ([393dd94](https://github.com/cedya77/aiometadata/commit/393dd946a45d8e74d8d479185e55a54502aac214))
* **meta:** uniformize catalogs and search ids to use imdb ids to better integrate with stremio's ecosystem ([0eb8e58](https://github.com/cedya77/aiometadata/commit/0eb8e582057a94b0983168b512fd8bf9d5ee1702))
* optimize undici networking ([4cbf13c](https://github.com/cedya77/aiometadata/commit/4cbf13c192df640044e93a18621b0d3e3a259d0d))
* **search:** improve tmdb search and overall search times ([bf6dd20](https://github.com/cedya77/aiometadata/commit/bf6dd20d2e5914d347a6bb732227bc0723c1aca1))


### Bug Fixes

* Art provider ID resolution, logging levels, and dashboard metrics ([eedbd9d](https://github.com/cedya77/aiometadata/commit/eedbd9db10517597304c4892a25c8415698d8d99))
* **backgrounds:** remove space in append causing tmdb bgs to disappear ([5cd988b](https://github.com/cedya77/aiometadata/commit/5cd988b8a3d686d41b4645098623c40062f49cf9))
* dashboard cache performance color ([c8501e7](https://github.com/cedya77/aiometadata/commit/c8501e7fad9e38aad7703746d1c2e4185f1dbc24))
* **getTmdb:** pass config object correctly ([b5181ea](https://github.com/cedya77/aiometadata/commit/b5181ea38858d05adea9ebbe852d2a4ef5d3dd88))
* **getTmdb:** undo getTmdb.js getting reverted ([5ec99f2](https://github.com/cedya77/aiometadata/commit/5ec99f235a380f6abfb8b5a6e695ec0acf50f658))
* isRequired condition for ST ([ad37a33](https://github.com/cedya77/aiometadata/commit/ad37a33bdfc886d26f1fff2692fdbac26e225eaf))
* **mdblist:** fix genre filtering ([e4edbc3](https://github.com/cedya77/aiometadata/commit/e4edbc3327e6089f2bab4ca9caaf5069aa5ec78e))
* **meta:** defensive programming for null app_extras object ([6215756](https://github.com/cedya77/aiometadata/commit/6215756453edabf52ddc6d006bdedadd4a11bb79))
* **search:** properly pass url containing special characters to search from stremio. Thanks to code by [@0x](https://github.com/0x)Constant1 (https://github.com/0xConstant1) ([8f262dc](https://github.com/cedya77/aiometadata/commit/8f262dc65b8f72774fbcd30b1ef4a015c59c2673))
* **ST lists:** fix pagination and genre filtering ([38a4d00](https://github.com/cedya77/aiometadata/commit/38a4d0070f78aed101e545d49cb7facd8fda345d))
* **translations:** correctly fallback when selected language isnt available for titles and overviews ([27b9b9c](https://github.com/cedya77/aiometadata/commit/27b9b9c64234e0b06e2e9ed232e4a52d28369604))
* tvdb genres not resolving correctly to imdb and add none genres to ST catalogs when showInHome is false ([9272225](https://github.com/cedya77/aiometadata/commit/9272225c15224d135b3ce0f4666b51c4b466e0b9))
* **tvdb:** fix tvdb search response ([34fcd69](https://github.com/cedya77/aiometadata/commit/34fcd692ff54b36753f718b20e293fe1d4a857e8))

Note: TMDB search has been revamped with filtering, so please create an issue if you have trouble finding a title.

## [1.0.0-beta.23.3.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.2.0...v1.0.0-beta.23.3.0) (2025-09-11)


### Features

* add auto cache-cleanup to remove old id cache system and refactor stremthru ([4aaea96](https://github.com/cedya77/aiometadata/commit/4aaea9624a0ad452ddd202948f757a45bc9a6177))


### Bug Fixes

* **meta & art:** fix fallback to english for overview and title, as well as fanart posters for mal catalogs ([fb280a7](https://github.com/cedya77/aiometadata/commit/fb280a7420574f4ab14c9e63a3cf0e5cdae00c00))
* **meta:** fix overview language fallback for tmdb ([cbeb989](https://github.com/cedya77/aiometadata/commit/cbeb989f7d5edb05f7c0935cef8c22bac9b55e37))

## [1.0.0-beta.23.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.1.0...v1.0.0-beta.23.2.0) (2025-09-10)


### Bug Fixes

* improve cache management and fix spoiled mappings issues ([1d5cfb2](https://github.com/cedya77/aiometadata/commit/1d5cfb2be18f8f41f7231775f9aaa1a0b4ac19cb))

## [1.0.0-beta.23.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.0...v1.0.0-beta.23.1.0) (2025-09-09)


### Features

* unify catalog metadata by providing full meta for non-anime catalog sources ([0ec7aea](https://github.com/cedya77/aiometadata/commit/0ec7aea4cd195fe057edfe54075b55c3965da011))


### Bug Fixes

* **mdblist:** fix id converter initialization ([389f096](https://github.com/cedya77/aiometadata/commit/389f0965100faa2da5467015d8b4688630bd82e0))
* resolve search errors and improve admin dashboard ([af0c7db](https://github.com/cedya77/aiometadata/commit/af0c7dba8e0e58c1fccd35bd835e43df4720b3e3))
* **tvmaze:** fix tvmaze search ([1ea370c](https://github.com/cedya77/aiometadata/commit/1ea370c1c74bd1a5533369a26b682de6209ef5c6))

## [1.0.0-beta.23.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.22.1.0...v1.0.0-beta.23.0) (2025-09-07)


### Features

* Add English Art Only toggle to Art Providers ([3836037](https://github.com/cedya77/aiometadata/commit/38360375675512dc43bf262b547afc399e70f821))
* Implement granular art provider configuration with nested structure ([4c83a22](https://github.com/cedya77/aiometadata/commit/4c83a226e583e9cb1fb4edcfd15df264529f9b33))
* Major dashboard and metadata improvements ([7224f7d](https://github.com/cedya77/aiometadata/commit/7224f7dba8150afcac50e6940ecc7d0c0641e795))
* Migrate ID cache from SQLite to Redis with auto-migration ([dae15a9](https://github.com/cedya77/aiometadata/commit/dae15a9dead755bd7a947d95ad6dbff9245a0c90))


### Bug Fixes

* **artwork:** fix malformed tmdb anime artwork url ([233a00d](https://github.com/cedya77/aiometadata/commit/233a00d1daac0765fe88d0b9cb571040afd5f125))
* resolve MAL API pagination error and improve dashboard privacy ([1e718c4](https://github.com/cedya77/aiometadata/commit/1e718c416f33373da60c7d32cd361d46c6a300f3))

## [1.0.0-beta.22.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.22...v1.0.0-beta.22.1.0) (2025-09-01)


### Features

* implement comprehensive anime episode mapping system ([c0737f0](https://github.com/cedya77/aiometadata/commit/c0737f04bab301157e4c46886bce79618779abb4))


### Bug Fixes

* **meta & cache:** restore systematic anime detection ([7e80a53](https://github.com/cedya77/aiometadata/commit/7e80a5393f1e3973daf11f67dd1ccd69e5c63277))

## [1.0.0-beta.22](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.21...v1.0.0-beta.22) (2025-08-28)

## [1.0.0-beta.21](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.20...v1.0.0-beta.21) (2025-08-27)


### Features

* implement age rating filtering and fix cache invalidation issues ([81c129b](https://github.com/cedya77/aiometadata/commit/81c129b73a4358eb792c1aeb346be290c4a9a119))
* implement comprehensive cache invalidation and performance improvements ([d6a770a](https://github.com/cedya77/aiometadata/commit/d6a770af90795f62007ff38214570c9bad65aaac))
* merge PR from [@nolan1024](https://github.com/nolan1024) and enhance cache logging ([ddf1272](https://github.com/cedya77/aiometadata/commit/ddf1272e9633457e307fe7de1c65d39e32bff971))
* resolve IMDb IDs when TMDBs API cant provide ([57eb2d9](https://github.com/cedya77/aiometadata/commit/57eb2d90453d7b48980eaa9e1ddce13aa4f2ef6c))
* set TVDB as default anime art provider and fix decade catalog caching ([e236b64](https://github.com/cedya77/aiometadata/commit/e236b64e30b251307d35c45083c35e441bee928c))

## [1.0.0-beta.20](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.19.9...v1.0.0-beta.20) (2025-08-22)


### Features

* add manual workflow trigger ([578a876](https://github.com/cedya77/aiometadata/commit/578a876a99fb2adacafde2cb1fc80c5afbe0bf71))
* add SFW filter, new MAL catalogs, and enhance loading UI with metadata improvements ([d332596](https://github.com/cedya77/aiometadata/commit/d33259638c5302a94fbb60e5e1fbba31c9947d48))


### Bug Fixes

* update workflow to support beta patch versions ([f19f55b](https://github.com/cedya77/aiometadata/commit/f19f55b945f83648a2a8cd0d90317550cbe5d1af))

## [1.0.0-beta.19.9](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.19...v1.0.0-beta.19.9) (2025-08-21)

## [1.0.0-beta.19](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.18...v1.0.0-beta.19) (2025-08-20)


### Bug Fixes

* uniformize meta ids, which fixes mark as watch issues and fix streaming/MDBList catalog issues ([20ee3a7](https://github.com/cedya77/aiometadata/commit/20ee3a72408985e24b038ea1a5b4c2cb2f1bf2b4))

## [1.0.0-beta.18](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.17...v1.0.0-beta.18) (2025-08-19)


### Features

* **ui:** flat sortable catalog list, added  delete for mdblist/streaming catalogs ([8ef843f](https://github.com/cedya77/aiometadata/commit/8ef843f93f7935ba87a2014d2b663c27b79d085d))

## [1.0.0-beta.17](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.0-beta.17) (2025-08-19)


### Bug Fixes

* Robust language fallback for TMDB/Fanart images, streaming catalog routing, and meta selection ([ed440e9](https://github.com/cedya77/aiometadata/commit/ed440e9375adb453ce4f8f9bd5e9d22e067e0aa1))

## [1.0.0-beta.16](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.0-beta.16) (2025-08-18)

### [1.0.1-beta.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.1-beta.0) (2025-08-18)

## [1.0.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.0) (2025-08-18)

## [1.0.0-beta.15](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.14...v1.0.0-beta.15) (2025-08-11)

## [1.0.0-beta.15](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.14...v1.0.0-beta.15) (2025-08-11)

## [1.0.0-beta.14](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.13...v1.0.0-beta.14) (2025-08-11)


### Features

* **config:** Improve Kitsu Mapping, add intagrate MDBLists  and add TVDB genre catalogs ([0254c50](https://github.com/cedya77/aiometadata/commit/0254c50797e4cc3773d7bd68caacff0776ba7e12))

## [1.0.0-beta.13](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.12...v1.0.0-beta.13) (2025-08-08)


### Bug Fixes

* **meta:** re-add tvdb meta that was stupidly removed because i forgot and else condition ([baf04eb](https://github.com/cedya77/aiometadata/commit/baf04eb7751eb64b80e851c0a9b083b4e710d104))
* **meta:** remove kitsu season number from id ([08fd8de](https://github.com/cedya77/aiometadata/commit/08fd8de25a89584445eb172a0075baf26fada4e6))
* **package:** fix package version ([b975390](https://github.com/cedya77/aiometadata/commit/b975390c8dffa48e79f49b72fe1093761e56b068))

## [1.0.0-beta.14](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.12...v1.0.0-beta.14) (2025-08-08)


### Bug Fixes

* **meta:** re-add tvdb meta that was stupidly removed because i forgot and else condition ([baf04eb](https://github.com/cedya77/aiometadata/commit/baf04eb7751eb64b80e851c0a9b083b4e710d104))
* **meta:** remove kitsu season number from id ([08fd8de](https://github.com/cedya77/aiometadata/commit/08fd8de25a89584445eb172a0075baf26fada4e6))

## [1.0.0-beta.13](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.12...v1.0.0-beta.13) (2025-08-07)


### Bug Fixes

* **meta:** remove kitsu season number from id ([08fd8de](https://github.com/cedya77/aiometadata/commit/08fd8de25a89584445eb172a0075baf26fada4e6))

## [1.0.0-beta.12](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.11...v1.0.0-beta.12) (2025-08-07)


### Bug Fixes

* **meta:** remove kitsu season number from id ([fd0a79a](https://github.com/cedya77/aiometadata/commit/fd0a79a611feaa141d99b59d6b231ce30b3b2ae3))

## [1.0.0-beta.11](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.10...v1.0.0-beta.11) (2025-08-07)


### Features

* **search:** Split anime search and add Kitsu ID mapping to tv groups ([2d56c84](https://github.com/cedya77/aiometadata/commit/2d56c847d5ec3d812651efdb8cec6f684c24ad5d))

## [1.0.0-beta.10](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.9...v1.0.0-beta.10) (2025-08-07)

## [1.0.0-beta.9](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.8...v1.0.0-beta.9) (2025-08-07)

## [1.0.0-beta.8](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.7...v1.0.0-beta.8) (2025-08-07)


### Features

* Add addon version to UI and prefix option ([549589f](https://github.com/cedya77/aiometadata/commit/549589f3c7dde40d04a7fedf77d2f5e1a044ef22))

## [1.0.0-beta.7](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.6...v1.0.0-beta.7) (2025-08-06)


### Features

* **meta:** switch anime catalog type to movie/series ([63e9a0d](https://github.com/cedya77/aiometadata/commit/63e9a0dffd3d955951b71626ae5e44a1e9fdf0d7))

## [1.0.0-beta.6](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.5...v1.0.0-beta.6) (2025-08-06)


### Features

* **search && meta:** Add TVmaze as a search and meta provider ([cea81a2](https://github.com/cedya77/aiometadata/commit/cea81a2b9391e76d52ea1c1f74cf5cdc7792aa22))

## [1.0.0-beta.5](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.4...v1.0.0-beta.5) (2025-08-05)


### Bug Fixes

* **search && meta:** fix config issue and id resolving to tvdb ([56350c3](https://github.com/cedya77/aiometadata/commit/56350c38d094f6a7428047c43c9ba3e6a8a190a2))

## [1.0.0-beta.4](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.3...v1.0.0-beta.4) (2025-08-05)


### Bug Fixes

* **meta & config:** fix persistent config issues and imdb mapping ([72af6f9](https://github.com/cedya77/aiometadata/commit/72af6f9c77e7e5c212072f519da325146561363b))

## [1.0.0-beta.3](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.2...v1.0.0-beta.3) (2025-08-05)


### Features

* **catalogs:** lazy loading ([b9cbb67](https://github.com/cedya77/aiometadata/commit/b9cbb67085f188246742eb261828ba1b13376a1f))


### Bug Fixes

* **packages:** update git url ([b9e67b5](https://github.com/cedya77/aiometadata/commit/b9e67b5f42bfb96d4a09f03272bdafa969bf1c21))

## [1.0.0-beta.2](https://github.com/mrcanelas/tmdb-addon/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2025-08-05)


### Bug Fixes

* **rpdb:** correctly pass api key ([4e90248](https://github.com/mrcanelas/tmdb-addon/commit/4e90248bcfda30d41f36c547381e96ed57184209))

## [1.0.0-beta.1](https://github.com/mrcanelas/tmdb-addon/compare/v1.0.0-beta.0...v1.0.0-beta.1) (2025-08-04)


### Features

* **ui:** implement env var injection and fix theme/styling issues ([649fd86](https://github.com/mrcanelas/tmdb-addon/commit/649fd86f7fe4a074bba5720c780dd1cb88368a64))

## [1.0.0-beta.0](https://github.com/mrcanelas/tmdb-addon/compare/v5.0.1-dev.0...v1.0.0-beta.0) (2025-08-04)
