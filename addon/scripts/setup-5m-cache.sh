#!/bin/bash

# Setup script for 5M ID cache configuration
echo "🔧 Setting up 5M ID cache configuration..."

# Set environment variables for 5M cache
export ID_CACHE_MAX_SIZE=5000000
export ID_CACHE_TTL_DAYS=90
export ID_CACHE_COMPRESSION=false

echo "✅ Environment variables set:"
echo "   ID_CACHE_MAX_SIZE=$ID_CACHE_MAX_SIZE"
echo "   ID_CACHE_TTL_DAYS=$ID_CACHE_TTL_DAYS"
echo "   ID_CACHE_COMPRESSION=$ID_CACHE_COMPRESSION"

# Show storage requirements
echo ""
echo "📊 Storage requirements for 5M entries:"
echo "   Disk space: ~814 MB"
echo "   Memory usage: ~183 MB (recommended)"
echo "   Backup size: ~814 MB"

# Show recommendations
echo ""
echo "💡 Recommendations for 5M cache:"
echo "   - Set up hourly optimization cron job"
echo "   - Monitor disk space closely"
echo "   - Consider TTL of 7-30 days for high turnover"
echo "   - Ensure at least 2GB free disk space"
echo "   - Recommended RAM: 4GB+ for optimal performance"

# Add to .env file if it exists
if [ -f ".env" ]; then
    echo ""
    echo "📝 Adding to .env file..."
    echo "ID_CACHE_MAX_SIZE=$ID_CACHE_MAX_SIZE" >> .env
    echo "ID_CACHE_TTL_DAYS=$ID_CACHE_TTL_DAYS" >> .env
    echo "ID_CACHE_COMPRESSION=$ID_CACHE_COMPRESSION" >> .env
    echo "✅ Added to .env file"
fi

# Show cron job example
echo ""
echo "⏰ Example cron job for optimization:"
echo "   # Hourly optimization for 5M cache"
echo "   0 * * * * cd $(pwd) && node addon/scripts/manage-id-cache.js optimize"

echo ""
echo "🎉 5M cache configuration complete!"
echo "   Restart your application to apply changes."







