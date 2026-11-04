// Plain-old-JavaScript launcher so an outdated Node gets a clear message instead of a cryptic crash.
var major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 20) {
  console.error('\n  Chartsmith needs Node.js 20 or newer. This computer has ' + process.version + '.');
  console.error('  Install the LTS version from https://nodejs.org, then run "npm start" again.\n');
  process.exit(1);
}
import('./server.mjs').catch(function (e) {
  console.error('\n  Chartsmith could not start: ' + (e && e.message ? e.message : e) + '\n');
  process.exit(1);
});
