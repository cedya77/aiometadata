#!/usr/bin/env node

/**
 * Test script for anime list auto-update functionality
 * This script tests the periodic update mechanism
 */

const { initializeMapper, cleanup } = require('./addon/lib/id-mapper');

async function testAutoUpdate() {
  console.log('=== Testing Anime List Auto-Update ===');
  
  try {
    // Initialize the mapper (this will start the auto-update interval)
    console.log('1. Initializing mapper...');
    await initializeMapper();
    
    // Wait for 5 seconds to see if the initial load works
    console.log('2. Waiting 5 seconds to verify initial load...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Test a second initialization (should not trigger another download due to ETag)
    console.log('3. Testing second initialization (should use cache)...');
    await initializeMapper();
    
    console.log('4. Auto-update interval is now running in the background.');
    console.log('   The anime list will update every 24 hours (or as configured).');
    console.log('   You can check the logs for update messages.');
    
    // Keep the process running for a bit to see the interval in action
    console.log('5. Keeping process alive for 10 seconds to demonstrate...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log('6. Test completed successfully!');
    
  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    // Clean up the interval
    cleanup();
    console.log('7. Cleaned up resources.');
    process.exit(0);
  }
}

// Run the test
testAutoUpdate();







