const metricsDisabled = process.env.DISABLE_METRICS === 'true';

function isMetricsDisabled(): boolean {
  return metricsDisabled;
}

export { isMetricsDisabled };
module.exports = { isMetricsDisabled };
