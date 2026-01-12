#!/usr/bin/env node
/**
 * Fetch Cloudflare Worker logs directly via API
 * 
 * Usage:
 *   node scripts/fetch-logs-api.js [options]
 * 
 * Options:
 *   --account-id <id>     Cloudflare Account ID (or set CLOUDFLARE_ACCOUNT_ID)
 *   --api-token <token>   Cloudflare API Token (or set CLOUDFLARE_API_TOKEN)
 *   --worker-name <name>  Worker name (default: timed-trading-ingest)
 *   --limit <number>      Number of logs to fetch (default: 100)
 *   --filter <pattern>    Filter logs by pattern (e.g., DISCORD, ALERT)
 *   --output <file>       Save logs to file (default: logs.txt)
 * 
 * Environment Variables:
 *   CLOUDFLARE_ACCOUNT_ID - Your Cloudflare Account ID
 *   CLOUDFLARE_API_TOKEN  - Your Cloudflare API Token
 * 
 * To get API token:
 *   1. Go to https://dash.cloudflare.com/profile/api-tokens
 *   2. Create token with "Workers Logs:Read" permission
 */

const https = require('https');
const fs = require('fs');
const { URL } = require('url');

// Parse command line arguments
function parseArgs() {
  const args = {};
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].substring(2);
      const value = process.argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function fetchLogs(options) {
  const {
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken = process.env.CLOUDFLARE_API_TOKEN,
    workerName = 'timed-trading-ingest',
    limit = 100,
    filter = null,
    output = 'logs.txt'
  } = options;

  if (!accountId) {
    console.error('❌ Error: Account ID required');
    console.error('   Set CLOUDFLARE_ACCOUNT_ID environment variable or use --account-id');
    console.error('   Get it from: https://dash.cloudflare.com (right sidebar)');
    process.exit(1);
  }

  if (!apiToken) {
    console.error('❌ Error: API Token required');
    console.error('   Set CLOUDFLARE_API_TOKEN environment variable or use --api-token');
    console.error('   Create token at: https://dash.cloudflare.com/profile/api-tokens');
    console.error('   Required permission: Workers Logs:Read');
    process.exit(1);
  }

  console.log('🔍 Fetching Cloudflare Worker logs...');
  console.log(`   Worker: ${workerName}`);
  console.log(`   Account: ${accountId.substring(0, 8)}...`);
  console.log(`   Limit: ${limit}`);
  if (filter) {
    console.log(`   Filter: ${filter}`);
  }
  console.log('');

  // Cloudflare Workers Logs API endpoint
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/logs/tail`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const error = JSON.parse(data);
            reject(new Error(`API Error ${res.statusCode}: ${error.errors?.[0]?.message || data}`));
          } catch (e) {
            reject(new Error(`API Error ${res.statusCode}: ${data}`));
          }
          return;
        }

        try {
          const response = JSON.parse(data);
          
          if (!response.success) {
            reject(new Error(`API Error: ${response.errors?.[0]?.message || 'Unknown error'}`));
            return;
          }

          // The logs API returns a stream, but for simplicity, we'll use the real-time logs endpoint
          // For historical logs, we need to use a different approach
          resolve(response);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Alternative: Use Cloudflare GraphQL Analytics API for historical logs
async function fetchLogsGraphQL(options) {
  const {
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken = process.env.CLOUDFLARE_API_TOKEN,
    workerName = 'timed-trading-ingest',
    limit = 100,
    filter = null,
    output = 'logs.txt'
  } = options;

  console.log('📊 Fetching logs via GraphQL Analytics API...');
  console.log('   Note: This requires Workers Analytics API access');
  console.log('');

  const query = `
    query {
      viewer {
        accounts(filter: {accountTag: "${accountId}"}) {
          workersInvocationsAdaptive(
            filter: {
              scriptName: "${workerName}"
            }
            limit: ${limit}
            orderBy: [timestamp_DESC]
          ) {
            dimensions {
              scriptName
              status
              datetime
            }
            metrics {
              requests
              errors
            }
          }
        }
      }
    }
  `;

  const url = 'https://api.cloudflare.com/client/v4/graphql';

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const error = JSON.parse(data);
            reject(new Error(`API Error ${res.statusCode}: ${error.errors?.[0]?.message || data}`));
          } catch (e) {
            reject(new Error(`API Error ${res.statusCode}: ${data}`));
          }
          return;
        }

        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(JSON.stringify({ query }));
    req.end();
  });
}

// Use Wrangler's tail command if available (most reliable)
async function fetchLogsWrangler(options) {
  const { execSync } = require('child_process');
  const { workerName = 'timed-trading-ingest', limit = 100, filter = null, output = 'logs.txt' } = options;

  console.log('📊 Fetching logs via Wrangler CLI...');
  console.log('');

  try {
    // Check if wrangler is installed
    execSync('which wrangler', { stdio: 'ignore' });
  } catch (e) {
    throw new Error('Wrangler CLI not found. Install with: npm install -g wrangler');
  }

  try {
    // Use wrangler tail to fetch logs
    const command = `cd worker && wrangler tail ${workerName} --format pretty --once 2>&1 | head -${limit}`;
    const logs = execSync(command, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    
    let filteredLogs = logs;
    if (filter) {
      const lines = logs.split('\n');
      filteredLogs = lines.filter(line => line.includes(filter)).join('\n');
    }

    if (output) {
      fs.writeFileSync(output, filteredLogs);
      console.log(`✅ Logs saved to ${output}`);
    }

    return filteredLogs;
  } catch (error) {
    throw new Error(`Failed to fetch logs: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs();

  if (args.help || args.h) {
    console.log(`
Usage: node scripts/fetch-logs-api.js [options]

Options:
  --account-id <id>     Cloudflare Account ID
  --api-token <token>   Cloudflare API Token
  --worker-name <name>  Worker name (default: timed-trading-ingest)
  --limit <number>      Number of logs (default: 100)
  --filter <pattern>    Filter by pattern (e.g., DISCORD, ALERT)
  --output <file>       Output file (default: logs.txt)
  --method <api|wrangler>  Method to use (default: wrangler)

Environment Variables:
  CLOUDFLARE_ACCOUNT_ID - Your Cloudflare Account ID
  CLOUDFLARE_API_TOKEN  - Your Cloudflare API Token

Examples:
  node scripts/fetch-logs-api.js --filter DISCORD
  node scripts/fetch-logs-api.js --limit 200 --output recent-logs.txt
  CLOUDFLARE_ACCOUNT_ID=xxx CLOUDFLARE_API_TOKEN=yyy node scripts/fetch-logs-api.js
`);
    process.exit(0);
  }

  const method = args.method || 'wrangler';

  try {
    let logs;

    if (method === 'wrangler') {
      logs = await fetchLogsWrangler(args);
      console.log('\n📋 Logs Preview:');
      console.log('='.repeat(60));
      const lines = logs.split('\n').slice(0, 20);
      console.log(lines.join('\n'));
      if (logs.split('\n').length > 20) {
        console.log(`\n... (showing first 20 of ${logs.split('\n').length} lines)`);
      }
    } else if (method === 'api') {
      console.error('❌ Direct API method requires Cloudflare API token');
      console.error('   Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
      console.error('   Or use --method wrangler (recommended)');
      process.exit(1);
    } else {
      console.error(`❌ Unknown method: ${method}`);
      console.error('   Use --method wrangler or --method api');
      process.exit(1);
    }

    console.log('\n✅ Logs fetched successfully!');
    console.log(`   Total lines: ${logs.split('\n').length}`);
    
    if (args.output) {
      console.log(`   Saved to: ${args.output}`);
      console.log(`\n💡 Analyze with: node scripts/analyze-logs.js ${args.output}`);
    }

  } catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    console.error('\nTroubleshooting:');
    console.error('  1. Make sure wrangler is installed: npm install -g wrangler');
    console.error('  2. Authenticate: wrangler login');
    console.error('  3. Check worker name matches your deployment');
    process.exit(1);
  }
}

main();
