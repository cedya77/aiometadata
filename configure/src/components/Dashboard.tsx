import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useAdmin } from '@/contexts/AdminContext';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { 
  Activity, 
  BarChart3, 
  Clock, 
  Database, 
  Globe, 
  HardDrive, 
  Loader2,
  Monitor, 
  Search,
  Server, 
  Settings, 
  Shield,
  TrendingUp, 
  Users, 
  Wrench,
  LineChart,
  BarChart,
  Zap,
  RefreshCw,
  Key,
  LogOut,
  AlertCircle
} from 'lucide-react';
import { LineChart as RechartsLineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart as RechartsBarChart, Bar, Legend } from 'recharts';

// Dashboard Overview Component
function DashboardOverview({ data, systemData, loading }) {
  
  const [systemStatus, setSystemStatus] = useState({
    status: 'healthy',
    uptime: '0h 0m',
    version: '1.0.0-beta.22.1.0',
    lastUpdate: new Date().toLocaleString()
  });

  const [quickStats, setQuickStats] = useState({
    totalRequests: 0,
    cacheHitRate: 0,
    activeUsers: 0,
    errorRate: 0
  });

  const [recentActivity, setRecentActivity] = useState([]);

  // Update state when data prop changes
  useEffect(() => {
    if (data) {
      // Update quick stats from overview data
      if (data.quickStats) {
        setQuickStats({
          totalRequests: data.quickStats.totalRequests,
          cacheHitRate: data.quickStats.cacheHitRate,
          activeUsers: data.quickStats.activeUsers,
          errorRate: data.quickStats.errorRate
        });
      }
      
      // Update system status from systemOverview
      if (data.systemOverview) {
        setSystemStatus({
          status: data.systemOverview.status,
          uptime: data.systemOverview.uptime,
          version: data.systemOverview.version,
          lastUpdate: data.systemOverview.lastUpdate
        });
      }
    }
  }, [data]);

  // Update recent activity when systemData changes
  useEffect(() => {
    if (systemData && systemData.recentActivity) {
      console.log('[Dashboard Overview] Received recent activity:', systemData.recentActivity);
      setRecentActivity(systemData.recentActivity);
    }
  }, [systemData]);

  return (
    <div className="space-y-6">
      {/* System Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System Status</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-2">
              <Badge variant={systemStatus.status === 'healthy' ? 'default' : 'destructive'}>
                {systemStatus.status}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Uptime: {systemStatus.uptime}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{quickStats.totalRequests.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cache Hit Rate</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{quickStats.cacheHitRate}%</div>
            <Progress value={quickStats.cacheHitRate} className="mt-2" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{quickStats.activeUsers}</div>
            <p className="text-xs text-muted-foreground">Currently online</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest metadata requests and system events</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {recentActivity.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Activity className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No recent activity</p>
                <p className="text-sm">Activity will appear here as requests come in</p>
              </div>
            ) : (
              recentActivity.map((activity, index) => (
                <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className={`w-2 h-2 rounded-full ${
                      activity.type === 'metadata_request' ? 'bg-blue-500' : 
                      activity.type === 'catalog_request' ? 'bg-green-500' : 'bg-gray-500'
                    }`}></div>
                    <div>
                      <p className="font-medium">
                        {activity.type === 'metadata_request' ? 'Metadata Request' : 
                         activity.type === 'catalog_request' ? 'Catalog Request' : 
                         'API Request'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {activity.details.endpoint} • {activity.timeAgo}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline">
                    {activity.details.method}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Critical Alerts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Shield className="h-5 w-5" />
            <span>System Alerts</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-muted-foreground">
            <Shield className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>All systems operational</p>
            <p className="text-sm">No critical alerts at this time</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Analytics & Performance Component
function DashboardAnalytics({ data, loading }) {
  
  const [requestMetrics, setRequestMetrics] = useState({
    requestsPerHour: [],
    responseTimes: [],
    successRate: 0,
    failureRate: 0
  });

  const [cachePerformance, setCachePerformance] = useState({
    hitRate: 0,
    missRate: 0,
    memoryUsage: 0,
    evictionRate: 0
  });

  const [providerPerformance, setProviderPerformance] = useState([]);
  const [providerHourlyData, setProviderHourlyData] = useState([]);
  const [idResolverPerformance, setIdResolverPerformance] = useState({
    totalResolutions: 0,
    wikiMappingEarlyReturns: { count: 0, percentage: 0 },
    cacheEarlyReturns: { count: 0, percentage: 0 },
    apiCallsRequired: { count: 0, percentage: 0 },
    animeResolutions: { count: 0, percentage: 0 },
    earlyReturnRate: 0
  });

  useEffect(() => {
    // Fetch real analytics data
    const fetchAnalytics = async () => {
      try {
        const [overviewResponse, analyticsResponse] = await Promise.all([
          fetch('/api/dashboard/overview'),
          fetch('/api/dashboard/analytics')
        ]);

        if (overviewResponse.ok && analyticsResponse.ok) {
          const overviewData = await overviewResponse.json();
          const analyticsData = await analyticsResponse.json();

          setProviderHourlyData(analyticsData.providerHourlyData || []);

          // Update request metrics
          const successRate = overviewData.quickStats.successRate || (100 - overviewData.quickStats.errorRate);
          
          // Process hourly data for charts
          const hourlyData = analyticsData.hourlyData || [];
          
          setRequestMetrics({
            requestsPerHour: hourlyData,
            responseTimes: hourlyData,
            successRate: successRate,
            failureRate: overviewData.quickStats.errorRate
          });

          // Update cache performance
          setCachePerformance({
            hitRate: overviewData.cachePerformance.hitRate,
            missRate: overviewData.cachePerformance.missRate,
            memoryUsage: overviewData.cachePerformance.memoryUsage,
            evictionRate: overviewData.cachePerformance.evictionRate
          });

          // Update provider performance
          setProviderPerformance(overviewData.providerPerformance || []);

          // Update ID resolver performance
          if (analyticsData.idResolverPerformance) {
            setIdResolverPerformance(analyticsData.idResolverPerformance);
          }
        }
      } catch (error) {
        console.error('Failed to fetch analytics data:', error);
        // Keep default empty values
      }
    };

    fetchAnalytics();
  }, []);

  // Get all unique provider keys from the data to ensure all lines are rendered
  const providerKeys = providerHourlyData.reduce((acc: string[], curr) => {
    Object.keys(curr).forEach(key => {
      if (!acc.includes(key) && !['hour', 'timestamp'].includes(key)) {
        acc.push(key);
      }
    });
    return acc;
  }, []);

  return (
    <div className="space-y-6">
      {/* Request Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Request Success Rate</CardTitle>
            <CardDescription>Overall request success vs failure</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Success</span>
                <span className="text-2xl font-bold text-green-600">{Number(requestMetrics.successRate).toFixed(1)}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Failure</span>
                <span className="text-2xl font-bold text-red-600">{Number(requestMetrics.failureRate).toFixed(1)}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div 
                  className="bg-green-600 h-2 rounded-full" 
                  style={{ width: `${Number(requestMetrics.successRate)}%` }}
                ></div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cache Performance</CardTitle>
            <CardDescription>Redis cache hit/miss ratios</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Hit Rate</span>
                <span className="text-2xl font-bold text-blue-600">{Number(cachePerformance.hitRate)}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Memory Usage</span>
                <span className="text-2xl font-bold text-orange-600">{Number(cachePerformance.memoryUsage)}%</span>
              </div>
              <Progress value={Number(cachePerformance.hitRate)} className="mt-2" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider Performance */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Performance</CardTitle>
          <CardDescription>Response times and error rates for each metadata provider</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {providerPerformance.map((provider, index) => (
              <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${
                    provider.status === 'healthy' ? 'bg-green-500' : 
                    provider.status === 'warning' ? 'bg-yellow-500' : 'bg-red-500'
                  }`}></div>
                  <span className="font-medium">{provider.name}</span>
                </div>
                <div className="flex items-center space-x-6">
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Response Time</p>
                    <p className="font-medium">{Number(provider.responseTime)}ms</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">Error Rate</p>
                    <p className="font-medium">{Number(provider.errorRate)}%</p>
                  </div>
                  <Badge variant={provider.status === 'healthy' ? 'default' : 'secondary'}>
                    {provider.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Provider Response Time Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Provider API Response Times</CardTitle>
          <CardDescription>Average response time (ms) per hour for each provider</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <RechartsLineChart data={providerHourlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="hour" 
                  tickFormatter={(hour) => `${hour}:00`}
                  tick={{ fontSize: 12 }}
                />
                <YAxis label={{ value: 'ms', angle: -90, position: 'insideLeft', fontSize: 12 }} tick={{ fontSize: 12 }} />
                <Tooltip 
                  labelFormatter={(hour) => `Hour: ${hour}:00`}
                  formatter={(value, name) => {
                    const formattedValue = value === null || value === undefined ? 'N/A' : `${value} ms`;
                    const formattedName = typeof name === 'string' ? name.toUpperCase() : name;
                    return [formattedValue, formattedName];
                  }}
                />
                <Legend />
                {providerKeys.map((provider, index) => (
                  <Line 
                    key={provider}
                    type="monotone" 
                    dataKey={provider} 
                    stroke={['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#00C49F', '#FFBB28', '#FF8042'][index % 7]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 6 }}
                    name={provider.toUpperCase()}
                    connectNulls
                  />
                ))}
              </RechartsLineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Performance Charts */}
      <Card>
        <CardHeader>
          <CardTitle>Performance Trends</CardTitle>
          <CardDescription>Request volume and response times over time</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* Request Volume Chart */}
            <div>
              <h4 className="text-sm font-medium mb-3">Request Volume (Last 24 Hours)</h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsLineChart data={requestMetrics.requestsPerHour}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="hour" 
                      tickFormatter={(hour) => `${hour}:00`}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip 
                      formatter={(value) => [value, 'Requests']}
                      labelFormatter={(hour) => `${hour}:00`}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="requests" 
                      stroke="#8884d8" 
                      strokeWidth={2}
                      dot={{ fill: '#8884d8', strokeWidth: 2, r: 4 }}
                      activeDot={{ r: 6, stroke: '#8884d8', strokeWidth: 2 }}
                    />
                  </RechartsLineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Response Times Chart */}
            <div>
              <h4 className="text-sm font-medium mb-3">Response Times (Last 24 Hours)</h4>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsBarChart data={requestMetrics.responseTimes}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="hour" 
                      tickFormatter={(hour) => `${hour}:00`}
                      tick={{ fontSize: 12 }}
                    />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip 
                      formatter={(value) => [value, 'ms']}
                      labelFormatter={(hour) => `${hour}:00`}
                    />
                    <Bar 
                      dataKey="responseTime" 
                      fill="#82ca9d" 
                      radius={[4, 4, 0, 0]}
                    />
                  </RechartsBarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

// Performance Metrics Component
function DashboardPerformance({ data, loading }) {
  
  const [timingMetrics, setTimingMetrics] = useState({});
  const [selectedMetric, setSelectedMetric] = useState('id_resolution_total');
  const [timeRange, setTimeRange] = useState('24h');
  const [idResolverPerformance, setIdResolverPerformance] = useState({
    totalResolutions: 0,
    wikiMappingEarlyReturns: { count: 0, percentage: 0 },
    cacheEarlyReturns: { count: 0, percentage: 0 },
    apiCallsRequired: { count: 0, percentage: 0 },
    animeResolutions: { count: 0, percentage: 0 },
    earlyReturnRate: 0
  });

  useEffect(() => {
    if (data) {
      // The API returns nested structure: { dashboard: {...}, providerBreakdown: {...}, ... }
      // We need to merge the dashboard metrics with the other data
      const processedData = {
        ...data.dashboard, // Main timing metrics
        providerBreakdown: data.providerBreakdown,
        resolutionBreakdown: data.resolutionBreakdown,
        timingTrends: data.timingTrends
      };
      setTimingMetrics(processedData);
    }
  }, [data]);

  useEffect(() => {
    // Fetch ID resolver performance data
    const fetchIdResolverPerformance = async () => {
      try {
        const response = await fetch('/api/dashboard/analytics');
        if (response.ok) {
          const analyticsData = await response.json();
          if (analyticsData.idResolverPerformance) {
            setIdResolverPerformance(analyticsData.idResolverPerformance);
          }
        }
      } catch (error) {
        console.error('Failed to fetch ID resolver performance:', error);
      }
    };

    fetchIdResolverPerformance();
  }, []);

  const formatDuration = (ms) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const getMetricColor = (average, metricType = 'general') => {
    // Different thresholds for different metric types
    if (metricType === 'search') {
      if (average < 3000) return 'text-green-600';  // Under 3 seconds = green
      if (average < 5000) return 'text-yellow-600'; // 3-5 seconds = yellow
      if (average < 8000) return 'text-orange-600'; // 5-8 seconds = orange
      return 'text-red-600'; // Over 8 seconds = red
    } else {
      // General metrics (ID resolution, API calls, etc.) - Match the updated status thresholds
      if (average < 500) return 'text-green-600';   // Under 500ms = green (Excellent)
      if (average < 1500) return 'text-yellow-600'; // 500ms-1.5s = yellow (Good)
      if (average < 3000) return 'text-orange-600'; // 1.5s-3s = orange (Fair)
      return 'text-red-600';                        // Over 3s = red (Poor)
    }
  };

  const getMetricStatus = (average, metricType = 'general') => {
    // Different thresholds for different metric types
    if (metricType === 'search') {
      if (average < 3000) return 'Excellent';  // Under 3 seconds = Excellent
      if (average < 5000) return 'Good';       // 3-5 seconds = Good
      if (average < 8000) return 'Fair';       // 5-8 seconds = Fair
      return 'Poor';                           // Over 8 seconds = Poor
    } else {
      // General metrics (ID resolution, API calls, etc.) - More realistic thresholds
      if (average < 500) return 'Excellent';   // Under 500ms = Excellent
      if (average < 1500) return 'Good';       // 500ms-1.5s = Good  
      if (average < 3000) return 'Fair';       // 1.5s-3s = Fair
      return 'Poor';                           // Over 3s = Poor
    }
  };

  const getMetricBadgeVariant = (average, metricType = 'general') => {
    const status = getMetricStatus(average, metricType);
    switch (status) {
      case 'Excellent': return 'default';      // Green-ish badge
      case 'Good': return 'secondary';         // Gray badge  
      case 'Fair': return 'outline';           // Orange-ish badge
      case 'Poor': return 'destructive';       // Red badge
      default: return 'secondary';
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      </div>
    );
  }

  const metrics = Object.keys(timingMetrics);

  return (
    <div className="space-y-6">
      {/* Performance Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.slice(0, 4).map((metric) => {
          const stats = timingMetrics[metric]?.overall || {};
          const isSearchMetric = metric.startsWith('search_') || metric === 'search_operation';
          const metricType = isSearchMetric ? 'search' : 'general';
          const colorThreshold = isSearchMetric ? 3000 : 1500;
          
          return (
            <Card key={metric}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium capitalize">
                  {metric.replace(/_/g, ' ')}
                </CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  <span className={getMetricColor(stats.average || 0, metricType)}>
                    {formatDuration(stats.average || 0)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Avg: {formatDuration(stats.average || 0)} • 
                  P95: {formatDuration(stats.p95 || 0)} • 
                  Count: {stats.count || 0}
                </p>
                <Badge variant={getMetricBadgeVariant(stats.average || 0, metricType)} className="mt-2">
                  {getMetricStatus(stats.average || 0, metricType)}
                </Badge>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Detailed Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ID Resolution Metrics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              ID Resolution Performance
            </CardTitle>
            <CardDescription>
              Time taken to resolve external IDs for movies and series
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {['id_resolution_total', 'id_resolution_cache', 'id_resolution_anime', 'id_resolution_wiki'].map((metric) => {
                const stats = timingMetrics[metric]?.overall || {};
                if (stats.count === 0) return null;
                
                return (
                  <div key={metric} className="p-4 rounded-lg border">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="font-medium capitalize">
                          {metric.replace(/_/g, ' ')}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {stats.count} operations
                        </p>
                      </div>
                      <div className="text-right">
                        <div className={`text-lg font-bold ${getMetricColor(stats.average || 0)}`}>
                          {formatDuration(stats.average || 0)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          avg
                        </div>
                      </div>
                    </div>
                    
                    {/* Compact timing summary */}
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span>min {formatDuration(stats.min || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p50 {formatDuration(stats.p50 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p95 {formatDuration(stats.p95 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>max {formatDuration(stats.max || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Search Provider Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Search Provider Performance
            </CardTitle>
            <CardDescription>
              Search response times by provider (TMDB, TVDB, TVMaze, MAL, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {['search_tmdb', 'search_tvdb', 'search_tvmaze', 'search_mal'].map((metric) => {
                const stats = timingMetrics[metric]?.overall || {};
                if (stats.count === 0) return null;
                
                const providerName = metric.replace('search_', '').toUpperCase();
                
                return (
                  <div key={metric} className="flex items-center justify-between p-3 rounded-lg border">
                    <div>
                      <h4 className="font-medium">
                        {providerName} Search
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        {stats.count} searches
                      </p>
                    </div>
                    <div className="text-right">
                      <div className={`text-lg font-bold ${getMetricColor(stats.average || 0, 'search')}`}>
                        {formatDuration(stats.average || 0)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        P95: {formatDuration(stats.p95 || 0)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* API Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              API Performance
            </CardTitle>
            <CardDescription>
              External API response times and lookup performance
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {['api_lookup', 'nameToImdb_lookup', 'imdb_scrape_lookup', 'tmdb_external_ids', 'tvdb_remote_ids', 'tvmaze_externals', 'search_operation'].map((metric) => {
                const stats = timingMetrics[metric]?.overall || {};
                if (stats.count === 0) return null;
                
                // Use search thresholds for search_operation, general for others
                const metricType = metric === 'search_operation' ? 'search' : 'general';
                
                return (
                  <div key={metric} className="p-4 rounded-lg border">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="font-medium capitalize">
                          {metric.replace(/_/g, ' ')}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {stats.count} operations
                        </p>
                      </div>
                      <div className="text-right">
                        <div className={`text-lg font-bold ${getMetricColor(stats.average || 0, metricType)}`}>
                          {formatDuration(stats.average || 0)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          avg
                        </div>
                      </div>
                    </div>
                    
                    {/* Compact timing summary */}
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span>min {formatDuration(stats.min || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p50 {formatDuration(stats.p50 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p95 {formatDuration(stats.p95 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>max {formatDuration(stats.max || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Search Provider Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Search className="h-5 w-5" />
              Search Provider Performance
            </CardTitle>
            <CardDescription>
              Performance of actual search operations by provider (TMDB, TVDB, TVMaze, MAL)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries((timingMetrics as any).providerBreakdown || {})
                .filter(([key, data]) => (data as any).type === 'search')
                .map(([key, providerData]) => {
                  const stats = providerData as any;
                  if (stats.count === 0) return null;
                  
                  const providerName = stats.provider || key.toUpperCase();
                  
                  return (
                    <div key={key} className="p-4 rounded-lg border">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h4 className="font-medium">
                            {providerName} Provider
                          </h4>
                          <p className="text-sm text-muted-foreground">
                            {stats.count} search operations
                          </p>
                        </div>
                        <div className="text-right">
                          <div className={`text-lg font-bold ${getMetricColor(stats.average || 0, 'search')}`}>
                            {formatDuration(stats.average || 0)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            avg response
                          </div>
                          {stats.success_rate !== undefined && (
                            <div className={`text-xs mt-1 ${
                              stats.success_rate >= 95 ? 'text-green-600' : 
                              stats.success_rate >= 90 ? 'text-yellow-600' : 'text-red-600'
                            }`}>
                              {stats.success_rate}% success
                            </div>
                          )}
                        </div>
                      </div>
                      
                    {/* Compact timing summary */}
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span>min {formatDuration(stats.min || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p50 {formatDuration(stats.p50 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p95 {formatDuration(stats.p95 || 0)}</span>
                      {stats.p99 ? (<>
                        <span className="mx-2">•</span>
                        <span>p99 {formatDuration(stats.p99 || 0)}</span>
                      </>) : null}
                      <span className="mx-2">•</span>
                      <span>max {formatDuration(stats.max || 0)}</span>
                    </div>
                    </div>
                  );
                })}
              {Object.entries((timingMetrics as any).providerBreakdown || {}).filter(([key, data]) => (data as any).type === 'search').length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No search operations recorded yet</p>
                  <p className="text-sm">Search providers will appear here after you perform searches</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Secondary API Call Performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              ID Resolution API Calls
            </CardTitle>
            <CardDescription>
              Performance of API calls during ID resolution (TMDB external IDs, TVDB remote IDs, TVMaze lookups, etc.)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries((timingMetrics as any).providerBreakdown || {})
                .filter(([key, data]) => (data as any).type === 'secondary')
                .map(([key, providerData]) => {
                  const stats = providerData as any;
                  if (stats.count === 0) return null;
                  
                  const operationName = (stats.operation || key).replace(/_/g, ' ').toUpperCase();
                
                return (
                  <div key={key} className="p-4 rounded-lg border bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950 dark:to-indigo-950">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="font-medium">
                          {operationName}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {stats.count} ID resolution calls
                        </p>
                      </div>
                      <div className="text-right">
                        <div className={`text-lg font-bold ${getMetricColor(stats.average || 0)}`}>
                          {formatDuration(stats.average || 0)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          avg lookup
                        </div>
                      </div>
                    </div>
                    
                    {/* Compact timing summary */}
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span>min {formatDuration(stats.min || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p50 {formatDuration(stats.p50 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>p95 {formatDuration(stats.p95 || 0)}</span>
                      <span className="mx-2">•</span>
                      <span>max {formatDuration(stats.max || 0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Timing Trends Over Time */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Timing Trends
            </CardTitle>
            <CardDescription>
              Performance trends over different time periods (1h, 24h, 7d)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {['id_resolution_total', 'search_operation', 'api_lookup'].map((metric) => {
                const trends = (timingMetrics as any).timingTrends?.[metric] || {};
                if (!trends || Object.keys(trends).length === 0) return null;
                
                return (
                  <div key={metric} className="p-4 rounded-lg border">
                    <div className="mb-3">
                      <h4 className="font-medium capitalize">
                        {metric.replace(/_/g, ' ')}
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        Performance trends across time periods
                      </p>
                    </div>
                    
                    {/* Time period breakdown */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {Object.entries(trends).map(([period, data]) => {
                        const trendData = data as any;
                        return (
                          <div key={period} className="text-center p-3 bg-muted rounded">
                            <div className="font-medium text-lg">
                              {formatDuration(trendData.average || 0)}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {period} average
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {trendData.count || 0} operations
                            </div>
                            {trendData.p95 && (
                              <div className="text-xs text-orange-600 mt-1">
                                P95: {formatDuration(trendData.p95)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Performance Insights */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Performance Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">Cache Effectiveness</h4>
              <p className="text-sm text-muted-foreground">
                {timingMetrics?.['id_resolution_cache']?.overall?.count > 0 ? (
                  <>
                    Cache hits are averaging{' '}
                    <span className="font-medium text-green-600">
                      {formatDuration(timingMetrics?.['id_resolution_cache']?.overall?.average || 0)}
                    </span>
                    , significantly faster than API lookups.
                  </>
                ) : (
                  'No cache data available yet.'
                )}
              </p>
            </div>
            
            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">API Performance</h4>
              <p className="text-sm text-muted-foreground">
                {timingMetrics?.['api_lookup']?.overall?.average ? (
                  <>
                    External API calls average{' '}
                    <span className="font-medium">
                      {formatDuration(timingMetrics?.['api_lookup']?.overall?.average || 0)}
                    </span>
                    . Consider caching strategies for slower endpoints.
                  </>
                ) : (
                  'No API timing data available yet.'
                )}
              </p>
            </div>
            
            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">Search Performance</h4>
              <p className="text-sm text-muted-foreground">
                {timingMetrics?.['search_operation']?.overall?.average ? (
                  <>
                    Search operations average{' '}
                    <span className="font-medium">
                      {formatDuration(timingMetrics?.['search_operation']?.overall?.average || 0)}
                    </span>
                    . {timingMetrics?.['search_operation']?.overall?.average > 5000 ? 'Consider optimizing search queries or implementing search caching.' : 'Search performance looks good!'}
                  </>
                ) : (
                  'No search timing data available yet.'
                )}
              </p>
            </div>
            
            <div className="p-4 rounded-lg bg-muted">
              <h4 className="font-medium mb-2">Provider Performance</h4>
              <p className="text-sm text-muted-foreground">
                {(() => {
                  const providers = ['search_tmdb', 'search_tvdb', 'search_tvmaze', 'search_mal'];
                  const providerStats = providers.map(provider => ({
                    name: provider.replace('search_', '').toUpperCase(),
                    avg: timingMetrics?.[provider]?.overall?.average || 0,
                    count: timingMetrics?.[provider]?.overall?.count || 0
                  })).filter(p => p.count > 0);
                  
                  if (providerStats.length === 0) {
                    return 'No provider timing data available yet.';
                  }
                  
                  const fastest = providerStats.reduce((min, p) => p.avg < min.avg ? p : min);
                  const slowest = providerStats.reduce((max, p) => p.avg > max.avg ? p : max);
                  
                  return (
                    <>
                      <span className="font-medium text-green-600">{fastest.name}</span> is fastest ({formatDuration(fastest.avg)})
                      {slowest.name !== fastest.name && (
                        <> while <span className="font-medium text-orange-600">{slowest.name}</span> is slowest ({formatDuration(slowest.avg)})</>
                      )}
                    </>
                  );
                })()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ID Resolver Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            ID Resolver Performance
          </CardTitle>
          <CardDescription>Performance breakdown of ID resolution process</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Overview Stats */}
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <div className="text-2xl font-bold text-blue-600">
                    {idResolverPerformance.totalResolutions.toLocaleString()}
                  </div>
                  <div className="text-sm text-blue-600">Total Resolutions</div>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <div className="text-2xl font-bold text-green-600">
                    {idResolverPerformance.earlyReturnRate}%
                  </div>
                  <div className="text-sm text-green-600">Early Return Rate</div>
                </div>
              </div>
              
              {/* Breakdown */}
              <div className="space-y-2">
                <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <span className="text-sm text-gray-900">Wiki Mappings</span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">{idResolverPerformance.wikiMappingEarlyReturns.count.toLocaleString()}</div>
                    <div className="text-xs text-green-700">{idResolverPerformance.wikiMappingEarlyReturns.percentage}%</div>
                  </div>
                </div>
                <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <span className="text-sm text-gray-900">Cache Hits</span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">{idResolverPerformance.cacheEarlyReturns.count.toLocaleString()}</div>
                    <div className="text-xs text-blue-700">{idResolverPerformance.cacheEarlyReturns.percentage}%</div>
                  </div>
                </div>
                <div className="flex justify-between items-center p-2 bg-gray-50 rounded">
                  <span className="text-sm text-gray-900">Anime Resolutions</span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">{idResolverPerformance.animeResolutions.count.toLocaleString()}</div>
                    <div className="text-xs text-purple-700">{idResolverPerformance.animeResolutions.percentage}%</div>
                  </div>
                </div>
                <div className="flex justify-between items-center p-2 bg-red-50 rounded">
                  <span className="text-sm text-gray-900">API Calls Required</span>
                  <div className="text-right">
                    <div className="text-sm font-medium text-gray-900">{idResolverPerformance.apiCallsRequired.count.toLocaleString()}</div>
                    <div className="text-xs text-red-700">{idResolverPerformance.apiCallsRequired.percentage}%</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Visual Chart */}
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <RechartsBarChart
                  data={[
                    { name: 'Wiki Mappings', value: idResolverPerformance.wikiMappingEarlyReturns.percentage, fill: '#10b981' },
                    { name: 'Cache Hits', value: idResolverPerformance.cacheEarlyReturns.percentage, fill: '#3b82f6' },
                    { name: 'Anime', value: idResolverPerformance.animeResolutions.percentage, fill: '#8b5cf6' },
                    { name: 'API Calls', value: idResolverPerformance.apiCallsRequired.percentage, fill: '#ef4444' }
                  ]}
                  layout="horizontal"
                  margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
                  <YAxis type="category" dataKey="name" width={80} />
                  <Tooltip formatter={(value) => [`${value}%`, 'Percentage']} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} />
                </RechartsBarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* IMDb Ratings Stats */}
      {data?.imdbRatingsStats && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              IMDb Ratings Performance
            </CardTitle>
            <CardDescription>
              Dataset vs Cinemeta fallback statistics
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <h4 className="font-medium">Dataset Hits</h4>
                  <p className="text-sm text-muted-foreground">
                    From IMDb official dataset
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-green-600">
                    {data.imdbRatingsStats.datasetHits.toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {data.imdbRatingsStats.datasetPercentage}% • Avg: {data.imdbRatingsStats.datasetAvgTime.toFixed(2)}ms
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg border">
                <div>
                  <h4 className="font-medium">Cinemeta Fallback</h4>
                  <p className="text-sm text-muted-foreground">
                    From Cinemeta API
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-orange-600">
                    {data.imdbRatingsStats.cinemetaFallbackHits.toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {data.imdbRatingsStats.cinemetaPercentage}% • Avg: {data.imdbRatingsStats.cinemetaAvgTime.toFixed(2)}ms
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total Requests:</span>
                  <span className="font-medium">{data.imdbRatingsStats.totalRequests.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-muted-foreground">Ratings Loaded:</span>
                  <span className="font-medium">{data.imdbRatingsStats.ratingsLoaded.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-sm mt-1">
                  <span className="text-muted-foreground">Speed Difference:</span>
                  <span className="font-medium text-green-600">
                    {data.imdbRatingsStats.cinemetaAvgTime > 0 && data.imdbRatingsStats.datasetAvgTime > 0
                      ? `${(data.imdbRatingsStats.cinemetaAvgTime / data.imdbRatingsStats.datasetAvgTime).toFixed(0)}x faster with dataset`
                      : 'N/A'}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Content Intelligence Component
function DashboardContent({ data, loading }) {
  
  const [popularContent, setPopularContent] = useState([]);
  const [searchPatterns, setSearchPatterns] = useState([]);
  const [searchLimit, setSearchLimit] = useState(10);
  const [contentQuality, setContentQuality] = useState({
    missingMetadata: 0,
    failedMappings: 0,
    correctionRequests: 0,
    successRate: 0
  });

  useEffect(() => {
    // Fetch real content data
    const fetchContentData = async () => {
      try {
        const response = await fetch(`/api/dashboard/content?limit=${searchLimit}`);
        if (response.ok) {
          const data = await response.json();
          
          setPopularContent(data.popularContent || []);
          setSearchPatterns(data.searchPatterns || []);
          setContentQuality(data.contentQuality || {
            missingMetadata: 0,
            failedMappings: 0,
            correctionRequests: 0,
            successRate: 0
          });
        }
      } catch (error) {
        console.error('Failed to fetch content data:', error);
        // Keep default empty values
      }
    };

    fetchContentData();
  }, [searchLimit]);

  return (
    <div className="space-y-6">
      {/* Popular Content */}
      <Card>
        <CardHeader>
          <CardTitle>Popular Content</CardTitle>
          <CardDescription>Most requested titles and their ratings</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {popularContent.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No popular content yet</p>
                <p className="text-sm">Content will appear here as users request metadata</p>
              </div>
            ) : (
              popularContent.map((content, index) => (
                <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center space-x-3">
                    <Badge variant={content.type === 'movie' || content.type === 'series' ? 'default' : 'secondary'}>
                      {content.type}
                    </Badge>
                    <span className="font-medium">{content.title}</span>
                  </div>
                  <div className="flex items-center space-x-4">
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">Requests</p>
                      <p className="font-medium">{content.requests}</p>
                    </div>
                    {content.rating && (
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Rating</p>
                        <p className="font-medium">⭐ {String(content.rating)}</p>
                      </div>
                    )}
                    {content.year && (
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Year</p>
                        <p className="font-medium">{String(content.year)}</p>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* Search Patterns */}
      <Card>
        <CardHeader>
          <CardTitle>Search Patterns</CardTitle>
          <CardDescription>Most common search queries (shows today + yesterday)</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show</span>
            <select
              value={searchLimit}
              onChange={(e) => setSearchLimit(parseInt(e.target.value) || 10)}
              className="px-2 py-1 border rounded-md bg-background text-sm"
            >
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
            </select>
          </div>
          {searchPatterns.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No search patterns yet</p>
              <p className="text-sm">Search queries will appear here as users search for content</p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-3">
              {(() => {
                const counts = searchPatterns.map((p: any) => p.count);
                const min = Math.min(...counts);
                const max = Math.max(...counts);
                const scale = (count: number) => {
                  if (max === min) return 16; // px
                  const t = (count - min) / (max - min);
                  return Math.round(14 + t * 22); // 14px -> 36px
                };
                return searchPatterns.map((p: any, idx: number) => (
                  <span
                    key={idx}
                    title={`"${p.query}" • Count: ${p.count}`}
                    className="select-none cursor-default inline-block"
                    style={{
                      fontSize: `${scale(p.count)}px`,
                      lineHeight: 1.1,
                      color: 'hsl(220 60% 55%)'
                    }}
                  >
                    {p.query}
                  </span>
                ));
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content Quality Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Content Quality</CardTitle>
            <CardDescription>Metadata completeness and accuracy</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Missing Metadata</span>
                <span className="text-2xl font-bold text-orange-600">{contentQuality.missingMetadata}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Failed Mappings</span>
                <span className="text-2xl font-bold text-red-600">{contentQuality.failedMappings}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Success Rate</span>
                <span className="text-2xl font-bold text-green-600">{contentQuality.successRate}%</span>
              </div>
              <Progress value={contentQuality.successRate} className="mt-2" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Correction Requests</CardTitle>
            <CardDescription>User feedback and correction submissions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <div className="text-3xl font-bold text-blue-600 mb-2">{contentQuality.correctionRequests}</div>
              <p className="text-sm text-muted-foreground">Pending corrections</p>
              <Button className="mt-4" variant="outline">
                View All
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Content Trends Placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>Content Trends</CardTitle>
          <CardDescription>Popular genres and seasonal patterns</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12 text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Content Trend Charts</p>
            <p className="text-sm">Charts will be implemented in the next step</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// System Management Component
function DashboardSystem({ data, loading }) {
  
  const [systemConfig, setSystemConfig] = useState({
    language: 'en-US',
    metaProvider: 'tvdb',
    artProvider: 'tvdb',
    animeIdProvider: 'imdb',
    cacheEnabled: true,
    redisConnected: false,
    // New aggregated stats structure
    totalUsers: 0,
    sampleSize: 0,
    lastUpdated: new Date().toISOString(),
    aggregatedStats: {
      metaProviders: { movie: [], series: [], anime: [] },
      languages: [],
      features: { cacheEnabled: 100, blurThumbs: 0, skipFiller: 0, skipRecap: 0, allowEpisodeMarking: 0 }
    }
  });

  const [resourceUsage, setResourceUsage] = useState({
    memoryUsage: 0,
    cpuUsage: 0,
    diskUsage: 0,
    networkIO: 0
  });

  const [providerStatus, setProviderStatus] = useState([]);
  const [recentActivity, setRecentActivity] = useState([]);

  useEffect(() => {
    // Fetch real system data
    const fetchSystemData = async () => {
      try {
        const response = await fetch('/api/dashboard/system');
        if (response.ok) {
          const data = await response.json();
          
          // Update system config
          setSystemConfig(data.systemConfig);
          
          // Update resource usage
          setResourceUsage(data.resourceUsage);
          
          // Update provider status
          if (data.providerStatus) {
            setProviderStatus(data.providerStatus);
          }
          
                    // Update recent activity
          if (data.recentActivity) {
            console.log('[Dashboard] Received recent activity:', data.recentActivity);
            setRecentActivity(data.recentActivity);
          } else {
            console.log('[Dashboard] No recent activity data received');
          }
        }
      } catch (error) {
        console.error('Failed to fetch system data:', error);
        // Keep default values
      }
    };

    fetchSystemData();
  }, []);

  return (
    <div className="space-y-6">
      {/* User Configuration Statistics */}
      <Card>
        <CardHeader>
          <CardTitle>User Configuration Statistics</CardTitle>
          <CardDescription>
            How {systemConfig.totalUsers || 0} users configure their addon
            {systemConfig.sampleSize && systemConfig.sampleSize < systemConfig.totalUsers && 
              ` (based on ${systemConfig.sampleSize} sampled configurations)`
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-6">
            {/* Provider Preferences */}
            <div>
              <h4 className="font-medium mb-3">Meta Provider Preferences</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Movies</p>
                  {systemConfig.aggregatedStats?.metaProviders?.movie?.slice(0, 3).map((provider, index) => (
                    <div key={index} className="flex justify-between items-center py-1">
                      <span className="text-sm">{provider.name.toUpperCase()}</span>
                      <Badge variant="outline">{provider.percentage}%</Badge>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Series</p>
                  {systemConfig.aggregatedStats?.metaProviders?.series?.slice(0, 3).map((provider, index) => (
                    <div key={index} className="flex justify-between items-center py-1">
                      <span className="text-sm">{provider.name.toUpperCase()}</span>
                      <Badge variant="outline">{provider.percentage}%</Badge>
                    </div>
                  ))}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Anime</p>
                  {systemConfig.aggregatedStats?.metaProviders?.anime?.slice(0, 3).map((provider, index) => (
                    <div key={index} className="flex justify-between items-center py-1">
                      <span className="text-sm">{provider.name.toUpperCase()}</span>
                      <Badge variant="outline">{provider.percentage}%</Badge>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Language Distribution */}
            <div>
              <h4 className="font-medium mb-3">Language Distribution</h4>
              <div className="space-y-2">
                {systemConfig.aggregatedStats?.languages?.slice(0, 5).map((lang, index) => (
                  <div key={index} className="flex justify-between items-center">
                    <span className="text-sm">{lang.name}</span>
                    <div className="flex items-center space-x-2">
                      <div className="w-20 bg-gray-200 rounded-full h-2">
                        <div 
                          className="bg-blue-600 h-2 rounded-full" 
                          style={{ width: `${lang.percentage}%` }}
                        ></div>
                      </div>
                      <Badge variant="outline">{lang.percentage}%</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Feature Usage */}
            <div>
              <h4 className="font-medium mb-3">Feature Usage</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-green-600">
                    {systemConfig.aggregatedStats?.features?.cacheEnabled || 100}%
                  </p>
                  <p className="text-sm text-muted-foreground">Cache Enabled</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-blue-600">
                    {systemConfig.aggregatedStats?.features?.blurThumbs || 0}%
                  </p>
                  <p className="text-sm text-muted-foreground">Blur Thumbnails</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-purple-600">
                    {systemConfig.aggregatedStats?.features?.skipFiller || 0}%
                  </p>
                  <p className="text-sm text-muted-foreground">Skip Filler</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-orange-600">
                    {systemConfig.aggregatedStats?.features?.skipRecap || 0}%
                  </p>
                  <p className="text-sm text-muted-foreground">Skip Recap</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-green-600">
                    {systemConfig.aggregatedStats?.features?.allowEpisodeMarking || 0}%
                  </p>
                  <p className="text-sm text-muted-foreground">Episode Marking</p>
                </div>
              </div>
            </div>

            {/* System Status */}
            <div className="pt-4 border-t">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Redis Connection</span>
                <Badge variant={systemConfig.redisConnected ? 'default' : 'destructive'}>
                  {systemConfig.redisConnected ? 'Connected' : 'Disconnected'}
                </Badge>
              </div>
              {systemConfig.lastUpdated && (
                <p className="text-xs text-muted-foreground mt-2">
                  Last updated: {new Date(systemConfig.lastUpdated).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Resource Monitoring */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Resource Usage</CardTitle>
            <CardDescription>System resource consumption</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Memory Usage</span>
                  <span>{resourceUsage.memoryUsage}%</span>
                </div>
                <Progress value={resourceUsage.memoryUsage} className="h-2" />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>CPU Usage</span>
                  <span>{resourceUsage.cpuUsage}%</span>
                </div>
                <Progress value={resourceUsage.cpuUsage} className="h-2" />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Disk Usage</span>
                  <span>{resourceUsage.diskUsage}%</span>
                </div>
                <Progress value={resourceUsage.diskUsage} className="h-2" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Network I/O</CardTitle>
            <CardDescription>Network activity and bandwidth</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <div className="text-3xl font-bold text-blue-600 mb-2">{resourceUsage.networkIO}</div>
              <p className="text-sm text-muted-foreground">MB/s</p>
              <p className="text-xs text-muted-foreground mt-2">Current bandwidth</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Provider Status */}
      <Card>
        <CardHeader>
          <CardTitle>Provider Status</CardTitle>
          <CardDescription>API keys and rate limit status for metadata providers</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {providerStatus.map((provider, index) => (
              <div key={index} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${
                    provider.status === 'healthy' ? 'bg-green-500' : 
                    provider.status === 'warning' ? 'bg-yellow-500' : 'bg-red-500'
                  }`}></div>
                  <span className="font-medium">{provider.name}</span>
                </div>
                <div className="flex items-center space-x-4">
                  <div className="text-right">
                    <p className="text-sm text-muted-foreground">API Key</p>
                    <Badge variant={provider.apiKey ? 'default' : 'secondary'}>
                      {provider.apiKey ? 'Set' : 'Missing'}
                    </Badge>
                  </div>
                  <Badge variant={provider.status === 'healthy' ? 'default' : 'secondary'}>
                    {provider.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* System Health */}
      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
          <CardDescription>Overall system status and recommendations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center space-x-3">
                <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                <span className="text-sm font-medium text-green-800">All systems operational</span>
              </div>
              <Badge variant="default" className="bg-green-100 text-green-800">Healthy</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              <p>• Redis connection is stable</p>
              <p>• All critical services are running</p>
              <p>• Resource usage is within normal limits</p>
              <p>• No critical errors detected</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Operational Tools Component
function DashboardOperations({ data, loading }) {
  const { adminKey } = useAdmin();
  
  const [cacheStats, setCacheStats] = useState({
    totalKeys: 0,
    memoryUsage: '0 MB',
    hitRate: 0,
    evictionRate: 0
  });

  const [errorLogs, setErrorLogs] = useState([]);
  const [maintenanceTasks, setMaintenanceTasks] = useState([]);
  const [cacheClearing, setCacheClearing] = useState(false);

  // Update state when data prop changes
  useEffect(() => {
    if (data) {
      setErrorLogs(data.errorLogs || []);
      setMaintenanceTasks(data.maintenanceTasks || []);
      
      // Update cache stats from API response
      if (data.cacheStats) {
        setCacheStats({
          totalKeys: data.cacheStats.totalKeys || 0,
          memoryUsage: data.cacheStats.memoryUsage ? `${data.cacheStats.memoryUsage}%` : '0%',
          hitRate: data.cacheStats.hitRate || 0,
          evictionRate: data.cacheStats.evictionRate || 0
        });
      }
    }
  }, [data]);

  const handleClearCache = async (type) => {
    setCacheClearing(true);
    try {
      console.log(`Clearing ${type} cache...`);
      
      const headers = {
        'Content-Type': 'application/json'
      };
      
      // Add admin key if available
      if (adminKey) {
        headers['x-admin-key'] = adminKey;
      }
      
      const response = await fetch('/api/dashboard/cache/clear', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type })
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log('Cache cleared successfully:', result.message);
        
        // Update cache stats with the key count from the clear response
        if (result.keyCount !== undefined) {
          setCacheStats(prev => ({
            ...prev,
            totalKeys: result.keyCount
          }));
        } else {
          // Fallback: refresh the cache stats after clearing
          const operationsResponse = await fetch('/api/dashboard/operations', { headers });
          if (operationsResponse.ok) {
            const data = await operationsResponse.json();
            if (data.cacheStats) {
              setCacheStats({
                totalKeys: data.cacheStats.totalKeys || 0,
                memoryUsage: data.cacheStats.memoryUsage ? `${data.cacheStats.memoryUsage}%` : '0%',
                hitRate: data.cacheStats.hitRate || 0,
                evictionRate: data.cacheStats.evictionRate || 0
              });
            }
          }
        }
        
        // Show success toast with key count if available
        const message = result.keyCount !== undefined 
          ? `Cache ${type} cleared successfully! ${result.keyCount} essential keys remain.`
          : `Cache ${type} cleared successfully!`;
        
        toast.success("Cache Cleared", {
          description: message
        });
      } else {
        const error = await response.json();
        console.error('Failed to clear cache:', error.error);
        toast.error("Cache Clear Failed", {
          description: error.error
        });
      }
    } catch (error) {
      console.error('Error clearing cache:', error);
      toast.error("Cache Clear Error", {
        description: error.message
      });
    } finally {
      setCacheClearing(false);
    }
  };

  const handleRetryError = (errorId) => {
    // TODO: Implement error retry logic
    console.log(`Retrying error ${errorId}...`);
  };

  return (
    <div className="space-y-6">
      {/* Cache Management */}
      <Card>
        <CardHeader>
          <CardTitle>Cache Management</CardTitle>
          <CardDescription>
            Redis cache statistics and management tools. 
            <br />
            <span className="text-xs text-muted-foreground">
              Note: "Clear All Cache" will show ~13 essential keys remaining (maintenance tracking, genres, etc.)
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex justify-between">
                <span className="text-sm font-medium">Total Keys</span>
                <span className="font-medium">{cacheStats.totalKeys.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Memory Usage</span>
                <span className="font-medium">{cacheStats.memoryUsage}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Hit Rate</span>
                <span className="font-medium">{cacheStats.hitRate}%</span>
              </div>
              <Progress value={cacheStats.hitRate} className="mt-2" />
            </div>
            <div className="space-y-3">
              <Button 
                onClick={() => handleClearCache('all')} 
                variant="outline" 
                className="w-full"
                disabled={cacheClearing}
              >
                {cacheClearing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Clearing Cache...
                  </>
                ) : (
                  'Clear All Cache'
                )}
              </Button>
              <Button 
                onClick={() => handleClearCache('expired')} 
                variant="outline" 
                className="w-full"
                disabled={cacheClearing}
              >
                {cacheClearing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  'Clear Expired'
                )}
              </Button>
              <Button 
                onClick={() => handleClearCache('metadata')} 
                variant="outline" 
                className="w-full"
                disabled={cacheClearing}
              >
                {cacheClearing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Clearing...
                  </>
                ) : (
                  'Clear Metadata Cache'
                )}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error Management */}
      <Card>
        <CardHeader>
          <CardTitle>Error Management</CardTitle>
          <CardDescription>Recent errors and retry options</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {errorLogs.map((error) => (
              <div key={error.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${
                    error.level === 'error' ? 'bg-red-500' : 
                    error.level === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
                  }`}></div>
                  <div>
                    <p className="font-medium">{error.message}</p>
                    <p className="text-sm text-muted-foreground">
                      {error.timestamp} • Occurred {error.count} time{error.count > 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Badge variant={error.level === 'error' ? 'destructive' : 'secondary'}>
                    {error.level}
                  </Badge>
                  {error.level === 'error' && (
                    <Button 
                      size="sm" 
                      variant="outline"
                      onClick={() => handleRetryError(error.id)}
                    >
                      Retry
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Maintenance Tasks */}
      <Card>
        <CardHeader>
          <CardTitle>Maintenance Tasks</CardTitle>
          <CardDescription>Scheduled and running maintenance operations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {maintenanceTasks.map((task) => (
              <div key={task.id} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center space-x-3">
                  <div className={`w-3 h-3 rounded-full ${
                    task.status === 'completed' ? 'bg-green-500' : 
                    task.status === 'running' ? 'bg-blue-500' : 'bg-gray-500'
                  }`}></div>
                  <div>
                    <p className="font-medium">{task.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Last run: {task.lastRun}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Badge variant={
                    task.status === 'completed' ? 'default' : 
                    task.status === 'running' ? 'secondary' : 'outline'
                  }>
                    {task.status}
                  </Badge>
                  {task.status === 'scheduled' && (
                    <Button size="sm" variant="outline">
                      Run Now
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common administrative tasks</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Button variant="outline" className="h-20 flex-col">
              <Database className="h-6 w-6 mb-2" />
              <span className="text-sm">Warm Cache</span>
            </Button>
            <Button variant="outline" className="h-20 flex-col">
              <RefreshCw className="h-6 w-6 mb-2" />
              <span className="text-sm">Refresh Data</span>
            </Button>
            <Button variant="outline" className="h-20 flex-col">
              <Settings className="h-6 w-6 mb-2" />
              <span className="text-sm">System Check</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// User Management Component
function DashboardUsers({ data, loading }) {
  const { adminKey } = useAdmin();
  
  const [userStats, setUserStats] = useState({
    totalUsers: 0,
    activeUsers: 0,
    newUsersToday: 0,
    totalRequests: 0
  });

  const [userActivity, setUserActivity] = useState([]);
  const [accessControl, setAccessControl] = useState({
    adminUsers: 0,
    apiKeyUsers: 0,
    rateLimitedUsers: 0,
    blockedUsers: 0
  });

  const [error, setError] = useState(null);

  // Update state when data prop changes
  useEffect(() => {
    if (data) {
      setUserStats({
        totalUsers: data.totalUsers || 0,
        activeUsers: data.activeUsers || 0,
        newUsersToday: data.newUsersToday || 0,
        totalRequests: data.totalRequests || 0
      });
      setUserActivity(data.userActivity || []);
      setAccessControl(data.accessControl || {
        adminUsers: 0,
        apiKeyUsers: 0,
        rateLimitedUsers: 0,
        blockedUsers: 0
      });
      setError(null);
    }
  }, [data]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading user data...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="text-red-500 mb-4">
              <AlertCircle className="h-12 w-12 mx-auto" />
            </div>
            <p className="text-red-600 font-medium">Failed to load user data</p>
            <p className="text-sm text-muted-foreground mt-2">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* User Statistics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{userStats.totalUsers.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">Registered users</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{userStats.activeUsers}</div>
            <p className="text-xs text-muted-foreground">Currently online</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">New Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{userStats.newUsersToday}</div>
            <p className="text-xs text-muted-foreground">Today</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{userStats.totalRequests?.toLocaleString() || '0'}</div>
            <p className="text-xs text-muted-foreground">All time requests</p>
          </CardContent>
        </Card>
      </div>

      {/* User Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Recent User Activity</CardTitle>
          <CardDescription>Latest user interactions and status</CardDescription>
        </CardHeader>
        <CardContent>
          {userActivity.length > 0 ? (
            <div className="space-y-3">
              {userActivity.map((user) => (
                <div key={user.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center space-x-3">
                    <div className={`w-3 h-3 rounded-full ${
                      user.status === 'active' ? 'bg-green-500' : 
                      user.status === 'idle' ? 'bg-yellow-500' : 'bg-blue-500'
                    }`}></div>
                    <div>
                      <p className="font-medium">{user.username}</p>
                      <p className="text-sm text-muted-foreground">
                        Last seen: {user.lastSeen} • {user.requests} requests
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Badge variant={
                      user.status === 'active' ? 'default' : 
                      user.status === 'idle' ? 'secondary' : 'outline'
                    }>
                      {user.status}
                    </Badge>
                    <Button size="sm" variant="outline">
                      View Details
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No recent user activity</p>
              <p className="text-sm">User activity will appear here as users interact with the addon</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Access Control */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Access Control</CardTitle>
            <CardDescription>User permissions and access levels</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Admin Users</span>
                <span className="text-2xl font-bold text-red-600">{accessControl.adminUsers}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">API Key Users</span>
                <span className="text-2xl font-bold text-blue-600">{accessControl.apiKeyUsers}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Rate Limited</span>
                <span className="text-2xl font-bold text-orange-600">{accessControl.rateLimitedUsers}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Blocked Users</span>
                <span className="text-2xl font-bold text-red-600">{accessControl.blockedUsers}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>User Management</CardTitle>
            <CardDescription>Administrative actions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <Button variant="outline" className="w-full">
                <Users className="h-4 w-4 mr-2" />
                Manage Users
              </Button>
              <Button variant="outline" className="w-full">
                <Shield className="h-4 w-4 mr-2" />
                Access Control
              </Button>
              <Button variant="outline" className="w-full">
                <Activity className="h-4 w-4 mr-2" />
                User Analytics
              </Button>
              <Button variant="outline" className="w-full">
                <Settings className="h-4 w-4 mr-2" />
                User Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* User Analytics Placeholder */}
      <Card>
        <CardHeader>
          <CardTitle>User Analytics</CardTitle>
          <CardDescription>User behavior patterns and trends</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>User Analytics Charts</p>
            <p className="text-sm">Charts will be implemented in the next step</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// Admin Login Component
function AdminLogin() {
  const { isAdmin, adminKey: contextAdminKey, login, logout, isLoading } = useAdmin();
  const [inputAdminKey, setInputAdminKey] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState('');
  const [adminFeaturesAvailable, setAdminFeaturesAvailable] = useState(true);

  // Check if admin features are available on mount
  useEffect(() => {
    const checkAdminFeatures = async () => {
      try {
        const response = await fetch('/api/dashboard/users', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        // If it returns 401, admin features are available but require authentication
        // If it returns 200, admin features are disabled (no ADMIN_KEY set)
        setAdminFeaturesAvailable(response.status === 401);
      } catch (error) {
        setAdminFeaturesAvailable(false);
      }
    };

    checkAdminFeatures();
  }, []);

  const handleLogin = async () => {
    if (!inputAdminKey.trim()) {
      setError('Please enter an admin key');
      return;
    }

    const success = await login(inputAdminKey);
    if (success) {
      setInputAdminKey('');
      setError('');
      setIsOpen(false);
    } else {
      setError('Invalid admin key');
    }
  };

  const handleLogout = () => {
    logout();
    setIsOpen(false);
  };

  if (isAdmin) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="default" className="bg-green-600">
          <Shield className="h-3 w-3 mr-1" />
          Admin
        </Badge>
        {contextAdminKey && (
          <Button variant="outline" size="sm" onClick={handleLogout}>
            <LogOut className="h-4 w-4 mr-1" />
            Logout
          </Button>
        )}
      </div>
    );
  }

  // If admin features are not available, don't show anything
  if (!adminFeaturesAvailable) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Key className="h-4 w-4 mr-1" />
          Admin Login
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md mx-4">
        <DialogHeader>
          <DialogTitle>Admin Authentication</DialogTitle>
          <DialogDescription>
            Enter your admin key to access administrative features.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="admin-key">Admin Key</Label>
            <Input
              id="admin-key"
              type="password"
              value={inputAdminKey}
              onChange={(e) => setInputAdminKey(e.target.value)}
              placeholder="Enter admin key"
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleLogin} disabled={isLoading}>
              {isLoading ? 'Authenticating...' : 'Login'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Main Dashboard Component
export function Dashboard() {
  const { isAdmin, adminKey } = useAdmin();
  const { isMobile } = useBreakpoint();
  
  // Unified dashboard data state
  const [dashboardData, setDashboardData] = useState({
    overview: null,
    analytics: null,
    content: null,
    performance: null,
    system: null,
    operations: null,
    users: null,
    loading: true,
    error: null
  });

  // Unified data fetching - fetch all dashboard data once
  useEffect(() => {
    const fetchAllDashboardData = async () => {
      try {
        setDashboardData(prev => ({ ...prev, loading: true, error: null }));
        
        // Fetch all dashboard data in parallel
        const [overviewResponse, analyticsResponse, contentResponse, performanceResponse, systemResponse] = await Promise.all([
          fetch('/api/dashboard/overview'),
          fetch('/api/dashboard/analytics'),
          fetch('/api/dashboard/content'),
          fetch('/api/dashboard/timing'),
          fetch('/api/dashboard/system')
        ]);

        const data = {
          overview: overviewResponse.ok ? await overviewResponse.json() : null,
          analytics: analyticsResponse.ok ? await analyticsResponse.json() : null,
          content: contentResponse.ok ? await contentResponse.json() : null,
          performance: performanceResponse.ok ? await performanceResponse.json() : null,
          system: systemResponse.ok ? await systemResponse.json() : null,
          operations: null,
          users: null
        };

        // Fetch admin-only data if admin is logged in
        if (isAdmin && adminKey) {
          console.log('[Dashboard] Fetching admin data with key:', adminKey ? 'present' : 'missing');
          const headers = { 'x-admin-key': adminKey };
          const [operationsResponse, usersResponse] = await Promise.all([
            fetch('/api/dashboard/operations', { headers }),
            fetch('/api/dashboard/users', { headers })
          ]);

          console.log('[Dashboard] Operations response:', operationsResponse.status);
          console.log('[Dashboard] Users response:', usersResponse.status);

          data.operations = operationsResponse.ok ? await operationsResponse.json() : null;
          data.users = usersResponse.ok ? await usersResponse.json() : null;
        } else {
          console.log('[Dashboard] Not fetching admin data - isAdmin:', isAdmin, 'adminKey:', adminKey ? 'present' : 'missing');
        }

        setDashboardData({
          ...data,
          loading: false,
          error: null
        });

      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
        setDashboardData(prev => ({
          ...prev,
          loading: false,
          error: error.message
        }));
      }
    };

    fetchAllDashboardData();
  }, [isAdmin, adminKey]); // Re-fetch when admin status changes

  // Calculate grid columns based on admin status
  const gridCols = isAdmin ? "grid-cols-6" : "grid-cols-4";
  
  // Dashboard pages configuration
  const dashboardPages = [
    { value: 'overview', title: 'Overview', component: <DashboardOverview data={dashboardData.overview} systemData={dashboardData.system} loading={dashboardData.loading} /> },
    { value: 'analytics', title: 'Analytics', component: <DashboardAnalytics data={dashboardData.analytics} loading={dashboardData.loading} /> },
    { value: 'content', title: 'Content', component: <DashboardContent data={dashboardData.content} loading={dashboardData.loading} /> },
    { value: 'performance', title: 'Performance', component: <DashboardPerformance data={dashboardData.performance} loading={dashboardData.loading} /> },
    { value: 'system', title: 'System', component: <DashboardSystem data={dashboardData.system} loading={dashboardData.loading} /> },
  ];

  // Add admin-only pages
  if (isAdmin) {
    dashboardPages.push(
      { value: 'operations', title: 'Operations', component: <DashboardOperations data={dashboardData.operations} loading={dashboardData.loading} /> },
      { value: 'users', title: 'Users', component: <DashboardUsers data={dashboardData.users} loading={dashboardData.loading} /> }
    );
  }

  // Mobile layout with accordion
  if (isMobile) {
    return (
      <div className="w-full p-4">
        <div className="flex flex-col items-start justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
            <p className="text-sm text-muted-foreground">
              Monitor your addon's performance, health, and usage statistics
            </p>
          </div>
          <AdminLogin />
        </div>

        <Accordion type="single" collapsible className="w-full">
          {dashboardPages.map((page, index) => (
            <AccordionItem 
              value={page.value} 
              key={page.value}
              className={index === dashboardPages.length - 1 ? "border-b-0" : "border-b"}
            >
              <AccordionTrigger className="text-lg font-medium hover:no-underline py-4">
                {page.title}
              </AccordionTrigger>
              <AccordionContent className="pt-2 pb-6">
                {page.component}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    );
  }

  // Desktop layout with tabs
  return (
    <div className="space-y-4 sm:space-y-6 p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-sm sm:text-base text-muted-foreground">
            Monitor your addon's performance, health, and usage statistics
          </p>
        </div>
        <AdminLogin />
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="inline-flex h-10 items-center justify-center rounded-md p-1 text-muted-foreground w-full gap-x-1 bg-muted overflow-x-auto">
          <TabsTrigger value="overview" className="text-xs sm:text-sm whitespace-nowrap">Overview</TabsTrigger>
          <TabsTrigger value="analytics" className="text-xs sm:text-sm whitespace-nowrap">Analytics</TabsTrigger>
          <TabsTrigger value="content" className="text-xs sm:text-sm whitespace-nowrap">Content</TabsTrigger>
          <TabsTrigger value="performance" className="text-xs sm:text-sm whitespace-nowrap">Perf</TabsTrigger>
          <TabsTrigger value="system" className="text-xs sm:text-sm whitespace-nowrap">System</TabsTrigger>
          {isAdmin && <TabsTrigger value="operations" className="text-xs sm:text-sm whitespace-nowrap">Ops</TabsTrigger>}
          {isAdmin && <TabsTrigger value="users" className="text-xs sm:text-sm whitespace-nowrap">Users</TabsTrigger>}
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <DashboardOverview data={dashboardData.overview} systemData={dashboardData.system} loading={dashboardData.loading} />
        </TabsContent>

        <TabsContent value="analytics" className="mt-6">
          <DashboardAnalytics data={dashboardData.analytics} loading={dashboardData.loading} />
        </TabsContent>

        <TabsContent value="content" className="mt-6">
          <DashboardContent data={dashboardData.content} loading={dashboardData.loading} />
        </TabsContent>

        <TabsContent value="performance" className="mt-6">
          <DashboardPerformance data={dashboardData.performance} loading={dashboardData.loading} />
        </TabsContent>

        <TabsContent value="system" className="mt-6">
          <DashboardSystem data={dashboardData.system} loading={dashboardData.loading} />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="operations" className="mt-6">
            <DashboardOperations data={dashboardData.operations} loading={dashboardData.loading} />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="users" className="mt-6">
            <DashboardUsers data={dashboardData.users} loading={dashboardData.loading} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
