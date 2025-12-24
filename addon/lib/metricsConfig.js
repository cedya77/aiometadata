/**
 * Metrics Configuration Module
 * 
 * Centralized configuration for enabling/disabling telemetry metrics collection.
 * When DISABLE_METRICS=true, all metrics recording is skipped and the dashboard
 * 
 */

const metricsDisabled = process.env.DISABLE_METRICS === 'true';

module.exports = {
  /**
   * Check if metrics collection is disabled
   * @returns {boolean} true if metrics are disabled
   */
  isMetricsDisabled: () => metricsDisabled
};
