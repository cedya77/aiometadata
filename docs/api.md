# API Documentation

This document describes the API endpoints available in the TMDB Addon.

## Base URL

All URLs referenced in the documentation have the following base:
```
http://your_domain:3232
```

## Authentication

Most endpoints don't require authentication. However, some features might require API keys to be set in the environment variables.

## Endpoints

### Manifest
```http
GET /manifest.json
```

Returns the Stremio addon manifest with addon details and available resources.

#### Response
```json
{
  "id": "tmdb-addon",
  "version": "1.0.0",
  "name": "TMDB Addon",
  "description": "TMDB Addon for Stremio",
  "resources": ["catalog", "meta", "stream"],
  "types": ["movie", "series"],
  "catalogs": [...]
}
```

### Catalog
```http
GET /catalog/:type/:id/:extra?.json
```

Returns a catalog of items based on type and ID.

#### Parameters
- `type`: Type of content (`movie` or `series`)
- `id`: Catalog ID
- `extra`: Additional parameters (optional)

#### Response
```json
{
  "metas": [
    {
      "id": "tmdb:106646",
      "type": "movie",
      "name": "Movie Title",
      "poster": "https://image.url/poster.jpg",
      "background": "https://image.url/background.jpg"
    }
  ]
}
```

### Meta
```http
GET /meta/:type/:id.json
```

Returns metadata for a specific item.

#### Parameters
- `type`: Type of content (`movie` or `series`)
- `id`: TMDB ID or IMDb ID

#### Response
```json
{
  "meta": {
    "id": "tmdb:106646",
    "type": "movie",
    "name": "Movie Title",
    "poster": "https://image.url/poster.jpg",
    "background": "https://image.url/background.jpg",
    "description": "Movie description",
    "runtime": "120",
    "year": 2023,
    "director": ["Director Name"],
    "cast": ["Actor 1", "Actor 2"]
  }
}
```

### Configuration
```http
GET /configure
```

Returns the configuration page for the addon.

## Error Responses

The API uses standard HTTP response codes:

- `200`: Success
- `400`: Bad Request
- `404`: Not Found
- `500`: Internal Server Error

Error response format:
```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

## Rate Limiting

The API implements rate limiting to prevent abuse:

- 100 requests per minute per IP
- 1000 requests per hour per IP

Rate limit headers:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1613937600
```

## Caching

The API implements caching for better performance:

- Manifest: 24 hours
- Catalog: 1 hour
- Meta: 24 hours

Cache headers:
```
Cache-Control: public, max-age=3600
ETag: "33a64df551425fcc55e4d42a148795d9f25f89d4"
```

## Examples

### Fetching Popular Movies
```http
GET /catalog/movie/tmdb.top/skip=0&limit=100.json
```

### Getting Movie Details
```http
GET /meta/movie/tmdb:106646.json
```

### Configuring the Addon
```http
GET /configure
```

## Development

For development and testing, you can use the following tools:

1. **Postman Collection**:
   Download our Postman collection for easy API testing.

2. **Development Environment**:
   ```bash
   npm run dev:server
   ```

## Additional Resources

- [Stremio Addon SDK Documentation](https://github.com/Stremio/stremio-addon-sdk)
- [TMDB API Documentation](https://developers.themoviedb.org/3)
- [Fanart.tv API Documentation](https://fanarttv.docs.apiary.io/) 