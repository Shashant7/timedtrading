#!/usr/bin/env node
/**
 * Analyze worker logs for Discord alert issues
 * 
 * Usage:
 *   node scripts/analyze-logs.js [log-file.txt]
 * 
 * If log file is provided, analyzes that file.
 * Otherwise, provides instructions for fetching logs.
 */

const fs = require('fs');
const path = require('path');

function analyzeLogs(logContent) {
  const lines = logContent.split('\n');
  
  const results = {
    discordConfig: [],
    alertDebug: [],
    alertEval: [],
    alertBlocked: [],
    discordAlerts: [],
    corridorEntries: [],
    errors: [],
  };
  
  lines.forEach((line, index) => {
    // Discord configuration issues
    if (line.includes('[DISCORD CONFIG]') || 
        line.includes('[DISCORD] Notifications disabled') ||
        line.includes('[DISCORD] Webhook URL not configured')) {
      results.discordConfig.push({ line: index + 1, content: line });
    }
    
    // Alert debug logs
    if (line.includes('[ALERT DEBUG]')) {
      results.alertDebug.push({ line: index + 1, content: line });
    }
    
    // Alert evaluation logs
    if (line.includes('[ALERT EVAL]')) {
      results.alertEval.push({ line: index + 1, content: line });
    }
    
    // Alert blocked logs
    if (line.includes('[ALERT BLOCKED]')) {
      results.alertBlocked.push({ line: index + 1, content: line });
    }
    
    // Discord alerts sent
    if (line.includes('[DISCORD ALERT]')) {
      results.discordAlerts.push({ line: index + 1, content: line });
    }
    
    // Corridor entries
    if (line.includes('corridor_entry') || line.includes('enteredCorridor')) {
      results.corridorEntries.push({ line: index + 1, content: line });
    }
    
    // Errors
    if (line.includes('ERROR') || line.includes('Error') || line.includes('error')) {
      results.errors.push({ line: index + 1, content: line });
    }
  });
  
  return results;
}

function printAnalysis(results) {
  console.log('='.repeat(60));
  console.log('📊 Log Analysis Results');
  console.log('='.repeat(60));
  console.log('');
  
  // Discord Configuration
  console.log(`🔧 Discord Configuration Issues: ${results.discordConfig.length}`);
  if (results.discordConfig.length > 0) {
    results.discordConfig.slice(0, 5).forEach(item => {
      console.log(`  Line ${item.line}: ${item.content.substring(0, 100)}`);
    });
    if (results.discordConfig.length > 5) {
      console.log(`  ... and ${results.discordConfig.length - 5} more`);
    }
  } else {
    console.log('  ✅ No Discord configuration issues found');
  }
  console.log('');
  
  // Alert Debug
  console.log(`🐛 Alert Debug Logs: ${results.alertDebug.length}`);
  if (results.alertDebug.length > 0) {
    results.alertDebug.slice(0, 3).forEach(item => {
      console.log(`  Line ${item.line}: ${item.content.substring(0, 150)}`);
    });
    if (results.alertDebug.length > 3) {
      console.log(`  ... and ${results.alertDebug.length - 3} more`);
    }
  }
  console.log('');
  
  // Alert Blocked
  console.log(`❌ Alerts Blocked: ${results.alertBlocked.length}`);
  if (results.alertBlocked.length > 0) {
    const blockers = {};
    results.alertBlocked.forEach(item => {
      const match = item.content.match(/\[ALERT BLOCKED\] (.+?): (.+)/);
      if (match) {
        const ticker = match[1];
        const reason = match[2];
        if (!blockers[ticker]) {
          blockers[ticker] = [];
        }
        blockers[ticker].push(reason);
      }
    });
    
    Object.entries(blockers).slice(0, 10).forEach(([ticker, reasons]) => {
      console.log(`  ${ticker}: ${reasons.join(', ')}`);
    });
    if (Object.keys(blockers).length > 10) {
      console.log(`  ... and ${Object.keys(blockers).length - 10} more tickers`);
    }
  } else {
    console.log('  ℹ️  No blocked alerts found in logs');
  }
  console.log('');
  
  // Discord Alerts Sent
  console.log(`✅ Discord Alerts Sent: ${results.discordAlerts.length}`);
  if (results.discordAlerts.length > 0) {
    results.discordAlerts.slice(0, 5).forEach(item => {
      console.log(`  Line ${item.line}: ${item.content.substring(0, 100)}`);
    });
    if (results.discordAlerts.length > 5) {
      console.log(`  ... and ${results.discordAlerts.length - 5} more`);
    }
  } else {
    console.log('  ⚠️  No Discord alerts sent!');
  }
  console.log('');
  
  // Corridor Entries
  console.log(`🚪 Corridor Entries: ${results.corridorEntries.length}`);
  if (results.corridorEntries.length > 0) {
    results.corridorEntries.slice(0, 5).forEach(item => {
      console.log(`  Line ${item.line}: ${item.content.substring(0, 100)}`);
    });
    if (results.corridorEntries.length > 5) {
      console.log(`  ... and ${results.corridorEntries.length - 5} more`);
    }
  }
  console.log('');
  
  // Errors
  console.log(`⚠️  Errors: ${results.errors.length}`);
  if (results.errors.length > 0) {
    results.errors.slice(0, 5).forEach(item => {
      console.log(`  Line ${item.line}: ${item.content.substring(0, 100)}`);
    });
    if (results.errors.length > 5) {
      console.log(`  ... and ${results.errors.length - 5} more`);
    }
  } else {
    console.log('  ✅ No errors found');
  }
  console.log('');
  
  // Summary
  console.log('='.repeat(60));
  console.log('📋 Summary');
  console.log('='.repeat(60));
  console.log('');
  
  if (results.discordConfig.length > 0) {
    console.log('❌ ISSUE: Discord not properly configured');
    console.log('   Check: DISCORD_ENABLE="true" and DISCORD_WEBHOOK_URL is set');
  }
  
  if (results.alertBlocked.length > 0 && results.discordAlerts.length === 0) {
    console.log('❌ ISSUE: Alerts are being blocked');
    console.log('   Review blockers above to see why alerts aren\'t firing');
  }
  
  if (results.corridorEntries.length > 0 && results.discordAlerts.length === 0) {
    console.log('⚠️  WARNING: Tickers entering corridor but no alerts sent');
    console.log('   This suggests alerts are being blocked by thresholds or conditions');
  }
  
  if (results.discordAlerts.length > 0) {
    console.log(`✅ SUCCESS: ${results.discordAlerts.length} Discord alerts sent`);
  }
  
  console.log('');
}

function main() {
  const logFile = process.argv[2];
  
  if (logFile) {
    // Analyze provided log file
    try {
      const logContent = fs.readFileSync(logFile, 'utf8');
      const results = analyzeLogs(logContent);
      printAnalysis(results);
    } catch (err) {
      console.error(`Error reading log file: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Provide instructions
    console.log('📋 Log Analysis Tool');
    console.log('='.repeat(60));
    console.log('');
    console.log('To analyze logs, you have two options:');
    console.log('');
    console.log('Option 1: Fetch logs using wrangler');
    console.log('  1. Install wrangler: npm install -g wrangler');
    console.log('  2. Authenticate: wrangler login');
    console.log('  3. Fetch logs: cd worker && wrangler tail > logs.txt');
    console.log('  4. Analyze: node scripts/analyze-logs.js logs.txt');
    console.log('');
    console.log('Option 2: Access logs via Cloudflare Dashboard');
    console.log('  1. Go to: https://dash.cloudflare.com');
    console.log('  2. Navigate to: Workers & Pages > timed-trading-ingest');
    console.log('  3. Click on "Logs" tab');
    console.log('  4. Filter for: DISCORD, ALERT, corridor');
    console.log('  5. Copy logs and save to a file');
    console.log('  6. Analyze: node scripts/analyze-logs.js <log-file>');
    console.log('');
    console.log('Option 3: Use the fetch script');
    console.log('  bash scripts/fetch-worker-logs.sh');
    console.log('');
  }
}

main();
