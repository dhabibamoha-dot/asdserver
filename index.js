// Some hosting panels (e.g. Bot-Hosting.net) always run `node index.js`
// regardless of package.json's "main"/"scripts.start". This file just
// hands off to the real entry point so the server boots either way.
require('./server.js');
