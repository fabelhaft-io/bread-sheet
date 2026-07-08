import config from './configs/config.js';
import app from './app.js';
import { startEditExpiryJob } from './jobs/editExpiryJob.js';

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
});

// Scheduled background jobs (run inside the server process)
startEditExpiryJob();
