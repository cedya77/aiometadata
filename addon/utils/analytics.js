require('dotenv').config();
const swaggerStats = require('swagger-stats');
const buildInfo = require("../lib/buildInfo");

class Analytics {
  static instance;
  constructor() {
    if (!Analytics.instance) {
      this.middleware = swaggerStats.getMiddleware({
        name: buildInfo.name,
        version: buildInfo.version,
        timelineBucketDuration: 60000,
        uriPath: '/stats/ui',
        authentication: true,
        onAuthenticate: (req, username, password) =>
          username === process.env.METRICS_USER &&
          password === process.env.METRICS_PASSWORD,
        swaggerSpec: {
          info: {
            title: 'TMDB Addon API',
            version: buildInfo.version
          }
        }
      });

      Analytics.instance = this;
    }

    return Analytics.instance;
  }
}

module.exports = new Analytics();

