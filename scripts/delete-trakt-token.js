#!/usr/bin/env node

const database = require('../dist/lib/database.js');

const tokenId = '059d387f-531d-4a47-ae65-2d26b5e21d94';

async function deleteToken() {
  try {
    console.log(`Deleting token ${tokenId}...`);
    
    const result = await database.runQuery(
      'DELETE FROM oauth_tokens WHERE id = ?', 
      [tokenId]
    );
    
    console.log('✅ Token deleted successfully');
    console.log('Please reconnect your Trakt account in the settings');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error deleting token:', error);
    process.exit(1);
  }
}

deleteToken();
