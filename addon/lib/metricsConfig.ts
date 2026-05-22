function isMetricsDisabled(): boolean {
  return process.env.DISABLE_METRICS === 'true';
}

export { isMetricsDisabled };
module.exports = { isMetricsDisabled };
