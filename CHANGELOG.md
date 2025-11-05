# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.7.0](https://github.com/cedya77/aiometadata/compare/v1.6.4...v1.7.0) (2025-11-04)


### Features

* **custom-manifest:** Add proxy endpoint for Docker network manifest URLs ([9083e12](https://github.com/cedya77/aiometadata/commit/9083e12c4bb2f842df30d3874747e9a86e8d344e))


### Bug Fixes

* **art:** RPDB handling and improve error resilience ([eafe942](https://github.com/cedya77/aiometadata/commit/eafe9422ab0d23e62bfdd1afbc013fb2b8b757ec))
* **tmdb trailers:** fix multilingual trailers logic ([cc4a088](https://github.com/cedya77/aiometadata/commit/cc4a088ad7a98b5d8e98a926ccfd6c3cd4eda4b0))
* **trakt up next:** fix issue with caching ([b44be7c](https://github.com/cedya77/aiometadata/commit/b44be7c81bad2bd6c7550b8cea63ec8d8678dd01))

## [1.6.4](https://github.com/cedya77/aiometadata/compare/v1.6.3...v1.6.4) (2025-11-04)


### Bug Fixes

* **anime meta & fanart:** fix self-inflicted initialization issue and re apply langugage selection logic to fanart ([af1b8ec](https://github.com/cedya77/aiometadata/commit/af1b8ec459c498681087a7124a2bf71413e9dd16))
* finetune person's search logic further ([#99](https://github.com/cedya77/aiometadata/issues/99)) ([5df4cc6](https://github.com/cedya77/aiometadata/commit/5df4cc6a29a2d8adb43ba611f48aefcd404b9e39))

## [1.6.3](https://github.com/cedya77/aiometadata/compare/v1.6.2...v1.6.3) (2025-11-04)


### Bug Fixes

* **anime movie:** adapt ids to new anime movie id mapping ([0ca12cc](https://github.com/cedya77/aiometadata/commit/0ca12cc5832f5c50662ccf73b78cba101d1c4ada))
* **fanart:** adapt changes from fanart api ([8b3d006](https://github.com/cedya77/aiometadata/commit/8b3d006d3e60da1b3aee99bd9b193c2f1a288324))

## [1.6.2](https://github.com/cedya77/aiometadata/compare/v1.6.1...v1.6.2) (2025-11-03)


### Bug Fixes

* **anime meta:** issue with anime override & filter out null names from cast/crew ([f5e633d](https://github.com/cedya77/aiometadata/commit/f5e633d1135d2d1b925797379fe27134199278db))

## [1.6.1](https://github.com/cedya77/aiometadata/compare/v1.6.0...v1.6.1) (2025-11-03)


### Bug Fixes

* **meta:** anime ID provider check logic ([17c7828](https://github.com/cedya77/aiometadata/commit/17c7828051d208062c873f41c23901e31e9d9ae0))

## [1.6.0](https://github.com/cedya77/aiometadata/compare/v1.5.0...v1.6.0) (2025-11-03)


### Features

* add clear expire keys button to dash ([2c17c48](https://github.com/cedya77/aiometadata/commit/2c17c481c48aef457ebcec48ade6b60bd3c76c68))
* Add granular RPDB control, anime movie mappings, and catalog warmer fixes ([3bef3b1](https://github.com/cedya77/aiometadata/commit/3bef3b197726789a46aba8d0332e674198053ef5))


### Bug Fixes

* missing 'None' genre option for tmdb.popular when showInHome is false ([2c17c48](https://github.com/cedya77/aiometadata/commit/2c17c481c48aef457ebcec48ade6b60bd3c76c68))
* use CATALOG_LIST_ITEMS_SIZE for MDBList catalogs in warmer ([5527d74](https://github.com/cedya77/aiometadata/commit/5527d748c474eeeb3fad613fed5ad9961b93789b))

## [1.5.0](https://github.com/cedya77/aiometadata/compare/v1.4.1...v1.5.0) (2025-10-28)


### Features

* **config:** Update CACHE_WARMUP_UUID to CACHE_WARMUP_UUIDS for multi-UUID support ([61d6cb6](https://github.com/cedya77/aiometadata/commit/61d6cb6503c6566d697b7a406a5d763606f2a628))
* **search:** Add search provider renaming and reordering functionality ([0512bc8](https://github.com/cedya77/aiometadata/commit/0512bc8d45156fe0697243c01cff635655c32c27))


### Bug Fixes

* catalog warmer stats accumulation ([fb9cc26](https://github.com/cedya77/aiometadata/commit/fb9cc26b4a681b78cd3fad00b1a23a3b7b3ad22e))
* poster fallback logic on tmdb ([6a6938e](https://github.com/cedya77/aiometadata/commit/6a6938ea9c43383d0028aec9063c9e5222253287))
* poster fallback logic on tmdb ([e7a9bef](https://github.com/cedya77/aiometadata/commit/e7a9bef6574150740707d15e95661c27a6e4813a))

## [1.4.1](https://github.com/cedya77/aiometadata/compare/v1.4.0...v1.4.1) (2025-10-24)


### Bug Fixes

* persons search logic ([269e9d1](https://github.com/cedya77/aiometadata/commit/269e9d1da51337e7ec8cc13bbbbd2c6299f04013))
* persons search logic ([2b7535e](https://github.com/cedya77/aiometadata/commit/2b7535ea6fe3a302510ee828f827fa27a19b7219))

## [1.4.0](https://github.com/cedya77/aiometadata/compare/v1.3.0...v1.4.0) (2025-10-24)


### Features

* add bulk editing actions to catalogs ([0f89eac](https://github.com/cedya77/aiometadata/commit/0f89eacf82feb8b580634846aef5279af97ef06c))
* add changelog modal and cache warming controls to ops tab with mobile responsiveness ([f74ad69](https://github.com/cedya77/aiometadata/commit/f74ad6940093ed092588273e18f05983f464c37a))
* add custom missing episode thumbnail ([f790504](https://github.com/cedya77/aiometadata/commit/f7905047e32d77ee6d8ae191cee96b7676c33660))
* Add custom TTL support for custom manifest integration ([4b274f5](https://github.com/cedya77/aiometadata/commit/4b274f5e5cc4f28691b15dc416c345544e018a78))
* add kitsu as anime meta/art provider ([79f6204](https://github.com/cedya77/aiometadata/commit/79f62047e46347627c1154a49327af7d5079ae8f))
* add MDBList watchlist integration with unified/non-unified support ([36daa55](https://github.com/cedya77/aiometadata/commit/36daa556369437f6bf343d40f88bc3f973277619))
* add prompt for missing mdblist api key in presets ([cde11ed](https://github.com/cedya77/aiometadata/commit/cde11edcea335837c501dbf4d2b63f591bad101e))
* Add user management system with admin controls ([351047f](https://github.com/cedya77/aiometadata/commit/351047f4fb4ec4186a6c59aee9b0bb4634fc9e2e))
* implement comprehensive catalog warming system ([ac5f0b9](https://github.com/cedya77/aiometadata/commit/ac5f0b97bc3195b736dd15059f18c74ddba567e4))
* support aliases for person's search ([6569cda](https://github.com/cedya77/aiometadata/commit/6569cda5906cba211e86c0591fc453ad4ecf68e0))


### Bug Fixes

* -tmdb should now respect language priority when getting posters during search. - Added release year condition to nameToImdb ([daa08cc](https://github.com/cedya77/aiometadata/commit/daa08cc795dfd45b14347e2cb97b246822d14e7b))
* age rating filtering ([d16c024](https://github.com/cedya77/aiometadata/commit/d16c02431a2ae9c513825573faafe42befbf79f0))
* apply content rating on trending tmdb catalog ([d0d5513](https://github.com/cedya77/aiometadata/commit/d0d5513c183b4dbe745ca2490bd95b238cf3b991))
* apply content rating on trending tmdb catalog ([8c27189](https://github.com/cedya77/aiometadata/commit/8c27189c0bc8b0a0b232ab407d5662a1e81a3d76))
* apply same logic to dashboard ([fc2260b](https://github.com/cedya77/aiometadata/commit/fc2260b5076c4601dca6662e007abe9bffb9e301))
* apply same logic to dashboard ([41f0bfe](https://github.com/cedya77/aiometadata/commit/41f0bfe121d635d9d6a23adfa5482d7b09be0075))
* **custom catalogs:** correct pagination logic to handle any page size and prevent repeated results ([89f5d35](https://github.com/cedya77/aiometadata/commit/89f5d357c1927706acad959c4ad45f1dadc63db7))
* make cache private for specific endpoints ([afa7967](https://github.com/cedya77/aiometadata/commit/afa796716d02cab62b1b9cf72f2cb7b028584e66))
* make cache private for specific endpoints ([5396976](https://github.com/cedya77/aiometadata/commit/5396976e1b12a386a6af1b4455f1cffdd51f3451))
* **stremthru:** correct configure URL generation for external button ([d25cf46](https://github.com/cedya77/aiometadata/commit/d25cf46810d2bbd8217a689bb30f13367cbbb743))

## [1.3.0](https://github.com/cedya77/aiometadata/compare/v1.2.1...v1.3.0) (2025-10-19)


### Features

* filter out TVDB features when no API key is available ([f9dd85e](https://github.com/cedya77/aiometadata/commit/f9dd85ec7694ded99765704b54b6947b89429b5c))
* implement dual content filtering system with cache invalidation ([b4b50ff](https://github.com/cedya77/aiometadata/commit/b4b50ffed4c0ac8144c5e5da27c7d5770874850c))

## [1.2.1](https://github.com/cedya77/aiometadata/compare/v1.2.0...v1.2.1) (2025-10-17)


### Bug Fixes

* prevent save button from being disabled during context loading ([02c3f0c](https://github.com/cedya77/aiometadata/commit/02c3f0c9ad69dc74dd1d4fb1870254be4eb9957b))

## [1.2.0](https://github.com/cedya77/aiometadata/compare/v1.1.0...v1.2.0) (2025-10-17)


### Features

* add CACHE_WARMUP_UUID env var for custom user config ([5f44698](https://github.com/cedya77/aiometadata/commit/5f44698c61c0b432029d31c7dcc5490f3e0c7eab))
* add external link icon for custom manifest catalogs that opens the manifest's /configure page in new tab when clicked ([559d139](https://github.com/cedya77/aiometadata/commit/559d1396d0bc8710e43fe7c568a3b7596f081321))
* add MAL catalog background warming ([cd19f5b](https://github.com/cedya77/aiometadata/commit/cd19f5b6015095234f763b91d289a8e4579e6b9f))
* add popular content cache warming system ([b3c8a23](https://github.com/cedya77/aiometadata/commit/b3c8a23449c9d5a08364019358ad8db97767cccd))
* add user list sort options for MDBList API ([6ee5d57](https://github.com/cedya77/aiometadata/commit/6ee5d576a73eebf721ab4ea494898079bd96f596))
* implement context-aware cache reconstruction ([56d5289](https://github.com/cedya77/aiometadata/commit/56d5289690aaac68f9f336deda6b3cc2d2eefa9b))
* make TVDB API key optional ([002e28e](https://github.com/cedya77/aiometadata/commit/002e28eb4cb4994cfd8016d1778bb7a691d558f9))
* parallelize server startup ([8380e2d](https://github.com/cedya77/aiometadata/commit/8380e2d4ea9b48ef3a6e591584d3b4ee1ca0a413))


### Bug Fixes

* add new custom catalogs at end of list to preserve existing catalog order ([ef9ad6e](https://github.com/cedya77/aiometadata/commit/ef9ad6eafe9fe78ddf0026bc99c12691bd560e6c))
* default catalogs name change not working ([5c77331](https://github.com/cedya77/aiometadata/commit/5c773315995851a5484a7292b4731737469c8d42))
* display type override revert and Dan Pyjama list filtering ([2fe4f39](https://github.com/cedya77/aiometadata/commit/2fe4f390eba6c78b59f22727d57c07b2db312d8c))
* improve MAL rate limiting and add configurable cache warming interval ([d465570](https://github.com/cedya77/aiometadata/commit/d465570b084b761391bbe9b23994fea5b27b5a44))
* meta reconstruction failing due to missing component during write and different components order in write and read ([bc9812f](https://github.com/cedya77/aiometadata/commit/bc9812f8cbc88a31163b79e73ca042eb817fcbf4))
* tvmaze air date not getting parsed properly ([625ee40](https://github.com/cedya77/aiometadata/commit/625ee40b70780121178c9c8ecb0d5cbfdf0ef41f))


### Reverts

* switch back to npm from Bun ([900e2df](https://github.com/cedya77/aiometadata/commit/900e2df589a8a6cdda13413e761899dfcba06d3b))

## [1.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.1...v1.1.0) (2025-10-14)


### Features

* add MAL Seasons catalog with dynamic season fetching ([3c4c42b](https://github.com/cedya77/aiometadata/commit/3c4c42bd2b6a195bae74719929ada3e62b2440a7))
* add support for Trakt Up Next and tun_ ID prefix ([97d55a2](https://github.com/cedya77/aiometadata/commit/97d55a2e43aecdf8858d21d9a080afb70f3acf7e))
* filter out most YT videos from TVDB ([3133a40](https://github.com/cedya77/aiometadata/commit/3133a40acf2b41d9c002072ed0aea6bbc2795f98))


### Bug Fixes

* improve metadata handling for anime episodes and TMDB images ([f0a371b](https://github.com/cedya77/aiometadata/commit/f0a371b49c23c6bb1f263a86b0f978a2f388b6d1))
* improve tvdb multilingual handling ([63fd49a](https://github.com/cedya77/aiometadata/commit/63fd49ae2d4d984f26e69f7edef519374bdf4d25))

## [1.0.1](https://github.com/cedya77/aiometadata/compare/v1.0.0...v1.0.1) (2025-10-12)


### Bug Fixes

* handle catalog IDs with colons in custom manifest imports ([14dcc2b](https://github.com/cedya77/aiometadata/commit/14dcc2b1ab5fd24c33607d077bf558e07d66efe1))

## [1.0.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.25.0.2.0...v1.0.0) (2025-10-11)


### Features

* add tvdb collections search ([7db7c2f](https://github.com/cedya77/aiometadata/commit/7db7c2fcb36b9070d1009ce9cd9666f0b458a960))
* fetch imdb ratings from imdb dataset ([70b0ab2](https://github.com/cedya77/aiometadata/commit/70b0ab23212ec38cba8ff1592285308cbbb89513))

## [1.0.0-beta.25.0.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.25.0.1.0...v1.0.0-beta.25.0.2.0) (2025-10-09)


### Bug Fixes

* Wrong file cache path, MAL poster bg, further tmdb meta edge cases and pagination for custom imported catalogs ([bdbc21b](https://github.com/cedya77/aiometadata/commit/bdbc21b9a5724ee8ba1aec0c8a2de7e406abdc43))

## [1.0.0-beta.25.0.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.25.0.0...v1.0.0-beta.25.0.1.0) (2025-10-08)


### Bug Fixes

* TMDB meta data edge case, Catalog id bug, and hide ST integration in the UI ([edf2e5c](https://github.com/cedya77/aiometadata/commit/edf2e5c030ddb3ac2f517e91cfdfbba5026c2f1b))

## [1.0.0-beta.25.0.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.3.0...v1.0.0-beta.25.0.0) (2025-10-08)


### Features

* add external manifests imports and improve presets ([dacbfa4](https://github.com/cedya77/aiometadata/commit/dacbfa49042d9e658123c9bc73afff4c1e08cac8))
* implement static genre system and enhance MDBList integration ([dba5847](https://github.com/cedya77/aiometadata/commit/dba5847788cdcb1bd66886fe4a9b47d59d77b708))
* improve preset system UX with clean slate behavior and visual enhancements ([62034bd](https://github.com/cedya77/aiometadata/commit/62034bd7741d3a99640be73914110dd5f87d7463))
* **ui:** Add config presets ([307c434](https://github.com/cedya77/aiometadata/commit/307c4342dd18957a7a0f95b91383b0e4d7d728fc))

## [1.0.0-beta.24.2.3.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.2.0...v1.0.0-beta.24.2.3.0) (2025-10-02)


### Bug Fixes

* **tvdb:** fix tvdb english art. ([b8e5995](https://github.com/cedya77/aiometadata/commit/b8e5995c7768b78366d34e280f2a4fb47be99fc7))

## [1.0.0-beta.24.2.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.1.0...v1.0.0-beta.24.2.2.0) (2025-10-02)


### Bug Fixes

* **meta:** fix anime movie meta when anime override is turned on as well as small meta issues fix. ([e1bcd5b](https://github.com/cedya77/aiometadata/commit/e1bcd5bd9e1077f2669bcb344b4b77336242813b))

## [1.0.0-beta.24.2.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.0...v1.0.0-beta.24.2.1.0) (2025-10-01)


### Bug Fixes

* **art && filters:** fix tmdb bg and digital release filter for search ([da56699](https://github.com/cedya77/aiometadata/commit/da56699ce5e1f5c8a36701074bb248e903c0204d))

## [1.0.0-beta.24.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.1.0...v1.0.0-beta.24.2.0) (2025-10-01)


### Features

* Add MDBList/StremThru genre caching and digital release filter ([044d57f](https://github.com/cedya77/aiometadata/commit/044d57f72107728e941f4a9b262e679c68ee3b14))
* **meta:** add digital release filtering to tvdb and imdb movie meta ([523c4d4](https://github.com/cedya77/aiometadata/commit/523c4d4d84d61bd1ff65285f0a04752464bf3fcc))


### Bug Fixes

* **logo:** fix lang selection for logo ([63feaf3](https://github.com/cedya77/aiometadata/commit/63feaf3c13d6ca680341b9453fc6f084eb2ed606))
* **tvdb genres:** set lang to eng  and country to usa ([8aebf83](https://github.com/cedya77/aiometadata/commit/8aebf834ceb6fa81548723255fdb408f1e03f132))

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
