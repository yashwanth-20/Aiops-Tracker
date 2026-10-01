'use strict';

const app = require('./app');
const repo = require('./repo');

const PORT = process.env.PORT || 3000;

repo.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AIOps Snapshot Tracker (${repo.kind} storage) running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise storage:', err.message);
    process.exit(1);
  });
