import { startBackupScheduler } from "./services/backup.service.js";
import app from "./index.js";
import { registerTask16Routes } from "./task16.routes.js";

registerTask16Routes(app);
\nstartBackupScheduler();\n